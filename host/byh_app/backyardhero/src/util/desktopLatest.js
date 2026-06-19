// Server-side resolver for the desktop installer `manifest.json` the build
// pipeline publishes to the static site (.github/scripts/publish_desktop.sh).
// Shape of the remote file:
//
//   { "version": "0.27.0",
//     "updated": "2026-06-18T12:00:00Z",
//     "platforms": {
//       "win-x64":   { "file", "link", "size" },
//       "mac-arm64": { "file", "link", "size" }, ... } }
//
// Mirrors firmwareLatest.js: fetch on the host (no CORS), cache in-process
// with a TTL, and stay offline-safe -- a failed refresh falls back to the
// last good value (flagged `stale`) or reports `available:false` rather than
// throwing. Used by /api/system/host_update to drive the Settings version
// footer's "update available" badge.

const BASE_URL = (
  process.env.BYH_DESKTOP_BASE_URL ||
  'https://backyard-hero.com/download/desktop'
).replace(/\/+$/, '');

// Desktop releases are infrequent; a long TTL keeps the static site quiet.
// The "Check for updates" button passes force=true to bypass it.
const TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

let cache = null; // { version, platforms, updated, fetchedAt } | null

async function fetchManifest() {
  const url = `${BASE_URL}/manifest.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const version = data && typeof data.version === 'string' ? data.version : null;
    if (!version) throw new Error('malformed manifest.json');
    return {
      version,
      platforms: (data && data.platforms) || {},
      updated: (data && data.updated) || null,
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the latest published desktop version. Never throws. Returns:
 *   { available, version?, platforms?, updated?, fetchedAt?, stale }
 *   - available:false => no data at all (never fetched successfully)
 *   - stale:true      => served cached data after a failed/forced refresh
 */
export async function getLatestDesktop({ force = false } = {}) {
  const fresh = cache && Date.now() - cache.fetchedAt < TTL_MS;
  if (cache && fresh && !force) {
    return { available: true, stale: false, ...cache };
  }
  try {
    cache = await fetchManifest();
    return { available: true, stale: false, ...cache };
  } catch {
    if (cache) return { available: true, stale: true, ...cache };
    return { available: false, stale: true };
  }
}
