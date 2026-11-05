/**
 * Required non-negative numbers such as aerial-shell fuse and lift delay.
 * Zero is a real value (ematched shells have no fuse delay), so only a blank,
 * non-numeric, or negative value counts as missing.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMissingNonNegative(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  const n = typeof value === 'number' ? value : Number(value);
  return !Number.isFinite(n) || n < 0;
}
