import { promises as fs } from 'fs';
import { receiverQueries } from '@/util/sqldb';

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
      res.status(200).json(systemConfig);
    } catch (error) {
      console.error('Error reading system configuration:', error);
      res.status(500).json({ error: 'Failed to read system configuration' });
    }
  } else if (req.method === 'POST') {
    try {
      const newConfig = req.body;
      // Don't let writes to systemcfg.json clobber the on-disk receivers
      // block (which the daemon no longer reads). Strip it before writing —
      // the table in /data/backyardhero.db is authoritative.
      if (newConfig && Object.prototype.hasOwnProperty.call(newConfig, 'receivers')) {
        delete newConfig.receivers;
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
