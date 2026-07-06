// Finale3D native show converter (".fin").
//
// A .fin file is a ZIP archive; the show data lives in a tab-separated
// `show_tables.txt` member made of several stacked tables, each row prefixed
// with `##<table>Header` / `##<table>Row`:
//
//   ##partsHeader   insertButton  partNumber  ... description ...
//   ##partsRow      P10000        P10000      ... Grand Union ...
//   ##scriptHeader  externalDelay actionTime  partNumber duration ... railAddress pinAddress ...
//   ##scriptRow                   00:00.000   G5032      65.58    ... 1           1          ...
//
// Every `##scriptRow` with a rail+pin address is one cue:
//   actionTime  -> startTime   ("MM:SS.mmm")
//   duration    -> duration    (seconds)
//   railAddress -> receiverKey (the imported receiver/module)
//   pinAddress  -> target      (cue number on that receiver)
//   partNumber  -> label       (resolved to the part's description)
//
// Columns are resolved by header name (not fixed index) so a differing export
// column order still imports. Unlike the BRP CSV export, a .fin is binary, so
// we override convert() to unzip first, then reuse the shared row parser.

import { BaseShowConverter } from "./BaseShowConverter";
import { readZipTextEntry } from "./zip";

const SHOW_TABLES_ENTRY = "show_tables.txt";

export class Finale3DFinConverter extends BaseShowConverter {
  static sourceId = "finale3d";
  static typeId = "fin";
  static label = "Finale3D Show (.fin)";
  static accept = ".fin,.zip";

  async convert(file, { onProgress } = {}) {
    onProgress?.(5);
    const buf = await this.readFileArrayBuffer(file);
    onProgress?.(30);
    const text = await readZipTextEntry(buf, SHOW_TABLES_ENTRY);
    if (text == null) {
      throw new Error(
        `This .fin has no "${SHOW_TABLES_ENTRY}" — is it a Finale3D show export?`,
      );
    }
    onProgress?.(55);
    const rows = this.parseDelimited(text);
    onProgress?.(75);
    const conversion = this.buildConversion(rows);
    onProgress?.(100);
    return conversion;
  }

  readFileArrayBuffer(file) {
    if (file && typeof file.arrayBuffer === "function") return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error("Failed to read file"));
      fr.readAsArrayBuffer(file);
    });
  }

  buildConversion(rows) {
    const partsCols = {};
    const scriptCols = {};
    const partDesc = new Map(); // partNumber -> description
    const scriptRows = [];

    // Map a `##...Header` row to { columnName: index }. Field names start at
    // index 1 (index 0 is the `##table` tag).
    const mapHeader = (row) => {
      const cols = {};
      for (let i = 1; i < row.length; i++) {
        const name = (row[i] || "").trim();
        if (name && !(name in cols)) cols[name] = i;
      }
      return cols;
    };

    for (const row of rows) {
      if (!Array.isArray(row) || row.length === 0) continue;
      const tag = (row[0] || "").trim();
      switch (tag) {
        case "##partsHeader":
          Object.assign(partsCols, mapHeader(row));
          break;
        case "##partsRow": {
          const pn = (row[partsCols.partNumber] || "").trim();
          if (pn) partDesc.set(pn, (row[partsCols.description] || "").trim());
          break;
        }
        case "##scriptHeader":
          Object.assign(scriptCols, mapHeader(row));
          break;
        case "##scriptRow":
          scriptRows.push(row);
          break;
        default:
          break;
      }
    }

    const cues = [];
    const receiverMap = new Map(); // key -> { key, maxTarget, items: [] }

    for (const row of scriptRows) {
      const receiverKey = (row[scriptCols.railAddress] || "").trim();
      const target = parseInt((row[scriptCols.pinAddress] || "").trim(), 10);
      // Skip rows with no firing address (e.g. DMX-only cues).
      if (!receiverKey || !Number.isFinite(target) || target <= 0) continue;

      const startTime = BaseShowConverter.clockToSeconds(
        row[scriptCols.actionTime],
      );
      const durationRaw = parseFloat((row[scriptCols.duration] || "").trim());
      const duration =
        Number.isFinite(durationRaw) && durationRaw >= 0 ? durationRaw : 0;
      const pn = (row[scriptCols.partNumber] || "").trim();
      const label = (partDesc.get(pn) || pn || "").trim() || "Imported cue";

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
}

export default Finale3DFinConverter;
