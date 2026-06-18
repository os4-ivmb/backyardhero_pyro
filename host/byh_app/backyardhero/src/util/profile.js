// Deployment profile + capability flags (Cloud Builder plan §3.1).
//
// The same Next.js source builds two ways:
//   * BYH_PROFILE=local (default) — on-device (Pi / laptop): SQLite, local
//     filesystem audio, dongle/daemon/ws hardware surfaces present, single
//     implicit operator (no auth).
//   * BYH_PROFILE=cloud — hosted multi-user editor: Supabase Postgres + RLS,
//     Supabase Storage for audio, hardware surfaces hidden, per-user scoping.
//
// `caps` is the single source of truth the rest of the app branches on, so we
// never sprinkle `if (process.env.BYH_PROFILE === 'cloud')` through the code.
// It is read server-side from env and surfaced to the client alongside `host`
// in /api/system/config (see api/system/config.js), mirroring how
// `is_raspberry_pi` is already plumbed.
//
// NOTE: this is intentionally server-evaluated. The client receives the
// derived `caps` object from the config endpoint rather than reading env
// directly, so no NEXT_PUBLIC_ var is required.

export const PROFILE = process.env.BYH_PROFILE === 'cloud' ? 'cloud' : 'local';

export const caps = Object.freeze({
  // Which deployment profile this process is running as.
  profile: PROFILE,
  // dongle / daemon / ws_server present (firing, live state, flashing, GPIO).
  hardware: PROFILE === 'local',
  // auth + per-user row scoping (Supabase). Local is single-operator.
  multiUser: PROFILE === 'cloud',
  // where show audio bytes live.
  audioStore: PROFILE === 'cloud' ? 'supabase' : 'fs',
  // which persistence adapter backs the repository layer (src/data/).
  db: PROFILE === 'cloud' ? 'supabase' : 'sqlite',
});

export function getCaps() {
  return caps;
}
