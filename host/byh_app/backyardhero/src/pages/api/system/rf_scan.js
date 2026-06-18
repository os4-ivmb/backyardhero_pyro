import fs from 'fs';
import path from 'path';
import { ensureHardware } from '@/util/apiGuards';
import { COMMAND_DIR, LAST_SCAN_FILE_PATH as LAST_SCAN_FILE } from '@/util/paths';

/**
 * GET  /api/system/rf_scan
 *   → returns the most recent scan result persisted by the daemon, or 404
 *     if no scan has ever been run. Shape mirrors the daemon's
 *     `_handle_scan_result` payload (top-level: results[], top[], current_ch,
 *     recommended_ch, host_ts_ms, ...).
 *
 * POST /api/system/rf_scan
 *   → enqueues a `scan_radio` daemon command. Body: { passes?, ch_start?, ch_end? }
 *     Returns 202 Accepted — the actual scan happens asynchronously on the
 *     dongle (~250ms-1s) and the result lands in /data/last_scan.json.
 *     Poll GET to know when it's done (host_ts_ms changes).
 */
export default function handler(req, res) {
  if (!ensureHardware(res)) return;
  if (req.method === 'GET') {
    try {
      if (!fs.existsSync(LAST_SCAN_FILE)) {
        return res.status(404).json({ error: 'No scan has been run yet.' });
      }
      const raw = fs.readFileSync(LAST_SCAN_FILE, 'utf-8');
      // The daemon writes atomically (mkstemp + os.replace), so we should
      // never see a partial file — but keep parse error handling in case
      // somebody pokes at it manually.
      try {
        const payload = JSON.parse(raw);
        return res.status(200).json(payload);
      } catch (e) {
        console.error('rf_scan: corrupt last_scan.json:', e);
        return res.status(500).json({ error: 'Last scan file is corrupt.' });
      }
    } catch (error) {
      console.error('rf_scan GET failed:', error);
      return res.status(500).json({ error: 'Failed to read last scan.' });
    }
  }

  if (req.method === 'POST') {
    try {
      if (!fs.existsSync(COMMAND_DIR)) {
        fs.mkdirSync(COMMAND_DIR, { recursive: true });
      }
      const body = req.body || {};
      // Sanitize bounds — the daemon clamps too, but reject obviously bad
      // inputs early so the operator gets immediate feedback.
      const passes   = Math.max(1,  Math.min(50,  parseInt(body.passes,   10) || 10));
      const ch_start = Math.max(0,  Math.min(125, parseInt(body.ch_start, 10) || 0));
      const ch_end   = Math.max(ch_start, Math.min(125, parseInt(body.ch_end, 10) || 125));

      const cmd = {
        type: 'scan_radio',
        passes,
        ch_start,
        ch_end,
      };
      const filePath = path.join(COMMAND_DIR, `${Date.now()}.json`);
      fs.writeFileSync(filePath, JSON.stringify(cmd, null, 2));
      return res.status(202).json({ message: 'Scan queued.', cmd });
    } catch (error) {
      console.error('rf_scan POST failed:', error);
      return res.status(500).json({ error: 'Failed to queue scan.' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
