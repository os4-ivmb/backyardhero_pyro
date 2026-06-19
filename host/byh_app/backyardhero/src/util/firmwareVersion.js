// Firmware version helpers (client-safe). Versions are plain integers
// everywhere: the dongle heartbeat `fw`, the receiver `fw_version`, and the
// `version` field in the static-site latest.json. Comparison is just
// running < latest, but every input can be null/undefined/string, so these
// helpers normalize and stay null-safe.

export function normalizeVersion(v) {
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * True only when we know both versions AND running is strictly older than
 * latest. Unknown inputs (null, non-numeric, or no latest fetched) return
 * false so the UI shows no warning rather than a misleading one.
 */
export function fwOutOfDate(running, latest) {
  const r = normalizeVersion(running);
  const l = normalizeVersion(latest);
  if (r == null || l == null) return false;
  return r < l;
}
