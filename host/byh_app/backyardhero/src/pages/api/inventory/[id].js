import { getRepo } from "@/data";
import { parseOptionalUnitCost } from "@/util/inventoryUnitCost";
import { caps } from "@/util/profile";
import { getBlobStore, localImageKey } from "@/data/blobStore";

// Best-effort removal of a locally-uploaded inventory image so deleting (or
// re-imaging) an item doesn't leave orphaned files in the persistent uploads
// dir. External image URLs and empty values are ignored.
async function removeLocalImage(imageValue) {
  const key = localImageKey(imageValue);
  if (!key) return;
  try {
    await getBlobStore("image").delete(key);
  } catch (err) {
    console.error("Failed to remove inventory image blob:", err);
  }
}


export default async function handler(req, res) {
  const { id } = req.query;
  // Local SQLite uses autoincrement integer ids; the cloud (Supabase) uses
  // UUID strings. Only enforce the numeric shape on the SQLite backend.
  let entityId = id;
  if (caps.db === 'sqlite') {
    const numericId = parseInt(id, 10);
    if (Number.isNaN(numericId)) {
      return res.status(400).json({ error: 'Invalid inventory id.' });
    }
    entityId = numericId;
  }

  let repo;
  try {
    repo = await getRepo(req);
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Failed to resolve data context.' });
  }

  if (req.method === 'DELETE') {
    try {
      // Capture the image reference before the row is gone so we can clean up
      // any locally-stored file once the delete succeeds.
      const existing = repo.inventory.getById ? await repo.inventory.getById(entityId) : null;
      await repo.firingProfiles.removeByInventoryId(entityId);
      const result = await repo.inventory.remove(entityId);
      if (result.changes === 0) return res.status(404).json({ error: 'Inventory item not found.' });
      await removeLocalImage(existing?.image);
      return res.status(200).json({ message: 'Inventory item deleted successfully.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to delete inventory item.' });
    }
  }

  if (req.method === 'PATCH') {
    const { name, type, duration, fuse_delay, lift_delay, burn_rate, color, available_ct, youtube_link, youtube_link_start_sec, image, metadata, source, unit_cost } = req.body;
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
      const sourceValue = source || 'user_created';
      const unitCost = parseOptionalUnitCost(unit_cost);
      // Note the prior image so a swapped-out local upload can be cleaned up.
      const existing = repo.inventory.getById ? await repo.inventory.getById(entityId) : null;
      const result = await repo.inventory.update(entityId, {
        name, type, duration, fuse_delay, lift_delay, burn_rate, color,
        available_ct, youtube_link, youtube_link_start_sec, image,
        metadata: metadataStr, unit_cost: unitCost, source: sourceValue,
      });
      if (result.changes === 0) return res.status(404).json({ error: 'Inventory item not found.' });
      const oldKey = localImageKey(existing?.image);
      if (oldKey && oldKey !== localImageKey(image)) {
        await removeLocalImage(existing.image);
      }
      return res.status(200).json({ message: 'Inventory item updated successfully.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to update inventory item.' });
    }
  }

  res.setHeader('Allow', ['PATCH', 'DELETE']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
