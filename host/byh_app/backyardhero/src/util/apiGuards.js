// Server-side capability guards for API routes (Cloud Builder plan §3.1).
//
// Hardware-coupled routes (fire, load/start/stop, flashing, RF scan, live
// state, receiver reload/retry, Pi WiFi/update) and SQLite-only routes (DB
// export/import) must refuse to run in the cloud profile even if a stray
// client somehow calls them. The UI already hides these surfaces; these
// guards are defense in depth so a hidden button can never reach hardware
// that doesn't exist (and so we never port the unauthenticated local
// assumptions onto the public internet — see SYSTEM_REVIEW §W1).

import { caps } from '@/util/profile';

/**
 * Returns true if the request may proceed. When the deployment has no
 * hardware, sends a 501 and returns false (caller should `return`).
 */
export function ensureHardware(res) {
  if (!caps.hardware) {
    res.status(501).json({ error: 'Hardware features are not available in this deployment.' });
    return false;
  }
  return true;
}

/**
 * Returns true if the request may proceed. For routes that operate on the
 * local SQLite file directly (whole-DB export/import). Sends a 501 and
 * returns false when the active persistence backend isn't SQLite.
 */
export function ensureLocalDb(res) {
  if (caps.db !== 'sqlite') {
    res.status(501).json({ error: 'This operation is only available on-device.' });
    return false;
  }
  return true;
}
