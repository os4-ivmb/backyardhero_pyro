import { getRepo } from '@/data';
import { getHostInfo } from '@/util/host';
import { caps } from '@/util/profile';
import { readMergedSystemConfig, writeUserOverrides } from '@/util/systemcfg';

/**
 * GET  /api/system/config
 *   → returns the base systemcfg.json overlaid with the operator's
 *     systemcfg.user.json overrides. The `receivers` block is then overlaid
 *     from the SQL Receivers table (the new source of truth) so existing UI
 *     consumers (ShowBuilder, ManualFirePanel, ShowLoadout, ...) keep working
 *     unchanged.
 *
 * POST /api/system/config
 *   → extracts the user-editable subset of the request body (system, protocol
 *     `config` blocks, default_location) and persists it to systemcfg.user.json.
 *     The git-tracked base file is never modified. Receiver definitions in the
 *     body are intentionally ignored — receivers must be edited via
 *     /api/receivers/* now.
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
      // Only the operator-owned subset (system / protocol config /
      // default_location) is persisted, and it lands in systemcfg.user.json
      // rather than the git-tracked base. Server-derived blocks (receivers,
      // host, caps) and base-owned metadata (types, labels) are dropped by
      // extractUserOverrides, so they round-trip silently.
      await writeUserOverrides(req.body || {});
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
 * Read the merged on-device config (base + user overrides). In the cloud
 * profile neither file exists (it's the daemon's per-device config), so fall
 * back to a minimal default. The authoring UI only dereferences `receivers`
 * (overlaid below), `protocols`, and `default_location`, all of which are
 * optional / empty-safe, plus `caps`/`host` added by the handler.
 */
async function readSystemConfig() {
  try {
    const merged = await readMergedSystemConfig();
    if (merged && Object.keys(merged).length > 0) return merged;
    if (caps.profile === 'cloud') return { protocols: {}, types: {}, system: {} };
    return merged;
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
