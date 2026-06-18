// Request -> persistence context resolver (Cloud Builder plan §3.2).
//
// Every repository call takes a `ctx = { userId }`. The SQLite adapter
// ignores it (single implicit operator); the Supabase adapter scopes every
// row to it (and Postgres RLS enforces it server-side).
//
//   local  -> { userId: 'local' }      (constant; no auth)
//   cloud  -> { userId }               (from the Supabase session; 401 if absent)

import { caps } from '@/util/profile';

export const LOCAL_USER_ID = 'local';

/**
 * Resolve the persistence context for a request. Throws an Error with
 * `.status = 401` in cloud profile when there is no authenticated user, so
 * route handlers can translate it to an HTTP 401 (see getRepo callers).
 */
export async function resolveCtx(req) {
  if (!caps.multiUser) {
    return { userId: LOCAL_USER_ID };
  }

  // Cloud profile: derive the user from the shared Supabase session cookie.
  // Imported lazily so the local build never pulls in @supabase/* code.
  const { getUserIdFromRequest } = await import('@/util/supabase/server');
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
  return { userId };
}
