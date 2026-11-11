import { getRepo } from "@/data";
import { inventoryUsageRows } from "@/util/showInventoryUsage";

// POST   { updateInventory?: boolean } -> archive the show, optionally
//        deducting its non-shell inventory usage from available_ct.
// DELETE -> un-archive. Inventory is left as-is.
export default async function handler(req, res) {
  const { id } = req.query;

  let repo;
  try {
    repo = await getRepo(req);
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Failed to resolve data context.' });
  }

  if (req.method === 'POST') {
    const updateInventory = !!req.body?.updateInventory;
    try {
      const show = await repo.shows.getById(id);
      if (!show) return res.status(404).json({ error: "Show not found." });
      if (show.archived_at) return res.status(409).json({ error: "Show is already archived." });

      let inventoryUpdates = [];
      if (updateInventory) {
        const inventory = await repo.inventory.list();
        const inventoryById = Object.fromEntries(inventory.map((it) => [it.id, it]));
        inventoryUpdates = inventoryUsageRows(show.display_payload, inventoryById);
        for (const row of inventoryUpdates) {
          if (row.after !== row.before) await repo.inventory.setAvailableCount(row.id, row.after);
        }
      }

      const archivedAt = new Date().toISOString();
      const result = await repo.shows.setArchivedAt(id, archivedAt);
      if (result.changes === 0) return res.status(404).json({ error: "Show not found." });
      return res.status(200).json({ archived_at: archivedAt, inventoryUpdates });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Failed to archive show." });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const result = await repo.shows.setArchivedAt(id, null);
      if (result.changes === 0) return res.status(404).json({ error: "Show not found." });
      return res.status(200).json({ archived_at: null });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Failed to un-archive show." });
    }
  }

  res.setHeader("Allow", ["POST", "DELETE"]);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
