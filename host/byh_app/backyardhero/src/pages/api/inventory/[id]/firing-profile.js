import { firingProfileQueries } from "@/util/sqldb";

export default function handler(req, res) {
  const { id } = req.query;

  if (req.method === 'GET') {
    try {
      const profile = firingProfileQueries.getByInventoryId.get(id);
      
      if (!profile) {
        return res.status(404).json({ error: 'Firing profile not found.' });
      }

      // Parse the shot_timestamps JSON
      let shot_timestamps = [];
      try {
        shot_timestamps = JSON.parse(profile.shot_timestamps);
        // Normalize to [start, end, color] format for backward compatibility
        shot_timestamps = shot_timestamps.map(shot => {
          if (Array.isArray(shot)) {
            if (shot.length === 2) {
              return [shot[0], shot[1], null]; // Old format, add null color
            } else if (shot.length >= 3) {
              return [shot[0], shot[1], shot[2] || null]; // New format
            }
          }
          return shot;
        });
      } catch (e) {
        console.error('Error parsing shot_timestamps:', e);
      }

      return res.status(200).json({
        ...profile,
        shot_timestamps
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to retrieve firing profile.' });
    }
  } else if (req.method === 'PATCH') {
    try {
      const { shot_timestamps } = req.body;
      
      if (!shot_timestamps || !Array.isArray(shot_timestamps)) {
        return res.status(400).json({ error: 'shot_timestamps must be an array.' });
      }

      // Get existing profile to preserve other fields
      const existingProfile = firingProfileQueries.getByInventoryId.get(id);
      if (!existingProfile) {
        return res.status(404).json({ error: 'Firing profile not found.' });
      }

      // Update only shot_timestamps
      const shot_timestamps_json = JSON.stringify(shot_timestamps);
      firingProfileQueries.update.run(shot_timestamps_json, id);

      return res.status(200).json({ message: 'Firing profile updated successfully.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to update firing profile.' });
    }
  }

  res.setHeader('Allow', ['GET', 'PATCH']);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
