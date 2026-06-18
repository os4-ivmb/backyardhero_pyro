// Persistence repository layer (Cloud Builder plan §3.2).
//
// API routes call `const repo = await getRepo(req)` and then talk to
// `repo.shows`, `repo.inventory`, `repo.racks`, `repo.receivers`,
// `repo.firingProfiles` — never SQLite or Supabase directly. The adapter is
// chosen from `caps.db` and imported dynamically so that:
//   * the local build only ever loads the SQLite adapter (native
//     better-sqlite3), and
//   * the cloud build only ever loads the Supabase adapter (no native addon,
//     no attempt to open /data/backyardhero.db).
//
// Adapter contract (all methods async, return plain JS):
//   shows.list()                       -> rows[]
//   shows.create(row)                  -> { id }
//   shows.update(id, row)              -> { changes }
//   shows.remove(id)                   -> { changes }
//   inventory.list()                   -> rows[]
//   inventory.create(row)              -> { id }
//   inventory.update(id, row)          -> { changes }
//   inventory.remove(id)               -> { changes }
//   firingProfiles.list()              -> rows[]
//   firingProfiles.getByInventoryId(id)-> row | undefined
//   firingProfiles.update(invId, ts)   -> { changes }   (ts = JSON string)
//   firingProfiles.removeByInventoryId(id) -> { changes }
//   racks.listByShow(showId)           -> rows[]
//   racks.getById(id)                  -> row | undefined
//   racks.create(row)                  -> { id }
//   racks.update(id, row)              -> { changes }
//   racks.remove(id)                   -> { changes }
//   receivers.list()                   -> hydrated rows[]
//   receivers.getById(id)              -> hydrated row | null
//   receivers.insert(obj)              -> { changes }
//   receivers.update(id, patch)        -> { changes }
//   receivers.remove(id)               -> { changes }

import { caps } from '@/util/profile';
import { resolveCtx } from './context';

/**
 * Resolve { ctx, adapter } and return the repository bound to that context.
 * Throws (with `.status = 401`) in cloud profile when unauthenticated.
 */
export async function getRepo(req) {
  const ctx = await resolveCtx(req);
  if (caps.db === 'supabase') {
    const { createSupabaseRepo } = await import('./supabase');
    return createSupabaseRepo(ctx, req);
  }
  const { createSqliteRepo } = await import('./sqlite');
  return createSqliteRepo(ctx);
}

/**
 * Helper for API routes: run `fn(repo)` and translate a thrown auth error
 * (`.status`) into the right HTTP status. Returns true if it handled an
 * error response, false otherwise (so the caller can proceed). Kept tiny and
 * optional — routes may also just `await getRepo(req)` in their own try/catch.
 */
export async function withRepo(req, res, fn) {
  let repo;
  try {
    repo = await getRepo(req);
  } catch (err) {
    const status = err?.status || 500;
    res.status(status).json({ error: err?.message || 'Failed to resolve data context.' });
    return true;
  }
  return fn(repo);
}
