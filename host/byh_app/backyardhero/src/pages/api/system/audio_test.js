import { execFile } from 'child_process';
import { ensureHardware } from '@/util/apiGuards';

// POST /api/system/audio_test
//   Body: { deviceId?: string }  ("default" or an ALSA device string from
//                                 /api/system/audio_devices)
//   → plays a short test tone out of the given output so the operator can
//     confirm the "Show audio output" device actually makes sound BEFORE a
//     live show, without having to arm a real one.
//
// This deliberately mirrors the `audio_player` daemon's own playback path
// (see audio_player.py `_spawn_args`): `default` goes through ffplay on the
// system default output; a specific ALSA device is decoded to that device by
// ffmpeg's alsa muxer (ffplay can't target an output device, ffmpeg can). If
// this button makes sound, a real show's soundtrack will too.
//
// The tone itself is generated with ffmpeg's lavfi `sine` source so no audio
// asset is needed; a short fade in/out avoids a click on start/stop.
//
// Local/host-deployment only (guarded) — the cloud profile has no host audio
// hardware, and the Settings card that surfaces this button is hidden there.

// Same "output can't be opened" markers the daemon treats as fatal — inspect
// stderr for these since ffplay exits 0 even when it fails to open the device.
const NO_DEVICE_MARKERS = [
  'audio open failed', 'could not initialize sdl',
  'no available audio device', "couldn't open audio device",
  'cannot open audio device', 'no such device', 'cannot open slave',
  'device or resource busy',
];

// lavfi tone: a gentle 1.2s note with short fades so it doesn't click.
const TONE_DURATION_S = 1.2;
const TONE = `sine=frequency=660:duration=${TONE_DURATION_S}`;
const FADE = `afade=t=in:d=0.05,afade=t=out:st=${TONE_DURATION_S - 0.15}:d=0.15`;

function spawnArgs(deviceId) {
  if (deviceId && deviceId !== 'default') {
    return [
      'ffmpeg', '-hide_banner', '-loglevel', 'warning', '-nostdin',
      '-f', 'lavfi', '-i', TONE, '-af', FADE, '-f', 'alsa', deviceId,
    ];
  }
  return [
    'ffplay', '-nodisp', '-autoexit', '-hide_banner',
    '-loglevel', 'warning', '-f', 'lavfi', '-af', FADE, TONE,
  ];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  if (!ensureHardware(res)) return;

  const raw = req.body?.deviceId;
  const deviceId = typeof raw === 'string' && raw.trim() ? raw.trim() : 'default';
  const [cmd, ...args] = spawnArgs(deviceId);

  // Give the tone a couple of seconds beyond its own length to spawn/decode,
  // then hard-kill so a hung player can't wedge the request.
  const timeoutMs = (TONE_DURATION_S + 4) * 1000;

  try {
    await new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
        const detail = String(stderr || '').trim();
        const low = detail.toLowerCase();
        // ffplay/ffmpeg print the real reason to stderr and often still exit 0,
        // so a device-open failure is detected by marker, not exit code.
        if (NO_DEVICE_MARKERS.some((m) => low.includes(m))) {
          reject(new Error(`Could not play through '${deviceId}': ${detail.slice(0, 160)}`));
          return;
        }
        if (err && err.code === 'ENOENT') {
          reject(new Error(`${cmd} is not installed on this device.`));
          return;
        }
        // A non-zero exit with no known marker is still worth surfacing.
        if (err) {
          reject(new Error(detail.slice(0, 160) || `Playback failed (${err.code ?? err.message}).`));
          return;
        }
        resolve();
      });
    });
    return res.status(200).json({ ok: true, deviceId });
  } catch (e) {
    console.error('audio_test failed:', e);
    return res.status(500).json({ error: e.message || 'Test playback failed.' });
  }
}
