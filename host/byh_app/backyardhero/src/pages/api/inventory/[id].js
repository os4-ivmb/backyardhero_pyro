import { inventoryQueries, firingProfileQueries } from "@/util/sqldb";
import { parseOptionalUnitCost } from "@/util/inventoryUnitCost";


export default function handler(req, res) {
  const { id } = req.query;
  const numericId = parseInt(id, 10);
  if (Number.isNaN(numericId)) {
    return res.status(400).json({ error: 'Invalid inventory id.' });
  }

  if (req.method === 'DELETE') {
    try {
      firingProfileQueries.deleteByInventoryId.run(numericId);
      const result = inventoryQueries.delete.run(numericId);
      if (result.changes === 0) return res.status(404).json({ error: 'Inventory item not found.' });
      return res.status(200).json({ message: 'Inventory item deleted successfully.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to delete inventory item.' });
    }
  }

  if (req.method === 'PATCH') {
    const { name, type, duration, fuse_delay, lift_delay, burn_rate, color, available_ct, youtube_link, youtube_link_start_sec, image, metadata, source, unit_cost } = req.body;
    console.log(req.body)
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
      const result = inventoryQueries.update.run(name, type, duration, fuse_delay, lift_delay, burn_rate, color, available_ct, youtube_link, youtube_link_start_sec, image, metadataStr, unitCost, sourceValue, numericId);
      if (result.changes === 0) return res.status(404).json({ error: 'Inventory item not found.' });
      return res.status(200).json({ message: 'Inventory item updated successfully.' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to update inventory item.' });
    }
  }

  res.setHeader('Allow', ['PATCH', 'DELETE']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}