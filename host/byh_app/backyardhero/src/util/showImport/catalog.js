// Catalog access for the show-import "Match items" step.
//
// The catalog (public product database) is a flat list of records loaded from
// /api/catalog. During import we use it to offer, for an imported cue name
// that isn't in the operator's inventory yet, a one-click "import from catalog"
// that adds the product to inventory so the cue can link to it.
//
// The record → inventory payload mapping mirrors ImportCatalogModal exactly so
// catalog-imported items look identical however they were added.

import { apiUrl } from "@/util/clientEnv";
import { normalizeItemName } from "./itemMatch";

// Fetch all catalog records. Returns [] when the catalog file isn't present
// (404) so the caller can degrade gracefully (matching still works, there's
// just nothing to import). Throws on other/network errors.
export async function fetchCatalogRecords() {
  const res = await fetch(apiUrl("/api/catalog"));
  if (res.status === 404) return [];
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to load catalog (HTTP ${res.status}).`);
  }
  const data = await res.json();
  return Array.isArray(data?.records) ? data.records : [];
}

// normalizedName -> [catalog records], for suggesting an import per cue label.
export function buildCatalogIndex(records) {
  const index = new Map();
  for (const rec of records || []) {
    const key = normalizeItemName(rec?.fw_name);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(rec);
  }
  return index;
}

// Best catalog suggestion for a label (first normalized-name match), or null.
export function suggestCatalogRecord(label, index) {
  const key = normalizeItemName(label);
  const hits = key ? index.get(key) || [] : [];
  return hits[0] || null;
}

// Map a catalog record to a createInventoryItem() payload. Mirrors
// ImportCatalogModal.handleImport: required-field defaults per type, catalog
// fields carried over, `source: "imported"`.
export function catalogRecordToInventoryPayload(rec) {
  const type = rec?.type || "UNKNOWN";
  let fuse_delay = null;
  let lift_delay = null;
  let burn_rate = null;
  let color = null;
  if (type === "FUSE") {
    burn_rate = 1.0;
    color = "#FFFFFF";
  } else if (type === "AERIAL_SHELL") {
    fuse_delay = 0.0;
    lift_delay = 0.0;
  }
  return {
    name: rec?.fw_name || "Unnamed",
    type,
    duration: rec?.duration && rec.duration > 0 ? rec.duration : null,
    fuse_delay,
    lift_delay,
    burn_rate,
    color,
    available_ct: 0,
    youtube_link: rec?.yt_url || null,
    youtube_link_start_sec: null,
    image: null,
    metadata: null,
    source: "imported",
  };
}
