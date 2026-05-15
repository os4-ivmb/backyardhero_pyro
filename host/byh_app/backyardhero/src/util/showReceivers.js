// Per-show receiver list helpers.
//
// A show owns its own list of receivers + cue counts. The list lives on the
// show row as a JSON blob (`show_receivers`) and is hydrated into
// `stagedShow.showReceivers` by the store. Each entry has the shape:
//
//   { id: <DB receiver ident>, label?: string, cues: number }
//
// `cues` is the number of cue slots the show expects from this receiver
// (always a multiple of 8, capped at 64 in the edit UI). `id` is the same
// identifier used by `item.zone` on timeline items, which keeps drag/drop
// and existing display_payload semantics unchanged.

// Cue-count selector options surfaced in the editor. Kept here so the modal
// and any validation helpers stay in sync.
export const SHOW_RECEIVER_CUE_OPTIONS = Array.from(
  { length: 8 },
  (_, i) => (i + 1) * 8
);
export const SHOW_RECEIVER_MIN_CUES = SHOW_RECEIVER_CUE_OPTIONS[0];
export const SHOW_RECEIVER_MAX_CUES =
  SHOW_RECEIVER_CUE_OPTIONS[SHOW_RECEIVER_CUE_OPTIONS.length - 1];

/**
 * Number of cues a DB receiver actually exposes. Mirrors the helper inside
 * ReceiverDisplay so callers don't need to reach into that component.
 */
export function dbReceiverCueCount(receiver) {
  if (!receiver || !receiver.cues) return 0;
  const firstZone = Object.keys(receiver.cues)[0];
  if (!firstZone) return 0;
  const arr = receiver.cues[firstZone];
  return Array.isArray(arr) ? arr.length : 0;
}

/**
 * Build the `availableDevices` map the builder consumes (zone -> [1..N])
 * from a showReceivers list. Each entry contributes its `id` as the zone
 * name and `[1..cues]` as the targets.
 */
export function availableDevicesFromShowReceivers(showReceivers) {
  const out = {};
  if (!Array.isArray(showReceivers)) return out;
  for (const entry of showReceivers) {
    if (!entry || !entry.id) continue;
    const n = Math.max(0, parseInt(entry.cues, 10) || 0);
    out[entry.id] = Array.from({ length: n }, (_, i) => i + 1);
  }
  return out;
}

/**
 * Back-fill a showReceivers list from a legacy show that pre-dates the
 * column. Uses timeline items[] to discover receiver idents and the highest
 * cue used by each, rounds the count up to the next 8 (with a floor of the
 * configured DB receiver's cue count if known), and reuses any labels that
 * were previously stored in `receiver_labels`.
 *
 * Pass an empty dbReceivers map to skip the floor; the result is still
 * usable.
 */
export function deriveShowReceiversFromLegacy({
  items,
  receiverLabels,
  dbReceivers,
}) {
  const usedCounts = new Map(); // ident -> highest cue index referenced
  if (Array.isArray(items)) {
    for (const it of items) {
      if (!it || !it.zone) continue;
      const target = parseInt(it.target, 10);
      if (!Number.isFinite(target) || target <= 0) continue;
      const cur = usedCounts.get(it.zone) || 0;
      if (target > cur) usedCounts.set(it.zone, target);
    }
  }

  const labels = receiverLabels || {};
  const db = dbReceivers || {};

  // Include every receiver that's either used by items OR has a saved label
  // (rare, but possible if the user labelled an empty zone before saving).
  const idents = new Set([...usedCounts.keys(), ...Object.keys(labels)]);

  const out = [];
  for (const ident of idents) {
    const used = usedCounts.get(ident) || 0;
    const dbCount = dbReceiverCueCount(db[ident]);
    const rounded = roundUpToCueOption(Math.max(used, dbCount, SHOW_RECEIVER_MIN_CUES));
    const entry = { id: ident, cues: rounded };
    if (labels[ident]) entry.label = labels[ident];
    out.push(entry);
  }
  return out;
}

function roundUpToCueOption(n) {
  for (const opt of SHOW_RECEIVER_CUE_OPTIONS) {
    if (opt >= n) return opt;
  }
  return SHOW_RECEIVER_MAX_CUES;
}

/**
 * Look up the highest cue (target) used by timeline items for a given
 * receiver id. Returns 0 if nothing is using it. Used to validate whether
 * a receiver entry can be removed, or its cue count shrunk, without
 * orphaning items.
 */
export function highestUsedCueForReceiver(items, receiverId) {
  if (!Array.isArray(items)) return 0;
  let max = 0;
  for (const it of items) {
    if (!it || it.zone !== receiverId) continue;
    const t = parseInt(it.target, 10);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/**
 * Count of items pinned to a given receiver id. Cheap O(n) walk; callers
 * generally use it to produce "N items will be left orphaned" messages.
 */
export function itemsCountForReceiver(items, receiverId) {
  if (!Array.isArray(items)) return 0;
  let n = 0;
  for (const it of items) {
    if (it && it.zone === receiverId) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Verification.
//
// Each show receiver entry is paired against the live DB receivers table and
// classified into one of:
//   - "ok":           receiver exists, is enabled, has >= entry.cues cues
//   - "missing":      no DB row with this id
//   - "disabled":     DB row exists but enabled === false
//   - "insufficient": DB row exists & enabled but its cue count < entry.cues
//
// "missing" and "disabled" are HARD errors -- the daemon can't address the
// receiver at all, so we block load and surface a red badge on the menu.
// "insufficient" is a SOFT warning -- the show will still load and fire,
// but cue numbers above the receiver's count won't physically actuate.
// We let operators build/load shows in this state intentionally (e.g.
// authoring ahead of a hardware install) and surface the warning on the
// Receivers page card.
//
// `hasError`   -- true when any entry is missing/disabled. Blocks load.
// `hasWarning` -- true when any entry is insufficient. Informational.
// ---------------------------------------------------------------------------

export const SHOW_RECEIVER_STATUS = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  DISABLED: 'disabled',
  INSUFFICIENT: 'insufficient',
});

export function verifyShowReceivers(showReceivers, dbReceivers) {
  const entries = Array.isArray(showReceivers) ? showReceivers : [];
  const db = dbReceivers || {};
  const results = entries.map((entry) => {
    if (!entry || !entry.id) {
      return { entry, status: SHOW_RECEIVER_STATUS.MISSING };
    }
    const row = db[entry.id];
    if (!row) return { entry, status: SHOW_RECEIVER_STATUS.MISSING };
    if (row.enabled === false) {
      return { entry, status: SHOW_RECEIVER_STATUS.DISABLED, dbReceiver: row };
    }
    const have = dbReceiverCueCount(row);
    const need = parseInt(entry.cues, 10) || 0;
    if (have < need) {
      return {
        entry,
        status: SHOW_RECEIVER_STATUS.INSUFFICIENT,
        dbReceiver: row,
        have,
        need,
      };
    }
    return { entry, status: SHOW_RECEIVER_STATUS.OK, dbReceiver: row };
  });
  // Hard errors only -- insufficient is a warning, not a load blocker.
  // See block comment above for rationale.
  const hasError = results.some(
    (r) => r.status === SHOW_RECEIVER_STATUS.MISSING
        || r.status === SHOW_RECEIVER_STATUS.DISABLED,
  );
  const hasWarning = results.some(
    (r) => r.status === SHOW_RECEIVER_STATUS.INSUFFICIENT,
  );
  return { results, hasError, hasWarning };
}

/**
 * Convenience: a human-readable summary of verification issues. Reports
 * BOTH errors (missing/disabled) and warnings (insufficient) -- callers
 * gate on `verification.hasError` / `hasWarning` to decide whether to
 * show it. Returns null only when there are no issues at all.
 */
export function summarizeVerificationErrors(verification) {
  if (!verification || (!verification.hasError && !verification.hasWarning)) {
    return null;
  }
  const counts = { missing: 0, disabled: 0, insufficient: 0 };
  for (const r of verification.results) {
    if (r.status === SHOW_RECEIVER_STATUS.MISSING) counts.missing++;
    if (r.status === SHOW_RECEIVER_STATUS.DISABLED) counts.disabled++;
    if (r.status === SHOW_RECEIVER_STATUS.INSUFFICIENT) counts.insufficient++;
  }
  const parts = [];
  if (counts.missing) parts.push(`${counts.missing} missing`);
  if (counts.disabled) parts.push(`${counts.disabled} disabled`);
  if (counts.insufficient) parts.push(`${counts.insufficient} under-cued`);
  return parts.join(', ');
}
