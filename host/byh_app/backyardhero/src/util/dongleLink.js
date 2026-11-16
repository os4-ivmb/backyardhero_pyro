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
