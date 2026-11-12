// Phone-app export of the staged show. The Android app only needs receiver
// ids, cues, and times — and, for a manual sequence, the step bins.
//
//   {
//     format: "byh-app-show", version: 1,
//     id, name, durationSec,
//     type: "timeline" | "manual_sequence",
//     cues: [{ zone, target, timeMs, name?, kind: "native"|"bilusocn", stepId? }],
//     steps?: [{ id, fireMode: "simultaneous"|"staggered", intervalMs }]
//   }
//
// timeMs is (startTime - delay) in milliseconds, minimum 1, which is the
// same instant the receivers are programmed with. Sequence cues keep the
// order the console fires them in (step order, then item order). Cues that
// don't belong to a step are left out, matching the console.

import { isBilusocnEntry } from "./showReceivers";
import { groupItemsIntoSteps, isManualSequenceShow, showConfigOf } from "./showConfig";

export function buildAppShow(show) {
  const sequence = isManualSequenceShow(show);
  const kinds = new Map();
  for (const entry of Array.isArray(show?.showReceivers) ? show.showReceivers : []) {
    if (entry?.id == null) continue;
    kinds.set(String(entry.id), isBilusocnEntry(entry) ? "bilusocn" : "native");
  }

  const items = Array.isArray(show?.items) ? show.items : [];
  let ordered = items;
  let steps;
  if (sequence) {
    const groups = groupItemsIntoSteps(showConfigOf(show).steps, items);
    steps = groups.map((g) => ({ id: g.id, fireMode: g.fireMode, intervalMs: g.intervalMs }));
    ordered = groups.flatMap((g) => g.items);
  }

  const cues = [];
  for (const it of ordered) {
    if (it?.zone == null || it.zone === "" || it.zone === "null" || it.target == null) continue;
    const zone = String(it.zone);
    const target = Number(it.target);
    if (!Number.isFinite(target) || target < 1) continue;
    const kind = kinds.get(zone) || (/^\d+$/.test(zone) ? "bilusocn" : "native");
    const timeMs = Math.max(
      1,
      Math.round(((Number(it.startTime) || 0) - (Number(it.delay) || 0)) * 1000),
    );
    const cue = { zone, target, timeMs, kind };
    if (it.name) cue.name = String(it.name);
    if (sequence && it.stepId != null) cue.stepId = String(it.stepId);
    cues.push(cue);
  }

  const id = Number(show?.id);
  const out = {
    format: "byh-app-show",
    version: 1,
    id: Number.isFinite(id) ? id : 1,
    name: show?.name || "Show",
    durationSec: Number(show?.duration) || 0,
    type: sequence ? "manual_sequence" : "timeline",
    cues,
  };
  if (sequence) out.steps = steps;
  return out;
}

export function downloadAppShow(show) {
  const data = buildAppShow(show);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safe = String(show?.name || "show").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "show";
  a.href = url;
  a.download = `${safe}.byh.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
