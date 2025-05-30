import { inventoryQueries } from "@/util/sqldb";


export default function handler(req, res) {
  const { id } = req.query;

  if (req.method === 'PATCH') {
    const { name, type, duration, fuse_delay, lift_delay, burn_rate, color, available_ct, youtube_link, youtube_link_start_sec, image } = req.body;
    console.log(req.body)
    if (!name || !type) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if ( type === "FUSE" && (!burn_rate || !color)){
      return res.status(400).json({ error: 'All fuse fields are required.' });
    }

    if ( type === "AERIAL_SHELL" && (!fuse_delay || !lift_delay)){
      return res.status(400).json({ error: 'All shell fields are required.' });
    }

    try {
      const result = inventoryQueries.update.run(name, type, duration, fuse_delay, lift_delay, burn_rate, color, available_ct, youtube_link, youtube_link_start_sec, image, id);
      if (result.changes === 0) return res.status(404).json({ error: 'Inventory item not found.' });
      return res.status(200).json({ message: 'Inventory item updated successfully.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to update inventory item.' });
    }
  }

  res.setHeader('Allow', ['PATCH']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}