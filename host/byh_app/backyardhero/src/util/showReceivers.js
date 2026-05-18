// Per-show receiver list helpers.
//
// A show owns its own list of receivers + cue counts. The list lives on the
// show row as a JSON blob (`show_receivers`) and is hydrated into
// `stagedShow.showReceivers` by the store. Each entry has the shape:
//
//   {
//     id: string,                     // see kind below
//     kind: 'native' | 'bilusocn',    // see below; defaults to 'native'
//     label?: string,
//     cues: number,
//   }
//
// Two kinds:
//
// - kind: 'native' (default; what every show pre-Bilusocn-zone-rework uses):
//     `id` is the DB receiver ident (same string used by `item.zone` on
//     timeline items). `cues` is the number of cue slots the show expects
//     from that receiver (multiples of 8, capped at 64).
//
// - kind: 'bilusocn':
//     The show owns a Bilusocn 4ch dipswitch zone directly; there is NO DB
//     receiver row backing this entry. `id` is the zone number as a string
//     (e.g. "1", "12") -- this is what `item.zone` uses, matching the
//     `cues_data` zone key the daemon sees on synthesized rows. `cues` is
//     always exactly BILUSOCN_ZONE_CUES (12). Stage-time, the daemon
//     synthesizes 3 ephemeral 4-cue receiver rows per zone (1-4, 5-8,
//     9-12) so the existing zone/target -> device_id resolver finds them.
//
// Entries persisted before this rework have no `kind` field; they are
// treated as 'native'.

// Kind constants. Use these instead of string literals to keep the
// surface area greppable and to make the verifier/materializer
// branch on a single token.
export const RECEIVER_KIND_NATIVE = 'native';
export const RECEIVER_KIND_BILUSOCN = 'bilusocn';

export function entryKind(entry) {
  return entry?.kind === RECEIVER_KIND_BILUSOCN
    ? RECEIVER_KIND_BILUSOCN
    : RECEIVER_KIND_NATIVE;
}

export function isBilusocnEntry(entry) {
  return entryKind(entry) === RECEIVER_KIND_BILUSOCN;
}

// Cue-count selector options surfaced in the editor for NATIVE entries.
// Kept here so the modal and any validation helpers stay in sync.
export const SHOW_RECEIVER_CUE_OPTIONS = Array.from(
  { length: 8 },
  (_, i) => (i + 1) * 8
);
export const SHOW_RECEIVER_MIN_CUES = SHOW_RECEIVER_CUE_OPTIONS[0];
export const SHOW_RECEIVER_MAX_CUES =
  SHOW_RECEIVER_CUE_OPTIONS[SHOW_RECEIVER_CUE_OPTIONS.length - 1];

// ---------------------------------------------------------------------------
// Bilusocn zone constants.
//
// A Bilusocn 4ch module covers 4 cues at a fixed dipswitch range start
// within a zone. A "Bilusocn zone" in the show-builder sense is the
// composition of all 3 possible 4-cue ranges -- so always 12 cues.
// We never let the operator partially scope a zone; if they only own
// one module, the unused cues just won't physically actuate.
// ---------------------------------------------------------------------------
export const BILUSOCN_ZONE_CUES = 12;
export const BILUSOCN_RANGE_LEN = 4;
// Range starts that together tile the 12 cues without overlap. Order
// matters only for iteration / display.
export const BILUSOCN_RANGE_STARTS = [1, 5, 9];
// Receiver-type string used by the daemon and ReceiverDisplay for
// 433MHz one-way TX modules. Re-exported here so the materializer can
// stamp synthesized ephemeral rows with the right type without
// reaching into receiver-display internals.
export const BILUSOCN_RECEIVER_TYPE = 'BILUSOCN_433_TX_ONLY';
// Min/max zone numbers the Bilusocn TX firmware accepts. Mirrors the
// add UI's clamp on the (now-deprecated) Receivers-page Add modal.
export const BILUSOCN_ZONE_MIN = 1;
export const BILUSOCN_ZONE_MAX = 256;

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
 * name and `[1..cues]` as the targets. Bilusocn entries always expose
 * 12 cues regardless of any stale `cues` value on the entry.
 */
export function availableDevicesFromShowReceivers(showReceivers) {
  const out = {};
  if (!Array.isArray(showReceivers)) return out;
  for (const entry of showReceivers) {
    if (!entry || !entry.id) continue;
    const n = isBilusocnEntry(entry)
      ? BILUSOCN_ZONE_CUES
      : Math.max(0, parseInt(entry.cues, 10) || 0);
    out[entry.id] = Array.from({ length: n }, (_, i) => i + 1);
  }
  return out;
}

/**
 * Synthesize the in-memory receivers map a staged show would see. Native
 * entries are passed through from `activeReceivers`; for each Bilusocn
 * entry we generate 3 ephemeral 4-cue receiver rows tiling the zone's
 * 12 cues. The result has the same shape as `activeReceivers` and can be
 * dropped into anywhere a "DB receivers map" is expected (target grid
 * header, layout map, etc.).
 *
 * The synthesized rows are flagged with `__ephemeral: true` so callers
 * can tell them apart from DB-backed rows (e.g. ReceiverDisplay should
 * never persist edits to them).
 *
 * Idents are deterministic: `__bilusocn_z<zone>_<start>` -- e.g. zone 1
 * yields `__bilusocn_z1_1`, `__bilusocn_z1_5`, `__bilusocn_z1_9`. The
 * leading underscores keep them out of the `RX\\d+` namespace the dongle
 * understands, so even if one of these rows somehow leaked into the
 * dongle's poll table it would be a clearly-non-physical ident.
 */
export function materializeReceiversForShow(activeReceivers, showReceivers) {
  const out = { ...(activeReceivers || {}) };
  if (!Array.isArray(showReceivers)) return out;
  for (const entry of showReceivers) {
    if (!entry || !entry.id) continue;
    if (!isBilusocnEntry(entry)) continue;
    const zone = String(entry.id);
    const label = entry.label || `Bilusocn zone ${zone}`;
    for (const start of BILUSOCN_RANGE_STARTS) {
      const ident = `__bilusocn_z${zone}_${start}`;
      out[ident] = {
        type: BILUSOCN_RECEIVER_TYPE,
        enabled: true,
        label,
        cues: {
          [zone]: Array.from(
            { length: BILUSOCN_RANGE_LEN },
            (_, i) => start + i,
          ),
        },
        __ephemeral: true,
      };
    }
  }
  return out;
}

/**
 * Validates a candidate Bilusocn zone number against an existing
 * showReceivers list. Returns null on success, or a human-readable
 * error string. `excludeEntryId` lets edit-mode callers skip the
 * entry being edited. The zone bounds match the Bilusocn TX firmware
 * (1-256).
 */
export function validateBilusocnZoneSelection({
  zone,
  showReceivers,
  excludeEntryId,
}) {
  const z = parseInt(zone, 10);
  if (!Number.isFinite(z) || z < BILUSOCN_ZONE_MIN || z > BILUSOCN_ZONE_MAX) {
    return `Zone must be a number between ${BILUSOCN_ZONE_MIN} and ${BILUSOCN_ZONE_MAX}.`;
  }
  if (Array.isArray(showReceivers)) {
    for (const entry of showReceivers) {
      if (!entry || !entry.id) continue;
      if (!isBilusocnEntry(entry)) continue;
      if (excludeEntryId && entry.id === excludeEntryId) continue;
      if (String(entry.id) === String(z)) {
        return `Zone ${z} is already in this show. Pick a different zone.`;
      }
    }
  }
  return null;
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
    // Legacy back-fill always produces NATIVE entries -- there's no
    // generic way to recover a Bilusocn-zone identity from old items[],
    // since pre-rework Bilusocn was DB-backed and its idents were free-
    // form (e.g. "BSC1A"), not zone numbers. Operators who used
    // Bilusocn before the rework will need to rebuild those zones in
    // the show builder by hand (per the manual_only migration policy).
    const entry = { id: ident, kind: RECEIVER_KIND_NATIVE, cues: rounded };
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
    // Bilusocn zones are not DB-backed: the show owns them outright and
    // the daemon synthesizes ephemeral receiver rows for them at stage
    // time. There is nothing to verify against the DB, so they are
    // unconditionally OK. Also implies their absence from the receivers
    // page is expected and not a load blocker.
    if (isBilusocnEntry(entry)) {
      return { entry, status: SHOW_RECEIVER_STATUS.OK };
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
