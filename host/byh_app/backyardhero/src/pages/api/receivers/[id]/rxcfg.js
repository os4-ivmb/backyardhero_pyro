import fs from 'fs';
import path from 'path';
import { ensureHardware } from '@/util/apiGuards';
import { COMMAND_DIR } from '@/util/paths';

/**
 * POST /api/receivers/:id/rxcfg
 *
 * Drops a `fetch_receiver_config` command into /tmp/d_cmd so the daemon
 * will issue a CONFIG_QUERY (FW v22+ on the receiver, FW v16+ on the
 * dongle) for a single receiver. The daemon writes the returned values
 * back into the Receivers table, so callers don't need to wait on the
 * response -- a subsequent GET /api/receivers/:id will see the new
 * fw_version / board_version / cues_available / config_data.
 *
 * Optional body:
 *   { fire_duration_ms?: number }
 * If provided, the receiver also persists this fire pulse width to its
 * NVS before responding (clamped to 50..5000ms on the receiver side).
 */
export default function handler(req, res) {
  if (!ensureHardware(res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Invalid receiver id.' });
  }

  const body = req.body || {};
  const cmd = { type: 'fetch_receiver_config', ident: id };
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
    const filePath = path.join(folderPath, `${Date.now()}-rxcfg-${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(cmd, null, 2));
    return res.status(200).json({ message: `rxcfg queued for ${id}.` });
  } catch (error) {
    console.error(`Failed to queue rxcfg(${id}):`, error);
    return res.status(500).json({ error: 'Failed to queue rxcfg command.' });
  }
}
