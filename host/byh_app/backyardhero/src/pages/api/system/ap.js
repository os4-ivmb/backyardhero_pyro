import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ensureHardware } from '@/util/apiGuards';

// /api/system/ap
//
// Read and update the host's WiFi access-point configuration (SSID,
// passphrase, channel, country) from the UI.
//
// The Next.js app runs inside the firework-system docker container,
// which doesn't have permission to twiddle hostapd directly. Instead,
// we round-trip through a small request file on /data (the host's
// host/data directory is bind-mounted at /data inside the container):
//
//   1. UI POSTs the desired config here.
//   2. We validate, generate a request_id, and write
//      /data/byh_ap_request.json.
//   3. A host-side systemd path watcher (byh-ap-apply.path) sees the
//      file change and triggers byh-ap-apply.py, which rewrites
//      /etc/hostapd/hostapd.conf, updates /data/byh_ap_current.json,
//      and schedules a deferred hostapd restart.
//   4. We poll /data/byh_ap_status.json until we see a status with the
//      matching request_id (or time out), then return that status.
//
// The deferred restart is what lets us hand the operator a coherent
// "Reconnect to <new SSID>" message: by the time hostapd actually
// resets the radio, the API response has already reached their phone.
//
// GET returns the current state out of /data/byh_ap_current.json,
// including the WPA2 passphrase in cleartext. The UI is on a
// single-tenant LAN (typically the AP itself) so this matches the rest
// of the app's "config is operator-visible" trust model. The UI is
// expected to render the passphrase masked by default (type=password)
// and only reveal it on operator request.

const DATA_DIR = '/data';
const REQ_PATH     = path.join(DATA_DIR, 'byh_ap_request.json');
const STATUS_PATH  = path.join(DATA_DIR, 'byh_ap_status.json');
const CURRENT_PATH = path.join(DATA_DIR, 'byh_ap_current.json');

// Mirror the validation in byh-ap-apply.py so the UI gets a fast,
// in-container rejection for obviously bad input. The apply script is
// the source of truth — these are defense-in-depth, not authoritative.
const SSID_RE     = /^[\x20-\x7e]{1,32}$/;
const PASSWORD_RE = /^[\x20-\x7e]{8,63}$/;
const COUNTRY_RE  = /^[A-Z]{2}$/;
// Channels 1-14 are legal somewhere in the world; the host-side
// regulatory domain (set by `country`) will refuse channels not legal
// where we are, but we don't try to second-guess that here.
const CHANNEL_MIN = 1;
const CHANNEL_MAX = 14;

// Total time the POST handler will wait for the host apply script to
// publish a status with our request_id. Has to exceed the deferred
// restart delay in byh-ap-apply.py (currently 3s) by a comfortable
// margin so the operator sees a real answer before the response
// timer pops, but stay short enough that a wedged path watcher
// doesn't hang every UI request indefinitely.
const POLL_TIMEOUT_MS  = 10_000;
const POLL_INTERVAL_MS = 200;

async function readJsonSafe(p) {
  try {
    const txt = await fs.readFile(p, 'utf-8');
    return JSON.parse(txt);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function loadCurrent() {
  const cur = await readJsonSafe(CURRENT_PATH);
  if (!cur) {
    return {
      configured: false,
      interface: null,
      ssid: '',
      password: '',
      channel: null,
      country: null,
      gateway_ip: null,
      web_url: null,
      updated_at: null,
    };
  }
  return {
    configured: true,
    interface: cur.interface || null,
    ssid: cur.ssid || '',
    password: cur.password || '',
    channel: cur.channel ?? null,
    country: cur.country || null,
    gateway_ip: cur.gateway_ip || null,
    web_url:
      cur.web_url ||
      (cur.gateway_ip ? `http://${cur.gateway_ip}:1776` : null),
    updated_at: cur.updated_at || null,
  };
}

function validateRequest(body) {
  const errors = [];
  const out = {};

  if (typeof body !== 'object' || body == null) {
    return { errors: ['request body must be a JSON object'] };
  }

  if (typeof body.ssid !== 'string' || !SSID_RE.test(body.ssid)) {
    errors.push('SSID must be 1-32 printable ASCII characters');
  } else {
    out.ssid = body.ssid;
  }

  if (typeof body.password !== 'string' || !PASSWORD_RE.test(body.password)) {
    errors.push('Password must be 8-63 printable ASCII characters');
  } else {
    out.password = body.password;
  }

  if (body.channel !== undefined && body.channel !== null && body.channel !== '') {
    const ch = Number(body.channel);
    if (!Number.isInteger(ch) || ch < CHANNEL_MIN || ch > CHANNEL_MAX) {
      errors.push(`Channel must be an integer ${CHANNEL_MIN}-${CHANNEL_MAX}`);
    } else {
      out.channel = ch;
    }
  }

  if (body.country !== undefined && body.country !== null && body.country !== '') {
    const cc = String(body.country).toUpperCase();
    if (!COUNTRY_RE.test(cc)) {
      errors.push('Country must be a 2-letter ISO code (e.g. US)');
    } else {
      out.country = cc;
    }
  }

  return { errors, validated: out };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForStatus(requestId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await readJsonSafe(STATUS_PATH);
    if (s && s.request_id === requestId) return s;
    await delay(POLL_INTERVAL_MS);
  }
  return null;
}

export default async function handler(req, res) {
  if (!ensureHardware(res)) return;
  if (req.method === 'GET') {
    try {
      const current = await loadCurrent();
      // Also surface the last apply outcome so the UI can show
      // diagnostic info if a previous change rolled back.
      const lastStatus = await readJsonSafe(STATUS_PATH);
      return res.status(200).json({ current, last_status: lastStatus });
    } catch (err) {
      console.error('GET /api/system/ap failed:', err);
      return res.status(500).json({ error: 'Failed to read AP state' });
    }
  }

  if (req.method === 'POST') {
    const { errors, validated } = validateRequest(req.body);
    if (errors && errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    // Pull through any fields the operator left blank from the current
    // state so the request is fully-specified for the apply script.
    const current = await loadCurrent();
    const request_id = crypto.randomUUID();
    const payload = {
      request_id,
      ssid:     validated.ssid     ?? current.ssid,
      password: validated.password ?? current.password,
      channel:  validated.channel  ?? current.channel ?? 6,
      country:  validated.country  ?? current.country ?? 'US',
      requested_at: new Date().toISOString(),
    };

    try {
      // Atomic write so the path watcher never sees a half-written
      // file: write to a sibling tmp and rename into place.
      const tmpPath = REQ_PATH + '.tmp';
      await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
      await fs.rename(tmpPath, REQ_PATH);
    } catch (err) {
      console.error('Failed to write AP request file:', err);
      return res.status(500).json({
        error: 'Failed to write AP request file. Is /data mounted? Is the host-side apply service installed?',
      });
    }

    const status = await pollForStatus(request_id, POLL_TIMEOUT_MS);
    if (!status) {
      return res.status(504).json({
        error:
          'AP apply timed out -- no response from host-side apply service. ' +
          'Check `systemctl status byh-ap-apply.path` on the Pi.',
        request_id,
      });
    }

    return res.status(status.ok ? 200 : 500).json({
      ...status,
      // Echo the new credentials so the UI can present reconnect
      // instructions even before re-fetching current state.
      requested: {
        ssid: payload.ssid,
        password: payload.password,
        channel: payload.channel,
        country: payload.country,
      },
    });
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
