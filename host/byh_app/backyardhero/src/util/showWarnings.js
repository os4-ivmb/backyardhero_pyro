// Non-blocking authoring warnings surfaced on the editor's Show Details tab.
// Each warning: { id, kind, title, detail }. Add new rules here.

import { computeSegmentWarnings } from "./segments";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function computeShowWarnings(items, inventoryById) {
  const out = [];

  // Partially-used segmented pieces: every section must be used as many
  // times as the most-used section, or the rest of each sliced piece is wasted.
  for (const w of computeSegmentWarnings(items, inventoryById)) {
    const parts = w.missing.map((m) =>
      `${m.label} ×${m.need}` + (m.used ? ` (used ${m.used} of ${w.pieces})` : "")
    );
    out.push({
      id: `segments:${w.itemId}`,
      kind: "segments",
      itemId: w.itemId,
      title: `${w.pieceName}: unused sections`,
      detail:
        `${plural(w.pieces, "piece")} sliced into ${w.segmentCount} sections. ` +
        `Also place ${parts.join(", ")} to fully use ${w.pieces === 1 ? "it" : "them"}.`,
      missing: w.missing,
    });
  }

  return out;
}
