// Finale3D "BRP CSV" converter.
//
// Despite the .csv extension, Finale3D's BRP export is tab-separated. The
// base class auto-detects the delimiter, so we just consume rows here.
//
// Column layout (0-based) we care about:
//   1  Event Time   "HH:MM:SS.mmm" — show-relative fire time (00:00:01 = 1s)
//   4  Duration     seconds (float)
//   6  Description  human label, needs cleanup (see parseDescription)
//   12 Rail Address the imported receiver key (e.g. "A", "B")
//   13 Pin Address  the cue number on that receiver
//
// Every data row becomes a single cue. A row's Device Count / Position list
// just means several tubes fire off one pin; we keep it as one cue pinned to
// that pin number.

import { BaseShowConverter } from "./BaseShowConverter";

const COL = {
  EVENT_TIME: 1,
  DURATION: 4,
  DESCRIPTION: 6,
  RAIL_ADDRESS: 12, // imported receiver key
  PIN_ADDRESS: 13, // cue number on that receiver
};

export class Finale3DBrpCsvConverter extends BaseShowConverter {
  static sourceId = "finale3d";
  static typeId = "brp_csv";
  static label = "BRP CSV";
  static accept = ".csv,.tsv,.txt";

  buildConversion(rows) {
    const cues = [];
    const receiverMap = new Map(); // key -> { key, maxTarget, items: [] }

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row) || row.length === 0) continue;

      // Skip a header row (first cell is non-numeric, e.g. "Cue").
      const first = (row[0] || "").trim();
      if (r === 0 && !/^\d+$/.test(first)) continue;

      // Defensive: rows too short to carry a rail/pin address.
      if (row.length <= COL.PIN_ADDRESS) continue;

      const receiverKey = (row[COL.RAIL_ADDRESS] || "").trim();
      const target = parseInt((row[COL.PIN_ADDRESS] || "").trim(), 10);
      if (!receiverKey || !Number.isFinite(target) || target <= 0) continue;

      const startTime = BaseShowConverter.clockToSeconds(row[COL.EVENT_TIME]);
      const durationRaw = parseFloat((row[COL.DURATION] || "").trim());
      const duration =
        Number.isFinite(durationRaw) && durationRaw >= 0 ? durationRaw : 0;
      const label = Finale3DBrpCsvConverter.parseDescription(
        row[COL.DESCRIPTION],
      );

      cues.push({ startTime, duration, target, label, receiverKey });

      let rec = receiverMap.get(receiverKey);
      if (!rec) {
        rec = { key: receiverKey, maxTarget: 0, items: [] };
        receiverMap.set(receiverKey, rec);
      }
      if (target > rec.maxTarget) rec.maxTarget = target;
      rec.items.push({ target, label });
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

    return { sourceId: this.sourceId, typeId: this.typeId, cues, receivers };
  }

  // Derive a clean custom label from the Finale3D Description column.
  //   "(2) Red Strobe (60sec) ..."          -> "Red Strobe"
  //   "Red Strobe (60sec)"                   -> "Red Strobe"
  //   "(2) 36s Multicolor Peony (25sec) ..." -> "36s Multicolor Peony"
  //   "10 Silver Gerb"                       -> "10 Silver Gerb"
  static parseDescription(raw) {
    let s = String(raw == null ? "" : raw).trim();
    if (!s) return "Imported cue";
    // 1) Strip a leading device-count prefix like "(2) ".
    s = s.replace(/^\(\s*\d+\s*\)\s*/, "");
    // 2) Strip a trailing ellipsis ("...", possibly spaced).
    s = s.replace(/\s*\.{2,}\s*$/, "");
    // 3) Strip a single trailing parenthetical annotation like "(60sec)".
    s = s.replace(/\s*\([^)]*\)\s*$/, "");
    // 4) Clean up any residual trailing ellipsis / whitespace.
    s = s.replace(/\s*\.{2,}\s*$/, "").trim();
    return s || "Imported cue";
  }
}

export default Finale3DBrpCsvConverter;
