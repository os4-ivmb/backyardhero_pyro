import { promises as fs } from 'fs';
import { receiverQueries } from '@/util/sqldb';
import { getHostInfo } from '@/util/host';

const configPath = '/config/systemcfg.json';

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
      const fileContent = await fs.readFile(configPath, 'utf-8');
      const systemConfig = JSON.parse(fileContent);
      systemConfig.receivers = buildReceiversMap();
      // Surface read-only host info so the UI can gate Pi-only surfaces
      // (WiFi AP settings, etc.) without a separate round-trip.
      systemConfig.host = getHostInfo();
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
      await fs.writeFile(configPath, JSON.stringify(newConfig, null, 2), 'utf-8');
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
 * Project the Receivers table into the legacy `{ [ident]: { label, type,
 * cues, enabled, ... } }` shape that the rest of the app expects on
 * systemConfig.receivers.
 */
function buildReceiversMap() {
  try {
    const rows = receiverQueries.getAll();
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
