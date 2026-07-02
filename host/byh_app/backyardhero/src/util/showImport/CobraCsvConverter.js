// COBRA firing-system CSV (script export) converter.
//
// A COBRA script CSV has three sections, each introduced by a `#`-prefixed
// header line, plus a trailing `END`:
//
//   #@firmware6.1
//   #Trigger Channel,#Trigger Button,...,#Script Name,...   <- script header
//   0,Autofire,,0,,Mystic Spirit,,,2,                        <- script values
//   #Event Time,#Channel,#Cue,#Event Description,...         <- event header
//   00:00.00s,1,1,Grand Union,,                              <- event rows
//   00:04.00s,1,2,Grand Union,,
//   ...
//   END
//
// Event columns (0-based) we care about:
//   0  Event Time        "MM:SS.mmm" with a trailing "s" (00:04.00s = 4s)
//   1  Channel           the module / receiver key (1, 2, ...)
//   2  Cue               the cue number on that channel
//   3  Event Description human label
//
// COBRA events are instantaneous fires — the script has no per-cue duration —
// so every event becomes a zero-duration cue. `#Script Name` from the script
// values row is surfaced as `suggestedName` to pre-fill the show name.

import { BaseShowConverter } from "./BaseShowConverter";

const COL = {
  EVENT_TIME: 0,
  CHANNEL: 1, // imported receiver key
  CUE: 2, // cue number on that receiver
  DESCRIPTION: 3,
};

// An event row's first cell is a COBRA clock like "00:04.00s" (the trailing
// "s" is optional; hours are allowed defensively). This distinguishes event
// rows from the script-values row (first cell "0", no colon).
const EVENT_TIME_RE = /^\d{1,3}:\d{1,2}(:\d{1,2})?(\.\d+)?s?$/i;

export class CobraCsvConverter extends BaseShowConverter {
  static sourceId = "cobra";
  static typeId = "script_csv";
  static label = "Script CSV";
  static accept = ".csv,.txt";

  buildConversion(rows) {
    const cues = [];
    const receiverMap = new Map(); // key -> { key, maxTarget, items: [] }

    let scriptNameCol = -1; // column of "#Script Name" in the script header
    let suggestedName = "";

    for (const row of rows) {
      if (!Array.isArray(row) || row.length === 0) continue;
      const first = (row[0] || "").trim();
      if (!first && row.length <= 1) continue;

      // Header lines start with `#`. Note where "#Script Name" lives so we can
      // read it out of the following values row.
      if (first.startsWith("#")) {
        const idx = row.findIndex(
          (c) => (c || "").trim().toLowerCase() === "#script name",
        );
        if (idx >= 0) scriptNameCol = idx;
        continue;
      }

      if (first.toUpperCase() === "END") continue;

      if (EVENT_TIME_RE.test(first)) {
        const receiverKey = (row[COL.CHANNEL] || "").trim();
        const target = parseInt((row[COL.CUE] || "").trim(), 10);
        if (!receiverKey || !Number.isFinite(target) || target <= 0) continue;

        const startTime = BaseShowConverter.clockToSeconds(first);
        const label = (row[COL.DESCRIPTION] || "").trim() || "Imported cue";

        cues.push({ startTime, duration: 0, target, label, receiverKey });

        let rec = receiverMap.get(receiverKey);
        if (!rec) {
          rec = { key: receiverKey, maxTarget: 0, items: [] };
          receiverMap.set(receiverKey, rec);
        }
        if (target > rec.maxTarget) rec.maxTarget = target;
        rec.items.push({ target, label });
        continue;
      }

      // Non-header, non-event, non-END: the script-values row that follows the
      // script header. Pull the show name out of it.
      if (scriptNameCol >= 0 && !suggestedName && scriptNameCol < row.length) {
        suggestedName = (row[scriptNameCol] || "").trim();
      }
    }

    const receivers = [...receiverMap.values()].map((rec) => ({
      key: rec.key,
      maxTarget: rec.maxTarget,
      neededCues: BaseShowConverter.ceilCues(rec.maxTarget),
      items: rec.items.slice().sort((a, b) => a.target - b.target),
    }));
    receivers.sort((a, b) =>
      String(a.key).localeCompare(String(b.key), undefined, { numeric: true }),
    );

    return {
      sourceId: this.sourceId,
      typeId: this.typeId,
      cues,
      receivers,
      suggestedName: suggestedName || undefined,
    };
  }
}

export default CobraCsvConverter;
