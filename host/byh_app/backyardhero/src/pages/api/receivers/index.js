import { getRepo } from "@/data";

/**
 * GET /api/receivers
 *   → returns an array of all receiver rows from the DB.
 *     Each row already has cues_data and metadata parsed to JS objects, and
 *     enabled is a boolean.
 *
 * POST /api/receivers
 *   → create a new receiver row (id is required and must be unique).
 *     Body: { id, label?, type, cues_data?, enabled?, metadata?, config_data? }
 *
 * GET responses include the receiver-reported fields: fw_version,
 * board_version, cues_available, config_data. fw/board/cues_available
 * are NULL until the receiver has answered a CONFIG_QUERY at least once.
 */
export default async function handler(req, res) {
  let repo;
  try {
    repo = await getRepo(req);
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Failed to resolve data context.' });
  }

  if (req.method === 'GET') {
    try {
      const receivers = await repo.receivers.list();
      return res.status(200).json(receivers);
    } catch (error) {
      console.error('Failed to list receivers:', error);
      return res.status(500).json({ error: 'Failed to list receivers.' });
    }
  }

  if (req.method === 'POST') {
    const { id, label, type, cues_data, enabled, metadata, config_data } = req.body || {};
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'id is required (string).' });
    }
    if (!type || typeof type !== 'string') {
      return res.status(400).json({ error: 'type is required (string).' });
    }
    if (await repo.receivers.getById(id)) {
      return res.status(409).json({ error: `Receiver with id "${id}" already exists.` });
    }
    try {
      await repo.receivers.insert({
        id,
        label: label || id,
        type,
        cues_data: cues_data || { [id]: [] },
        enabled: enabled !== undefined ? !!enabled : true,
        metadata: metadata || {},
        config_data: config_data || {},
      });
      return res.status(201).json(await repo.receivers.getById(id));
    } catch (error) {
      console.error('Failed to insert receiver:', error);
      return res.status(500).json({ error: 'Failed to insert receiver.' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
