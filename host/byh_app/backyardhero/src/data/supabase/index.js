// Supabase repository adapter (Cloud Builder plan §3.2 / §4).
//
// Backs the cloud profile against Supabase Postgres (`builder_*` tables) with
// per-user RLS. The cookie-backed client carries the signed-in user's JWT, so
// Postgres enforces row ownership; `user_id` is filled on insert by the
// column default `public.requesting_user_id()`. We additionally scope
// reads/updates/deletes by ctx.userId for clarity and defense in depth.
//
// text <-> jsonb is the only translation vs the SQLite adapter: the SQLite
// columns are TEXT (JSON strings) and the rest of the app expects strings, so
// on the way OUT we stringify jsonb back to text, and on the way IN we parse
// the route-provided JSON strings into objects for jsonb storage.
//
// NOTE: receivers are device-physical (Cloud Builder §6.3) and are NOT managed
// in the cloud — the receivers repo is a no-op/empty here so config.js and the
// (hardware-gated) receiver routes degrade cleanly.

import { createServerSupabase } from '@/util/supabase/server';

const T_SHOWS = 'builder_shows';
const T_INVENTORY = 'builder_inventory';
const T_PROFILES = 'builder_inventory_firing_profile';
const T_RACKS = 'builder_racks';
const T_RECEIVERS = 'builder_receivers';

// jsonb columns per table — read as text (stringify), written from text (parse).
const SHOW_JSON = ['display_payload', 'runtime_payload', 'audio_file', 'receiver_locations', 'receiver_labels', 'show_receivers'];
const INVENTORY_JSON = ['metadata'];
const PROFILE_JSON = ['shot_timestamps'];
const RACK_JSON = ['cells', 'fuses'];

function parseJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

function stringifyJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

// Map a DB row to the text-shaped row the rest of the app expects.
function rowToText(row, jsonCols) {
  if (!row) return row;
  const out = { ...row };
  for (const col of jsonCols) {
    if (col in out) out[col] = stringifyJson(out[col]);
  }
  return out;
}

// Map an incoming (route-provided) row's JSON-string columns to objects for
// jsonb storage, keeping only defined keys.
function rowToJsonb(row, jsonCols) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    out[k] = jsonCols.includes(k) ? parseJson(v) : v;
  }
  return out;
}

function raise(error, fallback) {
  const e = new Error(error?.message || fallback);
  e.cause = error;
  throw e;
}

// Map a builder_receivers row to the shape the rest of the app expects from
// the (on-device) Receivers table: keyed by the textual `ident` as `id`, with
// cues_data/metadata as objects (jsonb already parses to objects via
// supabase-js — receivers are the one entity whose consumers want objects, not
// JSON strings). Hardware/telemetry fields don't exist in the cloud, so they're
// reported as null/defaults to keep the row shape stable.
function receiverRowOut(row) {
  if (!row) return row;
  return {
    id: row.ident,
    label: row.label,
    type: row.type,
    cues_data: row.cues_data || {},
    enabled: row.enabled !== false,
    metadata: row.metadata || {},
    configuration_version: 1,
    fw_version: null,
    board_version: null,
    cues_available: null,
    config_data: {},
    updated_at: row.updated_at,
  };
}

export function createSupabaseRepo(ctx, req, res) {
  const sb = createServerSupabase(req, res);
  const uid = ctx.userId;

  return {
    shows: {
      async list() {
        const { data, error } = await sb.from(T_SHOWS).select('*').eq('user_id', uid);
        if (error) raise(error, 'Failed to list shows.');
        return (data || []).map((r) => rowToText(r, SHOW_JSON));
      },
      async create(row) {
        const { data, error } = await sb
          .from(T_SHOWS)
          .insert(rowToJsonb(row, SHOW_JSON))
          .select('id')
          .single();
        if (error) raise(error, 'Failed to create show.');
        return { id: data.id };
      },
      async update(id, row) {
        const { data, error } = await sb
          .from(T_SHOWS)
          .update(rowToJsonb(row, SHOW_JSON))
          .eq('id', id)
          .eq('user_id', uid)
          .select('id');
        if (error) raise(error, 'Failed to update show.');
        return { changes: data?.length || 0 };
      },
      async remove(id) {
        const { data, error } = await sb
          .from(T_SHOWS)
          .delete()
          .eq('id', id)
          .eq('user_id', uid)
          .select('id');
        if (error) raise(error, 'Failed to delete show.');
        return { changes: data?.length || 0 };
      },
    },

    inventory: {
      async list() {
        const { data, error } = await sb.from(T_INVENTORY).select('*').eq('user_id', uid);
        if (error) raise(error, 'Failed to list inventory.');
        return (data || []).map((r) => rowToText(r, INVENTORY_JSON));
      },
      async create(row) {
        const { data, error } = await sb
          .from(T_INVENTORY)
          .insert(rowToJsonb(row, INVENTORY_JSON))
          .select('id')
          .single();
        if (error) raise(error, 'Failed to create inventory item.');
        return { id: data.id };
      },
      async update(id, row) {
        const { data, error } = await sb
          .from(T_INVENTORY)
          .update(rowToJsonb(row, INVENTORY_JSON))
          .eq('id', id)
          .eq('user_id', uid)
          .select('id');
        if (error) raise(error, 'Failed to update inventory item.');
        return { changes: data?.length || 0 };
      },
      async remove(id) {
        const { data, error } = await sb
          .from(T_INVENTORY)
          .delete()
          .eq('id', id)
          .eq('user_id', uid)
          .select('id');
        if (error) raise(error, 'Failed to delete inventory item.');
        return { changes: data?.length || 0 };
      },
    },

    firingProfiles: {
      async list() {
        const { data, error } = await sb.from(T_PROFILES).select('*').eq('user_id', uid);
        if (error) raise(error, 'Failed to list firing profiles.');
        return (data || []).map((r) => rowToText(r, PROFILE_JSON));
      },
      async getByInventoryId(inventoryId) {
        const { data, error } = await sb
          .from(T_PROFILES)
          .select('*')
          .eq('inventory_id', inventoryId)
          .eq('user_id', uid)
          .maybeSingle();
        if (error) raise(error, 'Failed to read firing profile.');
        return data ? rowToText(data, PROFILE_JSON) : undefined;
      },
      async update(inventoryId, shotTimestampsJson) {
        const { data, error } = await sb
          .from(T_PROFILES)
          .update({ shot_timestamps: parseJson(shotTimestampsJson) })
          .eq('inventory_id', inventoryId)
          .eq('user_id', uid)
          .select('id');
        if (error) raise(error, 'Failed to update firing profile.');
        return { changes: data?.length || 0 };
      },
      async removeByInventoryId(inventoryId) {
        const { data, error } = await sb
          .from(T_PROFILES)
          .delete()
          .eq('inventory_id', inventoryId)
          .eq('user_id', uid)
          .select('id');
        if (error) raise(error, 'Failed to delete firing profile.');
        return { changes: data?.length || 0 };
      },
    },

    racks: {
      async listByShow(showId) {
        const { data, error } = await sb
          .from(T_RACKS)
          .select('*')
          .eq('show_id', showId)
          .eq('user_id', uid);
        if (error) raise(error, 'Failed to list racks.');
        return (data || []).map((r) => rowToText(r, RACK_JSON));
      },
      async getById(id) {
        const { data, error } = await sb
          .from(T_RACKS)
          .select('*')
          .eq('id', id)
          .eq('user_id', uid)
          .maybeSingle();
        if (error) raise(error, 'Failed to read rack.');
        return data ? rowToText(data, RACK_JSON) : undefined;
      },
      async create(row) {
        const { data, error } = await sb
          .from(T_RACKS)
          .insert(rowToJsonb(row, RACK_JSON))
          .select('id')
          .single();
        if (error) raise(error, 'Failed to create rack.');
        return { id: data.id };
      },
      async update(id, row) {
        const { data, error } = await sb
          .from(T_RACKS)
          .update(rowToJsonb(row, RACK_JSON))
          .eq('id', id)
          .eq('user_id', uid)
          .select('id');
        if (error) raise(error, 'Failed to update rack.');
        return { changes: data?.length || 0 };
      },
      async remove(id) {
        const { data, error } = await sb
          .from(T_RACKS)
          .delete()
          .eq('id', id)
          .eq('user_id', uid)
          .select('id');
        if (error) raise(error, 'Failed to delete rack.');
        return { changes: data?.length || 0 };
      },
    },

    // Receivers: the LOGICAL palette (builder_receivers), keyed by textual
    // ident. This powers the "native" show-receiver picker in the cloud editor.
    // Hardware-only routes (reload/retry/rxcfg) stay gated off; these CRUD ops
    // mirror the on-device Receivers table's logical columns only.
    receivers: {
      async list() {
        const { data, error } = await sb
          .from(T_RECEIVERS)
          .select('*')
          .eq('user_id', uid)
          .order('ident');
        if (error) raise(error, 'Failed to list receivers.');
        return (data || []).map(receiverRowOut);
      },
      async getById(id) {
        const { data, error } = await sb
          .from(T_RECEIVERS)
          .select('*')
          .eq('ident', id)
          .eq('user_id', uid)
          .maybeSingle();
        if (error) raise(error, 'Failed to read receiver.');
        return data ? receiverRowOut(data) : null;
      },
      async insert({ id, label, type, cues_data = {}, enabled = true, metadata = {} } = {}) {
        const { error } = await sb.from(T_RECEIVERS).insert({
          ident: id,
          label: label || id,
          type,
          cues_data: cues_data ?? {},
          enabled: enabled !== false,
          metadata: metadata ?? {},
        });
        if (error) raise(error, 'Failed to insert receiver.');
        return { changes: 1 };
      },
      async update(id, patch = {}) {
        // Only the logical columns are writable here; telemetry fields
        // (fw_version, etc.) are device-only and silently ignored.
        const upd = {};
        for (const k of ['label', 'type', 'cues_data', 'enabled', 'metadata']) {
          if (patch[k] !== undefined) upd[k] = patch[k];
        }
        if (Object.keys(upd).length === 0) return { changes: 0 };
        const { data, error } = await sb
          .from(T_RECEIVERS)
          .update(upd)
          .eq('ident', id)
          .eq('user_id', uid)
          .select('id');
        if (error) raise(error, 'Failed to update receiver.');
        return { changes: data?.length || 0 };
      },
      async remove(id) {
        const { data, error } = await sb
          .from(T_RECEIVERS)
          .delete()
          .eq('ident', id)
          .eq('user_id', uid)
          .select('id');
        if (error) raise(error, 'Failed to delete receiver.');
        return { changes: data?.length || 0 };
      },
    },
  };
}
