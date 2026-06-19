import fs from 'fs';
import crypto from 'crypto';
import { getHostInfo } from '@/util/host';
import { getLatestDesktop } from '@/util/desktopLatest';
import { HOST_UPDATE_STATUS_PATH, HOST_UPDATE_CMD_PATH } from '@/util/paths';

/**
 * GET  /api/system/host_update
 *   Query: refresh? "1"|"true"  -- bypass the manifest TTL cache.
 *
 *   Reports the running desktop app version, the latest published version,
 *   and the Electron auto-updater's live phase (read from the status file the
 *   main process writes). Offline-safe: a failed manifest fetch yields cached
 *   / unavailable data and never errors.
 *
 *   { running, isDesktop, outOfDate, latest: { available, version, stale },
 *     updater: { phase, available_version, progress_pct, error } | null }
 *
 * POST /api/system/host_update
 *   Body: { action: "check" | "install" }
 *   Desktop only. Drops a one-shot command file the Electron updater polls:
 *   "check" forces an update check, "install" restarts into the downloaded
 *   update. 501 when not running in the desktop bundle.
 */
export default async function handler(req, res) {
  const host = getHostInfo();
  const running = host.app_version;
  const isDesktop = !!host.is_desktop;

  if (req.method === 'GET') {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const [latest, updater] = await Promise.all([
      getLatestDesktop({ force }),
      Promise.resolve(readUpdaterStatus()),
    ]);

    // Prefer the updater's own resolved version (it talks to the same feed
    // and knows about a download in flight); fall back to the manifest.
    const latestVersion =
      (updater && updater.available_version) ||
      (latest.available ? latest.version : null);

    return res.status(200).json({
      running,
      isDesktop,
      latest: {
        available: latest.available,
        version: latest.available ? latest.version : null,
        stale: !!latest.stale,
      },
      updater,
      outOfDate: hostOutOfDate(running, latestVersion),
    });
  }

  if (req.method === 'POST') {
    if (!isDesktop) {
      return res.status(501).json({
        error: 'Auto-update is only available in the desktop app.',
      });
    }
    const action = req.body && req.body.action;
    if (action !== 'check' && action !== 'install') {
      return res.status(400).json({ error: 'action must be "check" or "install".' });
    }
    try {
      // Atomic write so the updater's poll never reads a half-written file.
      const tmp = `${HOST_UPDATE_CMD_PATH}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ action, ts: Date.now() }));
      fs.renameSync(tmp, HOST_UPDATE_CMD_PATH);
      return res.status(202).json({ message: `Queued ${action}.` });
    } catch (error) {
      console.error('host_update POST failed:', error);
      return res.status(500).json({ error: 'Failed to queue update command.' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

function readUpdaterStatus() {
  try {
    const raw = fs.readFileSync(HOST_UPDATE_STATUS_PATH, 'utf-8');
    const s = JSON.parse(raw);
    return {
      phase: s.phase || 'idle',
      available_version: s.available_version ?? null,
      progress_pct: typeof s.progress_pct === 'number' ? s.progress_pct : null,
      error: s.error ?? null,
      checked_at: s.checked_at ?? null,
    };
  } catch {
    // No file yet (updater hasn't run / not desktop) -- the manifest path
    // still drives the version comparison.
    return null;
  }
}

// Dotted-numeric version compare (e.g. "0.26.0"). Returns true only when both
// parse AND running is strictly older than latest, so unknown inputs never
// produce a misleading "update available". Pre-release suffixes are ignored.
function parseSemver(v) {
  if (v == null) return null;
  const core = String(v).trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = core.split('.').map((n) => parseInt(n, 10));
  if (parts.some((n) => !Number.isFinite(n)) || parts.length === 0) return null;
  return parts;
}

export function hostOutOfDate(running, latest) {
  const r = parseSemver(running);
  const l = parseSemver(latest);
  if (!r || !l) return false;
  const len = Math.max(r.length, l.length);
  for (let i = 0; i < len; i++) {
    const a = r[i] ?? 0;
    const b = l[i] ?? 0;
    if (a < b) return true;
    if (a > b) return false;
  }
  return false;
}
