// Base class for "import a show from another system" converters.
//
// The whole import feature is built around a small, modular contract so
// adding a new source (or a new file type within a source) is just a new
// subclass + a registry entry — shared plumbing (file reading, tolerant
// delimited parsing, clock parsing, receiver matching, and building the
// final createShow payload) all lives here.
//
// A subclass implements exactly one method, `buildConversion(rows)`, which
// turns raw parsed rows into the canonical ConversionResult:
//
//   {
//     sourceId, typeId,
//     cues: [{ startTime, duration, target, label, receiverKey }],
//     receivers: [{ key, maxTarget, neededCues, items: [{ target, label }] }],
//   }
//
//   - startTime / duration are seconds (floats ok).
//   - receiverKey is the *imported* receiver identifier (e.g. a Finale3D
//     Rail Address like "A"). It is matched against the operator's real
//     receivers in the resolve step; it is NOT a DB receiver id.
//   - target is the cue number on that receiver.
//   - neededCues is maxTarget ceiled to a supported receiver cue count
//     (a multiple of 8) — the size we'll provision the show receiver at.

import { SHOW_RECEIVER_CUE_OPTIONS } from "@/util/showReceivers";

export class BaseShowConverter {
  // Subclasses override these statics.
  static sourceId = "";
  static typeId = "";
  static label = "";
  // `accept` attribute for the file input on the source-specific panel.
  static accept = ".csv";

  get sourceId() {
    return this.constructor.sourceId;
  }
  get typeId() {
    return this.constructor.typeId;
  }

  // Orchestration: read the file → parse rows → build the canonical
  // conversion. `onProgress(pct)` is called with a 0-100 number so the UI
  // can drive the processing bar.
  async convert(file, { onProgress } = {}) {
    onProgress?.(5);
    const text = await this.readFileText(file);
    onProgress?.(35);
    const rows = this.parseDelimited(text);
    onProgress?.(65);
    const conversion = this.buildConversion(rows);
    onProgress?.(100);
    return conversion;
  }

  readFileText(file) {
    if (file && typeof file.text === "function") return file.text();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(fr.error || new Error("Failed to read file"));
      fr.readAsText(file);
    });
  }

  // Tolerant delimited parser. Auto-detects tab vs comma from the header
  // line (Finale3D "CSV" exports are actually tab-separated, so tab wins
  // when present) and supports double-quoted fields with "" escaping.
  parseDelimited(text) {
    const clean = String(text || "").replace(/^\uFEFF/, ""); // strip BOM
    const firstLine = clean.split(/\r?\n/, 1)[0] || "";
    const delim = firstLine.includes("\t") ? "\t" : ",";
    return BaseShowConverter.parseRows(clean, delim);
  }

  static parseRows(text, delim) {
    const rows = [];
    let field = "";
    let row = [];
    let inQuotes = false;
    // True only at the very start of a field. RFC4180 quoting applies only
    // when a `"` is the first character of a field; otherwise `"` is a
    // literal character. This matters because Finale3D's tab-separated
    // export uses `"` as an inch mark (e.g. `1.8"`, `2"`) mid-field — those
    // must NOT be treated as quote delimiters or whole rows merge together.
    let atFieldStart = true;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"' && atFieldStart) {
        inQuotes = true;
        atFieldStart = false;
        continue;
      }
      if (ch === delim) {
        atFieldStart = true;
        row.push(field);
        field = "";
        continue;
      }
      if (ch === "\n") {
        atFieldStart = true;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        continue;
      }
      if (ch === "\r") continue;
      field += ch;
      atFieldStart = false;
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  // Subclasses produce the canonical ConversionResult from raw rows.
  // eslint-disable-next-line no-unused-vars
  buildConversion(rows) {
    throw new Error(`${this.constructor.name} must implement buildConversion()`);
  }

  // ── Shared helpers ─────────────────────────────────────────────────────

  // "HH:MM:SS(.mmm)" / "MM:SS(.mmm)" / "SS(.mmm)" → seconds (float).
  // Returns 0 on anything unparseable.
  static clockToSeconds(str) {
    if (str == null) return 0;
    const s = String(str).trim();
    if (!s) return 0;
    const parts = s.split(":").map((p) => parseFloat(p));
    if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return 0;
    let secs = 0;
    for (const p of parts) secs = secs * 60 + p;
    return secs;
  }

  // Round a max cue/target up to the nearest supported show-receiver cue
  // count (multiples of 8, clamped to the configured min/max). A receiver
  // module is 8 cues, so 11 → 16, 32 → 32, etc.
  static ceilCues(maxTarget) {
    const n = Math.max(1, Math.ceil(Number(maxTarget) || 0));
    for (const opt of SHOW_RECEIVER_CUE_OPTIONS) {
      if (opt >= n) return opt;
    }
    return SHOW_RECEIVER_CUE_OPTIONS[SHOW_RECEIVER_CUE_OPTIONS.length - 1];
  }

  // Match an imported receiver key against the live DB receivers map
  // (id -> def). Tries the ident (case-insensitive) first, then the label
  // (case-insensitive). Only enabled receivers are considered. Returns the
  // matched receiver id (the map key) or null.
  static matchReceiverId(key, dbReceivers) {
    if (!key || !dbReceivers) return null;
    const want = String(key).trim().toLowerCase();
    if (!want) return null;
    const entries = Object.entries(dbReceivers).filter(
      ([, def]) => def && def.enabled !== false,
    );
    for (const [id] of entries) {
      if (String(id).trim().toLowerCase() === want) return id;
    }
    for (const [id, def] of entries) {
      const label = def.label ? String(def.label).trim().toLowerCase() : "";
      if (label && label === want) return id;
    }
    return null;
  }

  // Build the createShow() payload from a conversion, the user's receiver
  // resolutions (importedReceiverKey -> chosen DB receiver id), the item
  // matches (cue label -> inventory id, from the "Match items" step) and the
  // finalize-step metadata.
  //
  // A cue whose label matched an inventory item becomes a real inventory-backed
  // display item (its `itemId` links back to inventory; color/cost/image are
  // re-hydrated from there on load). An unmatched cue stays a GENERIC display
  // item carrying its own name/duration. Both are pinned to the resolved
  // receiver (`zone`) and cue number (`target`).
  //
  // The `importSource` tag is what marks the show as imported — there is no
  // dedicated DB column; readers detect it from display_payload (see
  // isImportedShow.js). It is whitelisted in the builder's
  // SAVEABLE_ITEM_ATTRIBUTES so it survives a later edit/re-save.
  static buildShowPayload({
    conversion,
    resolutions,
    name,
    authorization_code,
    protocol,
    itemMatches,
    inventoryById,
  }) {
    const res = resolutions || {};
    const matches = itemMatches || {};
    const invById = inventoryById || {};
    const importSource = conversion?.sourceId || "import";

    const display = (conversion?.cues || []).map((c, i) => {
      const startTime = Number.isFinite(c.startTime) ? c.startTime : 0;
      const zone = res[c.receiverKey] || "";
      const matchedId = matches[c.label];
      const inv = matchedId != null ? invById[matchedId] : null;

      if (inv) {
        // Delay contributed by the physical item, matching the add-item modal:
        // fuse burn + (aerial) lift. Inventory-derived visuals/cost rehydrate
        // from itemId on load, so we only persist the linking + timing fields.
        const fuseDelay = Number(inv.fuse_delay ?? inv.fuseDelay ?? 0) || 0;
        const liftDelay =
          inv.type === "AERIAL_SHELL" ? Number(inv.lift_delay) || 0 : 0;
        // Inventory duration wins when present; otherwise keep the cue's own
        // (a null/blank inventory duration must not zero out a .fin duration).
        const invDuration =
          inv.duration != null ? Number(inv.duration) : NaN;
        return {
          id: i,
          type: inv.type || "GENERIC",
          itemId: inv.id,
          name: c.label || inv.name || "Imported cue",
          duration: Number.isFinite(invDuration)
            ? invDuration
            : Number.isFinite(c.duration)
              ? c.duration
              : 0,
          startTime,
          delay: fuseDelay + liftDelay,
          zone,
          target: c.target,
          importSource,
        };
      }

      return {
        id: i,
        type: "GENERIC",
        name: c.label || "Imported cue",
        duration: Number.isFinite(c.duration) ? c.duration : 0,
        startTime,
        delay: 0,
        zone,
        target: c.target,
        importSource,
      };
    });
    const show_receivers = (conversion?.receivers || []).map((r) => ({
      id: res[r.key] || "",
      kind: "native",
      cues: r.neededCues,
    }));
    const duration = display.length
      ? Math.round(
          Math.max(...display.map((d) => (d.startTime || 0) + (d.duration || 0))),
        )
      : 0;
    return {
      name,
      duration,
      version: 1,
      runtime_version: "0",
      runtime_payload: "{}",
      display_payload: JSON.stringify(display),
      authorization_code,
      protocol,
      show_receivers: JSON.stringify(show_receivers),
    };
  }
}

export default BaseShowConverter;
