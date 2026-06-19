import { ensureHardware } from '@/util/apiGuards';
import { getLatest } from '@/util/firmwareLatest';

/**
 * GET /api/system/firmware_latest
 *   Query:
 *     device?   "dongle" | "receiver"  -- omit to get both
 *     refresh?  "1" | "true"           -- bypass the server-side TTL cache
 *
 *   Returns the latest published firmware version + download link for the
 *   requested device(s). The fetch happens server-side (no CORS), is cached
 *   with a long TTL, and is offline-safe -- a failed refresh yields cached
 *   data (stale:true) or { available:false } and never errors. Used by the
 *   status bar / receivers page out-of-date warnings and the "Flash latest"
 *   buttons.
 *
 *   Single device:  { device, available, version, link, fetchedAt, stale }
 *   Both devices:   { receiver: {...}, dongle: {...} }
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
    const [receiver, dongle] = await Promise.all([
      getLatest('receiver', { force }),
      getLatest('dongle', { force }),
    ]);
    return res.status(200).json({ receiver, dongle });
  } catch (error) {
    console.error('firmware_latest GET failed:', error);
    // getLatest is non-throwing, but guard anyway so the client never sees a 500.
    return res.status(200).json({
      receiver: { device: 'receiver', available: false, stale: true },
      dongle: { device: 'dongle', available: false, stale: true },
    });
  }
}
