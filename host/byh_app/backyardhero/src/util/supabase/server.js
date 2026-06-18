// Pages-Router Supabase server helpers (Cloud Builder plan §5 / §1.5).
//
// The gateway (App Router) uses next/headers cookies(); the builder is Pages
// Router, so the cookie adapter is bound to the API-route req/res instead.
// The builder is served under the same parent domain as the gateway
// (cloud.backyard-hero.com/builder), so the Supabase session cookie set at
// sign-in is visible here with no token plumbing — we just read it.
//
// Only loaded in the cloud profile (dynamically imported from
// src/data/context.js), so the local build never pulls @supabase/* into a
// request path.

import { createServerClient, serializeCookieHeader } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';

function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (legacy: NEXT_PUBLIC_SUPABASE_ANON_KEY) in environment.',
    );
  }
  return { url, publishableKey };
}

/**
 * Cookie-backed server client for a Pages-Router API request. RLS sees the
 * signed-in user's JWT on every query. `res` is optional; when provided,
 * refreshed auth cookies are written back via Set-Cookie (best effort).
 */
export function createServerSupabase(req, res) {
  const { url, publishableKey } = getSupabaseConfig();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        const jar = req?.cookies || {};
        return Object.entries(jar).map(([name, value]) => ({ name, value }));
      },
      setAll(cookiesToSet) {
        if (!res || typeof res.setHeader !== 'function') return;
        try {
          const prev = res.getHeader('Set-Cookie');
          const existing = Array.isArray(prev) ? prev : prev ? [prev] : [];
          const added = cookiesToSet.map(({ name, value, options }) =>
            serializeCookieHeader(name, value, options),
          );
          res.setHeader('Set-Cookie', [...existing, ...added]);
        } catch {
          // Headers already sent; the next request will refresh.
        }
      },
    },
  });
}

/**
 * Service-role client (bypasses RLS). Used for Storage signed-URL minting and
 * any admin-side reads. Never expose to the client.
 */
export function createServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secretKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY (legacy: SUPABASE_SERVICE_ROLE_KEY) in environment.',
    );
  }
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Resolve the authenticated user's id (the `sub` claim RLS scopes by), or
 * null when unauthenticated.
 */
export async function getUserIdFromRequest(req, res) {
  const supabase = createServerSupabase(req, res);
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data?.user?.id || null;
}
