// Local-only sync bookkeeping (Cloud Builder plan §6.1).
//
// Two SQLite tables, created lazily so they add nothing to the on-device schema
// path until the operator actually uses Cloud Sync:
//
//   cloud_sync_account  — the single cloud login this device pushes to
//                         (refresh token + cached access token). Single row.
//   sync_state          — maps a local entity (by autoincrement id / receiver
//                         ident) to its cloud UUID + the hash last pushed, so
//                         re-pushes upsert by the known cloud id and skip
//                         unchanged rows. This is also the seam pull-sync will
//                         reuse later (it already records cloud_id ↔ local_id).
//
// Everything here uses getDb() directly (never imported in the cloud profile —
// only the /api/sync/* routes touch it, and they're gated to caps.db==='sqlite').

import { getDb } from '@/util/sqldb';

let _ready = false;

function db() {
  const d = getDb();
  if (!_ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS cloud_sync_account (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        email         TEXT,
        url           TEXT,
        refresh_token TEXT,
        access_token  TEXT,
        expires_at    INTEGER,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_state (
        entity           TEXT NOT NULL,
        local_id         TEXT NOT NULL,
        cloud_id         TEXT NOT NULL,
        last_pushed_hash TEXT,
        last_pushed_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        PRIMARY KEY (entity, local_id)
      );
    `);
    _ready = true;
  }
  return d;
}

// ── Cloud account (single row) ──────────────────────────────────────────────
export function getAccount() {
  return db().prepare(`SELECT * FROM cloud_sync_account WHERE id = 1`).get() || null;
}

export function saveAccount({ email, url, refresh_token, access_token, expires_at }) {
  db()
    .prepare(
      `INSERT INTO cloud_sync_account (id, email, url, refresh_token, access_token, expires_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         url = excluded.url,
         refresh_token = excluded.refresh_token,
         access_token = excluded.access_token,
         expires_at = excluded.expires_at,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(email ?? null, url ?? null, refresh_token ?? null, access_token ?? null, expires_at ?? null);
}

export function clearAccount() {
  db().prepare(`DELETE FROM cloud_sync_account WHERE id = 1`).run();
}

// ── Entity id mapping ───────────────────────────────────────────────────────
export function getSyncState(entity, localId) {
  return (
    db()
      .prepare(`SELECT * FROM sync_state WHERE entity = ? AND local_id = ?`)
      .get(entity, String(localId)) || null
  );
}

export function setSyncState(entity, localId, cloudId, hash) {
  db()
    .prepare(
      `INSERT INTO sync_state (entity, local_id, cloud_id, last_pushed_hash, last_pushed_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(entity, local_id) DO UPDATE SET
         cloud_id = excluded.cloud_id,
         last_pushed_hash = excluded.last_pushed_hash,
         last_pushed_at = CURRENT_TIMESTAMP`,
    )
    .run(entity, String(localId), String(cloudId), hash ?? null);
}
