// Cloud Sync connection status (local-only). Reports whether the device is
// configured for sync and currently signed in.
import { ensureLocalDb } from '@/util/apiGuards';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!ensureLocalDb(res)) return;
  try {
    const { getStatus } = await import('@/util/cloudSync/client');
    return res.status(200).json(getStatus());
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Failed to read status.' });
  }
}
