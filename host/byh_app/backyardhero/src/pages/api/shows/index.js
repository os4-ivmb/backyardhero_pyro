// pages/api/shows/index.js
import { showQueries } from "@/util/sqldb";

export default function handler(req, res) {
  if (req.method === 'POST') {
    const {
      name, duration, version, runtime_version,
      display_payload, runtime_payload,
      authorization_code, protocol, audioFile,
      receiver_locations, receiver_labels, show_receivers,
    } = req.body;

    // `duration` is allowed to be 0 (an empty show with no items still has a
    // valid duration of zero seconds), so check explicitly for a finite
    // non-negative number rather than truthiness.
    const durationNum = Number(duration);
    if (
      !name || !version || !runtime_version ||
      !display_payload || !authorization_code || !protocol ||
      !Number.isFinite(durationNum) || durationNum < 0
    ) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
      // Convert audioFile object to JSON string for storage
      const audio_file = audioFile ? JSON.stringify(audioFile) : null;
      const result = showQueries.insert.run(
        name, duration, version, runtime_version,
        display_payload, runtime_payload,
        authorization_code, protocol, audio_file,
        receiver_locations, receiver_labels, show_receivers,
      );
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