import fs from 'fs';
import path from 'path';
import { ensureHardware } from '@/util/apiGuards';
import { COMMAND_DIR } from '@/util/paths';

/**
 * POST /api/receivers/reload
 *
 * Drops a `reload_receivers` command into /tmp/d_cmd so the daemon will:
 *   1. re-query the Receivers table from SQLite,
 *   2. diff against its in-memory map,
 *   3. register newly-enabled receivers with the dongle, and
 *   4. forget disabled / removed receivers from the dongle's poll list.
 *
 * Use this after PATCHing receivers via /api/receivers/[id] to push the
 * change all the way out to the radio.
 */
export default function handler(req, res) {
  if (!ensureHardware(res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const folderPath = COMMAND_DIR;
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    const filePath = path.join(folderPath, `${Date.now()}-reload-rcv.json`);
    fs.writeFileSync(filePath, JSON.stringify({ type: 'reload_receivers' }, null, 2));
    return res.status(200).json({ message: 'Reload command queued.' });
  } catch (error) {
    console.error('Failed to queue reload_receivers command:', error);
    return res.status(500).json({ error: 'Failed to queue reload command.' });
  }
}
