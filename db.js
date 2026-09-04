const Database = require("better-sqlite3");
const path = require("path");
const dbPath = path.join(__dirname, "bpq.db");

const db = new Database(dbPath);
console.log('Connected to SQLite database.');

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ========== TABLE: courts ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS courts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    uuid TEXT UNIQUE,
    status TEXT DEFAULT 'active',
    created_at INTEGER DEFAULT (strftime('%s','now')*1000)
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_courts_status ON courts(status);');

// ========== TABLE: sessions ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'ended')),
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    ended_at INTEGER
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);');

// ========== TABLE: players ==========
db.exec(`
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
db.exec('CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_players_skill ON players(skill_level);');
db.exec('CREATE INDEX IF NOT EXISTS idx_players_status ON players(status);');

// ========== TABLE: courts_in_use ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS courts_in_use (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL,
    court_id INTEGER NOT NULL,
    match_started_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(court_id) REFERENCES courts(id) ON DELETE RESTRICT
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_courts_in_use_session ON courts_in_use(session_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_courts_in_use_court ON courts_in_use(court_id);');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_courts_in_use_unique ON courts_in_use(session_id, court_id);');

// ========== TABLE: match_players (junction table, replaces CSV player_ids) ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS match_players (
    id INTEGER PRIMARY KEY,
    court_in_use_id INTEGER,
    match_history_id INTEGER,
    player_id INTEGER NOT NULL,
    FOREIGN KEY(court_in_use_id) REFERENCES courts_in_use(id) ON DELETE CASCADE,
    FOREIGN KEY(match_history_id) REFERENCES match_history(id) ON DELETE CASCADE,
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_match_players_court ON match_players(court_in_use_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_match_players_history ON match_players(match_history_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_match_players_player ON match_players(player_id);');

// ========== TABLE: match_history ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS match_history (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL,
    court_id INTEGER,
    duration_ms INTEGER,
    completed_at INTEGER DEFAULT (strftime('%s','now')*1000),
    notes TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(court_id) REFERENCES courts(id) ON DELETE SET NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_match_history_session ON match_history(session_id);');

// ========== Migration: drop old player_ids column if it exists ==========
// SQLite doesn't support DROP COLUMN before 3.35.0, so we check and leave
// the old column in place if present — new code uses the junction table.

module.exports = db;
