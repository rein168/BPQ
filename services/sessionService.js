const db = require('../db');
const { v4: uuidv4 } = require('uuid');

let io;

// Configurable court capacity: 4 for doubles (default), 2 for singles
const PLAYERS_PER_COURT = parseInt(process.env.PLAYERS_PER_COURT, 10) || 4;

// Prepared statements (lazy-initialized after db is ready)
let stmts = null;

function prepareStatements() {
  if (stmts) return stmts;
  stmts = {
    // Sessions
    createSession: db.prepare('INSERT INTO sessions (name, pin_hash, status) VALUES (?, ?, ?)'),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    getAllSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at DESC'),
    endSession: db.prepare('UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?'),

    // Players
    insertPlayer: db.prepare(
      'INSERT INTO players (session_id, name, skill_level, status, position) VALUES (?, ?, ?, ?, ?)'
    ),
    getSessionPlayers: db.prepare('SELECT * FROM players WHERE session_id = ? ORDER BY position ASC'),
    updatePlayerSkill: db.prepare('UPDATE players SET skill_level = ? WHERE id = ?'),
    updatePlayerStatus: db.prepare('UPDATE players SET status = ? WHERE id = ?'),
    updatePlayersPlaying: null, // built dynamically per-call

    // Courts
    getAllCourts: db.prepare("SELECT * FROM courts WHERE status = ? ORDER BY id ASC"),
    createCourt: db.prepare('INSERT INTO courts (name, uuid) VALUES (?, ?)'),

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
      'INSERT INTO match_players (court_in_use_id, player_id) VALUES (?, ?)'
    ),
    getMatchPlayerIds: db.prepare(
      'SELECT player_id FROM match_players WHERE court_in_use_id = ?'
    ),
    insertHistoryMatchPlayer: db.prepare(
      'INSERT INTO match_players (match_history_id, player_id) VALUES (?, ?)'
    ),

    // Match history
    insertMatchHistory: db.prepare(
      'INSERT INTO match_history (session_id, court_id, duration_ms) VALUES (?, ?, ?)'
    ),
    getMatchHistory: db.prepare(
      'SELECT * FROM match_history WHERE session_id = ? ORDER BY completed_at DESC LIMIT ?'
    ),
    getMatchHistoryPlayers: db.prepare(
      'SELECT mp.match_history_id, mp.player_id, p.name, p.skill_level FROM match_players mp JOIN players p ON p.id = mp.player_id WHERE mp.match_history_id = ?'
    ),
  };
  return stmts;
}

const sessionService = {
  init(socketIo) {
    io = socketIo;
    prepareStatements();
  },

  // ===== SESSION MANAGEMENT =====
  createSession(name, pinHash = null) {
    const s = prepareStatements();
    const result = s.createSession.run(name, pinHash, 'active');
    return result.lastInsertRowid;
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
    const insertMany = db.transaction((playerList) => {
      for (let i = 0; i < playerList.length; i++) {
        const p = playerList[i];
        s.insertPlayer.run(sessionId, p.name, p.skill_level, 'waiting', i + 1);
      }
    });

    insertMany(players);
    this.broadcastSessionState(sessionId);
    return players.length;
  },

  getSessionPlayers(sessionId) {
    const s = prepareStatements();
    return s.getSessionPlayers.all(sessionId);
  },

  updatePlayerSkill(playerId, skillLevel) {
    const s = prepareStatements();
    s.updatePlayerSkill.run(skillLevel, playerId);
  },

  updatePlayerStatus(playerId, status) {
    const s = prepareStatements();
    s.updatePlayerStatus.run(status, playerId);
  },

  removePlayer(playerId, sessionId) {
    // Only remove if player is waiting (not mid-match)
    const player = db.prepare('SELECT * FROM players WHERE id = ? AND session_id = ?').get(playerId, sessionId);
    if (!player) throw new Error('Player not found in this session');
    if (player.status === 'playing') {
      throw new Error('Cannot remove a player who is currently playing');
    }
    db.prepare('DELETE FROM players WHERE id = ? AND session_id = ?').run(playerId, sessionId);
    this.broadcastSessionState(sessionId);
  },

  // ===== COURT ALLOCATION & QUEUEING =====
  getAllCourts() {
    const s = prepareStatements();
    return s.getAllCourts.all('active');
  },

  createCourt(name) {
    const s = prepareStatements();
    const uuid = uuidv4();
    const result = s.createCourt.run(name, uuid);
    return result.lastInsertRowid;
  },

  getOccupiedCourtIds(sessionId) {
    const s = prepareStatements();
    return s.getOccupiedCourtIds.all(sessionId).map(r => r.court_id);
  },

  // Smart court allocation based on skill levels
  autoAllocateCourts(sessionId) {
    const players = this.getSessionPlayers(sessionId);
    const waitingPlayers = players.filter(p => p.status === 'waiting');

    if (waitingPlayers.length < PLAYERS_PER_COURT) {
      return { allocated: [], message: 'Not enough players for a game' };
    }

    const allCourts = this.getAllCourts();
    const occupiedIds = this.getOccupiedCourtIds(sessionId);
    const courts = allCourts.filter(c => !occupiedIds.includes(c.id));

    if (courts.length === 0) {
      return { allocated: [], message: 'All courts are occupied' };
    }

    const allocated = this._assignPlayersToCourts(sessionId, waitingPlayers, courts);

    this.broadcastSessionState(sessionId);
    return { allocated, message: `Allocated ${allocated.length} court(s)` };
  },

  // Fill a single specific court with the next waiting players (used by auto-allocate on court-free)
  autoFillCourt(sessionId, courtId) {
    const players = this.getSessionPlayers(sessionId);
    const waitingPlayers = players.filter(p => p.status === 'waiting');

    if (waitingPlayers.length < PLAYERS_PER_COURT) {
      return null;
    }

    const court = this.getAllCourts().find(c => c.id === Number(courtId));
    if (!court) return null;

    // Check court isn't already occupied
    const occupiedIds = this.getOccupiedCourtIds(sessionId);
    if (occupiedIds.includes(Number(courtId))) return null;

    const allocated = this._assignPlayersToCourts(sessionId, waitingPlayers, [court]);
    return allocated.length > 0 ? allocated[0] : null;
  },

  // Internal: assign waiting players to a list of available courts by skill grouping
  _assignPlayersToCourts(sessionId, waitingPlayers, courts) {
    // Separate by skill level
    const beginners = waitingPlayers.filter(p => p.skill_level === 'Beginner');
    const intermediate = waitingPlayers.filter(p => p.skill_level === 'Intermediate');

    let courtIndex = 0;
    const gameAssignments = [];

    // Rule 1: Try to group beginners together
    while (beginners.length >= PLAYERS_PER_COURT && courtIndex < courts.length) {
      gameAssignments.push({
        courtId: courts[courtIndex].id,
        courtName: courts[courtIndex].name,
        players: beginners.splice(0, PLAYERS_PER_COURT),
        type: 'beginner',
      });
      courtIndex++;
    }

    // Rule 2: Try to group intermediate together
    while (intermediate.length >= PLAYERS_PER_COURT && courtIndex < courts.length) {
      gameAssignments.push({
        courtId: courts[courtIndex].id,
        courtName: courts[courtIndex].name,
        players: intermediate.splice(0, PLAYERS_PER_COURT),
        type: 'intermediate',
      });
      courtIndex++;
    }

    // Rule 3: Mix remaining players if possible
    const remaining = [...beginners, ...intermediate];
    while (remaining.length >= PLAYERS_PER_COURT && courtIndex < courts.length) {
      gameAssignments.push({
        courtId: courts[courtIndex].id,
        courtName: courts[courtIndex].name,
        players: remaining.splice(0, PLAYERS_PER_COURT),
        type: 'mixed',
      });
      courtIndex++;
    }

    // Save to courts_in_use and update player status
    const allocated = [];
    for (const assignment of gameAssignments) {
      this.startCourt(sessionId, assignment.courtId, assignment.players);
      allocated.push(assignment);
    }

    return allocated;
  },

  startCourt(sessionId, courtId, players) {
    const s = prepareStatements();

    const startMatch = db.transaction(() => {
      // Insert into courts_in_use
      const result = s.insertCourtInUse.run(sessionId, courtId, Date.now());
      const courtInUseId = result.lastInsertRowid;

      // Insert players into junction table
      for (const player of players) {
        s.insertMatchPlayer.run(courtInUseId, player.id);
      }

      // Update player status to 'playing'
      const placeholders = players.map(() => '?').join(',');
      const playerIds = players.map(p => p.id);
      db.prepare(`UPDATE players SET status = 'playing' WHERE id IN (${placeholders})`).run(...playerIds);
    });

    startMatch();
  },

  endCourt(sessionId, courtId) {
    const s = prepareStatements();

    const courtInUse = s.getCourtInUse.get(sessionId, courtId);
    if (!courtInUse) throw new Error('No active match on this court');

    const playerRows = s.getMatchPlayerIds.all(courtInUse.id);
    const playerIds = playerRows.map(r => r.player_id);
    const durationMs = Date.now() - courtInUse.match_started_at;

    const finishMatch = db.transaction(() => {
      // Add to match history
      const historyResult = s.insertMatchHistory.run(sessionId, courtId, durationMs);
      const historyId = historyResult.lastInsertRowid;

      // Copy players to history junction
      for (const pid of playerIds) {
        s.insertHistoryMatchPlayer.run(historyId, pid);
      }

      // Update player status back to 'waiting'
      if (playerIds.length > 0) {
        const placeholders = playerIds.map(() => '?').join(',');
        db.prepare(`UPDATE players SET status = 'waiting' WHERE id IN (${placeholders})`).run(...playerIds);
      }

      // Remove from courts_in_use (cascade removes match_players rows)
      s.deleteCourtInUse.run(courtInUse.id);
    });

    finishMatch();

    // Auto-fill the freed court with next waiting players
    const autoFilled = this.autoFillCourt(sessionId, courtId);

    this.broadcastSessionState(sessionId);

    // Emit court-assignment notification so players know where to go
    if (autoFilled && io) {
      io.emit(`session:${sessionId}:court-assigned`, {
        courtName: autoFilled.courtName,
        courtId: autoFilled.courtId,
        playerNames: autoFilled.players.map(p => p.name),
        type: autoFilled.type,
      });
    }

    return { durationMs, autoFilled };
  },

  getCourtStatus(sessionId, courtId) {
    const s = prepareStatements();
    const courtInUse = s.getCourtInUse.get(sessionId, courtId);
    if (!courtInUse) return null;

    // Attach player_ids as CSV for backward compatibility with frontend
    const playerRows = s.getMatchPlayerIds.all(courtInUse.id);
    courtInUse.player_ids = playerRows.map(r => r.player_id).join(',');
    return courtInUse;
  },

  broadcastSessionState(sessionId) {
    try {
      const session = this.getSession(sessionId);
      const players = this.getSessionPlayers(sessionId);
      const courts = this.getAllCourts();

      const courtsStatus = [];
      for (const court of courts) {
        const status = this.getCourtStatus(sessionId, court.id);
        courtsStatus.push({
          court,
          match: status || null
        });
      }

      io.emit(`session:${sessionId}`, {
        session,
        players,
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

    // Attach player info to each match
    for (const match of matches) {
      const playerRows = s.getMatchHistoryPlayers.all(match.id);
      match.player_ids = playerRows.map(r => r.player_id).join(',');
      match.players = playerRows;
    }
    return matches;
  },

  // Session stats: match count, avg duration, per-player match counts
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

    const playerStats = db
      .prepare(
        `SELECT p.id, p.name, p.skill_level, COUNT(mp.id) AS matchCount
         FROM players p
         LEFT JOIN match_players mp ON mp.player_id = p.id AND mp.match_history_id IS NOT NULL
         WHERE p.session_id = ?
         GROUP BY p.id
         ORDER BY matchCount DESC`
      )
      .all(sessionId);

    return { summary, playerStats };
  },
};

module.exports = sessionService;
