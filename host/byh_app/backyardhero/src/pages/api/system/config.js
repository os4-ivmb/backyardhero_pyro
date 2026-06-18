import { promises as fs } from 'fs';
import crypto from 'crypto';
import { getRepo } from '@/data';
import { getHostInfo } from '@/util/host';
import { caps } from '@/util/profile';
import { SYSTEM_CFG_PATH } from '@/util/paths';

const configPath = SYSTEM_CFG_PATH;

/**
 * GET  /api/system/config
 *   → returns the parsed systemcfg.json. The `receivers` block is overlaid
 *     from the SQL Receivers table (the new source of truth) so existing UI
 *     consumers (ShowBuilder, ManualFirePanel, ShowLoadout, ...) keep working
 *     unchanged.
 *
 * POST /api/system/config
 *   → overwrites systemcfg.json with the request body. Receiver definitions
 *     in the body are intentionally ignored — receivers must be edited via
 *     /api/receivers/* now. Anything else (system, protocols, types) goes
 *     through unchanged for backwards compatibility.
 */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const systemConfig = await readSystemConfig();
      systemConfig.receivers = await buildReceiversMap(req);
      // Surface read-only host info so the UI can gate Pi-only surfaces
      // (WiFi AP settings, etc.) without a separate round-trip.
      systemConfig.host = getHostInfo();
      // Cloud Builder §3.1: surface the deployment capability flags to the
      // client alongside `host`, so MainNav / SettingsPanel can hide
      // hardware-only surfaces in the cloud profile from a single source.
      systemConfig.caps = caps;
      res.status(200).json(systemConfig);
    } catch (error) {
      console.error('Error reading system configuration:', error);
      res.status(500).json({ error: 'Failed to read system configuration' });
    }
  } else if (req.method === 'POST') {
    try {
      const newConfig = req.body;
      // Don't let writes to systemcfg.json clobber server-derived blocks.
      // `receivers` lives in the DB now (see buildReceiversMap), and `host`
      // is read-only platform detection -- both should round-trip silently.
      if (newConfig && Object.prototype.hasOwnProperty.call(newConfig, 'receivers')) {
        delete newConfig.receivers;
      }
      if (newConfig && Object.prototype.hasOwnProperty.call(newConfig, 'host')) {
        delete newConfig.host;
      }
      // W4b: atomic write. This file is the daemon's startup config; a
      // plain writeFile that's interrupted (power loss mid-write) leaves
      // it truncated/corrupt and the daemon won't boot. Write to a sibling
      // tmp file then rename (atomic on POSIX), matching update.js / ap.js.
      const tmpPath = `${configPath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(tmpPath, JSON.stringify(newConfig, null, 2), 'utf-8');
        await fs.rename(tmpPath, configPath);
      } catch (writeErr) {
        try { await fs.unlink(tmpPath); } catch { /* best effort */ }
        throw writeErr;
      }
      res.status(200).json({ message: 'System configuration updated successfully' });
    } catch (error) {
      console.error('Error writing system configuration:', error);
      res.status(500).json({ error: 'Failed to update system configuration' });
    }
  } else {
    res.setHeader('Allow', ['GET', 'POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

/**
 * Read and parse the on-device systemcfg.json. In the cloud profile that file
 * doesn't exist (it's the daemon's config, written per-device), so fall back to
 * a minimal default. The authoring UI only dereferences `receivers` (overlaid
 * below), `protocols`, and `default_location`, all of which are optional /
 * empty-safe, plus `caps`/`host` added by the handler. Local behaviour is
 * unchanged: the file is read as before and a genuine read error still throws.
 */
async function readSystemConfig() {
  try {
    const fileContent = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (err) {
    if (caps.profile === 'cloud') {
      return { protocols: {}, types: {}, system: {} };
    }
    throw err;
  }
}

/**
 * Project the Receivers table into the legacy `{ [ident]: { label, type,
 * cues, enabled, ... } }` shape that the rest of the app expects on
 * systemConfig.receivers.
 */
async function buildReceiversMap(req) {
  try {
    const repo = await getRepo(req);
    const rows = await repo.receivers.list();
    const out = {};
    for (const row of rows) {
      out[row.id] = {
        label: row.label,
        type: row.type,
        cues: row.cues_data || {},
        enabled: row.enabled,
        metadata: row.metadata || {},
        configuration_version: row.configuration_version,
      };
    }
    return out;
  } catch (err) {
    console.error('Failed to project Receivers table:', err);
    return {};
  }
}
