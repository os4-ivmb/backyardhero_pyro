// Dongle transport shared by the connection settings and the status-bar
// restart. "usb" is the hard-wired serial port. "wireless" is the Omni
// hub WebSocket at `hubHost` (the laptop has to be joined to that Wi-Fi).

export const DONGLE_LINK_USB = "usb";
export const DONGLE_LINK_WIRELESS = "wireless";
export const DEFAULT_HUB_HOST = "192.17.76.1";

export const DONGLE_DEFAULTS = {
  addr: "/dev/tty.usbmodem01",
  baud: 115200,
  protocol: "BKYD_TS_HYBRID",
  link: DONGLE_LINK_USB,
  hubHost: DEFAULT_HUB_HOST,
};

/**
 * Which hardware the dongle is: "omni" (byh_omni running as dongle),
 * "legacy" (the dedicated os4_dongle module), or null when not known yet.
 * Board type comes from the dongle heartbeat `bt` (fw_state.dongle_board_type:
 * 0 dedicated, 1 omni). A wireless link is only possible through an Omni
 * hub, so it settles the question before the first heartbeat arrives.
 */
export function dongleKind(boardType, link) {
  const n = boardType == null ? null : parseInt(String(boardType), 10);
  if (n === 1) return "omni";
  if (link === DONGLE_LINK_WIRELESS) return "omni";
  if (n === 0) return "legacy";
  return null;
}

export const DONGLE_KIND_LABEL = {
  omni: "Omni",
  legacy: "Legacy dongle",
};

function isIpv4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function isHostname(text) {
  if (!text || text.length > 253 || text.startsWith(".") || text.endsWith(".")) {
    return false;
  }
  return text.split(".").every((label) => {
    if (!label || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    return /^[A-Za-z0-9-]+$/.test(label);
  });
}

/** True for an IPv4 address or hostname, with no scheme or port. */
export function isHubHost(value) {
  const text = String(value ?? "").trim();
  if (!text || /[\s:/\\?#@]/.test(text)) return false;
  return isIpv4(text) || isHostname(text);
}

/**
 * Body for POST /api/system/cmd_daemon select_serial.
 * USB fields are always sent so switching back does not forget the port.
 */
export function selectSerialPayload({ addr, baud, protocol, link, hubHost } = {}) {
  const resolvedLink = link === DONGLE_LINK_WIRELESS
    ? DONGLE_LINK_WIRELESS
    : DONGLE_LINK_USB;
  const payload = {
    type: "select_serial",
    device: addr || DONGLE_DEFAULTS.addr,
    baud: parseInt(baud || DONGLE_DEFAULTS.baud, 10),
    protocol: protocol || DONGLE_DEFAULTS.protocol,
    link: resolvedLink,
  };
  if (resolvedLink === DONGLE_LINK_WIRELESS) {
    payload.host = String(hubHost || DONGLE_DEFAULTS.hubHost).trim();
  }
  return payload;
}
