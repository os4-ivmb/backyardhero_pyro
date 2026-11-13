import { ensureHardware } from '@/util/apiGuards';
import { getLatest } from '@/util/firmwareLatest';
import { FIRMWARE_PRODUCTS } from '@/util/firmwareVersion';

/**
 * GET /api/system/firmware_latest
 *   Query:
 *     device?   "receiver" | "dongle" | "omni"  -- omit to get all
 *     refresh?  "1" | "true"           -- bypass the server-side TTL cache
 *
 *   Returns the latest published firmware version + download link for the
 *   requested device(s). The fetch happens server-side (no CORS), is cached
 *   with a long TTL, and is offline-safe -- a failed refresh yields cached
 *   data (stale:true) or { available:false } and never errors. Used by the
 *   status bar / receivers page out-of-date warnings and the "Flash latest"
 *   buttons.
 *
 *   Single product: { device, available, version, link, fetchedAt, stale }
 *   All products:   { receiver: {...}, dongle: {...}, omni: {...} }
 *
 *   receiver/dongle are the dedicated os4 boards; omni is the byh_omni image
 *   (either role). Pick the entry with firmwareProduct(boardType, role).
 */
export default async function handler(req, res) {
  if (!ensureHardware(res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const force = req.query.refresh === '1' || req.query.refresh === 'true';
  const device = typeof req.query.device === 'string' ? req.query.device : null;

  try {
    if (device) {
      const result = await getLatest(device, { force });
      return res.status(200).json(result);
    }
    const results = await Promise.all(
      FIRMWARE_PRODUCTS.map((p) => getLatest(p, { force })),
    );
    return res.status(200).json(
      Object.fromEntries(FIRMWARE_PRODUCTS.map((p, i) => [p, results[i]])),
    );
  } catch (error) {
    console.error('firmware_latest GET failed:', error);
    // getLatest is non-throwing, but guard anyway so the client never sees a 500.
    return res.status(200).json(
      Object.fromEntries(
        FIRMWARE_PRODUCTS.map((p) => [p, { device: p, available: false, stale: true }]),
      ),
    );
  }
}
