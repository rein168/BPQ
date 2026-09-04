const db = require('../db');
const { v4: uuidv4 } = require('uuid');

let io;

// Configurable court capacity: 4 for doubles (default), 2 for singles
const PLAYERS_PER_COURT = parseInt(process.env.PLAYERS_PER_COURT, 10) || 4;
const TEAMS = PLAYERS_PER_COURT / 2; // 2 players per team in doubles

// Prepared statements (lazy-initialized after db is ready)
let stmts = null;

function prepareStatements() {
  if (stmts) return stmts;
  stmts = {
    // Sessions
    createSession: db.prepare('INSERT INTO sessions (name, pin_hash, court_count, game_date, status) VALUES (?, ?, ?, ?, ?)'),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    getAllSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at DESC'),
    endSession: db.prepare('UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?'),

    // Players
    insertPlayer: db.prepare(
      'INSERT INTO players (session_id, name, skill_level, status, position, arrived_at) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    getSessionPlayers: db.prepare('SELECT * FROM players WHERE session_id = ? ORDER BY position ASC'),
    updatePlayerSkill: db.prepare('UPDATE players SET skill_level = ? WHERE id = ?'),
    updatePlayerStatus: db.prepare('UPDATE players SET status = ? WHERE id = ?'),

    // Courts (per-session)
    getSessionCourts: db.prepare("SELECT * FROM courts WHERE session_id = ? AND status = ? ORDER BY id ASC"),
    createCourt: db.prepare('INSERT INTO courts (name, uuid, session_id) VALUES (?, ?, ?)'),
    deleteCourt: db.prepare('DELETE FROM courts WHERE id = ? AND session_id = ?'),
    updateSessionCourtCount: db.prepare('UPDATE sessions SET court_count = ? WHERE id = ?'),

    // Courts in use
    insertCourtInUse: db.prepare(
      'INSERT INTO courts_in_use (session_id, court_id, match_started_at) VALUES (?, ?, ?)'
    ),
    getCourtInUse: db.prepare(
      'SELECT * FROM courts_in_use WHERE session_id = ? AND court_id = ? ORDER BY id DESC LIMIT 1'
    ),
    getOccupiedCourtIds: db.prepare(
      'SELECT DISTINCT court_id FROM courts_in_use WHERE session_id = ?'
    ),
    deleteCourtInUse: db.prepare('DELETE FROM courts_in_use WHERE id = ?'),

    // Match players (junction table)
    insertMatchPlayer: db.prepare(
      'INSERT INTO match_players (court_in_use_id, player_id, team) VALUES (?, ?, ?)'
    ),
    getMatchPlayerIds: db.prepare(
      'SELECT player_id, team FROM match_players WHERE court_in_use_id = ?'
    ),
    insertHistoryMatchPlayer: db.prepare(
      'INSERT INTO match_players (match_history_id, player_id, team) VALUES (?, ?, ?)'
    ),

    // Match history
    insertMatchHistory: db.prepare(
      'INSERT INTO match_history (session_id, court_id, duration_ms) VALUES (?, ?, ?)'
    ),
    updateMatchScore: db.prepare(
      'UPDATE match_history SET score_a = ?, score_b = ? WHERE id = ?'
    ),
    getMatchHistory: db.prepare(
      'SELECT * FROM match_history WHERE session_id = ? ORDER BY completed_at DESC LIMIT ?'
    ),
    getMatchHistoryPlayers: db.prepare(
      'SELECT mp.match_history_id, mp.player_id, mp.team, p.name, p.skill_level FROM match_players mp JOIN players p ON p.id = mp.player_id WHERE mp.match_history_id = ?'
    ),

    // Player games-played count for fair allocation
    getPlayerGameCounts: db.prepare(
      `SELECT p.id, COUNT(mp.id) AS games_played
       FROM players p
       LEFT JOIN match_players mp ON mp.player_id = p.id AND mp.match_history_id IS NOT NULL
       WHERE p.session_id = ?
       GROUP BY p.id`
    ),

    // Player W/L record
    getPlayerWL: db.prepare(
      `SELECT p.id, p.name, p.skill_level, p.status, p.arrived_at, p.created_at,
              COUNT(CASE WHEN ((mp.team = 'A' AND mh.score_a > mh.score_b) OR (mp.team = 'B' AND mh.score_b > mh.score_a)) THEN 1 END) AS wins,
              COUNT(CASE WHEN ((mp.team = 'A' AND mh.score_a < mh.score_b) OR (mp.team = 'B' AND mh.score_b < mh.score_a)) THEN 1 END) AS losses,
              COUNT(CASE WHEN mp.match_history_id IS NOT NULL THEN 1 END) AS games_played
       FROM players p
       LEFT JOIN match_players mp ON mp.player_id = p.id AND mp.match_history_id IS NOT NULL
       LEFT JOIN match_history mh ON mh.id = mp.match_history_id
       WHERE p.session_id = ?
       GROUP BY p.id
       ORDER BY p.position ASC`
    ),
  };
  return stmts;
}

// Valid player statuses
const VALID_STATUSES = ['waiting', 'playing', 'rested', 'break', 'skipped', 'absent', 'left_early'];
// Statuses eligible for court allocation
const ALLOCATABLE_STATUSES = ['waiting', 'rested'];

const sessionService = {
  init(socketIo) {
    io = socketIo;
    prepareStatements();
  },

  // ===== SESSION MANAGEMENT =====
  createSession(name, pinHash = null, courtCount = 0, gameDate = null) {
    const s = prepareStatements();
    const count = Math.max(0, Math.min(courtCount, 20));
    const result = s.createSession.run(name, pinHash, count, gameDate, 'active');
    const sessionId = result.lastInsertRowid;

    // Pre-create courts if a count was explicitly provided
    for (let i = 1; i <= count; i++) {
      s.createCourt.run('Court ' + i, uuidv4(), sessionId);
    }

    return sessionId;
  },

  getSession(sessionId) {
    const s = prepareStatements();
    return s.getSession.get(sessionId) || null;
  },

  getAllSessions() {
    const s = prepareStatements();
    return s.getAllSessions.all();
  },

  endSession(sessionId) {
    const s = prepareStatements();
    s.endSession.run('ended', Date.now(), sessionId);
  },

  // ===== PLAYER ROSTER MANAGEMENT =====
  importPlayerRoster(sessionId, players) {
    if (!players || players.length === 0) return 0;

    const s = prepareStatements();
    const now = Date.now();
    const insertMany = db.transaction((playerList) => {
      for (let i = 0; i < playerList.length; i++) {
        const p = playerList[i];
        s.insertPlayer.run(sessionId, p.name, p.skill_level, 'waiting', i + 1, now);
      }
    });

    insertMany(players);
    this.autoAdjustCourtCount(sessionId);
    this.tryAutoAllocate(sessionId);
    this.broadcastSessionState(sessionId);
    return players.length;
  },

  getSessionPlayers(sessionId) {
    const s = prepareStatements();
    return s.getSessionPlayers.all(sessionId);
  },

  // Self-registration: player joins via QR code / link
  registerPlayer(sessionId, name, skillLevel) {
    const s = prepareStatements();
    const now = Date.now();
    // Get next position
    const players = s.getSessionPlayers.all(sessionId);
    const nextPos = players.length + 1;
    const result = s.insertPlayer.run(sessionId, name, skillLevel, 'waiting', nextPos, now);
    this.autoAdjustCourtCount(sessionId);
    this.tryAutoAllocate(sessionId);
    this.broadcastSessionState(sessionId);
    return result.lastInsertRowid;
  },

  // Check-in: update arrived_at timestamp (re-scan QR at venue)
  checkInPlayer(playerId, sessionId) {
    const player = db.prepare('SELECT * FROM players WHERE id = ? AND session_id = ?').get(playerId, sessionId);
    if (!player) throw new Error('Player not found in this session');
    // Update arrived_at if not already set, or update to now (re-arrival)
    db.prepare('UPDATE players SET arrived_at = ? WHERE id = ?').run(Date.now(), playerId);
    this.broadcastSessionState(sessionId);
  },

  // Get players with W/L records and games played (for queue display)
  getPlayersWithStats(sessionId) {
    const s = prepareStatements();
    return s.getPlayerWL.all(sessionId);
  },

  updatePlayerSkill(playerId, skillLevel) {
    const s = prepareStatements();
    s.updatePlayerSkill.run(skillLevel, playerId);
  },

  // Set player status with validation
  setPlayerStatus(playerId, sessionId, newStatus) {
    if (!VALID_STATUSES.includes(newStatus)) {
      throw new Error(`Invalid status: ${newStatus}`);
    }
    const player = db.prepare('SELECT * FROM players WHERE id = ? AND session_id = ?').get(playerId, sessionId);
    if (!player) throw new Error('Player not found in this session');
    if (player.status === 'playing' && newStatus !== 'waiting' && newStatus !== 'rested') {
      throw new Error('Cannot change status of a player currently on court');
    }

    const s = prepareStatements();
    s.updatePlayerStatus.run(newStatus, playerId);
    this.broadcastSessionState(sessionId);
  },

  removePlayer(playerId, sessionId) {
    const player = db.prepare('SELECT * FROM players WHERE id = ? AND session_id = ?').get(playerId, sessionId);
    if (!player) throw new Error('Player not found in this session');
    if (player.status === 'playing') {
      throw new Error('Cannot remove a player who is currently playing');
    }
    db.prepare('DELETE FROM players WHERE id = ? AND session_id = ?').run(playerId, sessionId);
    this.broadcastSessionState(sessionId);
  },

  // ===== COURT ALLOCATION & QUEUEING =====
  getSessionCourts(sessionId) {
    const s = prepareStatements();
    return s.getSessionCourts.all(sessionId, 'active');
  },

  // Add a court to a session (host adjusts court count up)
  addCourt(sessionId) {
    const s = prepareStatements();
    const existing = s.getSessionCourts.all(sessionId, 'active');
    if (existing.length >= 20) throw new Error('Maximum 20 courts');
    const nextNum = existing.length + 1;
    const result = s.createCourt.run('Court ' + nextNum, uuidv4(), sessionId);
    s.updateSessionCourtCount.run(existing.length + 1, sessionId);
    this.broadcastSessionState(sessionId);
    return result.lastInsertRowid;
  },

  // Remove a court from a session (only if not occupied)
  removeCourt(sessionId, courtId) {
    const s = prepareStatements();
    const existing = s.getSessionCourts.all(sessionId, 'active');
    if (existing.length <= 1) throw new Error('Must have at least 1 court');

    // Check court is not in use
    const occupiedIds = this.getOccupiedCourtIds(sessionId);
    if (occupiedIds.includes(Number(courtId))) {
      throw new Error('Cannot remove a court with an active match');
    }

    s.deleteCourt.run(courtId, sessionId);
    s.updateSessionCourtCount.run(existing.length - 1, sessionId);
    this.broadcastSessionState(sessionId);
  },

  getOccupiedCourtIds(sessionId) {
    const s = prepareStatements();
    return s.getOccupiedCourtIds.all(sessionId).map(r => r.court_id);
  },

  // Auto-adjust court count based on active player count
  // Creates courts as players join: floor(activePlayers / PLAYERS_PER_COURT)
  // Never removes courts — host does that manually via +/-
  autoAdjustCourtCount(sessionId) {
    const s = prepareStatements();
    const players = s.getSessionPlayers.all(sessionId);
    const activePlayers = players.filter(p =>
      ['waiting', 'rested', 'playing'].includes(p.status)
    );
    const neededCourts = Math.max(1, Math.floor(activePlayers.length / PLAYERS_PER_COURT));
    const currentCourts = s.getSessionCourts.all(sessionId, 'active');

    if (neededCourts > currentCourts.length) {
      for (let i = currentCourts.length + 1; i <= neededCourts; i++) {
        s.createCourt.run('Court ' + i, uuidv4(), sessionId);
      }
      s.updateSessionCourtCount.run(neededCourts, sessionId);
    }
  },

  // Auto-allocate: silently tries to fill any free courts when enough players are waiting
  tryAutoAllocate(sessionId) {
    try {
      this.autoAllocateCourts(sessionId);
    } catch (err) {
      // Silently ignore — auto-allocation is best-effort
      console.error('Auto-allocate error:', err.message);
    }
  },

  // Get eligible waiting players sorted by fairness: fewest games first, then earliest arrival
  _getEligiblePlayers(sessionId) {
    const players = this.getSessionPlayers(sessionId);
    const eligible = players.filter((p) => ALLOCATABLE_STATUSES.includes(p.status));

    if (eligible.length === 0) return [];

    // Get games-played counts
    const s = prepareStatements();
    const gameCounts = s.getPlayerGameCounts.all(sessionId);
    const countMap = {};
    for (const row of gameCounts) {
      countMap[row.id] = row.games_played;
    }

    // Sort: fewest games first, then earliest arrival (arrived_at or created_at)
    eligible.sort((a, b) => {
      const gamesA = countMap[a.id] || 0;
      const gamesB = countMap[b.id] || 0;
      if (gamesA !== gamesB) return gamesA - gamesB;
      const arrA = a.arrived_at || a.created_at;
      const arrB = b.arrived_at || b.created_at;
      return arrA - arrB;
    });

    return eligible;
  },

  // Smart court allocation based on skill levels + fairness
  autoAllocateCourts(sessionId) {
    const waitingPlayers = this._getEligiblePlayers(sessionId);

    if (waitingPlayers.length < PLAYERS_PER_COURT) {
      return { allocated: [], message: 'Not enough players for a game' };
    }

    const allCourts = this.getSessionCourts(sessionId);
    const occupiedIds = this.getOccupiedCourtIds(sessionId);
    const courts = allCourts.filter(c => !occupiedIds.includes(c.id));

    if (courts.length === 0) {
      return { allocated: [], message: 'All courts are occupied' };
    }

    const allocated = this._assignPlayersToCourts(sessionId, waitingPlayers, courts);

    this.broadcastSessionState(sessionId);
    return { allocated, message: `Allocated ${allocated.length} court(s)` };
  },

  // Fill a single specific court with the next waiting players
  autoFillCourt(sessionId, courtId) {
    const waitingPlayers = this._getEligiblePlayers(sessionId);

    if (waitingPlayers.length < PLAYERS_PER_COURT) {
      return null;
    }

    const court = this.getSessionCourts(sessionId).find(c => c.id === Number(courtId));
    if (!court) return null;

    const occupiedIds = this.getOccupiedCourtIds(sessionId);
    if (occupiedIds.includes(Number(courtId))) return null;

    const allocated = this._assignPlayersToCourts(sessionId, waitingPlayers, [court]);
    return allocated.length > 0 ? allocated[0] : null;
  },

  // Internal: assign waiting players to available courts by skill grouping
  // Players are pre-sorted by fairness (fewest games, earliest arrival)
  _assignPlayersToCourts(sessionId, waitingPlayers, courts) {
    const beginners = waitingPlayers.filter(p => p.skill_level === 'Beginner');
    const intermediate = waitingPlayers.filter(p => p.skill_level === 'Intermediate');

    let courtIndex = 0;
    const gameAssignments = [];

    // Rule 1: Group beginners together
    while (beginners.length >= PLAYERS_PER_COURT && courtIndex < courts.length) {
      const picked = beginners.splice(0, PLAYERS_PER_COURT);
      gameAssignments.push({
        courtId: courts[courtIndex].id,
        courtName: courts[courtIndex].name,
        players: picked,
        teamA: picked.slice(0, TEAMS),
        teamB: picked.slice(TEAMS),
        type: 'beginner',
      });
      courtIndex++;
    }

    // Rule 2: Group intermediate together
    while (intermediate.length >= PLAYERS_PER_COURT && courtIndex < courts.length) {
      const picked = intermediate.splice(0, PLAYERS_PER_COURT);
      gameAssignments.push({
        courtId: courts[courtIndex].id,
        courtName: courts[courtIndex].name,
        players: picked,
        teamA: picked.slice(0, TEAMS),
        teamB: picked.slice(TEAMS),
        type: 'intermediate',
      });
      courtIndex++;
    }

    // Rule 3: Mix remaining
    const remaining = [...beginners, ...intermediate];
    while (remaining.length >= PLAYERS_PER_COURT && courtIndex < courts.length) {
      const picked = remaining.splice(0, PLAYERS_PER_COURT);
      gameAssignments.push({
        courtId: courts[courtIndex].id,
        courtName: courts[courtIndex].name,
        players: picked,
        teamA: picked.slice(0, TEAMS),
        teamB: picked.slice(TEAMS),
        type: 'mixed',
      });
      courtIndex++;
    }

    // Execute assignments
    const allocated = [];
    for (const assignment of gameAssignments) {
      this.startCourt(sessionId, assignment.courtId, assignment.teamA, assignment.teamB);
      allocated.push(assignment);
    }

    return allocated;
  },

  // Assign players to a court (pre-game: match_started_at = null)
  startCourt(sessionId, courtId, teamA, teamB) {
    const s = prepareStatements();

    const assignMatch = db.transaction(() => {
      // match_started_at = null means "assigned, not started"
      const result = s.insertCourtInUse.run(sessionId, courtId, null);
      const courtInUseId = result.lastInsertRowid;

      for (const player of teamA) {
        s.insertMatchPlayer.run(courtInUseId, player.id, 'A');
      }
      for (const player of teamB) {
        s.insertMatchPlayer.run(courtInUseId, player.id, 'B');
      }

      // Mark players as 'playing' (they're assigned to a court)
      const allPlayers = [...teamA, ...teamB];
      const placeholders = allPlayers.map(() => '?').join(',');
      const playerIds = allPlayers.map(p => p.id);
      db.prepare(`UPDATE players SET status = 'playing' WHERE id IN (${placeholders})`).run(
        ...playerIds
      );
    });

    assignMatch();
  },

  // Begin the match timer on a court (START GAME pressed)
  beginMatch(sessionId, courtId) {
    const s = prepareStatements();
    const courtInUse = s.getCourtInUse.get(sessionId, courtId);
    if (!courtInUse) throw new Error('No match assigned to this court');
    if (courtInUse.match_started_at) throw new Error('Match already started');

    db.prepare('UPDATE courts_in_use SET match_started_at = ? WHERE id = ?')
      .run(Date.now(), courtInUse.id);
    this.broadcastSessionState(sessionId);
  },

  endCourt(sessionId, courtId) {
    const s = prepareStatements();

    const courtInUse = s.getCourtInUse.get(sessionId, courtId);
    if (!courtInUse) throw new Error('No active match on this court');

    const playerRows = s.getMatchPlayerIds.all(courtInUse.id);
    const playerIds = playerRows.map(r => r.player_id);
    const durationMs = courtInUse.match_started_at
      ? Date.now() - courtInUse.match_started_at
      : 0;

    const finishMatch = db.transaction(() => {
      const historyResult = s.insertMatchHistory.run(sessionId, courtId, durationMs);
      const historyId = historyResult.lastInsertRowid;

      // Copy players to history junction with team
      for (const row of playerRows) {
        s.insertHistoryMatchPlayer.run(historyId, row.player_id, row.team);
      }

      // Update player status back to 'rested' (they've played, back in queue)
      if (playerIds.length > 0) {
        const placeholders = playerIds.map(() => '?').join(',');
        db.prepare(`UPDATE players SET status = 'rested' WHERE id IN (${placeholders})`).run(
          ...playerIds
        );
      }

      // Remove from courts_in_use
      s.deleteCourtInUse.run(courtInUse.id);

      return historyId;
    });

    const historyId = finishMatch();

    // Auto-fill the freed court with next players (pre-game state)
    const autoFilled = this.autoFillCourt(sessionId, courtId);

    this.broadcastSessionState(sessionId);

    return { durationMs, historyId, autoFilled };
  },

  // Record score for a completed match
  recordScore(matchHistoryId, scoreA, scoreB) {
    const s = prepareStatements();
    s.updateMatchScore.run(scoreA, scoreB, matchHistoryId);
  },

  getCourtStatus(sessionId, courtId) {
    const s = prepareStatements();
    const courtInUse = s.getCourtInUse.get(sessionId, courtId);
    if (!courtInUse) return null;

    const playerRows = s.getMatchPlayerIds.all(courtInUse.id);
    courtInUse.player_ids = playerRows.map(r => r.player_id).join(',');
    courtInUse.players = playerRows; // includes team assignment
    return courtInUse;
  },

  broadcastSessionState(sessionId) {
    try {
      const session = this.getSession(sessionId);
      const playersWithStats = this.getPlayersWithStats(sessionId);
      const courts = this.getSessionCourts(sessionId);

      const courtsStatus = [];
      for (const court of courts) {
        const status = this.getCourtStatus(sessionId, court.id);
        courtsStatus.push({
          court,
          match: status || null,
        });
      }

      io.emit(`session:${sessionId}`, {
        session,
        players: playersWithStats,
        courts: courtsStatus,
        config: { playersPerCourt: PLAYERS_PER_COURT },
      });
    } catch (err) {
      console.error('Error broadcasting session state:', err);
    }
  },

  getMatchHistory(sessionId, limit = 50) {
    const s = prepareStatements();
    const matches = s.getMatchHistory.all(sessionId, limit);

    for (const match of matches) {
      const playerRows = s.getMatchHistoryPlayers.all(match.id);
      match.player_ids = playerRows.map(r => r.player_id).join(',');
      match.players = playerRows;
    }
    return matches;
  },

  // Session stats
  getSessionStats(sessionId) {
    const summary = db
      .prepare(
        `SELECT COUNT(*) AS totalMatches,
                COALESCE(AVG(duration_ms), 0) AS avgDurationMs,
                COALESCE(MIN(duration_ms), 0) AS minDurationMs,
                COALESCE(MAX(duration_ms), 0) AS maxDurationMs
         FROM match_history WHERE session_id = ?`
      )
      .get(sessionId);

    const playerStats = this.getPlayersWithStats(sessionId);

    return { summary, playerStats };
  },
};

module.exports = sessionService;
