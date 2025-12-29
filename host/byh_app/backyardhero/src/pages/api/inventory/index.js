import { inventoryQueries } from "@/util/sqldb";

export default function handler(req, res) {
  if (req.method === 'POST') {
    const { name, type, duration, fuse_delay, lift_delay, burn_rate, color, available_ct, youtube_link , youtube_link_start_sec, image, metadata } = req.body;

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
      const metadataStr = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;
      const result = inventoryQueries.insert.run(name, type, duration, fuse_delay, lift_delay, burn_rate, color, available_ct, youtube_link, youtube_link_start_sec, image, metadataStr);
      return res.status(201).json({ id: result.lastInsertRowid });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to create inventory item.' });
    }
  }else if (req.method === 'GET') {
    try {
      const inventory = inventoryQueries.getAll.all();
      return res.status(200).json(inventory);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to retrieve inventory.' });
    }
  }

  res.setHeader('Allow', ['POST', 'GET']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}