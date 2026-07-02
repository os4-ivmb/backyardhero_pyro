// Name-matching helpers for the show-import "Match items" step.
//
// Imported cues carry a free-text label (the firework's name, e.g.
// "Grand Union", "Statue of Liberty", "Majestic Brocades (3\")"). To turn a
// generic imported cue into a real inventory-backed item we match that label
// against inventory item names. Matching is normalized (case, whitespace and
// inch-mark/quote punctuation are folded) so trivially-different spellings
// still line up — the same tolerant style the receiver matcher uses.

// Fold a name to a comparison key: lowercase, drop quotes / inch marks,
// collapse whitespace, trim.
export function normalizeItemName(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/["'‘’“”]/g, "") // straight + smart quotes / inch marks
    .replace(/\s+/g, " ")
    .trim();
}

// Build a normalizedName -> [inventory items] index. FUSE items are excluded
// (they aren't firing cues). Items with no name are skipped.
export function buildInventoryIndex(inventory) {
  const index = new Map();
  for (const it of inventory || []) {
    if (!it || it.type === "FUSE") continue;
    const key = normalizeItemName(it.name);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(it);
  }
  return index;
}

// Classify one label against an inventory index:
//   { status: "matched" | "ambiguous" | "unmatched", item, candidates }
// - matched:   exactly one inventory item shares the normalized name.
// - ambiguous: several do (user must pick which).
// - unmatched: none (offer catalog import / manual pick / leave generic).
export function matchLabel(label, index) {
  const key = normalizeItemName(label);
  const candidates = key ? index.get(key) || [] : [];
  if (candidates.length === 1) {
    return { status: "matched", item: candidates[0], candidates };
  }
  if (candidates.length > 1) {
    return { status: "ambiguous", item: null, candidates };
  }
  return { status: "unmatched", item: null, candidates: [] };
}

// Distinct cue labels (first-appearance order) with how many cues use each.
export function uniqueLabels(cues) {
  const counts = new Map();
  for (const c of cues || []) {
    const label = (c && c.label) || "Imported cue";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

// Seed label -> inventoryId auto-matches for every unambiguously-matched
// label. Ambiguous / unmatched labels are left unset (null) for the user to
// resolve in the window.
export function autoMatchLabels(cues, inventory) {
  const index = buildInventoryIndex(inventory);
  const out = {};
  for (const { label } of uniqueLabels(cues)) {
    const m = matchLabel(label, index);
    out[label] = m.status === "matched" ? m.item.id : null;
  }
  return out;
}
