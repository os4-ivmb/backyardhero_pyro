import { showQueries } from "@/util/sqldb";

export default function handler(req, res) {
  const { id } = req.query;

  if (req.method === 'DELETE') {
    try {
      const result = showQueries.delete.run(id); // Run the delete query
      if (result.changes === 0) {
        return res.status(404).json({ error: "Show not found." });
      }
      return res.status(200).json({ message: "Show deleted successfully." });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Failed to delete show." });
    }
  } else if (req.method === 'PATCH') {
    const { name, duration, version, runtime_version, display_payload, runtime_payload, authorization_code, protocol } = req.body;

    if (!name || !duration || !version || !runtime_version || !display_payload || !runtime_payload || !authorization_code || !protocol) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
      const result = showQueries.update.run(
        name,
        duration,
        version,
        runtime_version,
        display_payload,
        runtime_payload,
        authorization_code,
        protocol,
        id
      );
      if (result.changes === 0) return res.status(404).json({ error: "Show not found." });
      return res.status(200).json({ message: "Show updated successfully." });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Failed to update show." });
    }
  }

  res.setHeader("Allow", ["PATCH", "DELETE"]);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
