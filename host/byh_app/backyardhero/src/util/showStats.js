// Lightweight stats derived from a show's `display_payload`.
//
// Centralised here so the console picker, future show-detail surfaces and
// any export tooling all categorise cues the same way. The display payload
// is a heterogeneous list (raw inventory items, FUSED_LINE composites,
// FUSED_AERIAL_LINE bundles, RACK_SHELLS rack picks, GENERIC placeholders)
// so we walk it with a tiny visitor.

const SHELL_BUNDLE_TYPES = new Set([
  "FUSED_AERIAL_LINE",
  // Legacy alias still floating around in older payloads.
  "FUSED_SHELL_LINE",
]);

function shellsInBundle(cue) {
  return Array.isArray(cue?.shells) ? cue.shells.length : 0;
}

function rackCueShells(cue) {
  // Both `fireableItem.cells` and `rackCells` are present on RACK_SHELLS
  // payloads -- prefer the fireable item since it's authoritative.
  const cells = cue?.fireableItem?.cells || cue?.rackCells;
  return Array.isArray(cells) ? cells.length : 0;
}

function multipleOf(cue) {
  const m = Math.floor(Number(cue?.multiple) || 0);
  return m > 1 ? m : 1;
}

/**
 * Compute summary counts for one show row.
 *
 * Returns an object with:
 *   - cues:          total number of cue events in the timeline
 *   - shells:        total aerial shells launched across all cues
 *   - nonShellItems: total non-shell physical items consumed (cakes,
 *                    fountains, compounds, fuses, ...). Excludes GENERIC
 *                    placeholders, which represent gaps rather than items.
 *   - racks:         distinct racks referenced by RACK_SHELLS cues
 *   - createdAt:     ISO/SQL timestamp string from the show row, or null
 *
 * Pass `inventoryById` so FUSED_LINE substeps that reference an inventory
 * id can be classified shell-vs-non-shell. If the inventory map isn't
 * available yet, FUSED_LINE steps fall back to "non-shell" -- a safe
 * default since fused-line steps are usually cakes.
 */
export function computeShowStats(show, inventoryById = {}) {
  const empty = { cues: 0, shells: 0, nonShellItems: 0, racks: 0, createdAt: null };
  if (!show) return empty;

  let payload = [];
  try {
    payload = JSON.parse(show.display_payload || "[]");
  } catch {
    payload = [];
  }

  let shells = 0;
  let nonShellItems = 0;
  const rackIds = new Set();

  for (const cue of payload) {
    if (!cue || !cue.type) continue;
    const type = cue.type;

    if (type === "AERIAL_SHELL") {
      shells += multipleOf(cue);
      continue;
    }

    if (SHELL_BUNDLE_TYPES.has(type)) {
      shells += shellsInBundle(cue);
      continue;
    }

    if (type === "RACK_SHELLS") {
      shells += rackCueShells(cue);
      // Fall back to rackName so legacy payloads without rackId still
      // count the rack at least once.
      const rackKey = cue.rackId ?? cue.rackName ?? cue.fireableItemId;
      if (rackKey != null) rackIds.add(rackKey);
      continue;
    }

    if (type === "GENERIC") continue;

    if (type === "FUSED_LINE") {
      const steps = Array.isArray(cue.steps) ? cue.steps : [];
      for (const step of steps) {
        if (!step) continue;
        const stepMult = Math.max(1, Math.floor(Number(step.multiple) || 1));
        if (step.type === "FUSED_SHELL_LINE") {
          // Embedded shell line carries its own shells array.
          shells += shellsInBundle(step.fusedShellLine || step);
          continue;
        }
        if (step.type === "GENERIC") continue;
        const inv = step.itemId != null ? inventoryById[step.itemId] : null;
        if (inv?.type === "AERIAL_SHELL") {
          shells += stepMult;
        } else {
          nonShellItems += stepMult;
        }
      }
      continue;
    }

    // Standard inventory item (cakes, compounds, fuses, etc.)
    nonShellItems += multipleOf(cue);
  }

  return {
    cues: payload.length,
    shells,
    nonShellItems,
    racks: rackIds.size,
    createdAt: show.created_at || null,
  };
}

/**
 * Best-effort short date for a SQLite TIMESTAMP / ISO string.
 * Returns "—" if the value is missing or unparseable. Uses the user's
 * locale so it matches the rest of the date formatting in the app.
 */
export function formatShowCreatedAt(value) {
  if (!value) return "—";
  // SQLite stores naive UTC strings like "2025-04-30 14:23:11".
  // Coerce to ISO so Date doesn't fall back to local-time parsing.
  const iso = typeof value === "string" && !value.includes("T")
    ? value.replace(" ", "T") + "Z"
    : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
