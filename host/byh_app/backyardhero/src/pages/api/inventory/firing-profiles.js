import { firingProfileQueries, inventoryQueries } from "@/util/sqldb";

function parseShotTimestamps(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((shot) => {
      if (Array.isArray(shot)) {
        if (shot.length === 2) return [shot[0], shot[1], null];
        if (shot.length >= 3) return [shot[0], shot[1], shot[2] || null];
      }
      return shot;
    });
  } catch (error) {
    console.error("Error parsing shot_timestamps:", error);
    return [];
  }
}

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const inventoryById = inventoryQueries.getAll.all().reduce((acc, item) => {
      acc[item.id] = item;
      return acc;
    }, {});

    const profiles = firingProfileQueries.getAll.all().map((profile) => {
      const item = inventoryById[profile.inventory_id] || {};
      return {
        inventory_id: profile.inventory_id,
        id: item.id ?? profile.inventory_id,
        name: item.name || `Item ${profile.inventory_id}`,
        type: item.type || null,
        duration: item.duration,
        image: item.image || null,
        shot_timestamps: parseShotTimestamps(profile.shot_timestamps),
      };
    });

    return res.status(200).json(profiles);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to retrieve firing profiles." });
  }
}
