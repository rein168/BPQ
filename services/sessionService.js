const db = require('../db');
const { v4: uuidv4 } = require('uuid');
const { planAssignments, sortByFairness, nextCourtName } = require('./allocation');
const { notifyCourtReady } = require('./notify');

let io;

// Configurable court capacity: 4 for doubles (default), 2 for singles
const PLAYERS_PER_COURT = parseInt(process.env.PLAYERS_PER_COURT, 10) || 4;
// Max players assigned per court (playing + waiting rotation)
const PLAYERS_PER_COURT_CAPACITY = parseInt(process.env.PLAYERS_PER_COURT_CAPACITY, 10) || 8;

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
    getSessionPlayers: db.prepare('SELECT * FROM players WHERE session_id = ? AND removed_at IS NULL ORDER BY position ASC, id ASC'),
    getPlayer: db.prepare('SELECT * FROM players WHERE id = ? AND session_id = ? AND removed_at IS NULL'),
    nextPlayerPosition: db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM players WHERE session_id = ?'),
    updatePlayerSkill: db.prepare('UPDATE players SET skill_level = ? WHERE id = ? AND session_id = ? AND removed_at IS NULL'),
    updatePlayerStatus: db.prepare('UPDATE players SET status = ? WHERE id = ?'),

    // Courts (per-session)
    // Order by the number in "Court N" so a re-added Court 2 sits between 1 and 3
    getSessionCourts: db.prepare("SELECT * FROM courts WHERE session_id = ? AND status = ? ORDER BY CAST(SUBSTR(name, 7) AS INTEGER), id ASC"),
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
      'UPDATE match_history SET score_a = ?, score_b = ? WHERE id = ? AND session_id = ?'
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
       WHERE p.session_id = ? AND p.removed_at IS NULL
       GROUP BY p.id`
    ),

    // Player W/L record
    getPlayerWL: db.prepare(
      `SELECT p.id, p.name, p.skill_level, p.status, p.arrived_at, p.break_at, p.created_at, p.mix_preference,
              COUNT(CASE WHEN ((mp.team = 'A' AND mh.score_a > mh.score_b) OR (mp.team = 'B' AND mh.score_b > mh.score_a)) THEN 1 END) AS wins,
              COUNT(CASE WHEN ((mp.team = 'A' AND mh.score_a < mh.score_b) OR (mp.team = 'B' AND mh.score_b < mh.score_a)) THEN 1 END) AS losses,
              COUNT(CASE WHEN mp.match_history_id IS NOT NULL THEN 1 END) AS games_played
       FROM players p
       LEFT JOIN match_players mp ON mp.player_id = p.id AND mp.match_history_id IS NOT NULL
       LEFT JOIN match_history mh ON mh.id = mp.match_history_id
       WHERE p.session_id = ? AND p.removed_at IS NULL
       GROUP BY p.id
       ORDER BY p.position ASC, p.id ASC`
    ),
  };
  return stmts;
}

// Error carrying an HTTP status for routes to pass through
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
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
  createSession(name, pinHash = null, courtCount = 1, gameDate = null) {
    const s = prepareStatements();
    const count = Math.max(1, Math.min(courtCount, 20));
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

  // Active sessions for the dashboard, with player counts and capacity, in one
  // query. Keeps sessions dated up to a day back: the server runs in UTC, so
  // "today" on the host's phone can be yesterday here. The client filters exactly.
  getActiveSessionSummaries() {
    const rows = db.prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM players p WHERE p.session_id = s.id AND p.removed_at IS NULL) AS playerCount,
              (SELECT COUNT(*) FROM courts c WHERE c.session_id = s.id AND c.status = 'active') AS activeCourts
       FROM sessions s
       WHERE s.status = 'active' AND (s.game_date IS NULL OR s.game_date >= date('now', '-1 day'))
       ORDER BY s.created_at DESC`
    ).all();
    return rows.map(({ pin_hash, activeCourts, ...rest }) => ({
      ...rest,
      hasPin: !!pin_hash,
      maxPlayers: activeCourts * PLAYERS_PER_COURT_CAPACITY,
    }));
  },

  // Throws unless the session exists and is still active. Returns the session.
  assertActive(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) throw httpError(404, 'Session not found');
    if (session.status === 'ended') throw httpError(400, 'Session has ended');
    return session;
  },

  // End a session: clear all courts and take players off them, then mark ended
  endSession(sessionId) {
    const s = prepareStatements();
    db.transaction(() => {
      // match_players rows for courts_in_use cascade on delete
      db.prepare('DELETE FROM courts_in_use WHERE session_id = ?').run(sessionId);
      db.prepare("UPDATE players SET status = 'rested' WHERE session_id = ? AND status = 'playing'").run(sessionId);
      s.endSession.run('ended', Date.now(), sessionId);
    })();
    this.broadcastSessionState(sessionId);
  },

  // Update session mix mode ('grouped' or 'open_mix')
  setMixMode(sessionId, mixMode) {
    const valid = ['grouped', 'open_mix'];
    if (!valid.includes(mixMode)) throw new Error('Invalid mix mode');
    this.assertActive(sessionId);
    db.prepare('UPDATE sessions SET mix_mode = ? WHERE id = ?').run(mixMode, sessionId);
    this.broadcastSessionState(sessionId);
  },

  // ===== PLAYER ROSTER MANAGEMENT =====
  importPlayerRoster(sessionId, players) {
    if (!players || players.length === 0) return 0;
    this.assertActive(sessionId);

    const s = prepareStatements();
    const now = Date.now();
    const insertMany = db.transaction((playerList) => {
      const startPos = s.nextPlayerPosition.get(sessionId).pos;
      for (let i = 0; i < playerList.length; i++) {
        const p = playerList[i];
        s.insertPlayer.run(sessionId, p.name, p.skill_level, 'waiting', startPos + i, now);
      }
    });

    insertMany(players);
    this.tryAutoAllocate(sessionId);
    this.broadcastSessionState(sessionId);
    return players.length;
  },

  getSessionPlayers(sessionId) {
    const s = prepareStatements();
    return s.getSessionPlayers.all(sessionId);
  },

  // Self-registration: player joins via QR code / link
  // arrived_at is left NULL — player is RSVP'd but not yet present
  // They become queue-eligible only after checking in via Arrival QR
  registerPlayer(sessionId, name, skillLevel, mixPreference) {
    this.assertActive(sessionId);
    const s = prepareStatements();
    const nextPos = s.nextPlayerPosition.get(sessionId).pos;
    const result = s.insertPlayer.run(sessionId, name, skillLevel, 'waiting', nextPos, null);
    const playerId = result.lastInsertRowid;
    // Set mix preference if provided
    if (mixPreference && ['same_level', 'mix_me_in'].includes(mixPreference)) {
      db.prepare('UPDATE players SET mix_preference = ? WHERE id = ?').run(mixPreference, playerId);
    }
    this.broadcastSessionState(sessionId);
    return playerId;
  },

  // Check-in: update arrived_at timestamp (Arrival QR at venue)
  // Returns arrival position and stats for the arrival page
  checkInPlayer(playerId, sessionId) {
    this.assertActive(sessionId);
    const player = prepareStatements().getPlayer.get(playerId, sessionId);
    if (!player) throw httpError(404, 'Player not found in this session');

    const allPlayers = this.getSessionPlayers(sessionId);
    const totalRsvp = allPlayers.length;
    const alreadyCheckedIn = player.arrived_at != null;

    if (!alreadyCheckedIn) {
      db.prepare('UPDATE players SET arrived_at = ? WHERE id = ?').run(Date.now(), playerId);
    }

    // Count arrived players and determine arrival order
    const arrivedPlayers = allPlayers
      .filter(p => p.arrived_at != null || p.id === playerId)
      .sort((a, b) => (a.arrived_at || Infinity) - (b.arrived_at || Infinity));
    const arrivalPosition = arrivedPlayers.findIndex(p => p.id === playerId) + 1;
    const totalArrived = arrivedPlayers.length;

    // Early birds: first 3 arrivals
    const earlyBirds = arrivedPlayers.slice(0, 3).map((p, i) => ({
      name: p.name,
      badge: ['🥇', '🥈', '🥉'][i],
      position: i + 1,
    }));

    this.tryAutoAllocate(sessionId);
    this.broadcastSessionState(sessionId);

    return {
      alreadyCheckedIn,
      arrivalPosition,
      totalArrived,
      totalRsvp,
      earlyBirds,
      playerName: player.name,
    };
  },

  // Get players with W/L records and games played (for queue display)
  getPlayersWithStats(sessionId) {
    const s = prepareStatements();
    return s.getPlayerWL.all(sessionId);
  },

  getPlayer(playerId, sessionId) {
    return prepareStatements().getPlayer.get(playerId, sessionId) || null;
  },

  updatePlayerSkill(playerId, sessionId, skillLevel) {
    this.assertActive(sessionId);
    const s = prepareStatements();
    const result = s.updatePlayerSkill.run(skillLevel, playerId, sessionId);
    if (result.changes === 0) throw httpError(404, 'Player not found in this session');
    this.broadcastSessionState(sessionId);
  },

  // Set player status with validation
  setPlayerStatus(playerId, sessionId, newStatus) {
    if (!VALID_STATUSES.includes(newStatus)) {
      throw new Error(`Invalid status: ${newStatus}`);
    }
    this.assertActive(sessionId);
    const player = this.getPlayer(playerId, sessionId);
    if (!player) throw httpError(404, 'Player not found in this session');
    // A player on court stays in match_players until the match ends; changing
    // their status here would leave them on court and in the queue at once.
    if (player.status === 'playing') {
      throw new Error('Cannot change status of a player currently on court. End or cancel the match first.');
    }
    if (newStatus === 'playing') {
      throw new Error('Players are put on court by allocation, not by status change');
    }

    const s = prepareStatements();
    s.updatePlayerStatus.run(newStatus, playerId);

    // Track break timestamp
    if (newStatus === 'break') {
      db.prepare('UPDATE players SET break_at = ? WHERE id = ?').run(Date.now(), playerId);
    } else if (player.status === 'break') {
      // Clearing break — reset break_at
      db.prepare('UPDATE players SET break_at = NULL WHERE id = ?').run(playerId);
    }

    // Any status change can make an idle court fillable: a player returning
    // completes a four, or a missing player marked absent after a cancel
    this.tryAutoAllocate(sessionId);
    this.broadcastSessionState(sessionId);
  },

  removePlayer(playerId, sessionId) {
    this.assertActive(sessionId);
    const player = this.getPlayer(playerId, sessionId);
    if (!player) throw httpError(404, 'Player not found in this session');
    if (player.status === 'playing') {
      throw new Error('Cannot remove a player who is currently playing');
    }
    // Soft delete: a hard delete would cascade and erase them from match history
    db.prepare('UPDATE players SET removed_at = ? WHERE id = ? AND session_id = ?').run(Date.now(), playerId, sessionId);
    this.broadcastSessionState(sessionId);
  },

  // ===== COURT ALLOCATION & QUEUEING =====
  getSessionCourts(sessionId) {
    const s = prepareStatements();
    return s.getSessionCourts.all(sessionId, 'active');
  },

  // Add a court to a session (host adjusts court count up)
  addCourt(sessionId) {
    this.assertActive(sessionId);
    const s = prepareStatements();
    const existing = s.getSessionCourts.all(sessionId, 'active');
    if (existing.length >= 20) throw new Error('Maximum 20 courts');
    const name = nextCourtName(existing.map(c => c.name));
    const result = s.createCourt.run(name, uuidv4(), sessionId);
    s.updateSessionCourtCount.run(existing.length + 1, sessionId);
    // A new court may be fillable right away from the waiting queue
    this.tryAutoAllocate(sessionId);
    this.broadcastSessionState(sessionId);
    return result.lastInsertRowid;
  },

  // Remove a court from a session (only if not occupied)
  removeCourt(sessionId, courtId) {
    this.assertActive(sessionId);
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

  // Max players allowed for a session: courts × PLAYERS_PER_COURT_CAPACITY
  getMaxPlayers(sessionId) {
    const courts = this.getSessionCourts(sessionId);
    return courts.length * PLAYERS_PER_COURT_CAPACITY;
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
  // Only players who have arrived (scanned QR / checked in) are eligible
  _getEligiblePlayers(sessionId) {
    const players = this.getSessionPlayers(sessionId);
    const eligible = players.filter((p) => ALLOCATABLE_STATUSES.includes(p.status) && p.arrived_at);

    if (eligible.length === 0) return [];

    // Get games-played counts
    const s = prepareStatements();
    const gameCounts = s.getPlayerGameCounts.all(sessionId);
    const countMap = {};
    for (const row of gameCounts) {
      countMap[row.id] = row.games_played;
    }

    return sortByFairness(eligible, countMap);
  },

  // Smart court allocation based on skill levels + fairness
  autoAllocateCourts(sessionId) {
    this.assertActive(sessionId);
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

  // Internal: plan games for the free courts (see services/allocation.js) and
  // put the players on court. Players are pre-sorted by fairness.
  _assignPlayersToCourts(sessionId, waitingPlayers, courts) {
    const session = this.getSession(sessionId);
    const games = planAssignments(waitingPlayers, courts.length, {
      mixMode: session?.mix_mode || 'grouped',
      playersPerCourt: PLAYERS_PER_COURT,
    });

    return games.map((game, i) => {
      const assignment = { courtId: courts[i].id, courtName: courts[i].name, ...game };
      this.startCourt(sessionId, assignment.courtId, game.teamA, game.teamB);
      this._announceCourt(sessionId, courts[i], game.players);
      return assignment;
    });
  },

  // Tell the room (in-app toast) and the players' phones (push) who's up
  _announceCourt(sessionId, court, players) {
    io.to(`session:${sessionId}`).emit(`session:${sessionId}:court-assigned`, {
      courtName: court.name,
      playerNames: players.map(p => p.name),
    });
    const base = process.env.PUBLIC_URL;
    notifyCourtReady(court, players, base ? base.replace(/\/$/, '') + '/session/' + sessionId : null);
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

  // Undo an assignment that hasn't started (e.g. someone isn't there).
  // Players go back to the queue without a game counted, and the court is
  // left empty so the same four aren't immediately reassigned; the host marks
  // whoever is missing, which triggers allocation again.
  cancelAssignment(sessionId, courtId) {
    this.assertActive(sessionId);
    const s = prepareStatements();
    const courtInUse = s.getCourtInUse.get(sessionId, courtId);
    if (!courtInUse) throw httpError(404, 'No match assigned to this court');
    if (courtInUse.match_started_at) throw new Error('Match already started. End it instead.');

    const playerIds = s.getMatchPlayerIds.all(courtInUse.id).map(r => r.player_id);
    db.transaction(() => {
      if (playerIds.length > 0) {
        const placeholders = playerIds.map(() => '?').join(',');
        db.prepare(`UPDATE players SET status = 'waiting' WHERE id IN (${placeholders})`).run(...playerIds);
      }
      s.deleteCourtInUse.run(courtInUse.id); // match_players rows cascade
    })();
    this.broadcastSessionState(sessionId);
  },

  // Replace one player on a court with someone from the queue (no-show,
  // injury, wrong level). Works before or during a match; the player leaving
  // goes back to the queue with no game counted, the sub takes their team slot.
  swapPlayer(sessionId, courtId, outPlayerId, inPlayerId) {
    this.assertActive(sessionId);
    const s = prepareStatements();
    const courtInUse = s.getCourtInUse.get(sessionId, courtId);
    if (!courtInUse) throw httpError(404, 'No match on this court');

    const onCourt = s.getMatchPlayerIds.all(courtInUse.id).map(r => r.player_id);
    if (!onCourt.includes(Number(outPlayerId))) throw httpError(404, 'That player is not on this court');

    const sub = this.getPlayer(inPlayerId, sessionId);
    if (!sub) throw httpError(404, 'Substitute not found in this session');
    if (!ALLOCATABLE_STATUSES.includes(sub.status) || !sub.arrived_at) {
      throw new Error(`${sub.name} isn't in the queue, so can't be subbed in`);
    }

    db.transaction(() => {
      db.prepare('UPDATE match_players SET player_id = ? WHERE court_in_use_id = ? AND player_id = ?')
        .run(sub.id, courtInUse.id, Number(outPlayerId));
      s.updatePlayerStatus.run('waiting', Number(outPlayerId));
      s.updatePlayerStatus.run('playing', sub.id);
    })();

    const court = this.getSessionCourts(sessionId).find(c => c.id === Number(courtId));
    if (court) this._announceCourt(sessionId, court, [sub]);
    this.broadcastSessionState(sessionId);
  },

  // Begin the match timer on a court (START GAME pressed)
  beginMatch(sessionId, courtId) {
    this.assertActive(sessionId);
    const s = prepareStatements();
    const courtInUse = s.getCourtInUse.get(sessionId, courtId);
    if (!courtInUse) throw new Error('No match assigned to this court');
    if (courtInUse.match_started_at) throw new Error('Match already started');

    db.prepare('UPDATE courts_in_use SET match_started_at = ? WHERE id = ?')
      .run(Date.now(), courtInUse.id);
    this.broadcastSessionState(sessionId);
  },

  endCourt(sessionId, courtId) {
    this.assertActive(sessionId);
    const s = prepareStatements();

    const courtInUse = s.getCourtInUse.get(sessionId, courtId);
    if (!courtInUse) throw new Error('No active match on this court');
    // An unstarted match would count as a game played for all four players
    if (!courtInUse.match_started_at) {
      throw new Error("This match hasn't started. Start it, or cancel the assignment.");
    }

    const playerRows = s.getMatchPlayerIds.all(courtInUse.id);
    const playerIds = playerRows.map(r => r.player_id);
    const durationMs = Date.now() - courtInUse.match_started_at;

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
  // Allowed after the session ends so the host can catch up on scores
  recordScore(sessionId, matchHistoryId, scoreA, scoreB) {
    const s = prepareStatements();
    const result = s.updateMatchScore.run(scoreA, scoreB, matchHistoryId, sessionId);
    if (result.changes === 0) throw httpError(404, 'Match not found in this session');
    this.broadcastSessionState(sessionId);
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

  // Full state snapshot for a session (sent over sockets)
  getSessionState(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const { pin_hash, ...publicSession } = session;
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

    return {
      session: { ...publicSession, hasPin: !!pin_hash },
      players: playersWithStats,
      courts: courtsStatus,
      config: {
        playersPerCourt: PLAYERS_PER_COURT,
        playersPerCourtCapacity: PLAYERS_PER_COURT_CAPACITY,
        maxPlayers: courts.length * PLAYERS_PER_COURT_CAPACITY,
      },
    };
  },

  // Push state only to clients in this session's room
  broadcastSessionState(sessionId) {
    try {
      const state = this.getSessionState(sessionId);
      if (!state) return;
      io.to(`session:${sessionId}`).emit(`session:${sessionId}`, state);
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

  // When play actually happened: earliest arrival or match start, to the last
  // match completed (or now if nothing finished yet). Null if nobody arrived.
  getPlaySpan(sessionId) {
    const row = db.prepare(
      `SELECT
         (SELECT MIN(arrived_at) FROM players WHERE session_id = ? AND arrived_at IS NOT NULL) AS firstArrival,
         (SELECT MIN(completed_at - duration_ms) FROM match_history WHERE session_id = ?) AS firstMatch,
         (SELECT MAX(completed_at) FROM match_history WHERE session_id = ?) AS lastMatch`
    ).get(sessionId, sessionId, sessionId);
    const starts = [row.firstArrival, row.firstMatch].filter(v => v != null);
    if (starts.length === 0) return null;
    const start = Math.min(...starts);
    return { start, end: Math.max(start, row.lastMatch || Date.now()) };
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
