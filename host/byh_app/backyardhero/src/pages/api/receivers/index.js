import { receiverQueries } from "@/util/sqldb";

/**
 * GET /api/receivers
 *   → returns an array of all receiver rows from the DB.
 *     Each row already has cues_data and metadata parsed to JS objects, and
 *     enabled is a boolean.
 *
 * POST /api/receivers
 *   → create a new receiver row (id is required and must be unique).
 *     Body: { id, label?, type, cues_data?, enabled?, metadata? }
 */
export default function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const receivers = receiverQueries.getAll();
      return res.status(200).json(receivers);
    } catch (error) {
      console.error('Failed to list receivers:', error);
      return res.status(500).json({ error: 'Failed to list receivers.' });
    }
  }

  if (req.method === 'POST') {
    const { id, label, type, cues_data, enabled, metadata } = req.body || {};
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'id is required (string).' });
    }
    if (!type || typeof type !== 'string') {
      return res.status(400).json({ error: 'type is required (string).' });
    }
    if (receiverQueries.getById(id)) {
      return res.status(409).json({ error: `Receiver with id "${id}" already exists.` });
    }
    try {
      receiverQueries.insert({
        id,
        label: label || id,
        type,
        cues_data: cues_data || { [id]: [] },
        enabled: enabled !== undefined ? !!enabled : true,
        metadata: metadata || {},
      });
      return res.status(201).json(receiverQueries.getById(id));
    } catch (error) {
      console.error('Failed to insert receiver:', error);
      return res.status(500).json({ error: 'Failed to insert receiver.' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
