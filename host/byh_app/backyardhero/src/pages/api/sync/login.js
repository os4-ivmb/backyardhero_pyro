// Cloud Sync sign-in (local-only). Exchanges email/password for a Supabase
// session and stores the refresh token on-device.
import { ensureLocalDb } from '@/util/apiGuards';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!ensureLocalDb(res)) return;
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  try {
    const { signIn } = await import('@/util/cloudSync/client');
    const result = await signIn(String(email).trim(), String(password));
    return res.status(200).json({ connected: true, email: result.email });
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Sign-in failed.' });
  }
}
