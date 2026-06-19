import Database from 'better-sqlite3';
import { DB_PATH as RESOLVED_DB_PATH, SYSTEM_CFG_PATH } from '@/util/paths';
import { readMergedSystemConfigSync } from '@/util/systemcfg';
const fs = require('fs');

// DB_PATH / SYSTEM_CFG_PATH now come from the central, env-driven resolver
// (src/util/paths.js) so the Docker image, the Pi, and the desktop bundle all
// agree on where state lives without forking this module. Re-exported here
// because existing callers (e.g. api/system/data.js) import DB_PATH from
// '@/util/sqldb'.
export const DB_PATH = RESOLVED_DB_PATH;

// Cloud Builder plan §3.2/§11: this module must NOT open the database at
// import time. The cloud build (BYH_PROFILE=cloud) imports the data layer
// but never selects the SQLite adapter, and `better-sqlite3` is a native
// addon that would try to open the DB on a serverless/cloud host that has no
// such file. We therefore lazy-init: the connection and the prepared
// statements are built on first use via getDb()/getQueries(), and the SQLite
// repository adapter is the only thing that touches them (behind a dynamic
// import gated on caps.db === 'sqlite'). Local behavior is unchanged — the
// first API request opens + migrates the DB exactly as the old import-time
// path did.

let _db = null;
let _queries = null;

/**
 * Open (and, on first call, migrate/seed) the SQLite database. Memoized for
 * the life of the process. W4b: outside production we attach
 * `verbose: console.log`; in prod that floods logs and leaks query values on
 * a busy show night, so it's omitted.
 */
export function getDb() {
  if (_db) return _db;
  _db = new Database(
    DB_PATH,
    process.env.NODE_ENV === 'production' ? {} : { verbose: console.log },
  );
  initializeDatabase(_db);
  return _db;
}

/**
 * Close the live connection and drop the memoized handle/statements so the
 * next getDb() reopens cleanly. Used by the DB import/restore flow
 * (api/system/data.js), which must release the file before swapping it.
 */
export function closeDb() {
  if (_db) {
    try { _db.close(); } catch { /* already closed */ }
  }
  _db = null;
  _queries = null;
}

/**
 * Legacy DBs used CHECK(type IN ('CAKE_FOUNTAIN', ...)) which blocks new types.
 * SQLite cannot drop a column CHECK; recreate the table without a type enum.
 */
function migrateInventoryRemoveLegacyTypeCheck(db) {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory'`)
    .get();
  if (!row?.sql || !row.sql.includes("type IN ('CAKE_FOUNTAIN'")) {
    return;
  }

  const cols = db.prepare(`PRAGMA table_info(inventory)`).all();
  const colNames = cols.map((c) => c.name);
  const colList = colNames.join(', ');

  console.log('Migrating inventory: removing legacy type IN(...) CHECK constraint...');
  db.exec('PRAGMA foreign_keys = OFF');
  // W4b: this migration runs at module import. The original code had no
  // ROLLBACK, so any failure between BEGIN and COMMIT left the connection
  // wedged mid-transaction (every later query throws "cannot start a
  // transaction within a transaction"). Roll back + re-raise on error so a
  // failed migration surfaces cleanly instead of poisoning the connection.
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE inventory__type_check_migration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        duration REAL,
        fuse_delay REAL,
        lift_delay REAL,
        burn_rate REAL,
        color TEXT,
        available_ct INTEGER DEFAULT 0,
        youtube_link TEXT,
        image TEXT,
        youtube_link_start_sec INTEGER,
        metadata TEXT,
        source TEXT DEFAULT 'user_created',
        unit_cost REAL CHECK(unit_cost IS NULL OR unit_cost >= 0)
      );
    `);
    db.exec(
      `INSERT INTO inventory__type_check_migration (${colList}) SELECT ${colList} FROM inventory`
    );
    db.exec('DROP TABLE inventory');
    db.exec('ALTER TABLE inventory__type_check_migration RENAME TO inventory');
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* nothing in flight */ }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.log('Inventory type CHECK migration finished.');
}

function initializeDatabase(db) {
  const createShowTable = `
    CREATE TABLE IF NOT EXISTS Show (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration INTEGER NOT NULL CHECK(duration >= 0),
      version TEXT NOT NULL,
      runtime_version TEXT NOT NULL,
      display_payload TEXT NOT NULL, -- To hold very large serialized JSON
      runtime_payload TEXT NOT NULL, -- To hold very large serialized JSON
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      authorization_code TEXT NOT NULL,
      protocol TEXT,
      audio_file TEXT, -- To store audio file path and metadata as JSON
      receiver_locations TEXT, -- To store receiver positions as JSON
      receiver_labels TEXT, -- To store receiver labels as JSON
      show_receivers TEXT -- Per-show receiver list as JSON: [{ id, kind: 'native'|'bilusocn', cues, label? }]. Bilusocn entries have no DB receiver row -- the daemon synthesizes 4-cue shadows on stage.
    );
  `;

  const createInventoryTable = `
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      duration REAL CHECK(duration >= 0),
      fuse_delay REAL CHECK(fuse_delay >= 0),
      lift_delay REAL CHECK(lift_delay >= 0),
      burn_rate REAL CHECK(burn_rate >= 0),
      color TEXT,
      available_ct INTEGER DEFAULT 0,
      youtube_link TEXT,
      image TEXT,
      youtube_link_start_sec INTEGER,
      unit_cost REAL CHECK(unit_cost IS NULL OR unit_cost >= 0)
    );
  `;

  const createInventoryFiringProfileTable = `
    CREATE TABLE IF NOT EXISTS inventoryFiringProfile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL,
      youtube_link TEXT NOT NULL,
      youtube_link_start_sec INTEGER NOT NULL,
      shot_timestamps TEXT NOT NULL, -- JSON array of [start_ms, end_ms, color] or [start_ms, end_ms]: [[start1, end1, color1], [start2, end2, color2], ...] where color is optional hex string
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE,
      UNIQUE(inventory_id)
    );
  `;

  const createRacksTable = `
    CREATE TABLE IF NOT EXISTS racks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      show_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      x_rows INTEGER NOT NULL CHECK(x_rows > 0),
      x_spacing REAL NOT NULL CHECK(x_spacing >= 0),
      y_rows INTEGER NOT NULL CHECK(y_rows > 0),
      y_spacing REAL NOT NULL CHECK(y_spacing >= 0),
      cells TEXT NOT NULL, -- JSON: { "x_y": { "shellId": number, "shellNumber": number, "fuseId": string|null } }
      fuses TEXT NOT NULL, -- JSON: { "fuseId": { "type": string, "leadIn": number, "cells": ["x_y", ...] } }
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (show_id) REFERENCES Show(id) ON DELETE CASCADE
    );
  `;

  // Receivers: source of truth for the dongle's poll list. The daemon reads
  // from this table on startup and on reload_receivers commands. The id is
  // the receiver ident (e.g. "RX163"); cues_data and metadata are JSON blobs;
  // configuration_version is bumped on every UPDATE so other components can
  // trivially detect changes.
  //
  // Receiver-reported fields (FW v22+ via the dongle's RECEIVER_CONFIG_RESPONSE):
  //   fw_version       INT    -- nullable until first config response lands
  //   board_version    INT    -- ditto
  //   cues_available   INT    -- physically-usable cues per the receiver's
  //                              own NUM_BOARDS detection. 0 when no boards
  //                              are plugged in. Authoritative; replaces the
  //                              old "operator types a cue count in the UI"
  //                              flow.
  //   config_data      JSON   -- writable per-receiver runtime config:
  //                              { fire_duration_ms?: number, ... }
  //                              The daemon mirrors the latest values it got
  //                              back from the receiver here so they survive
  //                              host restarts.
  const createReceiversTable = `
    CREATE TABLE IF NOT EXISTS Receivers (
      id TEXT PRIMARY KEY NOT NULL,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      cues_data TEXT NOT NULL DEFAULT '{}', -- JSON: { "<zoneName>": [1,2,3,...] }
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      metadata TEXT NOT NULL DEFAULT '{}', -- JSON: any extra fields
      configuration_version INTEGER NOT NULL DEFAULT 1,
      fw_version INTEGER,
      board_version INTEGER,
      cues_available INTEGER,
      config_data TEXT NOT NULL DEFAULT '{}', -- JSON: { fire_duration_ms?: number, ... }
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `;

  try {
    db.exec(createShowTable);
    console.log("Checked/created Show table.");
    
    // Add receiver_labels column if it doesn't exist (migration)
    try {
      db.exec(`ALTER TABLE Show ADD COLUMN receiver_labels TEXT`);
      console.log("Added receiver_labels column to Show table.");
    } catch (err) {
      // Column already exists, ignore error
      if (!err.message.includes('duplicate column name')) {
        console.error("Error adding receiver_labels column:", err.message);
      }
    }

    // Per-show receivers list (JSON). The Show now owns the canonical list of
    // receivers + cue counts it uses; the builder no longer derives the
    // editable target grid from the global Receivers table at edit time. Old
    // shows that pre-date this column have it as NULL and the builder
    // back-fills from items[] + receiver_labels on first edit.
    try {
      db.exec(`ALTER TABLE Show ADD COLUMN show_receivers TEXT`);
      console.log("Added show_receivers column to Show table.");
    } catch (err) {
      if (!err.message.includes('duplicate column name')) {
        console.error("Error adding show_receivers column:", err.message);
      }
    }
    
    db.exec(createInventoryTable);
    console.log("Checked/created inventory table.");
    
    // Add metadata column if it doesn't exist (migration)
    try {
      db.exec(`ALTER TABLE inventory ADD COLUMN metadata TEXT`);
      console.log("Added metadata column to inventory table.");
    } catch (err) {
      // Column already exists, ignore error
      if (!err.message.includes('duplicate column name')) {
        console.error("Error adding metadata column:", err.message);
      }
    }
    
    // Add source column if it doesn't exist (migration)
    try {
      db.exec(`ALTER TABLE inventory ADD COLUMN source TEXT DEFAULT 'user_created'`);
      console.log("Added source column to inventory table.");
      // Update existing records to have source = 'user_created'
      db.exec(`UPDATE inventory SET source = 'user_created' WHERE source IS NULL`);
    } catch (err) {
      // Column already exists, ignore error
      if (!err.message.includes('duplicate column name')) {
        console.error("Error adding source column:", err.message);
      }
    }

    try {
      db.exec(`ALTER TABLE inventory ADD COLUMN unit_cost REAL`);
      console.log("Added unit_cost column to inventory table.");
    } catch (err) {
      if (!err.message.includes('duplicate column name')) {
        console.error("Error adding unit_cost column:", err.message);
      }
    }

    migrateInventoryRemoveLegacyTypeCheck(db);
    
    // Note: Type CHECK constraint removed to allow new types
    // For existing databases with the constraint, it will remain but won't affect new databases
    db.exec(createInventoryFiringProfileTable);
    console.log("Checked/created inventoryFiringProfile table.");
    
    db.exec(createRacksTable);
    console.log("Checked/created racks table.");
    
    // Add show_id column if it doesn't exist (migration)
    try {
      db.exec(`ALTER TABLE racks ADD COLUMN show_id INTEGER`);
      console.log("Added show_id column to racks table.");
    } catch (err) {
      // Column already exists, ignore error
      if (!err.message.includes('duplicate column name')) {
        console.error("Error adding show_id column:", err.message);
      }
    }

    db.exec(createReceiversTable);
    console.log("Checked/created Receivers table.");

    // Migrations for receiver-reported config columns (FW v22+). Wrapped in
    // individual try/catches so an existing column doesn't abort the rest.
    // Schema choices:
    //   * fw_version / board_version / cues_available are nullable -- they
    //     stay NULL until the receiver first answers a CONFIG_QUERY, which
    //     lets the UI distinguish "haven't queried yet" from "really 0".
    //   * config_data defaults to '{}' so the JSON.parse path in
    //     _hydrateReceiverRow can always succeed without a NULL guard.
    for (const sql of [
      `ALTER TABLE Receivers ADD COLUMN fw_version INTEGER`,
      `ALTER TABLE Receivers ADD COLUMN board_version INTEGER`,
      `ALTER TABLE Receivers ADD COLUMN cues_available INTEGER`,
      `ALTER TABLE Receivers ADD COLUMN config_data TEXT NOT NULL DEFAULT '{}'`,
    ]) {
      try {
        db.exec(sql);
        console.log(`Migration applied: ${sql}`);
      } catch (err) {
        if (!err.message.includes('duplicate column name')) {
          console.error(`Receivers migration failed (${sql}):`, err.message);
        }
      }
    }

    seedReceiversFromSystemCfgIfEmpty(db);
  } catch (err) {
    console.error("Error initializing database tables:", err.message);
  }
}

/**
 * Legacy-install migration: when the Receivers table is brand-new (empty)
 * AND systemcfg.json still has a `receivers` block (pre-DB schema), copy
 * each entry into the table so older deployments upgrade transparently.
 *
 * For new installs systemcfg.json no longer contains a `receivers` block,
 * so this function silently no-ops on a fresh DB. The Receivers SQL table
 * is the only source of truth going forward.
 */
function seedReceiversFromSystemCfgIfEmpty(db) {
  try {
    const { count } = db.prepare(`SELECT COUNT(*) AS count FROM Receivers`).get();
    if (count > 0) return;

    if (!fs.existsSync(SYSTEM_CFG_PATH)) {
      console.log(`No ${SYSTEM_CFG_PATH} to seed Receivers from; starting empty.`);
      return;
    }

    // Merged read (base + systemcfg.user.json) for consistency with every
    // other config reader. The legacy `receivers` block only ever lived in
    // the base file, so in practice this resolves the same value as before.
    const cfg = readMergedSystemConfigSync();
    const legacy = cfg && cfg.receivers ? cfg.receivers : {};
    const idents = Object.keys(legacy);
    if (idents.length === 0) {
      console.log("systemcfg.json has no receivers to seed.");
      return;
    }

    const insert = db.prepare(`
      INSERT INTO Receivers (id, label, type, cues_data, enabled, metadata, configuration_version)
      VALUES (?, ?, ?, ?, 1, ?, 1)
    `);
    const seedTx = db.transaction((items) => {
      for (const [ident, def] of items) {
        const label = (def && def.label) ? String(def.label) : ident;
        const type = (def && def.type) ? String(def.type) : 'BKYD_TS_24_1';
        const cues = (def && def.cues) ? def.cues : { [ident]: [] };
        // metadata = anything in the legacy entry that isn't one of the first-class columns
        const meta = {};
        if (def) {
          for (const k of Object.keys(def)) {
            if (k !== 'label' && k !== 'type' && k !== 'cues') meta[k] = def[k];
          }
        }
        insert.run(ident, label, type, JSON.stringify(cues), JSON.stringify(meta));
      }
    });
    seedTx(Object.entries(legacy));
    console.log(`Seeded ${idents.length} receiver(s) from systemcfg.json into the Receivers table.`);
  } catch (err) {
    console.error("Failed to seed Receivers from systemcfg.json:", err.message);
  }
}

/**
 * Build (once) and return all prepared statements + receiver helpers bound to
 * the lazily-opened DB. The SQLite repository adapter (src/data/sqlite) is the
 * sole consumer; the SQL is byte-for-byte the same as the previous
 * import-time exports — only the open is deferred.
 */
export function getQueries() {
  if (_queries) return _queries;
  const db = getDb();

  const showQueries = {
    insert: db.prepare(`INSERT INTO Show (name, duration, version, runtime_version, display_payload, runtime_payload, authorization_code, protocol, audio_file, receiver_locations, receiver_labels, show_receivers)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getAll: db.prepare(`SELECT * FROM Show`),
    update: db.prepare(`UPDATE Show SET name = ?, duration = ?, version = ?, runtime_version = ?, display_payload = ?, runtime_payload = ?, authorization_code = ?, protocol = ?, audio_file = ?, receiver_locations = ?, receiver_labels = ?, show_receivers = ? WHERE id = ?`),
    delete: db.prepare(`DELETE FROM Show WHERE id = ?`), // Delete query
  };

  /** INVENTORY TABLE OPERATIONS */
  const inventoryQueries = {
    insert: db.prepare(`INSERT INTO inventory (name, type, duration, fuse_delay, lift_delay, burn_rate, color, available_ct, youtube_link, youtube_link_start_sec, image, metadata, unit_cost, source)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getAll: db.prepare(`SELECT * FROM inventory`),
    update: db.prepare(`UPDATE inventory SET name = ?, type = ?, duration = ?, fuse_delay = ?, lift_delay = ?, burn_rate = ?, color = ?, available_ct = ?, youtube_link = ?, youtube_link_start_sec = ?, image = ?, metadata = ?, unit_cost = ?, source = ? WHERE id = ?`),
    delete: db.prepare(`DELETE FROM inventory WHERE id = ?`),
  };

  /** FIRING PROFILE TABLE OPERATIONS */
  const firingProfileQueries = {
    getByInventoryId: db.prepare(`SELECT * FROM inventoryFiringProfile WHERE inventory_id = ?`),
    getAll: db.prepare(`SELECT * FROM inventoryFiringProfile`),
    update: db.prepare(`UPDATE inventoryFiringProfile SET shot_timestamps = ? WHERE inventory_id = ?`),
    deleteByInventoryId: db.prepare(`DELETE FROM inventoryFiringProfile WHERE inventory_id = ?`),
  };

  /** RACKS TABLE OPERATIONS */
  const rackQueries = {
    insert: db.prepare(`INSERT INTO racks (show_id, name, x_rows, x_spacing, y_rows, y_spacing, cells, fuses)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    getAll: db.prepare(`SELECT * FROM racks WHERE show_id = ?`),
    getById: db.prepare(`SELECT * FROM racks WHERE id = ?`),
    update: db.prepare(`UPDATE racks SET name = ?, x_rows = ?, x_spacing = ?, y_rows = ?, y_spacing = ?, cells = ?, fuses = ? WHERE id = ?`),
    delete: db.prepare(`DELETE FROM racks WHERE id = ?`),
  };

  /** RECEIVERS TABLE OPERATIONS
   *
   * The Receivers table is the single source of truth for which receivers the
   * dongle should know about. A row's `enabled` flag controls whether the
   * daemon pushes it to the dongle's poll list. `configuration_version` is
   * bumped on every update so the daemon (or any client) can detect changes
   * cheaply.
   *
   * Helper accessors below return rows with `cues_data` and `metadata` parsed
   * to JS objects so callers don't have to remember.
   */
  const _receiverStmts = {
    getAll: db.prepare(`SELECT * FROM Receivers ORDER BY id`),
    getById: db.prepare(`SELECT * FROM Receivers WHERE id = ?`),
    insert: db.prepare(`
      INSERT INTO Receivers (id, label, type, cues_data, enabled, metadata, configuration_version, config_data)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `),
    // The COALESCE-with-current-row pattern lets callers PATCH any subset of
    // columns without clobbering the others. configuration_version bumps on
    // every update.
    //
    // Receiver-reported columns (fw_version / board_version / cues_available /
    // config_data) are part of the same patch surface so the daemon can write
    // them via the same helper -- no special-casing.
    update: db.prepare(`
      UPDATE Receivers SET
        label = COALESCE(?, label),
        type = COALESCE(?, type),
        cues_data = COALESCE(?, cues_data),
        enabled = COALESCE(?, enabled),
        metadata = COALESCE(?, metadata),
        fw_version = COALESCE(?, fw_version),
        board_version = COALESCE(?, board_version),
        cues_available = COALESCE(?, cues_available),
        config_data = COALESCE(?, config_data),
        configuration_version = configuration_version + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `),
    delete: db.prepare(`DELETE FROM Receivers WHERE id = ?`),
  };

  function _hydrateReceiverRow(row) {
    if (!row) return null;
    let cues = {};
    let metadata = {};
    let configData = {};
    try { cues = row.cues_data ? JSON.parse(row.cues_data) : {}; } catch { cues = {}; }
    try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch { metadata = {}; }
    try { configData = row.config_data ? JSON.parse(row.config_data) : {}; } catch { configData = {}; }
    return {
      ...row,
      enabled: row.enabled === 1,
      cues_data: cues,
      metadata,
      config_data: configData,
    };
  }

  const receiverQueries = {
    getAll: () => _receiverStmts.getAll.all().map(_hydrateReceiverRow),
    getById: (id) => _hydrateReceiverRow(_receiverStmts.getById.get(id)),
    insert: ({ id, label, type, cues_data = {}, enabled = true, metadata = {}, config_data = {} }) => {
      return _receiverStmts.insert.run(
        id,
        label || id,
        type,
        JSON.stringify(cues_data),
        enabled ? 1 : 0,
        JSON.stringify(metadata),
        JSON.stringify(config_data),
      );
    },
    /**
     * Patch-style update. Pass only the fields you want to change; pass
     * undefined for any field to leave it alone. Returns the run() result
     * (with `.changes`).
     *
     * Pass numbers (or null to clear) for fw_version/board_version/cues_available;
     * pass an object for config_data (it'll be JSON.stringified).
     */
    update: (id, {
      label, type, cues_data, enabled, metadata,
      fw_version, board_version, cues_available, config_data,
    } = {}) => {
      return _receiverStmts.update.run(
        label === undefined ? null : label,
        type === undefined ? null : type,
        cues_data === undefined ? null : JSON.stringify(cues_data),
        enabled === undefined ? null : (enabled ? 1 : 0),
        metadata === undefined ? null : JSON.stringify(metadata),
        fw_version === undefined ? null : fw_version,
        board_version === undefined ? null : board_version,
        cues_available === undefined ? null : cues_available,
        config_data === undefined ? null : JSON.stringify(config_data),
        id,
      );
    },
    delete: (id) => _receiverStmts.delete.run(id),
  };

  _queries = { showQueries, inventoryQueries, firingProfileQueries, rackQueries, receiverQueries };
  return _queries;
}