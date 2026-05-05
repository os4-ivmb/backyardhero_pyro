import { receiverQueries } from "@/util/sqldb";

/**
 * GET /api/receivers/:id
 *   → returns a single receiver row, or 404 if not found.
 *
 * PATCH /api/receivers/:id
 *   → updates one or more of: label, type, cues_data, enabled, metadata.
 *     Only the provided fields are updated. configuration_version is bumped
 *     by the underlying SQL.
 *     Body: { label?, type?, cues_data?, enabled?, metadata? }
 *
 * DELETE /api/receivers/:id
 *   → deletes the row outright. Note: the daemon won't know about this
 *     until a reload_receivers command is issued.
 */
export default function handler(req, res) {
  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Invalid receiver id.' });
  }

  if (req.method === 'GET') {
    const row = receiverQueries.getById(id);
    if (!row) return res.status(404).json({ error: 'Receiver not found.' });
    return res.status(200).json(row);
  }

  if (req.method === 'PATCH') {
    if (!receiverQueries.getById(id)) {
      return res.status(404).json({ error: 'Receiver not found.' });
    }
    const { label, type, cues_data, enabled, metadata } = req.body || {};

    // Lightweight validation. cues_data must be an object-of-arrays.
    if (cues_data !== undefined) {
      if (typeof cues_data !== 'object' || Array.isArray(cues_data)) {
        return res.status(400).json({ error: 'cues_data must be an object.' });
      }
      for (const [zone, arr] of Object.entries(cues_data)) {
        if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n > 0)) {
          return res.status(400).json({
            error: `cues_data.${zone} must be an array of positive integers.`,
          });
        }
      }
    }

    try {
      receiverQueries.update(id, { label, type, cues_data, enabled, metadata });
      return res.status(200).json(receiverQueries.getById(id));
    } catch (error) {
      console.error(`Failed to update receiver ${id}:`, error);
      return res.status(500).json({ error: 'Failed to update receiver.' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const result = receiverQueries.delete(id);
      if (result.changes === 0) return res.status(404).json({ error: 'Receiver not found.' });
      return res.status(200).json({ message: 'Receiver deleted.' });
    } catch (error) {
      console.error(`Failed to delete receiver ${id}:`, error);
      return res.status(500).json({ error: 'Failed to delete receiver.' });
    }
  }

  res.setHeader('Allow', ['GET', 'PATCH', 'DELETE']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
