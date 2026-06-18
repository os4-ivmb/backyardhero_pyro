// Cloud Sync push (local-only). Pushes inventory, firing profiles, and
// receivers up to the operator's cloud account. Shows/racks/audio follow in
// Phase 2B. Returns a per-entity report.
import { ensureLocalDb } from '@/util/apiGuards';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!ensureLocalDb(res)) return;
  try {
    const { runPush } = await import('@/util/cloudSync/push');
    const { ok, report } = await runPush();
    return res.status(200).json({ ok, report });
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Push failed.' });
  }
}
