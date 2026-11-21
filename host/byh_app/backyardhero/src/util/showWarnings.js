// Non-blocking authoring warnings surfaced on the editor's Show Details tab.
// Each warning: { id, kind, title, detail }. Add new rules here.

import { computeSegmentWarnings } from "./segments";
import { RF433_REPEAT_DEFAULT, findBilusocnLateCues, rf433MinSpacingMs } from "./rf433";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Show time as m:ss.ss (timeline seconds can be fractional).
const fmtTime = (sec) => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
};

const fmtDelay = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`);

// opts.bilusocnZones: Set of zone ids owned by Bilusocn entries.
// opts.rf433RepeatCt: the dongle's Bilusocn repeat setting (default 8).
export function computeShowWarnings(items, inventoryById, opts = {}) {
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

  // Bilusocn cues too close together: the base sends one at a time, so
  // later cues in a tight run fire late.
  const repeatCt = opts.rf433RepeatCt ?? RF433_REPEAT_DEFAULT;
  const spacingMs = rf433MinSpacingMs(repeatCt);
  for (const c of findBilusocnLateCues(items, opts.bilusocnZones, repeatCt)) {
    const span = c.toSec > c.fromSec
      ? `from ${fmtTime(c.fromSec)} to ${fmtTime(c.toSec)}`
      : `at ${fmtTime(c.fromSec)}`;
    out.push({
      id: `rf433-spacing:${c.firstItemId}`,
      kind: "rf433-spacing",
      itemId: c.firstItemId,
      itemIds: c.itemIds,
      title: `Bilusocn cues too close together at ${fmtTime(c.fromSec)}`,
      detail:
        `${plural(c.count, "Bilusocn cue")} ${span} need at least ${spacingMs} ms between them ` +
        `at ${repeatCt} ${repeatCt === 1 ? "repeat" : "repeats"}. The base sends them one at a time, ` +
        `so the last one fires up to ${fmtDelay(c.maxLateMs)} late. Spread them out, or lower ` +
        `Bilusocn repeats in the dongle settings.`,
    });
  }

  return out;
}
