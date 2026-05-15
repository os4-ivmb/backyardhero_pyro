import fs from 'fs';
import path from 'path';

// Where staged firmware blobs live. /tmp/ota_staging is bind-mounted
// from the host into the container in all three docker-compose files
// so the host-side bridge can read these same paths back out (it's
// the bridge that hands them to esptool). If you change this path,
// update docker-compose.yml / docker-compose-dev.yml /
// docker-compose-prod.yml in lockstep.
const STAGING_DIR = '/tmp/ota_staging';
// Where the daemon polls for command files.
const COMMAND_DIR = '/tmp/d_cmd';

// Hard cap on the uploaded app image. The dongle's app .bin sits
// around ~340KB; 4MB is generous headroom for any future partition-
// scheme that gives the dongle more code space.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// The dongle ships from the build pipeline already flashed (bootloader
// + partitions + boot_app0 + app), and it never self-OTAs (only
// receivers OTA, and they do it over RF -- not via this UI flow).
// That means a UI-driven update is *only* ever an app refresh: write
// the new app .bin at 0x10000 and reboot. Bootloader, partitions, and
// boot_app0 don't change between builds and aren't worth re-uploading
// or re-writing. If a dongle ever needs a true full reflash (new
// partition scheme, brick-suspect recovery), use the CLI:
//   devices/utils/flash_dongle.py --full
const APP_OFFSET = '0x10000';

// All ESP32 app .bin files start with byte 0xE9 (ESP_IMAGE_HEADER_MAGIC).
// Reject anything else early so the operator can't accidentally upload
// e.g. the receiver image, the partition table, or a random file.
function looksLikeEsp32App(buf) {
  return !!buf && buf.length >= 8 && buf[0] === 0xE9;
}

export const config = {
  api: {
    bodyParser: {
      // ~340KB raw -> ~460KB base64; cap at 8MB so a future partition
      // scheme that gives the dongle more code space doesn't need a
      // code change. Still well under any reasonable upload budget.
      sizeLimit: '8mb',
    },
  },
};

/**
 * POST /api/system/dongle_flash
 *   Body: {
 *     name:      "os4_dongle_v16.bin",  // optional, used in the UI log
 *     image_b64: "...",                  // required, the app .bin
 *   }
 *   Returns 202 on success. The actual flash runs asynchronously via
 *   the daemon -> bridge -> esptool path; progress shows up in
 *   /data/state under fw_state.dongle_ota.
 *
 * DELETE /api/system/dongle_flash
 *   Aborts the in-flight dongle update.
 *
 * PATCH /api/system/dongle_flash
 *   Confirms manual bootloader entry (operator hit BOOT+RESET on the
 *   dongle). Forwards to the bridge's /flash_dongle/continue.
 */
export default function handler(req, res) {
  if (req.method === 'POST') {
    return handleStart(req, res);
  }
  if (req.method === 'DELETE') {
    return queueDaemonCmd(res, { type: 'dongle_flash_abort' }, 'abort');
  }
  if (req.method === 'PATCH') {
    return queueDaemonCmd(res, { type: 'dongle_flash_continue' }, 'continue');
  }
  res.setHeader('Allow', ['POST', 'DELETE', 'PATCH']);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

function handleStart(req, res) {
  try {
    const { name, image_b64 } = req.body || {};
    if (typeof image_b64 !== 'string' || !image_b64) {
      return res.status(400).json({ error: 'image_b64 is required.' });
    }
    // Be defensive: a UI bug could send a data: URL prefix or whitespace.
    const cleaned = image_b64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    let image;
    try {
      image = Buffer.from(cleaned, 'base64');
    } catch {
      return res.status(400).json({ error: 'image_b64 is not valid base64.' });
    }
    if (image.length === 0) {
      return res.status(400).json({ error: 'decoded image is empty.' });
    }
    if (image.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({
        error: `image too large (${image.length} bytes; max ${MAX_IMAGE_BYTES}).`,
      });
    }
    if (!looksLikeEsp32App(image)) {
      return res.status(400).json({
        error:
          "file doesn't look like an ESP32 app image (first byte must be 0xE9). " +
          'Make sure you picked os4_dongle_v<N>.bin (the app), not bootloader, ' +
          'partitions, or boot_app0.',
      });
    }

    // Stage to /tmp/ota_staging/<ts>_dongle/app.bin. The bridge running
    // on the host reads from these same paths via the bind-mount, so
    // this directory MUST exist on both sides. The compose files set
    // that up; here we just create sub-directories defensively.
    if (!fs.existsSync(STAGING_DIR)) {
      fs.mkdirSync(STAGING_DIR, { recursive: true });
    }
    const jobDir = path.join(STAGING_DIR, `${Date.now()}_dongle`);
    fs.mkdirSync(jobDir, { recursive: true });

    const stagedPath = path.join(jobDir, 'app.bin');
    fs.writeFileSync(stagedPath, image);

    // Sanitize display name -- don't trust whatever came over the wire.
    const rawName = (typeof name === 'string' && name) ? name : 'app.bin';
    const safeName = rawName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);

    if (!fs.existsSync(COMMAND_DIR)) {
      fs.mkdirSync(COMMAND_DIR, { recursive: true });
    }
    // The daemon -> bridge protocol still speaks {mode, files,
    // file_names} so the bridge HTTP layer can stay general (CLI
    // callers can still hit it with a four-file full reflash). The UI
    // path just always emits the minimal app-only shape.
    const filesByOffset = { [APP_OFFSET]: stagedPath };
    const fileNamesByOffset = { [APP_OFFSET]: safeName };
    const cmd = {
      type: 'dongle_flash_start',
      mode: 'app',
      files: filesByOffset,
      file_names: fileNamesByOffset,
    };
    const cmdPath = path.join(COMMAND_DIR, `${Date.now()}-dongle-flash.json`);
    fs.writeFileSync(cmdPath, JSON.stringify(cmd, null, 2));

    return res.status(202).json({
      message: 'Dongle flash queued.',
      mode: 'app',
      files: {
        [APP_OFFSET]: { name: safeName, bytes: image.length },
      },
    });
  } catch (error) {
    console.error('dongle_flash POST failed:', error);
    return res.status(500).json({ error: 'Failed to queue dongle flash.' });
  }
}

function queueDaemonCmd(res, payload, label) {
  try {
    if (!fs.existsSync(COMMAND_DIR)) {
      fs.mkdirSync(COMMAND_DIR, { recursive: true });
    }
    const cmdPath = path.join(
      COMMAND_DIR, `${Date.now()}-dongle-flash-${label}.json`,
    );
    fs.writeFileSync(cmdPath, JSON.stringify(payload, null, 2));
    return res.status(202).json({ message: `Dongle ${label} queued.` });
  } catch (error) {
    console.error(`dongle_flash ${label} failed:`, error);
    return res.status(500).json({ error: `Failed to queue dongle ${label}.` });
  }
}
