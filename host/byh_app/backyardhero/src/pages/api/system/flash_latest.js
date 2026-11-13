import fs from 'fs';
import path from 'path';
import { ensureHardware } from '@/util/apiGuards';
import { getRepo } from '@/data';
import { COMMAND_DIR, STAGING_DIR, STATE_FILE_PATH } from '@/util/paths';
import { getLatest } from '@/util/firmwareLatest';
import {
  firmwareProduct,
  normalizeBoardType,
  normalizeVersion,
  PRODUCT_BIN_PREFIX,
} from '@/util/firmwareVersion';

// Mirrors the caps in dongle_flash.js / ota_flash.js: the app .bin is ~340KB;
// 4MB is generous headroom for a future partition scheme.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const APP_OFFSET = '0x10000';

// The static-site download is small; give it room on a slow uplink but don't
// hang a request forever if the host's internet is flaky.
const DOWNLOAD_TIMEOUT_MS = 30000;

// All ESP32 app .bin files start with 0xE9 (ESP_IMAGE_HEADER_MAGIC). Reject
// anything else -- if the static site served HTML (a 404 page, a redirect),
// we must not hand it to esptool / the OTA streamer.
function looksLikeEsp32App(buf) {
  return !!buf && buf.length >= 8 && buf[0] === 0xe9;
}

function readDaemonState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Work out which hardware we're about to flash. Returns
 *   { boardType, running, inferred } or { error, status }.
 * The board type comes from the hardware itself (dongle heartbeat `bt`,
 * Receivers.board_type from the receiver's config response) -- the caller
 * never gets to choose the image.
 */
async function resolveTarget(req, device, ident) {
  if (device === 'dongle') {
    const state = readDaemonState();
    const boardType = normalizeBoardType(state?.dongle_board_type);
    if (boardType == null) {
      return { status: 409, error: 'Dongle board type not reported yet (is the dongle connected?).' };
    }
    return {
      boardType,
      running: normalizeVersion(state?.dongle_fw_version),
      // Heartbeat had no `bt`; type 0 was assumed. A pre-v35 omni dongle
      // looks exactly like this too.
      inferred: state?.dongle_board_type_reported === false,
    };
  }

  const repo = await getRepo(req);
  const row = await repo.receivers.getById(ident);
  if (!row) return { status: 404, error: `Unknown receiver ${ident}.` };
  const boardType = normalizeBoardType(row.board_type);
  if (boardType == null) {
    return {
      status: 409,
      error: `Board type for ${ident} is unknown. Refresh its config (rxcfg) first.`,
    };
  }
  return { boardType, running: normalizeVersion(row.fw_version), inferred: false };
}

async function downloadBin(link) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const resp = await fetch(link, { signal: controller.signal, cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/system/flash_latest
 *   Body: { device: "dongle", force?: bool }
 *      or { device: "receiver", ident: "RX163", rate?: 0|1|2, force?: bool }
 *
 *   `device` is the ROLE being flashed (USB dongle vs receiver OTA), not the
 *   image. The image is the firmware product for the hardware's reported
 *   board type: dedicated boards get os4_dongle / os4_receiver, omni boards
 *   get byh_omni in either role. Unknown board type is refused.
 *
 *   Safety net for the rollout: an omni running firmware older than v35
 *   reports board type 0. If the unit's running version is NEWER than the
 *   latest of the product we resolved, it's almost certainly a different
 *   product, so we refuse unless force:true.
 *
 *   Resolves the latest published firmware for that product, downloads the .bin
 *   on the host, stages it, and drops the SAME daemon command the manual
 *   upload routes use (dongle_flash_start / ota_flash_start). All downstream
 *   gating (show loaded / armed / receiver online) is enforced by the daemon
 *   unchanged. Progress shows up via fw_state.dongle_ota / fw_state.ota.
 */
export default async function handler(req, res) {
  if (!ensureHardware(res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const { device, ident, rate, force } = req.body || {};
    if (device !== 'dongle' && device !== 'receiver') {
      return res.status(400).json({ error: 'device must be "dongle" or "receiver".' });
    }
    if (device === 'receiver' && (!ident || typeof ident !== 'string')) {
      return res.status(400).json({ error: 'ident is required (string) for a receiver flash.' });
    }

    const target = await resolveTarget(req, device, ident);
    if (target.error) {
      return res.status(target.status).json({ error: target.error });
    }
    const product = firmwareProduct(target.boardType, device);
    if (!product) {
      return res.status(409).json({
        error: `No firmware product for board type ${target.boardType} as ${device}.`,
      });
    }

    const latest = await getLatest(product, { force: false });
    if (!latest.available || !latest.link) {
      return res.status(503).json({
        error: 'Latest firmware metadata is unavailable (no internet?). Try "Check for updates" first.',
      });
    }

    if (
      force !== true &&
      target.running != null &&
      target.running > latest.version
    ) {
      return res.status(409).json({
        error:
          `Running v${target.running} is newer than the latest ${product} firmware ` +
          `(v${latest.version}). This may be a different board type` +
          (target.inferred ? ' (its board type was not reported)' : '') +
          '. Not flashing.',
        product,
      });
    }

    let image;
    try {
      image = await downloadBin(latest.link);
    } catch (e) {
      return res.status(502).json({ error: `Failed to download firmware: ${e.message}` });
    }
    if (image.length === 0) {
      return res.status(502).json({ error: 'Downloaded firmware image is empty.' });
    }
    if (image.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({
        error: `Downloaded firmware too large (${image.length} bytes; max ${MAX_IMAGE_BYTES}).`,
      });
    }
    if (!looksLikeEsp32App(image)) {
      return res.status(502).json({
        error: "Downloaded file isn't an ESP32 app image (first byte must be 0xE9).",
      });
    }

    if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });
    if (!fs.existsSync(COMMAND_DIR)) fs.mkdirSync(COMMAND_DIR, { recursive: true });

    const fileName = `${PRODUCT_BIN_PREFIX[product]}_v${latest.version}.bin`;

    if (device === 'dongle') {
      const jobDir = path.join(STAGING_DIR, `${Date.now()}_dongle`);
      fs.mkdirSync(jobDir, { recursive: true });
      const stagedPath = path.join(jobDir, 'app.bin');
      fs.writeFileSync(stagedPath, image);

      const cmd = {
        type: 'dongle_flash_start',
        mode: 'app',
        files: { [APP_OFFSET]: stagedPath },
        file_names: { [APP_OFFSET]: fileName },
      };
      fs.writeFileSync(
        path.join(COMMAND_DIR, `${Date.now()}-dongle-flash.json`),
        JSON.stringify(cmd, null, 2),
      );
      return res.status(202).json({
        message: 'Dongle flash (latest) queued.',
        device,
        product,
        version: latest.version,
        bytes: image.length,
      });
    }

    // receiver OTA
    const sanitizedRate = [0, 1, 2].includes(parseInt(rate, 10)) ? parseInt(rate, 10) : 2;
    const safeIdent = ident.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
    const stagedName = `${Date.now()}_${safeIdent}_${fileName}`;
    const stagedPath = path.join(STAGING_DIR, stagedName);
    fs.writeFileSync(stagedPath, image);

    const cmd = {
      type: 'ota_flash_start',
      ident,
      image_path: stagedPath,
      rate: sanitizedRate,
      file_name: fileName,
    };
    fs.writeFileSync(
      path.join(COMMAND_DIR, `${Date.now()}-ota.json`),
      JSON.stringify(cmd, null, 2),
    );
    return res.status(202).json({
      message: 'OTA flash (latest) queued.',
      device,
      product,
      ident,
      version: latest.version,
      bytes: image.length,
      rate: sanitizedRate,
    });
  } catch (error) {
    console.error('flash_latest POST failed:', error);
    return res.status(500).json({ error: 'Failed to queue flash from latest.' });
  }
}
