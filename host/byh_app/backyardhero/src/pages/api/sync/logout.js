// Cloud Sync sign-out (local-only). Clears the stored cloud session. Pushed
// data and the sync_state id map are left intact so a later re-login resumes
// upserting in place rather than duplicating rows.
import { ensureLocalDb } from '@/util/apiGuards';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!ensureLocalDb(res)) return;
  try {
    const { signOut } = await import('@/util/cloudSync/client');
    signOut();
    return res.status(200).json({ connected: false });
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Sign-out failed.' });
  }
}
