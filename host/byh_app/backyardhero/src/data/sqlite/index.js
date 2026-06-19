// SQLite repository adapter (Cloud Builder plan §3.2).
//
// Wraps the lazily-built prepared statements from `@/util/sqldb` 1:1. The
// `ctx` (userId) is intentionally IGNORED — local is a single implicit
// operator, so the on-device data path keeps its exact current semantics.
// All methods are async to match the repository contract (the Supabase
// adapter is genuinely async); they just resolve the synchronous result.

import { getQueries } from '@/util/sqldb';

export function createSqliteRepo(/* ctx */) {
  const {
    showQueries,
    inventoryQueries,
    firingProfileQueries,
    rackQueries,
    receiverQueries,
  } = getQueries();

  return {
    shows: {
      async list() {
        return showQueries.getAll.all();
      },
      async create(row) {
        const r = showQueries.insert.run(
          row.name, row.duration, row.version, row.runtime_version,
          row.display_payload, row.runtime_payload,
          row.authorization_code, row.protocol, row.audio_file,
          row.receiver_locations, row.receiver_labels, row.show_receivers,
        );
        return { id: r.lastInsertRowid };
      },
      async update(id, row) {
        const r = showQueries.update.run(
          row.name, row.duration, row.version, row.runtime_version,
          row.display_payload, row.runtime_payload,
          row.authorization_code, row.protocol, row.audio_file,
          row.receiver_locations, row.receiver_labels, row.show_receivers,
          id,
        );
        return { changes: r.changes };
      },
      async remove(id) {
        const r = showQueries.delete.run(id);
        return { changes: r.changes };
      },
    },

    inventory: {
      async list() {
        return inventoryQueries.getAll.all();
      },
      async getById(id) {
        return inventoryQueries.getById.get(id);
      },
      async create(row) {
        const r = inventoryQueries.insert.run(
          row.name, row.type, row.duration, row.fuse_delay, row.lift_delay,
          row.burn_rate, row.color, row.available_ct, row.youtube_link,
          row.youtube_link_start_sec, row.image, row.metadata, row.unit_cost,
          row.source,
        );
        return { id: r.lastInsertRowid };
      },
      async update(id, row) {
        const r = inventoryQueries.update.run(
          row.name, row.type, row.duration, row.fuse_delay, row.lift_delay,
          row.burn_rate, row.color, row.available_ct, row.youtube_link,
          row.youtube_link_start_sec, row.image, row.metadata, row.unit_cost,
          row.source, id,
        );
        return { changes: r.changes };
      },
      async remove(id) {
        const r = inventoryQueries.delete.run(id);
        return { changes: r.changes };
      },
    },

    firingProfiles: {
      async list() {
        return firingProfileQueries.getAll.all();
      },
      async getByInventoryId(inventoryId) {
        return firingProfileQueries.getByInventoryId.get(inventoryId);
      },
      async update(inventoryId, shotTimestampsJson) {
        const r = firingProfileQueries.update.run(shotTimestampsJson, inventoryId);
        return { changes: r.changes };
      },
      async removeByInventoryId(inventoryId) {
        const r = firingProfileQueries.deleteByInventoryId.run(inventoryId);
        return { changes: r.changes };
      },
    },

    racks: {
      async listByShow(showId) {
        return rackQueries.getAll.all(showId);
      },
      async getById(id) {
        return rackQueries.getById.get(id);
      },
      async create(row) {
        const r = rackQueries.insert.run(
          row.show_id, row.name, row.x_rows, row.x_spacing,
          row.y_rows, row.y_spacing, row.cells, row.fuses,
        );
        return { id: r.lastInsertRowid };
      },
      async update(id, row) {
        const r = rackQueries.update.run(
          row.name, row.x_rows, row.x_spacing, row.y_rows, row.y_spacing,
          row.cells, row.fuses, id,
        );
        return { changes: r.changes };
      },
      async remove(id) {
        const r = rackQueries.delete.run(id);
        return { changes: r.changes };
      },
    },

    receivers: {
      async list() {
        return receiverQueries.getAll();
      },
      async getById(id) {
        return receiverQueries.getById(id);
      },
      async insert(obj) {
        const r = receiverQueries.insert(obj);
        return { changes: r.changes };
      },
      async update(id, patch) {
        const r = receiverQueries.update(id, patch);
        return { changes: r.changes };
      },
      async remove(id) {
        const r = receiverQueries.delete(id);
        return { changes: r.changes };
      },
    },
  };
}
