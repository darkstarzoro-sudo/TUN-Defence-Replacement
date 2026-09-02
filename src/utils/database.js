// ============================================================
// src/utils/database.js
// Uses sql.js — pure JavaScript SQLite, no compilation needed
// ============================================================

const path = require('path');
const fs = require('fs');
const logger = require('./logger');

// On Railway, RAILWAY_VOLUME_MOUNT_PATH tells us exactly where the attached
// volume is mounted. Using it directly (instead of a hardcoded '../../data')
// avoids a mismatch if the volume's configured mount path differs from what
// the code assumes — which would otherwise silently write the database to
// the container's non-persistent local disk instead of the actual volume.
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'bot.db')
  : path.join(__dirname, '../../data/bot.db');

let db;
let sqlJs;

async function connectDatabase() {
  // Create /data folder if it doesn't exist
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Load sql.js (pure JavaScript, no compilation needed)
  const initSqlJs = require('sql.js');
  sqlJs = await initSqlJs();

  // Load existing database file if it exists, otherwise create new
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new sqlJs.Database(fileBuffer);
    logger.info('Loaded existing database from disk');
  } else {
    db = new sqlJs.Database();
    logger.info('Created new database');
  }

  // Create all tables
  createTables();

  // Save database to disk now, and every 30 seconds automatically
  saveDatabase();
  setInterval(saveDatabase, 30000);

  addPhase6Tables();
  addPhase7Tables();
  addPhase9Tables();
  addPhase10Tables();
  addPhase12Tables();
  addNationLinksTable();
  addSpyTables();
  addDnrTable();
  addWarRoomTables();
  logger.info(`Database ready at: ${DB_PATH}`);
}

// Save the in-memory database to the .db file on disk
function saveDatabase() {
  try {
    if (!db) return;
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (err) {
    logger.error(`Failed to save database to disk: ${err.message}`);
  }
}

// sql.js throws on a bind parameter that's JavaScript `undefined` (as opposed
// to `null`, which is fine) — often with an error object that doesn't even
// have a proper `.message`, which is why some past errors logged as blank.
// This converts any stray `undefined` (e.g. from an unlinked Discord user,
// a missing lookup result, etc.) to `null` before it ever reaches sql.js.
function sanitizeParams(params) {
  return params.map(p => p === undefined ? null : p);
}

function describeError(error) {
  if (error && error.message) return error.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

// Run a SELECT query — returns { rows: [...] }
function query(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(sanitizeParams(params));
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return { rows };
  } catch (error) {
    logger.error(`DB query error: ${describeError(error)}`);
    logger.error(`SQL: ${sql}`);
    throw error;
  }
}

// Run INSERT / UPDATE / DELETE
function run(sql, params = []) {
  try {
    db.run(sql, sanitizeParams(params));
    saveDatabase(); // Save after every write
  } catch (error) {
    logger.error(`DB run error: ${describeError(error)}`);
    logger.error(`SQL: ${sql}`);
    throw error;
  }
}

// Get a single row
function queryOne(sql, params = []) {
  const result = query(sql, params);
  return result.rows[0] || null;
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS guilds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT UNIQUE NOT NULL,
      alliance_id INTEGER,
      alliance_name TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS guild_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      role_type TEXT NOT NULL,
      discord_role_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(guild_id, role_type)
    );

    CREATE TABLE IF NOT EXISTS guild_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      discord_channel_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(guild_id, channel_type)
    );

    CREATE TABLE IF NOT EXISTS alert_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      setting_key TEXT NOT NULL,
      setting_value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(guild_id, alert_type, setting_key)
    );

    CREATE TABLE IF NOT EXISTS nation_watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      nation_id INTEGER NOT NULL,
      nation_name TEXT,
      added_by TEXT,
      priority_level TEXT DEFAULT 'normal',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(guild_id, nation_id)
    );

    CREATE TABLE IF NOT EXISTS alliance_watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      alliance_id INTEGER NOT NULL,
      alliance_name TEXT,
      watchlist_type TEXT DEFAULT 'enemy',
      added_by TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(guild_id, alliance_id)
    );

    CREATE TABLE IF NOT EXISTS military_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nation_id INTEGER NOT NULL,
      soldiers INTEGER DEFAULT 0,
      tanks INTEGER DEFAULT 0,
      aircraft INTEGER DEFAULT 0,
      ships INTEGER DEFAULT 0,
      missiles INTEGER DEFAULT 0,
      nukes INTEGER DEFAULT 0,
      score REAL,
      recorded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS target_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      target_nation_id INTEGER NOT NULL,
      target_nation_name TEXT,
      assigned_to_discord_id TEXT,
      assigned_by_discord_id TEXT,
      status TEXT DEFAULT 'assigned',
      priority TEXT DEFAULT 'normal',
      notes TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS target_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      nation_id INTEGER NOT NULL,
      reserved_by TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(guild_id, nation_id)
    );

    CREATE TABLE IF NOT EXISTS beige_alerts_sent (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      nation_id INTEGER NOT NULL,
      alert_interval INTEGER NOT NULL,
      sent_at TEXT DEFAULT (datetime('now')),
      UNIQUE(guild_id, nation_id, alert_interval)
    );

    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_by TEXT,
      status TEXT DEFAULT 'planning',
      start_time TEXT,
      end_time TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT,
      action_type TEXT NOT NULL,
      performed_by TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_alert_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      dm_enabled INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(guild_id, discord_user_id, alert_type)
    );
  `);

  logger.info('All database tables ready');
}

function addWarRoomTables() {
  if (!db) return;
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS war_rooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        enemy_nation_id INTEGER NOT NULL, enemy_nation_name TEXT,
        enemy_alliance_name TEXT, director_discord_id TEXT,
        card_message_id TEXT, status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(guild_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS war_room_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        war_room_id INTEGER NOT NULL, discord_user_id TEXT,
        nation_id INTEGER, nation_name TEXT, war_id INTEGER,
        joined_at TEXT DEFAULT (datetime('now')),
        UNIQUE(war_room_id, war_id)
      );
    `);
  } catch (err) {}
  migrateWarRoomMembersUnique();
}

// One-time migration for databases created before this fix: the old
// UNIQUE(war_room_id, nation_id) constraint silently blocked a member from
// ever being tracked again if they started a NEW, separate war against the
// same enemy later on (their row already "existed" from the old war, so the
// INSERT OR IGNORE for the new war_id did nothing) — no card, no attack
// reports, for that member's new war. SQLite can't alter a UNIQUE constraint
// in place, so this recreates the table with the corrected constraint and
// copies existing rows over. Safe to run every startup — it's a no-op once
// already migrated (detected via the marker table below).
function migrateWarRoomMembersUnique() {
  if (!db) return;
  try {
    const alreadyDone = db.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='war_room_members_migrated_v2'`);
    if (alreadyDone.length > 0 && alreadyDone[0].values.length > 0) return;

    db.run(`
      CREATE TABLE IF NOT EXISTS war_room_members_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        war_room_id INTEGER NOT NULL, discord_user_id TEXT,
        nation_id INTEGER, nation_name TEXT, war_id INTEGER,
        joined_at TEXT DEFAULT (datetime('now')),
        UNIQUE(war_room_id, war_id)
      );
      INSERT OR IGNORE INTO war_room_members_new (id,war_room_id,discord_user_id,nation_id,nation_name,war_id,joined_at)
        SELECT id,war_room_id,discord_user_id,nation_id,nation_name,war_id,joined_at FROM war_room_members;
      DROP TABLE war_room_members;
      ALTER TABLE war_room_members_new RENAME TO war_room_members;
      CREATE TABLE war_room_members_migrated_v2 (done INTEGER);
    `);
    saveDatabase();
  } catch (err) {
    logger.error(`migrateWarRoomMembersUnique: ${err.message}`);
  }
}

module.exports = { connectDatabase, query, run, queryOne, saveDatabase, addPhase6Tables, addPhase7Tables, addPhase9Tables, addPhase10Tables, addPhase12Tables, addNationLinksTable, addSpyTables, addDnrTable };

// NOTE: This function is appended — new tables added in Phase 6
// Call addPhase6Tables() from connectDatabase if needed,
// or just add these to the createTables() db.run block above.
// The simplest approach: we add them here and call on startup.
function addPhase6Tables() {
  if (!db) return;
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS blitz_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        launch_time TEXT NOT NULL,
        created_by TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS blitz_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        blitz_id INTEGER NOT NULL,
        discord_user_id TEXT NOT NULL,
        status TEXT DEFAULT 'ready',
        responded_at TEXT DEFAULT (datetime('now')),
        UNIQUE(blitz_id, discord_user_id)
      );

      CREATE TABLE IF NOT EXISTS operation_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id INTEGER NOT NULL,
        nation_id INTEGER NOT NULL,
        nation_name TEXT,
        assigned_to TEXT,
        status TEXT DEFAULT 'assigned',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(operation_id, nation_id)
      );
    `);
  } catch (err) {
    // Tables may already exist — that's fine
  }
}


function addPhase7Tables() {
  if (!db) return;
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS participation_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        data TEXT NOT NULL,
        recorded_at TEXT DEFAULT (datetime('now'))
      );
    `);
  } catch (err) { /* already exists */ }
}

function addPhase9Tables() {
  if (!db) return;
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS defense_alerts_sent (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        war_id INTEGER NOT NULL,
        sent_at TEXT DEFAULT (datetime('now')),
        UNIQUE(guild_id, war_id)
      );
    `);
  } catch (err) { /* already exists */ }
}

function addPhase10Tables() {
  if (!db) return;
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS nation_cache (
        nation_id INTEGER PRIMARY KEY,
        nation_name TEXT,
        alliance_name TEXT,
        num_cities INTEGER DEFAULT 0,
        score REAL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  } catch (err) { /* already exists */ }
}

function addPhase12Tables() {
  if (!db) return;
  try {
    // Add war room columns to operations table if they don't exist
    const cols = ['war_room_category_id', 'war_room_main_id', 'war_room_assign_id', 'war_room_intel_id', 'war_room_results_id'];
    for (const col of cols) {
      try {
        db.run(`ALTER TABLE operations ADD COLUMN ${col} TEXT`);
      } catch (e) { /* column already exists */ }
    }

    // Treaty tracking table
    db.run(`
      CREATE TABLE IF NOT EXISTS treaties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        alliance_id INTEGER NOT NULL,
        alliance_name TEXT,
        treaty_type TEXT NOT NULL,
        notes TEXT,
        added_by TEXT,
        expires_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(guild_id, alliance_id, treaty_type)
      );
    `);
  } catch (err) { /* already exists */ }
}

function addNationLinksTable() {
  if (!db) return;
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS nation_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        nation_id INTEGER NOT NULL,
        nation_name TEXT NOT NULL,
        alliance_id INTEGER,
        alliance_name TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(guild_id, discord_user_id),
        UNIQUE(guild_id, nation_id)
      );
    `);
  } catch (err) { /* already exists */ }
}

function addSpyTables() {
  if (!db) return;
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS spy_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        nation_id INTEGER NOT NULL,
        nation_name TEXT,
        soldiers INTEGER DEFAULT 0,
        tanks INTEGER DEFAULT 0,
        aircraft INTEGER DEFAULT 0,
        ships INTEGER DEFAULT 0,
        missiles INTEGER DEFAULT 0,
        nukes INTEGER DEFAULT 0,
        spies INTEGER DEFAULT 0,
        recorded_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_spy_snapshots_guild_nation
        ON spy_snapshots(guild_id, nation_id);
    `);
  } catch (err) { /* already exists */ }
}

function addDnrTable() {
  if (!db) return;
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS dnr_list (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        alliance_id INTEGER NOT NULL,
        alliance_name TEXT NOT NULL,
        reason TEXT,
        added_by TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(guild_id, alliance_id)
      );
    `);
  } catch (err) { /* already exists */ }
}
