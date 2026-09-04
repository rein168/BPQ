const db = require('../db');
const { v4: uuidv4 } = require('uuid');

let io;

const sessionService = {
  init(socketIo) {
    io = socketIo;
  },

  // ===== SESSION MANAGEMENT =====
  async createSession(name) {
    return new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO sessions (name, status) VALUES (?, ?)',
        [name, 'active'],
        function(err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });
  },

  async getSession(sessionId) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM sessions WHERE id = ?',
        [sessionId],
        (err, row) => (err ? reject(err) : resolve(row || null))
      );
    });
  },

  async getAllSessions() {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM sessions ORDER BY created_at DESC',
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });
  },

  async endSession(sessionId) {
    return new Promise((resolve, reject) => {
      db.run(
        'UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?',
        ['ended', Date.now(), sessionId],
        (err) => (err ? reject(err) : resolve())
      );
    });
  },

  // ===== PLAYER ROSTER MANAGEMENT =====
  async importPlayerRoster(sessionId, players) {
    // players: [{ name, skill_level }, ...]
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        let completed = 0;
        const total = players.length;

        players.forEach((player, index) => {
          db.run(
            'INSERT INTO players (session_id, name, skill_level, status, position) VALUES (?, ?, ?, ?, ?)',
            [sessionId, player.name, player.skill_level, 'waiting', index + 1],
            (err) => {
              if (err) {
                db.run('ROLLBACK');
                return reject(err);
              }
              completed++;
              if (completed === total) {
                db.run('COMMIT', (err) => {
                  if (err) return reject(err);
                  this.broadcastSessionState(sessionId);
                  resolve(total);
                });
              }
            }
          );
        });
      });
    });
  },

  async getSessionPlayers(sessionId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM players WHERE session_id = ? ORDER BY position ASC',
        [sessionId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });
  },

  async updatePlayerSkill(playerId, skillLevel) {
    return new Promise((resolve, reject) => {
      db.run(
        'UPDATE players SET skill_level = ? WHERE id = ?',
        [skillLevel, playerId],
        (err) => (err ? reject(err) : resolve())
      );
    });
  },

  async updatePlayerStatus(playerId, status) {
    return new Promise((resolve, reject) => {
      db.run(
        'UPDATE players SET status = ? WHERE id = ?',
        [status, playerId],
        (err) => (err ? reject(err) : resolve())
      );
    });
  },

  // ===== COURT ALLOCATION & QUEUEING =====
  async getAllCourts() {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM courts WHERE status = ? ORDER BY id ASC',
        ['active'],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });
  },

  async createCourt(name) {
    return new Promise((resolve, reject) => {
      const uuid = uuidv4();
      db.run(
        'INSERT INTO courts (name, uuid) VALUES (?, ?)',
        [name, uuid],
        function(err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });
  },

  // Get all courts currently in use for a session
  async getOccupiedCourtIds(sessionId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT DISTINCT court_id FROM courts_in_use WHERE session_id = ?',
        [sessionId],
        (err, rows) => (err ? reject(err) : resolve((rows || []).map(r => r.court_id)))
      );
    });
  },

  // Smart court allocation based on skill levels
  async autoAllocateCourts(sessionId) {
    try {
      const players = await this.getSessionPlayers(sessionId);
      const waitingPlayers = players.filter(p => p.status === 'waiting');

      if (waitingPlayers.length < 4) {
        return { allocated: [], message: 'Not enough players for a game' };
      }

      const allCourts = await this.getAllCourts();
      const occupiedIds = await this.getOccupiedCourtIds(sessionId);
      const courts = allCourts.filter(c => !occupiedIds.includes(c.id));

      if (courts.length === 0) {
        return { allocated: [], message: 'All courts are occupied' };
      }

      const allocated = [];

      // Separate by skill level
      const beginners = waitingPlayers.filter(p => p.skill_level === 'Beginner');
      const intermediate = waitingPlayers.filter(p => p.skill_level === 'Intermediate');

      let courtIndex = 0;
      let gameAssignments = [];

      // Rule 1: Try to group beginners together (4 players = 1 court)
      while (beginners.length >= 4 && courtIndex < courts.length) {
        gameAssignments.push({
          courtId: courts[courtIndex].id,
          players: beginners.splice(0, 4),
          type: 'beginner'
        });
        courtIndex++;
      }

      // Rule 2: Try to group intermediate together
      while (intermediate.length >= 4 && courtIndex < courts.length) {
        gameAssignments.push({
          courtId: courts[courtIndex].id,
          players: intermediate.splice(0, 4),
          type: 'intermediate'
        });
        courtIndex++;
      }

      // Rule 3: Mix remaining players if possible
      const remaining = [...beginners, ...intermediate];
      while (remaining.length >= 4 && courtIndex < courts.length) {
        gameAssignments.push({
          courtId: courts[courtIndex].id,
          players: remaining.splice(0, 4),
          type: 'mixed'
        });
        courtIndex++;
      }

      // Save to courts_in_use and update player status
      for (const assignment of gameAssignments) {
        await this.startCourt(sessionId, assignment.courtId, assignment.players);
        allocated.push(assignment);
      }

      await this.broadcastSessionState(sessionId);
      return { allocated, message: `Allocated ${allocated.length} court(s)` };
    } catch (err) {
      throw err;
    }
  },

  async startCourt(sessionId, courtId, players) {
    return new Promise((resolve, reject) => {
      const playerIds = players.map(p => p.id).join(',');
      
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        
        // Insert into courts_in_use
        db.run(
          'INSERT INTO courts_in_use (session_id, court_id, player_ids, match_started_at) VALUES (?, ?, ?, ?)',
          [sessionId, courtId, playerIds, Date.now()],
          (err) => {
            if (err) {
              db.run('ROLLBACK');
              return reject(err);
            }

            // Update player status to 'playing'
            const placeholders = players.map(() => '?').join(',');
            const playerIdsArray = players.map(p => p.id);
            
            db.run(
              `UPDATE players SET status = ? WHERE id IN (${placeholders})`,
              ['playing', ...playerIdsArray],
              (err) => {
                if (err) {
                  db.run('ROLLBACK');
                  return reject(err);
                }
                db.run('COMMIT', (err) => {
                  if (err) return reject(err);
                  resolve();
                });
              }
            );
          }
        );
      });
    });
  },

  async endCourt(sessionId, courtId) {
    return new Promise((resolve, reject) => {
      // Get the court in use record
      db.get(
        'SELECT * FROM courts_in_use WHERE session_id = ? AND court_id = ? ORDER BY id DESC LIMIT 1',
        [sessionId, courtId],
        (err, courtInUse) => {
          if (err) return reject(err);
          if (!courtInUse) return reject(new Error('No active match on this court'));

          const playerIds = courtInUse.player_ids.split(',').map(Number);
          const durationMs = Date.now() - courtInUse.match_started_at;

          db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            // Add to match history
            db.run(
              'INSERT INTO match_history (session_id, court_id, player_ids, duration_ms) VALUES (?, ?, ?, ?)',
              [sessionId, courtId, courtInUse.player_ids, durationMs],
              (err) => {
                if (err) {
                  db.run('ROLLBACK');
                  return reject(err);
                }

                // Update player status back to 'waiting'
                const placeholders = playerIds.map(() => '?').join(',');
                db.run(
                  `UPDATE players SET status = ? WHERE id IN (${placeholders})`,
                  ['waiting', ...playerIds],
                  (err) => {
                    if (err) {
                      db.run('ROLLBACK');
                      return reject(err);
                    }

                    // Remove from courts_in_use
                    db.run(
                      'DELETE FROM courts_in_use WHERE id = ?',
                      [courtInUse.id],
                      (err) => {
                        if (err) {
                          db.run('ROLLBACK');
                          return reject(err);
                        }
                        db.run('COMMIT', (err) => {
                          if (err) return reject(err);
                          this.broadcastSessionState(sessionId);
                          resolve({ durationMs });
                        });
                      }
                    );
                  }
                );
              }
            );
          });
        }
      );
    });
  },

  async getCourtStatus(sessionId, courtId) {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM courts_in_use WHERE session_id = ? AND court_id = ? ORDER BY id DESC LIMIT 1',
        [sessionId, courtId],
        (err, row) => (err ? reject(err) : resolve(row || null))
      );
    });
  },

  async broadcastSessionState(sessionId) {
    try {
      const session = await this.getSession(sessionId);
      const players = await this.getSessionPlayers(sessionId);
      const courts = await this.getAllCourts();
      
      const courtsStatus = [];
      for (const court of courts) {
        const status = await this.getCourtStatus(sessionId, court.id);
        courtsStatus.push({
          court,
          match: status || null
        });
      }

      io.emit(`session:${sessionId}`, {
        session,
        players,
        courts: courtsStatus
      });
    } catch (err) {
      console.error('Error broadcasting session state:', err);
    }
  },

  async getMatchHistory(sessionId, limit = 50) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM match_history WHERE session_id = ? ORDER BY completed_at DESC LIMIT ?',
        [sessionId, limit],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });
  }
};

module.exports = sessionService;
