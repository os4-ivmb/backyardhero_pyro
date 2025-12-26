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
  }

  res.setHeader('Allow', ['GET']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}

