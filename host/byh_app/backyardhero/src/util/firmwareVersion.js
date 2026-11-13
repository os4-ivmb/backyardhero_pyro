// Firmware version helpers (client-safe). Versions are plain integers
// everywhere: the dongle heartbeat `fw`, the receiver `fw_version`, and the
// `version` field in the static-site latest.json. Comparison is just
// running < latest, but every input can be null/undefined/string, so these
// helpers normalize and stay null-safe.

export function normalizeVersion(v) {
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * True only when we know both versions AND running is strictly older than
 * latest. Unknown inputs (null, non-numeric, or no latest fetched) return
 * false so the UI shows no warning rather than a misleading one.
 */
export function fwOutOfDate(running, latest) {
  const r = normalizeVersion(running);
  const l = normalizeVersion(latest);
  if (r == null || l == null) return false;
  return r < l;
}

// ---------------------------------------------------------------------------
// Firmware products. Versions are only comparable WITHIN a product: an omni
// at v35 and a dedicated receiver at v31 are on independent counters. The
// catalog is keyed by product, and the product is picked from the hardware's
// reported board type (+ role, for dedicated boards) -- never from the
// firmware number.
//
//   board type 0 (dedicated) + receiver role -> os4_receiver
//   board type 0 (dedicated) + dongle role   -> os4_dongle
//   board type 1 (omni)      + either role   -> byh_omni (one binary, role at boot)
//
// Board type comes from RECEIVER_CONFIG_RESPONSE reserved[1] (receivers,
// persisted as Receivers.board_type) and the dongle heartbeat `bt`
// (fw_state.dongle_board_type).
// ---------------------------------------------------------------------------

export const BOARD_TYPE_DEDICATED = 0;
export const BOARD_TYPE_OMNI = 1;

export const FIRMWARE_PRODUCTS = ['receiver', 'dongle', 'omni'];

// Filename prefix of each product's published .bin.
export const PRODUCT_BIN_PREFIX = {
  receiver: 'os4_receiver',
  dongle: 'os4_dongle',
  omni: 'byh_omni',
};

export const PRODUCT_LABEL = {
  receiver: 'receiver',
  dongle: 'dongle',
  omni: 'omni',
};

export function normalizeBoardType(bt) {
  if (bt == null) return null;
  const n = parseInt(String(bt), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Catalog product for a board. role is "receiver" or "dongle". Returns null
 * when the board type is unknown (not reported yet) or unrecognized, so
 * callers show no update info rather than guess.
 */
export function firmwareProduct(boardType, role) {
  const bt = normalizeBoardType(boardType);
  if (bt === BOARD_TYPE_OMNI) return 'omni';
  if (bt === BOARD_TYPE_DEDICATED) {
    if (role === 'receiver') return 'receiver';
    if (role === 'dongle') return 'dongle';
  }
  return null;
}

/**
 * The latestFirmware store entry ({ available, version, ... }) that applies
 * to a board, or null when the product is unknown / nothing was fetched.
 */
export function latestForBoard(latestFirmware, boardType, role) {
  const product = firmwareProduct(boardType, role);
  if (!product) return null;
  const entry = latestFirmware?.[product];
  return entry?.available ? entry : null;
}

/**
 * Product a .bin belongs to, judged by its published filename prefix
 * (os4_receiver_v.. / os4_dongle_v.. / byh_omni_v..). null for anything
 * else (latest.bin, renamed files) -- we can't tell, so we don't block.
 */
export function productFromFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop().toLowerCase();
  for (const [product, prefix] of Object.entries(PRODUCT_BIN_PREFIX)) {
    if (base.startsWith(`${prefix}_v`)) return product;
  }
  return null;
}

/**
 * Error message when a manually-picked image is clearly for another product
 * than the board it's about to be flashed onto, else null. Only fires when
 * both the board type and the file's product are known.
 *
 * Type 1 (omni) is always trustworthy -- only omni v35+ reports it. Type 0
 * is ambiguous during rollout: omni firmware before v35 zero-fills the
 * field, so a "type 0" unit may really be an omni that needs byh_omni to
 * upgrade. Pass typeCertain=true only when the 0 was explicitly reported by
 * firmware that knows about board types (the dongle heartbeat's `bt`).
 */
export function imageMismatchError(fileName, boardType, role, { typeCertain = false } = {}) {
  const want = firmwareProduct(boardType, role);
  const got = productFromFileName(fileName);
  if (!want || !got || want === got) return null;
  if (want !== 'omni' && !typeCertain) return null;
  return (
    `${fileName} is ${PRODUCT_BIN_PREFIX[got]} firmware, but this ${role} is ` +
    `${want === 'omni' ? 'an omni' : `a dedicated board`} and needs ` +
    `${PRODUCT_BIN_PREFIX[want]}_v<N>.bin.`
  );
}
