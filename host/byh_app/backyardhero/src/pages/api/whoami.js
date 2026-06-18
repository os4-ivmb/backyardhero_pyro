// GET /api/whoami — report the identity the server resolves for this request.
//
// Local profile: there's no auth, so this is the implicit single operator.
// Cloud profile: derived from the shared Supabase session cookie (the same
// account you signed into the gateway with). 401 when unauthenticated.
import { caps } from '@/util/profile';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  if (!caps.multiUser) {
    return res
      .status(200)
      .json({ profile: 'local', authenticated: true, userId: 'local', email: null });
  }

  const { createServerSupabase } = await import('@/util/supabase/server');
  const supabase = createServerSupabase(req, res);
  const { data, error } = await supabase.auth.getUser();
  const user = data?.user;
  if (error || !user) {
    return res.status(401).json({ profile: 'cloud', authenticated: false });
  }

  return res.status(200).json({
    profile: 'cloud',
    authenticated: true,
    userId: user.id,
    email: user.email ?? null,
    role: user.role ?? null,
    lastSignInAt: user.last_sign_in_at ?? null,
  });
}
