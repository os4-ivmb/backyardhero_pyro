import Database from 'better-sqlite3';
const path = require('path');

const db = new Database('/data/backyardhero.db', { verbose: console.log });

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
      receiver_locations TEXT -- To store receiver positions as JSON
    );
  `;

  const createInventoryTable = `
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT CHECK(type IN ('CAKE_FOUNTAIN', 'CAKE_200G', 'CAKE_500G', 'AERIAL_SHELL', 'GENERIC', 'FUSE')) NOT NULL,
      duration REAL CHECK(duration >= 0),
      fuse_delay REAL CHECK(fuse_delay >= 0),
      lift_delay REAL CHECK(lift_delay >= 0),
      burn_rate REAL CHECK(burn_rate >= 0),
      color TEXT,
      available_ct INTEGER DEFAULT 0,
      youtube_link TEXT,
      image TEXT,
      youtube_link_start_sec INTEGER
    );
  `;

  const createInventoryFiringProfileTable = `
    CREATE TABLE IF NOT EXISTS inventoryFiringProfile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL,
      youtube_link TEXT NOT NULL,
      youtube_link_start_sec INTEGER NOT NULL,
      shot_timestamps TEXT NOT NULL, -- JSON array of [start_ms, end_ms] pairs: [[start1, end1], [start2, end2], ...]
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE,
      UNIQUE(inventory_id)
    );
  `;

  try {
    db.exec(createShowTable);
    console.log("Checked/created Show table.");
    db.exec(createInventoryTable);
    console.log("Checked/created inventory table.");
    db.exec(createInventoryFiringProfileTable);
    console.log("Checked/created inventoryFiringProfile table.");
  } catch (err) {
    console.error("Error initializing database tables:", err.message);
  }
}

initializeDatabase(); // Initialize database on load

export const showQueries = {
  insert: db.prepare(`INSERT INTO Show (name, duration, version, runtime_version, display_payload, runtime_payload, authorization_code, protocol, audio_file, receiver_locations)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getAll: db.prepare(`SELECT * FROM Show`),
  update: db.prepare(`UPDATE Show SET name = ?, duration = ?, version = ?, runtime_version = ?, display_payload = ?, runtime_payload = ?, authorization_code = ?, protocol = ?, audio_file = ?, receiver_locations = ? WHERE id = ?`),
  delete: db.prepare(`DELETE FROM Show WHERE id = ?`), // Delete query
};

/** INVENTORY TABLE OPERATIONS */
export const inventoryQueries = {
  insert: db.prepare(`INSERT INTO inventory (name, type, duration, fuse_delay, lift_delay, burn_rate, color, available_ct, youtube_link, youtube_link_start_sec, image)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getAll: db.prepare(`SELECT * FROM inventory`),
  update: db.prepare(`UPDATE inventory SET name = ?, type = ?, duration = ?, fuse_delay = ?, lift_delay = ?, burn_rate = ?, color = ?, available_ct = ?, youtube_link = ?, youtube_link_start_sec = ?, image = ? WHERE id = ?`),
};

/** FIRING PROFILE TABLE OPERATIONS */
export const firingProfileQueries = {
  getByInventoryId: db.prepare(`SELECT * FROM inventoryFiringProfile WHERE inventory_id = ?`),
  getAll: db.prepare(`SELECT * FROM inventoryFiringProfile`),
};