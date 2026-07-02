import { execFile } from 'child_process';
import fs from 'fs';
import { caps } from '@/util/profile';

// GET /api/system/audio_devices
//   → the host's available audio OUTPUT devices, for the "Show audio output"
//     device picker. The `audio-player` daemon plays through whatever id is
//     saved in system.hostAudio.deviceId (ffmpeg's ALSA device string), so
//     the ids returned here must be valid ALSA output identifiers.
//
// "System default" (id: "default") is always the first option and always
// works; the daemon uses plain ffplay for it. Everything else is discovered
// from ALSA. Enumeration is best-effort: aplay -L when alsa-utils is present
// (richest labels), else a parse of /proc/asound/cards, else just default.
//
// Local/host-deployment only — the cloud profile has no host audio hardware.

const DEFAULT_DEVICE = { id: 'default', label: 'System default' };

// ALSA plug/virtual prefixes worth exposing. `plughw`/`sysdefault`/`hdmi` do
// automatic format+rate conversion so an arbitrary track just plays; bare
// `hw:` is exact-hardware and often rejects the file's sample format, so we
// leave it out to avoid "device busy / format" foot-guns.
const KEEP_PREFIXES = ['sysdefault:', 'hdmi:', 'plughw:', 'dmix:', 'pulse'];

function execFileP(cmd, args, timeoutMs = 2500) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

// Parse `aplay -L`: a device id at column 0, followed by indented
// description line(s). We pair each id with its first description line.
function parseAplayL(out) {
  const devices = [];
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^\s/.test(line)) continue; // skip blanks + description lines
    const id = line.trim();
    if (!KEEP_PREFIXES.some((p) => id.startsWith(p))) continue;
    // First following indented line is the human label.
    let label = id;
    const next = lines[i + 1];
    if (next && /^\s/.test(next) && next.trim()) label = next.trim();
    devices.push({ id, label });
  }
  return devices;
}

// Fallback: parse /proc/asound/cards. Each card looks like:
//   " 0 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones"
// We expose a safe `plughw:<index>,0` per card.
function parseProcCards() {
  let raw;
  try {
    raw = fs.readFileSync('/proc/asound/cards', 'utf-8');
  } catch {
    return [];
  }
  const devices = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+\[([^\]]+)\]:\s*(.*)$/);
    if (!m) continue;
    const [, index, shortName, desc] = m;
    devices.push({
      id: `plughw:${index},0`,
      label: (desc && desc.trim()) || shortName.trim() || `Card ${index}`,
    });
  }
  return devices;
}

function dedupeById(devices) {
  const seen = new Set();
  const out = [];
  for (const d of devices) {
    if (!d.id || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  // No host audio hardware in the cloud profile; just the default option.
  if (caps.profile === 'cloud') {
    return res.status(200).json({ devices: [DEFAULT_DEVICE], source: 'none' });
  }

  let discovered = [];
  let source = 'none';
  const aplay = await execFileP('aplay', ['-L']);
  if (aplay) {
    discovered = parseAplayL(aplay);
    source = 'aplay';
  }
  if (discovered.length === 0) {
    discovered = parseProcCards();
    if (discovered.length) source = 'proc';
  }

  const devices = dedupeById([DEFAULT_DEVICE, ...discovered]);
  return res.status(200).json({ devices, source });
}
