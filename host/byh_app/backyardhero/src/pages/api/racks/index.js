import { getRepo } from "@/data";

export default async function handler(req, res) {
  let repo;
  try {
    repo = await getRepo(req);
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Failed to resolve data context.' });
  }

  if (req.method === 'POST') {
    const { show_id, name, x_rows, x_spacing, y_rows, y_spacing, cells, fuses } = req.body;

    if (!show_id || !name || x_rows === undefined || x_spacing === undefined || y_rows === undefined || y_spacing === undefined) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
      const cellsStr = cells ? (typeof cells === 'string' ? cells : JSON.stringify(cells)) : JSON.stringify({});
      const fusesStr = fuses ? (typeof fuses === 'string' ? fuses : JSON.stringify(fuses)) : JSON.stringify({});
      const result = await repo.racks.create({
        show_id, name, x_rows, x_spacing, y_rows, y_spacing,
        cells: cellsStr, fuses: fusesStr,
      });
      return res.status(201).json({ id: result.id });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to create rack.' });
    }
  } else if (req.method === 'GET') {
    const { show_id } = req.query;

    if (!show_id) {
      return res.status(400).json({ error: 'show_id is required.' });
    }

    try {
      const racks = await repo.racks.listByShow(show_id);
      // Parse JSON strings
      const parsedRacks = racks.map(rack => ({
        ...rack,
        cells: rack.cells ? JSON.parse(rack.cells) : {},
        fuses: rack.fuses ? JSON.parse(rack.fuses) : {}
      }));
      return res.status(200).json(parsedRacks);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to retrieve racks.' });
    }
  }

  res.setHeader('Allow', ['POST', 'GET']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
