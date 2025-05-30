// pages/api/shows/index.js
import { showQueries } from "@/util/sqldb";

export default function handler(req, res) {
  if (req.method === 'POST') {
    const { name, duration, version, runtime_version, display_payload, runtime_payload, authorization_code, protocol } = req.body;

    if (!name || !duration || !version || !runtime_version || !display_payload || !authorization_code || !protocol) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
      const result = showQueries.insert.run(name, duration, version, runtime_version, display_payload, runtime_payload, authorization_code, protocol);
      return res.status(201).json({ id: result.lastInsertRowid });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to create show.' });
    }
  }else if (req.method === 'GET') {
    try {
      const shows = showQueries.getAll.all();
      return res.status(200).json(shows);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to retrieve shows.' });
    }
  }

  res.setHeader('Allow', ['POST', 'GET']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}