// Detect whether the Next.js server is running on a Raspberry Pi. Pi-only
// surfaces in the UI (e.g. WiFi access-point settings) are hidden when this
// returns false so the same docker image stays usable on dev laptops and
// generic Linux boxes without showing knobs that have no host-side wiring.
//
// Detection reads /proc/device-tree/model, which on every Pi (1 through 5,
// CM, Zero) contains a string like "Raspberry Pi 4 Model B Rev 1.4\0".
// On macOS the /proc tree doesn't exist; on a generic Linux server the
// file is missing too. Inside docker, /proc is the host's /proc, so this
// works through the bind without any extra plumbing.
//
// Cached in module scope: the host doesn't morph from a MacBook into a Pi
// at runtime, and we'd rather not stat /proc on every API request.

import fs from 'fs';

const MODEL_PATH = '/proc/device-tree/model';
let cached = null;

export function getHostInfo() {
  if (cached) return cached;

  let model = null;
  let isRaspberryPi = false;

  try {
    const raw = fs.readFileSync(MODEL_PATH, 'utf-8');
    // device-tree files are null-terminated; trim and normalise.
    model = raw.replace(/\0+$/, '').trim() || null;
    isRaspberryPi = !!model && /raspberry pi/i.test(model);
  } catch (err) {
    // ENOENT on macOS / Windows / non-Pi Linux is the common case;
    // anything else is unexpected but still non-fatal -- we just
    // assume "not a Pi" and move on.
    if (err && err.code !== 'ENOENT') {
      console.warn('[host] failed to read', MODEL_PATH, '--', err.message);
    }
  }

  cached = {
    is_raspberry_pi: isRaspberryPi,
    model,
  };
  return cached;
}
