import { getRepo } from "@/data";

export const config = {
  api: {
      bodyParser: {
          // W6: a 2mb cap silently rejected large shows (the body carries
          // both display_payload and runtime_payload JSON), and the client
          // only console.logged the failure -- so a big show looked saved
          // but wasn't. Raise the ceiling to comfortably fit a dense show;
          // the client now also surfaces any save failure (see updateShow).
          sizeLimit: '32mb'
      }
  }
}

export default async function handler(req, res) {
  const { id } = req.query;

  let repo;
  try {
    repo = await getRepo(req);
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Failed to resolve data context.' });
  }

  if (req.method === 'DELETE') {
    try {
      const result = await repo.shows.remove(id); // Run the delete query
      if (result.changes === 0) {
        return res.status(404).json({ error: "Show not found." });
      }
      return res.status(200).json({ message: "Show deleted successfully." });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Failed to delete show." });
    }
  } else if (req.method === 'PATCH') {
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
      !display_payload || !runtime_payload ||
      !authorization_code || !protocol ||
      !Number.isFinite(durationNum) || durationNum < 0
    ) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
      // Convert audioFile object to JSON string for storage
      const audio_file = audioFile ? JSON.stringify(audioFile) : null;
      const result = await repo.shows.update(id, {
        name,
        duration,
        version,
        runtime_version,
        display_payload,
        runtime_payload,
        authorization_code,
        protocol,
        audio_file,
        receiver_locations,
        receiver_labels,
        show_receivers,
      });
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
