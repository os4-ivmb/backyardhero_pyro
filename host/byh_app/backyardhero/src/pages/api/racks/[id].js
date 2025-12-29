import { rackQueries } from "@/util/sqldb";

export default function handler(req, res) {
  const { id } = req.query;

  if (req.method === 'PATCH') {
    const { name, x_rows, x_spacing, y_rows, y_spacing, cells, fuses } = req.body;

    if (!name || x_rows === undefined || x_spacing === undefined || y_rows === undefined || y_spacing === undefined) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
      const cellsStr = cells ? (typeof cells === 'string' ? cells : JSON.stringify(cells)) : JSON.stringify({});
      const fusesStr = fuses ? (typeof fuses === 'string' ? fuses : JSON.stringify(fuses)) : JSON.stringify({});
      const result = rackQueries.update.run(name, x_rows, x_spacing, y_rows, y_spacing, cellsStr, fusesStr, id);
      if (result.changes === 0) return res.status(404).json({ error: 'Rack not found.' });
      return res.status(200).json({ message: 'Rack updated successfully.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to update rack.' });
    }
  } else if (req.method === 'DELETE') {
    try {
      const result = rackQueries.delete.run(id);
      if (result.changes === 0) return res.status(404).json({ error: 'Rack not found.' });
      return res.status(200).json({ message: 'Rack deleted successfully.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to delete rack.' });
    }
  } else if (req.method === 'GET') {
    try {
      const rack = rackQueries.getById.get(id);
      if (!rack) return res.status(404).json({ error: 'Rack not found.' });
      return res.status(200).json({
        ...rack,
        cells: rack.cells ? JSON.parse(rack.cells) : {},
        fuses: rack.fuses ? JSON.parse(rack.fuses) : {}
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to retrieve rack.' });
    }
  }

  res.setHeader('Allow', ['PATCH', 'DELETE', 'GET']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}

