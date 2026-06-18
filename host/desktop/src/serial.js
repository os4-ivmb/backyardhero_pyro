'use strict';

/**
 * Dongle COM/tty auto-detection.
 *
 * Rather than add a second native module (node-serialport) we reuse the
 * embedded Python's pyserial, which is already bundled for the bridge. We
 * run a one-shot `list_ports` and pick the most likely dongle:
 *
 *   1. Anything reporting Espressif's USB vendor id (0x303A) -- the
 *      ESP32-S2 native USB-CDC the v0.2 dongle enumerates as.
 *   2. Common USB-serial bridge chips (CP210x 0x10C4, CH340 0x1A86, FTDI
 *      0x0403) used by older / one-way dongles.
 *   3. Failing a VID match, the first port whose device path looks like a
 *      USB modem/ACM port.
 *
 * Returns the chosen device path (e.g. "COM4", "/dev/tty.usbmodem01",
 * "/dev/ttyACM0") or null. The daemon still reconfigures the bridge at
 * runtime, so a wrong guess is recoverable from the UI -- this just removes
 * the manual "which COM port?" step for the common case.
 */

const { execFile } = require('child_process');

const ESPRESSIF_VID = 0x303a;
const KNOWN_USB_SERIAL_VIDS = new Set([0x303a, 0x10c4, 0x1a86, 0x0403]);

const LIST_PORTS_SNIPPET = [
  'import json',
  'from serial.tools import list_ports',
  'out = []',
  'for p in list_ports.comports():',
  '    out.append({"device": p.device, "vid": p.vid, "pid": p.pid, "desc": p.description})',
  'print(json.dumps(out))',
].join('\n');

function listPorts(pythonBin) {
  return new Promise((resolve) => {
    execFile(pythonBin, ['-c', LIST_PORTS_SNIPPET], { timeout: 8000 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || '[]'));
      } catch {
        resolve([]);
      }
    });
  });
}

function looksLikeUsbSerial(device) {
  if (!device) return false;
  const d = device.toLowerCase();
  return (
    d.startsWith('com') ||
    d.includes('usbmodem') ||
    d.includes('ttyacm') ||
    d.includes('usbserial') ||
    d.includes('ttyusb') ||
    d.includes('wchusbserial')
  );
}

async function detectDonglePort(pythonBin) {
  const ports = await listPorts(pythonBin);
  if (!ports.length) return null;

  const byEspressif = ports.find((p) => p.vid === ESPRESSIF_VID);
  if (byEspressif) return byEspressif.device;

  const byKnownVid = ports.find((p) => KNOWN_USB_SERIAL_VIDS.has(p.vid));
  if (byKnownVid) return byKnownVid.device;

  const byShape = ports.find((p) => looksLikeUsbSerial(p.device));
  if (byShape) return byShape.device;

  return null;
}

module.exports = { detectDonglePort, listPorts };
