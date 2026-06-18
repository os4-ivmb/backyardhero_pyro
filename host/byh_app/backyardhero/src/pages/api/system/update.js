import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ensureHardware } from '@/util/apiGuards';

// /api/system/update
//
// UI-driven Pi update. Same architectural pattern as /api/system/ap:
// the docker container can't run host-side `git pull` / `docker compose
// pull` / `systemctl restart byh-host`, so we round-trip through a
// request file on /data (bind-mounted from the host's host/data
// directory). Host-side wiring lives in install.sh:
//
//   /data/byh_update_request.json  -- written here, watched by
//                                     byh-update.path
//   /data/byh_update_status.json   -- written by byh-update.py, read
//                                     here
//
// Flow:
//
//   1. UI POSTs the desired options here (do_source, do_image, ...).
//   2. We validate, generate a request_id, drop /data/byh_update_request.json,
//      and immediately return 202 with the request_id. We do NOT block:
//      a real update takes 30s-2min, and the systemctl restart at the
//      end of update.sh will tear this very container down. Polling is
//      the only way the UI can survive that gap.
//   3. systemd's path watcher fires byh-update.service which runs
//      byh-update.py. The apply script writes incremental snapshots
//      to byh_update_status.json (phase, step, log_tail).
//   4. UI polls GET /api/system/update every couple seconds. When
//      phase=restarting and the next poll fails (ECONNREFUSED, the
//      container is being restarted), the UI shows "Restarting..."
//      and retries with backoff for up to ~60s. The status file is on
//      /data which survives the container restart, so the post-restart
//      poll sees phase=done.
//
// GET also runs a quick connectivity preflight (curl-equivalent against
// GitHub + Docker Hub) when ?preflight=1 is set, so the UI can show
// "internet OK / offline" before the operator commits to an update.
// The host-side apply script reruns the same probes when it actually
// fires; we ship both so the UI can offer a helpful "soft-block"
// while still letting force=true override.

const DATA_DIR    = '/data';
const REQ_PATH    = path.join(DATA_DIR, 'byh_update_request.json');
const STATUS_PATH = path.join(DATA_DIR, 'byh_update_status.json');

// Connectivity probes. Mirror the URLs in byh-update.py (GITHUB_PROBE_URL
// / DOCKERHUB_PROBE_URL) so the UI's preflight result and the apply
// script's are directly comparable. Both endpoints are tiny and stable;
// a 401 from registry-1.docker.io counts as "reachable" (we don't have
// auth, but reaching the server proves the network path).
const PROBE_GITHUB    = 'https://api.github.com/zen';
const PROBE_DOCKERHUB = 'https://registry-1.docker.io/v2/';
const PROBE_TIMEOUT_MS = 5000;

// What phases a status file can be in. Mirrors byh-update.py's set;
// duplicated here purely to defend against typos when validating the
// "is a job in flight?" check.
const ACTIVE_PHASES = new Set([
  'preparing',
  'preflight',
  'updating',
  'restarting',
  'rebooting',
]);

async function readJsonSafe(p) {
  try {
    const txt = await fs.readFile(p, 'utf-8');
    return JSON.parse(txt);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

async function probeUrl(url, timeoutMs = PROBE_TIMEOUT_MS) {
  // AbortController is fine in Next.js's Node 18+; we don't need any
  // dependency beyond what ships with the runtime.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'byh-update-ui/1.0' },
      signal: controller.signal,
      // Don't follow redirects to weird places; for these endpoints
      // there shouldn't be any. Keeps the probe predictable.
      redirect: 'manual',
    });
    return { ok: true, detail: `HTTP ${r.status}`, url };
  } catch (e) {
    return { ok: false, detail: `${e.name}: ${e.message}`, url };
  } finally {
    clearTimeout(t);
  }
}

async function preflight() {
  // Probe both in parallel -- gates the GET response on the slower of
  // the two but stays under PROBE_TIMEOUT_MS in the worst case.
  const [github, dockerhub] = await Promise.all([
    probeUrl(PROBE_GITHUB),
    probeUrl(PROBE_DOCKERHUB),
  ]);
  return {
    internet_ok: github.ok && dockerhub.ok,
    probes: { github, dockerhub },
    checked_at: new Date().toISOString(),
  };
}

function validateRequest(body) {
  const errors = [];
  const out = {
    do_source:    true,
    do_image:     true,
    do_install:   true,
    restart_mode: 'service',
    force:        false,
  };

  if (typeof body !== 'object' || body == null) {
    return { errors: ['request body must be a JSON object'] };
  }

  for (const key of ['do_source', 'do_image', 'do_install', 'force']) {
    if (key in body) {
      if (typeof body[key] !== 'boolean') {
        errors.push(`${key} must be boolean`);
      } else {
        out[key] = body[key];
      }
    }
  }

  if ('restart_mode' in body) {
    const mode = String(body.restart_mode).toLowerCase();
    if (!['service', 'reboot', 'none'].includes(mode)) {
      errors.push("restart_mode must be one of 'service', 'reboot', or 'none'");
    } else {
      out.restart_mode = mode;
    }
  }

  if (!out.do_source && !out.do_image && !out.do_install
      && out.restart_mode === 'none') {
    errors.push('all steps disabled; nothing to do');
  }

  return { errors, validated: out };
}

async function loadStatus() {
  const status = await readJsonSafe(STATUS_PATH);
  if (!status) {
    // First-ever load on a freshly-installed Pi: no status file yet.
    // Synthesize an "idle" snapshot so the UI doesn't have to special-
    // case missing-file vs error.
    return { phase: 'idle', step: null, log_tail: [], options: null };
  }
  return status;
}

export default async function handler(req, res) {
  if (!ensureHardware(res)) return;
  if (req.method === 'GET') {
    try {
      const wantPreflight = String(req.query.preflight ?? '') === '1';
      const status = await loadStatus();
      const body = { status };
      if (wantPreflight) {
        body.preflight = await preflight();
      }
      return res.status(200).json(body);
    } catch (err) {
      console.error('GET /api/system/update failed:', err);
      return res.status(500).json({ error: 'Failed to read update status' });
    }
  }

  if (req.method === 'POST') {
    const { errors, validated } = validateRequest(req.body);
    if (errors && errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    // Refuse to start if a job is already running. Without this gate
    // the apply script would still self-defend (idempotency on
    // request_id), but bouncing the operator at the API edge gives a
    // much clearer error than "your request was silently coalesced".
    const existing = await readJsonSafe(STATUS_PATH);
    if (existing && existing.phase && ACTIVE_PHASES.has(existing.phase)) {
      return res.status(409).json({
        error:
          `Another update is already in flight (phase=${existing.phase}). ` +
          'Wait for it to finish or check the status panel.',
        status: existing,
      });
    }

    const request_id = crypto.randomUUID();
    const payload = {
      request_id,
      do_source:    validated.do_source,
      do_image:     validated.do_image,
      do_install:   validated.do_install,
      restart_mode: validated.restart_mode,
      force:        validated.force,
      requested_at: new Date().toISOString(),
    };

    try {
      // Atomic write -- the path watcher must never see a half-written
      // request file or the apply script will JSON-parse-fail.
      const tmpPath = REQ_PATH + '.tmp';
      await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
      await fs.rename(tmpPath, REQ_PATH);
    } catch (err) {
      console.error('Failed to write update request file:', err);
      return res.status(500).json({
        error:
          'Failed to write update request. Is /data mounted? ' +
          'Is byh-update.path enabled on the host? ' +
          'Run `systemctl status byh-update.path` to check.',
      });
    }

    // We do NOT poll for completion here. update.sh takes 30s+ and ends
    // by killing this very container; the UI will pick the result up
    // from the post-restart status file via its GET poll loop.
    return res.status(202).json({
      message: 'Update queued.',
      request_id,
      requested: payload,
    });
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
