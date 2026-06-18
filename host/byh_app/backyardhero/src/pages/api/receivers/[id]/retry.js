import fs from 'fs';
import path from 'path';
import { ensureHardware } from '@/util/apiGuards';
import { COMMAND_DIR } from '@/util/paths';

/**
 * POST /api/receivers/:id/retry
 *
 * Drops a `retry_receiver` command into /tmp/d_cmd so the daemon will
 * re-issue the registration / sync sequence for a single receiver.
 * Useful when a receiver was pruned by the dongle (timeout) and needs to be
 * re-added without disturbing the others.
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

  try {
    const folderPath = COMMAND_DIR;
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    const filePath = path.join(folderPath, `${Date.now()}-retry-${id}.json`);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ type: 'retry_receiver', ident: id }, null, 2),
    );
    return res.status(200).json({ message: `Retry queued for ${id}.` });
  } catch (error) {
    console.error(`Failed to queue retry_receiver(${id}):`, error);
    return res.status(500).json({ error: 'Failed to queue retry command.' });
  }
}
