import Database from 'better-sqlite3';
const path = require('path');

const db = new Database('/data/backyardhero.db', { verbose: console.log });

/**
 * Legacy DBs used CHECK(type IN ('CAKE_FOUNTAIN', ...)) which blocks new types.
 * SQLite cannot drop a column CHECK; recreate the table without a type enum.
 */
function migrateInventoryRemoveLegacyTypeCheck() {
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
  db.exec('BEGIN');
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
  db.exec('PRAGMA foreign_keys = ON');
  console.log('Inventory type CHECK migration finished.');
}

function initializeDatabase() {
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
      receiver_labels TEXT -- To store receiver labels as JSON
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

    migrateInventoryRemoveLegacyTypeCheck();
    
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
  } catch (err) {
    console.error("Error initializing database tables:", err.message);
  }
}

initializeDatabase(); // Initialize database on load

export const showQueries = {
  insert: db.prepare(`INSERT INTO Show (name, duration, version, runtime_version, display_payload, runtime_payload, authorization_code, protocol, audio_file, receiver_locations, receiver_labels)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getAll: db.prepare(`SELECT * FROM Show`),
  update: db.prepare(`UPDATE Show SET name = ?, duration = ?, version = ?, runtime_version = ?, display_payload = ?, runtime_payload = ?, authorization_code = ?, protocol = ?, audio_file = ?, receiver_locations = ?, receiver_labels = ? WHERE id = ?`),
  delete: db.prepare(`DELETE FROM Show WHERE id = ?`), // Delete query
};

/** INVENTORY TABLE OPERATIONS */
export const inventoryQueries = {
  insert: db.prepare(`INSERT INTO inventory (name, type, duration, fuse_delay, lift_delay, burn_rate, color, available_ct, youtube_link, youtube_link_start_sec, image, metadata, unit_cost, source)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getAll: db.prepare(`SELECT * FROM inventory`),
  update: db.prepare(`UPDATE inventory SET name = ?, type = ?, duration = ?, fuse_delay = ?, lift_delay = ?, burn_rate = ?, color = ?, available_ct = ?, youtube_link = ?, youtube_link_start_sec = ?, image = ?, metadata = ?, unit_cost = ?, source = ? WHERE id = ?`),
  delete: db.prepare(`DELETE FROM inventory WHERE id = ?`),
};

/** FIRING PROFILE TABLE OPERATIONS */
export const firingProfileQueries = {
  getByInventoryId: db.prepare(`SELECT * FROM inventoryFiringProfile WHERE inventory_id = ?`),
  getAll: db.prepare(`SELECT * FROM inventoryFiringProfile`),
  update: db.prepare(`UPDATE inventoryFiringProfile SET shot_timestamps = ? WHERE inventory_id = ?`),
  deleteByInventoryId: db.prepare(`DELETE FROM inventoryFiringProfile WHERE inventory_id = ?`),
};

/** RACKS TABLE OPERATIONS */
export const rackQueries = {
  insert: db.prepare(`INSERT INTO racks (show_id, name, x_rows, x_spacing, y_rows, y_spacing, cells, fuses)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  getAll: db.prepare(`SELECT * FROM racks WHERE show_id = ?`),
  getById: db.prepare(`SELECT * FROM racks WHERE id = ?`),
  update: db.prepare(`UPDATE racks SET name = ?, x_rows = ?, x_spacing = ?, y_rows = ?, y_spacing = ?, cells = ?, fuses = ? WHERE id = ?`),
  delete: db.prepare(`DELETE FROM racks WHERE id = ?`),
};