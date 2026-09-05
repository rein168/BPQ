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
    name TEXT NOT NULL,
    uuid TEXT UNIQUE,
    session_id INTEGER,
    status TEXT DEFAULT 'active',
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_courts_status ON courts(status);');
// idx_courts_session created after migrations (column may not exist on old DBs)

// ========== TABLE: sessions ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    pin_hash TEXT,
    court_count INTEGER DEFAULT 4,
    game_date TEXT,
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
    skill_level TEXT NOT NULL CHECK(skill_level IN ('Beginner', 'Intermediate', 'Advanced')),
    status TEXT DEFAULT 'waiting' CHECK(status IN ('waiting', 'playing', 'rested', 'break', 'skipped', 'absent', 'left_early')),
    position INTEGER,
    arrived_at INTEGER,
    break_at INTEGER,
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
    team TEXT CHECK(team IN ('A', 'B')),
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
    score_a INTEGER,
    score_b INTEGER,
    completed_at INTEGER DEFAULT (strftime('%s','now')*1000),
    notes TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY(court_id) REFERENCES courts(id) ON DELETE SET NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_match_history_session ON match_history(session_id);');

// ========== Migrations (for existing databases) ==========
const migrations = [
  // Phase 4: PIN auth
  'ALTER TABLE sessions ADD COLUMN pin_hash TEXT',
  // Phase 6: Player states + arrival
  'ALTER TABLE players ADD COLUMN arrived_at INTEGER',
  // Phase 6: Team assignment on match_players
  "ALTER TABLE match_players ADD COLUMN team TEXT CHECK(team IN ('A', 'B'))",
  // Phase 6: Score columns on match_history
  'ALTER TABLE match_history ADD COLUMN score_a INTEGER',
  'ALTER TABLE match_history ADD COLUMN score_b INTEGER',
  // Phase 7: Per-game courts
  'ALTER TABLE courts ADD COLUMN session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE',
  'ALTER TABLE sessions ADD COLUMN court_count INTEGER DEFAULT 4',
  // Phase 8: Game date
  'ALTER TABLE sessions ADD COLUMN game_date TEXT',
  // Phase 9: Break timestamp
  'ALTER TABLE players ADD COLUMN break_at INTEGER',
  // Phase 10: Skill mix preferences
  "ALTER TABLE sessions ADD COLUMN mix_mode TEXT DEFAULT 'grouped'",
  "ALTER TABLE players ADD COLUMN mix_preference TEXT DEFAULT 'same_level'",
];

for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch {
    // Column/constraint already exists — ignore
  }
}

// Post-migration indexes (columns added by migrations above)
try { db.exec('CREATE INDEX IF NOT EXISTS idx_courts_session ON courts(session_id);'); } catch { /* column may not exist */ }

// Migrate player status CHECK constraint for existing DBs
// SQLite doesn't support ALTER CHECK, but new rows will fail if not in the list.
// The CREATE TABLE IF NOT EXISTS above handles fresh DBs. For existing DBs,
// we accept that SQLite doesn't enforce CHECK on existing rows and the app
// validates status values at the service layer.

// R2 backup: mark DB dirty after any write.
// The r2Backup module is loaded lazily to avoid circular deps.
let _markDirty = null;
function notifyWrite() {
  if (!_markDirty) {
    try { _markDirty = require('./services/r2Backup').markDirty; } catch { _markDirty = () => {}; }
  }
  _markDirty();
}

// Wrap db.exec to detect write statements
const origExec = db.exec.bind(db);
db.exec = function(sql) {
  const result = origExec(sql);
  // Only mark dirty for DML/DDL, not reads or pragmas
  if (/^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i.test(sql)) {
    notifyWrite();
  }
  return result;
};

// Wrap db.prepare to intercept .run() on write statements
const origPrepare = db.prepare.bind(db);
db.prepare = function(sql) {
  const stmt = origPrepare(sql);
  if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
    const origRun = stmt.run.bind(stmt);
    stmt.run = function(...args) {
      const result = origRun(...args);
      notifyWrite();
      return result;
    };
  }
  return stmt;
};

module.exports = db;
