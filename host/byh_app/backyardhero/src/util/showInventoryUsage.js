// Physical, non-shell inventory consumed by a show — what "Archive show →
// Update inventory" deducts from each item's `available_ct`.
//
// Shells are excluded: they're tracked per pack / shell number (see
// utils/shellUsageCounts.js), not as a single per-item count. Shell-only cue
// types are skipped outright, and inventory-linked cues whose item is an
// AERIAL_SHELL are skipped too. GENERIC placeholders aren't physical items.

const SHELL_CUE_TYPES = new Set([
  "AERIAL_SHELL",
  "RACK_SHELLS",
  "FUSED_AERIAL_LINE",
  "FUSED_SHELL_LINE",
]);

function qtyOf(entry) {
  const m = Math.floor(Number(entry?.multiple) || 0);
  return m > 1 ? m : 1;
}

function parsePayload(displayPayload) {
  if (Array.isArray(displayPayload)) return displayPayload;
  try {
    const parsed = JSON.parse(displayPayload || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * @param {string|Array} displayPayload - show `display_payload` (JSON or parsed)
 * @param {Record<string|number, { type?: string }>} inventoryById
 * @returns {Map<string, number>} inventory id (stringified) -> units used.
 *   Only ids present in `inventoryById` are included.
 */
export function computeInventoryUsage(displayPayload, inventoryById = {}) {
  const usage = new Map();

  const add = (entry) => {
    if (!entry || entry.itemId == null) return;
    if (entry.type === "GENERIC" || SHELL_CUE_TYPES.has(entry.type)) return;
    const inv = inventoryById[entry.itemId];
    if (!inv || inv.type === "AERIAL_SHELL") return;
    const key = String(entry.itemId);
    usage.set(key, (usage.get(key) || 0) + qtyOf(entry));
  };

  for (const cue of parsePayload(displayPayload)) {
    if (!cue) continue;
    if (cue.type === "FUSED_LINE") {
      (Array.isArray(cue.steps) ? cue.steps : []).forEach(add);
      continue;
    }
    add(cue);
  }

  return usage;
}

/**
 * Usage joined with inventory rows, sorted by name, for display and for
 * applying the deduction. `after` is clamped at zero.
 */
export function inventoryUsageRows(displayPayload, inventoryById = {}) {
  const rows = [];
  for (const [id, used] of computeInventoryUsage(displayPayload, inventoryById)) {
    const inv = inventoryById[id];
    const before = Math.max(0, Math.trunc(Number(inv.available_ct) || 0));
    rows.push({
      id: inv.id,
      name: inv.name,
      used,
      before,
      after: Math.max(0, before - used),
    });
  }
  return rows.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
}
