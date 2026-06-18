// pages/api/shows/index.js
import { getRepo } from "@/data";
import { caps } from "@/util/profile";

export const config = {
  api: {
    bodyParser: {
      // W6 parity with PATCH (shows/[id].js): a new show's POST body carries
      // both display_payload and runtime_payload JSON and can be several MB.
      // The default 1mb cap would silently 413 a dense first save.
      sizeLimit: '32mb',
    },
  },
};

export default async function handler(req, res) {
  let repo;
  try {
    repo = await getRepo(req);
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Failed to resolve data context.' });
  }

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
      const result = await repo.shows.create({
        name, duration, version, runtime_version,
        display_payload, runtime_payload,
        authorization_code, protocol, audio_file,
        receiver_locations, receiver_labels, show_receivers,
      });
      return res.status(201).json({ id: result.id });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to create show.' });
    }
  } else if (req.method === 'GET') {
    try {
      const shows = await repo.shows.list();
      // W3 (SYSTEM_REVIEW): the show "authorization code" must not ride along
      // in list responses on the public internet. We only strip it in the
      // cloud profile — the local single-operator client still uses it for
      // its (UX-only) load prompt, and there's no shared surface to leak it to.
      if (caps.multiUser) {
        for (const s of shows) {
          if (s && typeof s === 'object') delete s.authorization_code;
        }
      }
      return res.status(200).json(shows);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to retrieve shows.' });
    }
  }

  res.setHeader('Allow', ['POST', 'GET']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
