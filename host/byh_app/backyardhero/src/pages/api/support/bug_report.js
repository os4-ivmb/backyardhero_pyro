import crypto from 'crypto';

import { ensureHardware } from '@/util/apiGuards';
import { collectDiagnostics } from '@/util/diagnostics';

// In-app support ticket intake.
//
// The browser modal POSTs the operator-entered fields (+ the staged show id).
// This route gathers the full local diagnostics snapshot, signs the payload
// with the shared secret baked into the installer (BYH_BUGREPORT_SECRET), and
// forwards it to the cloud gateway's public /api/app-reports endpoint. The
// signing keeps the secret server-side (never exposed to the renderer).
//
// On success it returns the gateway-assigned readable id (e.g. BHAR-42).

const DEFAULT_GATEWAY = 'https://cloud.backyard-hero.com';
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

function gatewayBaseUrl() {
  const raw = process.env.BYH_BUGREPORT_URL || DEFAULT_GATEWAY;
  return raw.replace(/\/+$/, '');
}

export default async function handler(req, res) {
  if (!ensureHardware(res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const secret = process.env.BYH_BUGREPORT_SECRET;
  if (!secret) {
    return res.status(503).json({
      error:
        'Support reporting is not configured in this build. Please reach out on Discord instead.',
    });
  }

  const body = req.body || {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';

  if (title.length < 3) {
    return res.status(400).json({ error: 'Please enter a short title (at least 3 characters).' });
  }
  if (description.length < 1) {
    return res.status(400).json({ error: 'Please describe what happened.' });
  }

  const severity = SEVERITIES.has(body.severity) ? body.severity : 'medium';
  const stagedShowId =
    body.staged_show_id !== undefined && body.staged_show_id !== null && body.staged_show_id !== ''
      ? body.staged_show_id
      : null;

  let collected;
  try {
    collected = await collectDiagnostics({ stagedShowId, req });
  } catch (err) {
    console.error('[support] diagnostics collection failed:', err);
    // Still let the report through with an error marker rather than blocking
    // the user from reaching support.
    collected = {
      summary: { app_version: process.env.BYH_HOST_VERSION || null, dongle_version: null, os_info: null, device_id: null },
      diagnostics: { error: `diagnostics collection failed: ${err?.message || err}` },
      logs: {},
    };
  }

  const payload = {
    title,
    description,
    severity,
    steps_to_reproduce: typeof body.steps_to_reproduce === 'string' ? body.steps_to_reproduce.trim() || null : null,
    expected_behavior: typeof body.expected_behavior === 'string' ? body.expected_behavior.trim() || null : null,
    actual_behavior: typeof body.actual_behavior === 'string' ? body.actual_behavior.trim() || null : null,
    contact_email: typeof body.contact_email === 'string' ? body.contact_email.trim() || null : null,
    app_version: collected.summary.app_version,
    dongle_version: collected.summary.dongle_version,
    os_info: collected.summary.os_info,
    device_id: collected.summary.device_id,
    diagnostics: collected.diagnostics,
    logs: collected.logs,
  };

  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const url = `${gatewayBaseUrl()}/api/app-reports`;

  let gatewayRes;
  try {
    gatewayRes = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-byh-timestamp': timestamp,
        'x-byh-signature': `sha256=${signature}`,
      },
      body: rawBody,
    });
  } catch (err) {
    console.error('[support] failed to reach gateway:', err);
    return res.status(502).json({
      error:
        'Could not reach the Backyard Hero cloud to file your report. Check your internet connection and try again.',
    });
  }

  const text = await gatewayRes.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }

  if (!gatewayRes.ok) {
    const message = parsed?.error || `Report submission failed (HTTP ${gatewayRes.status}).`;
    return res.status(gatewayRes.status === 503 ? 503 : 502).json({ error: message });
  }

  const data = parsed?.data || {};
  return res.status(201).json({
    readable_id: data.readable_id || null,
    id: data.id || null,
  });
}

// Diagnostics + log tails can exceed the default 1 MB body limit when the
// forwarded response echoes; the inbound modal body is tiny, but bump the
// response parsing limit headroom anyway. (Next parses the *request* body; the
// large payload is built server-side, so the default request limit is fine.)
export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
};
