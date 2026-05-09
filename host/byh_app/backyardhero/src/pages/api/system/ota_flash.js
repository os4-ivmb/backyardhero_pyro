import fs from 'fs';
import path from 'path';

const COMMAND_DIR = '/tmp/d_cmd';
// Where uploaded firmware images get staged before the daemon picks
// them up. Kept on tmpfs so old jobs don't accumulate across reboots.
const STAGING_DIR = '/tmp/ota_staging';
// Hard cap on the upload size. The receiver image today is ~340KB; we
// allow ~4MB to give headroom for partition-scheme growth and base64
// expansion (~4/3 vs raw bytes).
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Configure Next.js's bodyParser to allow the larger payload. Default is
// 1MB, which would reject most realistic ESP32 firmware images.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '8mb',
    },
  },
};

/**
 * POST /api/system/ota_flash
 *   Body: {
 *     ident: string,                 // receiver ident, e.g. "RX163"
 *     file_name?: string,            // displayed in UI / logs
 *     image_b64: string,             // base64-encoded firmware app bin
 *                                    // (the .ino.bin from build_receiver.sh,
 *                                    //  NOT the bootloader / partitions /
 *                                    //  boot_app0 — those are first-flash
 *                                    //  only and don't go over the air).
 *     rate?: 0 | 1 | 2,              // RF data rate during OTA. Default 2 (2Mbps)
 *   }
 *   Returns 202 on success with the staged path. The actual flash runs
 *   asynchronously on the daemon and reports progress through the
 *   websocket-broadcast `fw_state.ota` block.
 *
 * DELETE /api/system/ota_flash
 *   Aborts the in-flight OTA job (queues an `ota_flash_abort` daemon
 *   command).
 */
export default function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { ident, file_name, image_b64, rate } = req.body || {};
      if (!ident || typeof ident !== 'string') {
        return res.status(400).json({ error: 'ident is required (string).' });
      }
      if (!image_b64 || typeof image_b64 !== 'string') {
        return res.status(400).json({ error: 'image_b64 is required (base64 string).' });
      }
      // Be defensive: a UI bug could send a data: URL prefix or whitespace.
      const cleaned = image_b64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
      let image;
      try {
        image = Buffer.from(cleaned, 'base64');
      } catch (e) {
        return res.status(400).json({ error: 'image_b64 is not valid base64.' });
      }
      if (image.length === 0) {
        return res.status(400).json({ error: 'Decoded image is empty.' });
      }
      if (image.length > MAX_IMAGE_BYTES) {
        return res.status(413).json({
          error: `Image too large (${image.length} bytes; max ${MAX_IMAGE_BYTES}).`,
        });
      }

      const sanitizedRate = [0, 1, 2].includes(parseInt(rate, 10))
        ? parseInt(rate, 10)
        : 2;

      // Stage the image under /tmp so the daemon can mmap it without
      // worrying about base64 in the command file. Each upload gets a
      // unique filename (timestamp + sanitized basename) so concurrent
      // uploads don't clobber each other.
      if (!fs.existsSync(STAGING_DIR)) {
        fs.mkdirSync(STAGING_DIR, { recursive: true });
      }
      const cleanedName = (file_name || 'firmware.bin')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 80);
      const stagedName = `${Date.now()}_${ident}_${cleanedName}`;
      const stagedPath = path.join(STAGING_DIR, stagedName);
      fs.writeFileSync(stagedPath, image);

      // Drop the daemon command pointing at the staged file.
      if (!fs.existsSync(COMMAND_DIR)) {
        fs.mkdirSync(COMMAND_DIR, { recursive: true });
      }
      const cmd = {
        type: 'ota_flash_start',
        ident,
        image_path: stagedPath,
        rate: sanitizedRate,
        file_name: cleanedName,
      };
      const cmdPath = path.join(COMMAND_DIR, `${Date.now()}-ota.json`);
      fs.writeFileSync(cmdPath, JSON.stringify(cmd, null, 2));

      return res.status(202).json({
        message: 'OTA flash queued.',
        ident,
        bytes: image.length,
        staged_path: stagedPath,
        rate: sanitizedRate,
      });
    } catch (error) {
      console.error('ota_flash POST failed:', error);
      return res.status(500).json({ error: 'Failed to queue OTA flash.' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      if (!fs.existsSync(COMMAND_DIR)) {
        fs.mkdirSync(COMMAND_DIR, { recursive: true });
      }
      const cmdPath = path.join(COMMAND_DIR, `${Date.now()}-ota-abort.json`);
      fs.writeFileSync(
        cmdPath,
        JSON.stringify({ type: 'ota_flash_abort' }, null, 2),
      );
      return res.status(202).json({ message: 'OTA abort queued.' });
    } catch (error) {
      console.error('ota_flash DELETE failed:', error);
      return res.status(500).json({ error: 'Failed to queue OTA abort.' });
    }
  }

  res.setHeader('Allow', ['POST', 'DELETE']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
