/**
 * Optional cost per unit, stored with 2 decimal places.
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseOptionalUnitCost(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/,/g, ''));
  if (Number.isNaN(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}
