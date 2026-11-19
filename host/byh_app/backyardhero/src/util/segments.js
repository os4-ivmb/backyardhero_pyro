// Piece segments ("sections"): an inventory cake/fountain/compound can be
// broken down into ordered sections that are fired independently, e.g. a
// compound cake sliced apart into its component cakes.
//
// Storage: `item.metadata.segments = [{ id, name, duration, color }]`. Array
// order IS the section index (1-based for display). Cues placed from a
// section carry `segmentId` (stable across reorders) and get their
// duration/colour re-derived from the live segment on hydrate.

export const SEGMENTABLE_TYPES = new Set([
  "CAKE_FOUNTAIN",
  "CAKE_200G",
  "CAKE_350G",
  "CAKE_500G",
  "COMPOUND_CAKE",
]);

export const isSegmentableType = (type) => SEGMENTABLE_TYPES.has(type);

export const parseMetadata = (metadata) => {
  if (!metadata) return {};
  if (typeof metadata === "object") return metadata;
  try {
    const m = JSON.parse(metadata);
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
};

// Segments defined on an inventory item (empty array when none / not a
// segmentable type).
export const getSegments = (item) => {
  if (!item || !isSegmentableType(item.type)) return [];
  const segs = parseMetadata(item.metadata).segments;
  return Array.isArray(segs) ? segs.filter((s) => s && s.id) : [];
};

export const hasSegments = (item) => getSegments(item).length > 0;

export const newSegmentId = () =>
  `seg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// Dropdown / table label: the section's own name, else its index.
export const segmentLabel = (seg, index) =>
  seg?.name && String(seg.name).trim() ? String(seg.name).trim() : `Section ${index + 1}`;

// Cue name for a section of a piece: "<piece name>[<index>]".
export const segmentCueName = (pieceName, index) => `${pieceName}[${index + 1}]`;

// Locate a cue's segment on its inventory item. Returns { seg, index, count }
// or null when the cue isn't a section (or the section was deleted).
export const findCueSegment = (cue, invItem) => {
  if (!cue || cue.segmentId == null || !invItem) return null;
  const segs = getSegments(invItem);
  const index = segs.findIndex((s) => s.id === cue.segmentId);
  if (index < 0) return null;
  return { seg: segs[index], index, count: segs.length };
};

// Overlay the live segment's timing/colour/index onto a hydrated cue. Call
// after merging the inventory item into the cue.
export const applySegmentToCue = (cue, invItem) => {
  const found = findCueSegment(cue, invItem);
  if (!found) return cue;
  const { seg, index, count } = found;
  const out = { ...cue, segmentIndex: index, segmentCount: count };
  const d = Number(seg.duration);
  if (seg.duration !== "" && seg.duration != null && Number.isFinite(d)) out.duration = d;
  if (seg.color) out.color = seg.color;
  // Keep an auto-generated "<piece>[n]" label in step with the section's
  // current index (sections can be reordered after cues are placed). Custom
  // labels are left alone.
  if (invItem.name && typeof cue.name === "string") {
    const prefix = `${invItem.name}[`;
    if (cue.name.startsWith(prefix) && /^\d+\]$/.test(cue.name.slice(prefix.length))) {
      out.name = segmentCueName(invItem.name, index);
    }
  }
  return out;
};

// Cue-allocation notation for a section cue: "<piece name>:<index>" plus the
// section's label when it has one. Null for whole-piece cues.
export const cueSegmentNotation = (cue, invItem) => {
  const found = findCueSegment(cue, invItem);
  if (!found) return null;
  const idx = found.index + 1;
  return {
    piece: invItem.name,
    index: idx,
    count: found.count,
    label: found.seg.name ? String(found.seg.name).trim() : "",
    text: `${invItem.name}:${idx}`,
  };
};

// Section usage across a show's cues: itemId (string) -> Map(segmentId -> count),
// counting `multiple`.
export const collectSectionUsage = (items) => {
  const usage = new Map();
  for (const it of items || []) {
    if (it?.itemId == null || it.segmentId == null) continue;
    const key = String(it.itemId);
    if (!usage.has(key)) usage.set(key, new Map());
    const m = usage.get(key);
    const n = Math.max(1, Math.floor(Number(it.multiple) || 1));
    m.set(it.segmentId, (m.get(it.segmentId) || 0) + n);
  }
  return usage;
};

const lookupInv = (inventoryById, itemId) =>
  inventoryById?.[itemId] ?? inventoryById?.[Number(itemId)] ?? null;

// Physical pieces that must be sliced for a show. A piece is used `pieces`
// times = the highest usage count across its sections (counting `multiple`).
// Returns [{ itemId, inv, pieces, segmentCount, segments, counts }].
export const slicedPieceCounts = (items, inventoryById) => {
  const out = [];
  for (const [itemId, m] of collectSectionUsage(items)) {
    const inv = lookupInv(inventoryById, itemId);
    const segs = getSegments(inv);
    if (!segs.length) continue;
    const counts = segs.map((sg) => m.get(sg.id) || 0);
    const pieces = Math.max(0, ...counts);
    if (pieces === 0) continue;
    out.push({ itemId, inv, pieces, segmentCount: segs.length, segments: segs, counts });
  }
  return out;
};

// Index inventory as an id map (accepts an array or an existing map).
export const toInventoryById = (inventory) => {
  if (!inventory) return {};
  if (!Array.isArray(inventory)) return inventory;
  const map = {};
  for (const inv of inventory) if (inv && inv.id != null) map[inv.id] = inv;
  return map;
};

// Warnings for partially-used segmented pieces: every section used fewer
// times than the piece count is under-utilised.
// Returns [{ itemId, pieceName, pieces, segmentCount, missing: [{ index, label, used, need }] }]
export const computeSegmentWarnings = (items, inventoryById) => {
  const warnings = [];
  for (const p of slicedPieceCounts(items, inventoryById)) {
    const missing = p.segments
      .map((sg, i) => ({ index: i, label: segmentLabel(sg, i), used: p.counts[i], need: p.pieces - p.counts[i] }))
      .filter((x) => x.need > 0);
    if (missing.length) {
      warnings.push({
        itemId: p.itemId, pieceName: p.inv.name, pieces: p.pieces,
        segmentCount: p.segmentCount, missing,
      });
    }
  }
  return warnings;
};

// Whether a cue fires a (still-existing) section of its piece.
export const isSectionCue = (cue, invItem) => !!findCueSegment(cue, invItem);

// Loadout "Items to Pack": fold section cues into one entry per base piece
// with a slicing note. `itemCounts` is the loadout's { key: entry } map keyed
// `${name}-${type}`; section cues must have been skipped when building it.
export const addSlicedPiecesToPack = (itemCounts, items, inventory) => {
  for (const p of slicedPieceCounts(items, toInventoryById(inventory))) {
    const key = `${p.inv.name}-${p.inv.type}`;
    if (!itemCounts[key]) {
      itemCounts[key] = {
        name: p.inv.name, type: p.inv.type, itemId: p.inv.id,
        image: p.inv.image || null, count: 0,
      };
    }
    itemCounts[key].count += p.pieces;
    itemCounts[key].slicePieces = (itemCounts[key].slicePieces || 0) + p.pieces;
    itemCounts[key].sliceInto = p.segmentCount;
  }
  return itemCounts;
};

// Human note for a pack entry, e.g. "Slice 2 into 4 sections each".
export const sliceNote = (entry) => {
  if (!entry?.slicePieces) return null;
  const n = entry.slicePieces;
  return `Slice ${n === entry.count ? (n === 1 ? "it" : "all " + n) : n} into ${entry.sliceInto} sections${n > 1 ? " each" : ""}`;
};
