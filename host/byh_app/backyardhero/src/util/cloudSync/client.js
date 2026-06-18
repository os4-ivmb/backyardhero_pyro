// Device → cloud Supabase client for push sync (Cloud Builder plan §6.2).
//
// Runs on the LOCAL device (BYH_PROFILE=local). The operator signs in with
// their cloud account; we keep the refresh token in SQLite (cloud_sync_account)
// and mint a fresh access token per push. RLS on the builder_* tables then
// scopes every upsert to that user — identical enforcement to the cloud editor.
//
// Only imported by /api/sync/* routes, which are gated to the local profile.

import { createClient } from '@supabase/supabase-js';
import { getAccount, saveAccount, clearAccount } from './state';

// The device pushes to the same Supabase project the cloud editor uses. Prefer
// dedicated CLOUD_SYNC_* env, falling back to the NEXT_PUBLIC_* names so a box
// that already has them configured just works.
export function getCloudConfig() {
  const url =
    process.env.CLOUD_SYNC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null;
  const anonKey =
    process.env.CLOUD_SYNC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    null;
  return { url, anonKey };
}

export function isConfigured() {
  const { url, anonKey } = getCloudConfig();
  return !!(url && anonKey);
}

function newClient() {
  const { url, anonKey } = getCloudConfig();
  if (!url || !anonKey) {
    const e = new Error(
      'Cloud sync is not configured on this device (set CLOUD_SYNC_SUPABASE_URL and CLOUD_SYNC_SUPABASE_ANON_KEY).',
    );
    e.status = 503;
    throw e;
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Sign in with email/password and persist the session. Returns { email }.
 */
export async function signIn(email, password) {
  const sb = newClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data?.session) {
    const e = new Error(error?.message || 'Sign-in failed.');
    e.status = 401;
    throw e;
  }
  const { url } = getCloudConfig();
  saveAccount({
    email: data.user?.email || email,
    url,
    refresh_token: data.session.refresh_token,
    access_token: data.session.access_token,
    expires_at: data.session.expires_at,
  });
  return { email: data.user?.email || email };
}

export function signOut() {
  clearAccount();
}

export function getStatus() {
  const acct = getAccount();
  return {
    configured: isConfigured(),
    connected: !!acct?.refresh_token,
    email: acct?.email || null,
  };
}

/**
 * Return an authenticated client (and the user's id/email) by refreshing the
 * stored session. refreshSession both validates and rotates the refresh token,
 * so this transparently handles expiry. Throws { status: 401 } when there is no
 * stored session or the refresh is rejected (e.g. password changed / revoked).
 */
export async function getAuthedClient() {
  const acct = getAccount();
  if (!acct?.refresh_token) {
    const e = new Error('Not connected to the cloud. Sign in first.');
    e.status = 401;
    throw e;
  }
  const sb = newClient();
  const { data, error } = await sb.auth.refreshSession({
    refresh_token: acct.refresh_token,
  });
  if (error || !data?.session) {
    const e = new Error('Cloud session expired. Sign in again.');
    e.status = 401;
    throw e;
  }
  const { url } = getCloudConfig();
  saveAccount({
    email: data.user?.email || acct.email,
    url,
    refresh_token: data.session.refresh_token,
    access_token: data.session.access_token,
    expires_at: data.session.expires_at,
  });
  await sb.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  return { sb, userId: data.user?.id, email: data.user?.email || acct.email };
}
