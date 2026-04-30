/**
 * Key for counting how many times a pack shell (inventory aerial + shell #) appears
 * in timeline RACK_SHELLS cues and/or rack grid cells.
 * String-normalizes ids so API numbers and inventory ids match.
 */
export function shellPackShellKey(shellId, shellNumber) {
  const id = shellId == null ? '' : String(shellId);
  const n = shellNumber === null || shellNumber === undefined ? 'any' : String(shellNumber);
  return `${id}_${n}`;
}

/**
 * Inverse of shellPackShellKey (numeric shell ids only; ids are written without underscores).
 * @param {string} key
 * @returns {{ shellId: number|string, shellNumber: number|null }|null}
 */
export function parseShellPackShellKey(key) {
  if (typeof key !== 'string' || !key.length) return null;
  const i = key.lastIndexOf('_');
  if (i <= 0) return null;
  const idPart = key.slice(0, i);
  const nPart = key.slice(i + 1);
  const shellNumber = nPart === 'any' ? null : Number(nPart);
  const shellId = /^\d+$/.test(idPart) ? Number(idPart) : idPart;
  if (nPart !== 'any' && Number.isNaN(shellNumber)) return null;
  return { shellId, shellNumber };
}

function addUsage(counts, shellId, shellNumber) {
  if (shellId == null) return;
  const k = shellPackShellKey(shellId, shellNumber);
  counts.set(k, (counts.get(k) || 0) + 1);
}

/** @param {...Map<string, number>} maps */
export function mergeShellUsageCounts(...maps) {
  const out = new Map();
  for (const m of maps) {
    if (!m) continue;
    for (const [k, v] of m) {
      out.set(k, (out.get(k) || 0) + v);
    }
  }
  return out;
}

/**
 * Count shells placed on rack grids (all racks in the show).
 * @param {Array<{ cells?: Record<string, { shellId?: number, shellNumber?: number|null }> }>} racks
 * @returns {Map<string, number>}
 */
export function buildShellUsageCountsFromRacks(racks) {
  const counts = new Map();
  if (!racks || !Array.isArray(racks)) return counts;

  for (const rack of racks) {
    const cells = rack.cells || {};
    for (const cellData of Object.values(cells)) {
      if (cellData && cellData.shellId != null) {
        addUsage(counts, cellData.shellId, cellData.shellNumber);
      }
    }
  }

  return counts;
}

/**
 * Count shells only for rack cells assigned in the show (RACK_SHELLS items with rackCells).
 * Each physical cell counts once (deduped by rack id + cell key) for packing lists.
 * @param {Array} items - show timeline items
 * @param {Array<{ id: unknown, cells?: Record<string, { shellId?: number, shellNumber?: number|null }> }>} racks
 * @returns {Map<string, number>}
 */
export function buildShellUsageCountsFromRackCellAssignments(items, racks) {
  const counts = new Map();
  if (!items || !Array.isArray(items) || !racks || !Array.isArray(racks)) return counts;

  const rackById = new Map();
  for (const rack of racks) {
    rackById.set(parseInt(String(rack.id), 10), rack);
  }

  const seen = new Set();
  for (const item of items) {
    if (item.type !== 'RACK_SHELLS' || !item.rackCells?.length || item.rackId == null) continue;
    const rackIdNum = parseInt(String(item.rackId), 10);
    const rack = rackById.get(rackIdNum);
    if (!rack) continue;
    const cells = rack.cells || {};

    for (const cellKey of item.rackCells) {
      const dedupeKey = `${rackIdNum}:${cellKey}`;
      if (seen.has(dedupeKey)) continue;
      const cellData = cells[cellKey];
      if (!cellData || cellData.shellId == null) continue;
      seen.add(dedupeKey);
      addUsage(counts, cellData.shellId, cellData.shellNumber);
    }
  }

  return counts;
}

/**
 * @param {Array} items - show timeline items
 * @returns {Map<string, number>}
 */
export function buildShellUsageCountsFromShowItems(items) {
  const counts = new Map();
  if (!items || !Array.isArray(items)) return counts;

  for (const item of items) {
    if (item.type !== 'RACK_SHELLS' || !item.fireableItem) continue;
    const fi = item.fireableItem;

    if (fi.type === 'fused' && Array.isArray(fi.cellData)) {
      for (const cd of fi.cellData) {
        if (cd) addUsage(counts, cd.shellId, cd.shellNumber);
      }
    } else if (fi.type === 'single' && fi.cellData) {
      const cd = Array.isArray(fi.cellData) ? fi.cellData[0] : fi.cellData;
      if (cd) addUsage(counts, cd.shellId, cd.shellNumber);
    }
  }

  return counts;
}
