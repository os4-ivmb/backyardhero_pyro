import fs from 'fs';
import path from 'path';
import { ensureHardware } from '@/util/apiGuards';
import { COMMAND_DIR } from '@/util/paths';

/**
 * POST /api/receivers/rxcfg
 *
 * Broadcast variant of /api/receivers/:id/rxcfg -- drops a single
 * `fetch_receiver_config` command (with no `ident`) into /tmp/d_cmd.
 * The daemon iterates every currently-connected receiver and issues a
 * CONFIG_QUERY for each. Used by the settings panel's
 * "set fire duration for all connected receivers" action and by the
 * "refresh all" button.
 *
 * Optional body:
 *   { fire_duration_ms?: number }
 * When provided, every queried receiver also persists this fire pulse
 * width before responding.
 */
export default function handler(req, res) {
  if (!ensureHardware(res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const body = req.body || {};
  const cmd = { type: 'fetch_receiver_config' };  // no ident => broadcast
  if (body.fire_duration_ms !== undefined && body.fire_duration_ms !== null) {
    const fdv = Number(body.fire_duration_ms);
    if (!Number.isInteger(fdv) || fdv < 50 || fdv > 5000) {
      return res.status(400).json({
        error: 'fire_duration_ms must be an integer in [50, 5000].',
      });
    }
    cmd.fire_duration_ms = fdv;
  }

  try {
    const folderPath = COMMAND_DIR;
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    const filePath = path.join(folderPath, `${Date.now()}-rxcfg-all.json`);
    fs.writeFileSync(filePath, JSON.stringify(cmd, null, 2));
    return res.status(200).json({ message: 'Broadcast rxcfg queued.' });
  } catch (error) {
    console.error('Failed to queue broadcast rxcfg:', error);
    return res.status(500).json({ error: 'Failed to queue rxcfg command.' });
  }
}
