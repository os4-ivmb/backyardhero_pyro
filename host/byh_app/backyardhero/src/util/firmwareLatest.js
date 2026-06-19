// Server-side resolver for the per-device firmware `latest.json` published on
// the static site by the firmware deploy scripts (ownerutils/deploy_*_firmware
// -> write_latest_manifest). Shape of each remote file:
//
//   { "version": "21",
//     "link": "https://backyard-hero.com/download/firmware/dongle/os4_dongle_v21.bin" }
//
// This module fetches those files on the host (Next.js server), caches the
// result in-process with a TTL so we don't hammer the static site, and is
// offline-safe: a failed refresh falls back to the last good value (flagged
// `stale`) or reports `available: false` rather than throwing. Both the
// firmware_latest GET route and the flash_latest POST route share it so the
// version surfaced to the UI and the bin we download to flash always agree.

const BASE_URL = (
  process.env.BYH_FIRMWARE_BASE_URL ||
  'https://backyard-hero.com/download/firmware'
).replace(/\/+$/, '');

// Long TTL: firmware changes rarely, and a manual "Check for updates" button
// passes force=true to bypass this. 6h keeps the static site untouched during
// normal operation while still catching a release within a day.
const TTL_MS = 6 * 60 * 60 * 1000;

// Fail fast when there's no internet -- the warnings/buttons are best-effort.
const FETCH_TIMEOUT_MS = 4000;

const DEVICES = ['receiver', 'dongle'];

// Module-level cache survives across requests within a single server process.
// { receiver: { version, link, fetchedAt } | null, dongle: ... }
const cache = { receiver: null, dongle: null };

function parseVersion(v) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

async function fetchOne(device) {
  const url = `${BASE_URL}/${device}/latest.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const version = parseVersion(data && data.version);
    const link = data && typeof data.link === 'string' ? data.link : null;
    if (version == null || !link) throw new Error('malformed latest.json');
    return { version, link, fetchedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the latest firmware for a device, using the cache when fresh.
 * Never throws. Returns:
 *   { device, available, version?, link?, fetchedAt?, stale }
 *   - available:false => we have no data at all (never fetched successfully)
 *   - stale:true      => served cached data after a failed/forced refresh
 */
export async function getLatest(device, { force = false } = {}) {
  if (!DEVICES.includes(device)) {
    return { device, available: false, stale: false, error: 'unknown device' };
  }
  const cached = cache[device];
  const fresh = cached && Date.now() - cached.fetchedAt < TTL_MS;
  if (cached && fresh && !force) {
    return {
      device,
      available: true,
      version: cached.version,
      link: cached.link,
      fetchedAt: cached.fetchedAt,
      stale: false,
    };
  }
  try {
    const fetched = await fetchOne(device);
    cache[device] = fetched;
    return {
      device,
      available: true,
      version: fetched.version,
      link: fetched.link,
      fetchedAt: fetched.fetchedAt,
      stale: false,
    };
  } catch {
    if (cached) {
      return {
        device,
        available: true,
        version: cached.version,
        link: cached.link,
        fetchedAt: cached.fetchedAt,
        stale: true,
      };
    }
    return { device, available: false, stale: true };
  }
}
