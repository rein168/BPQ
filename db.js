const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const dbPath = path.join(__dirname, "bpq.db");

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect to SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

db.serialize(() => {
  // Enable foreign key support
  db.run('PRAGMA foreign_keys = ON;');

  // ========== TABLE: courts ==========
  db.run(`
    CREATE TABLE IF NOT EXISTS courts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      uuid TEXT UNIQUE,
      status TEXT DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s','now')*1000)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_courts_status ON courts(status);');

  // ========== TABLE: players ==========
  // Session-based roster for each day/session
  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      skill_level TEXT NOT NULL CHECK(skill_level IN ('Beginner', 'Intermediate')),
      status TEXT DEFAULT 'waiting' CHECK(status IN ('waiting', 'playing', 'rested')),
      position INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')*1000),
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_id);');
  db.run('CREATE INDEX IF NOT EXISTS idx_players_skill ON players(skill_level);');
  db.run('CREATE INDEX IF NOT EXISTS idx_players_status ON players(status);');

  // ========== TABLE: sessions ==========
  // Represents a day/event of badminton
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'ended')),
      created_at INTEGER DEFAULT (strftime('%s','now')*1000),
      ended_at INTEGER
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);');

  // ========== TABLE: courts_in_use ==========
  // Maps players to courts during active matches
  db.run(`
    CREATE TABLE IF NOT EXISTS courts_in_use (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      court_id INTEGER NOT NULL,
      player_ids TEXT NOT NULL,
      match_started_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')*1000),
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(court_id) REFERENCES courts(id) ON DELETE RESTRICT
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_courts_in_use_session ON courts_in_use(session_id);');
  db.run('CREATE INDEX IF NOT EXISTS idx_courts_in_use_court ON courts_in_use(court_id);');
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_courts_in_use_unique ON courts_in_use(session_id, court_id);');

  // ========== TABLE: match_history ==========
  // Records completed matches
  db.run(`
    CREATE TABLE IF NOT EXISTS match_history (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      court_id INTEGER,
      player_ids TEXT NOT NULL,
      duration_ms INTEGER,
      completed_at INTEGER DEFAULT (strftime('%s','now')*1000),
      notes TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(court_id) REFERENCES courts(id) ON DELETE SET NULL
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_match_history_session ON match_history(session_id);');

});

module.exports = db;
