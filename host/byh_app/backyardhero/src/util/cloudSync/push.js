// Push engine: device → cloud (Cloud Builder plan §6.2).
//
// Pushes, in dependency order:
//   * inventory       → builder_inventory                 (local int id → cloud uuid)
//   * firing profiles → builder_inventory_firing_profile  (keyed by inv uuid)
//   * receivers       → builder_receivers                 (keyed by textual ident)
//   * shows           → builder_shows  (display_payload inventory refs remapped;
//                       audio bytes uploaded to Storage + urls rewritten)
//   * racks           → builder_racks  (show_id + cell/fuse inventory refs remapped),
//                       then a second pass relinks rackId back-refs in show items.
//
// Strategy: explicit, last-write-wins, idempotent. Each row is upserted by its
// recorded cloud id (sync_state); a content hash of the LOCAL source lets
// re-pushes skip unchanged rows (and avoids re-uploading audio). Errors are
// collected per-entity rather than aborting the whole run so one bad row
// doesn't strand the rest.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getQueries } from '@/util/sqldb';
import { getAuthedClient } from './client';
import { getSyncState, setSyncState } from './state';

const T_INVENTORY = 'builder_inventory';
const T_PROFILES = 'builder_inventory_firing_profile';
const T_RECEIVERS = 'builder_receivers';
const T_SHOWS = 'builder_shows';
const T_RACKS = 'builder_racks';
const AUDIO_BUCKET = process.env.BYH_AUDIO_BUCKET || 'show-audio';
const AUDIO_SIGNED_TTL_S = 60 * 60 * 24 * 7; // 7 days

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function hashOf(payload) {
  return crypto.createHash('sha1').update(stableStringify(payload)).digest('hex');
}

function parseJsonOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// SQLite is loosely typed: numeric columns can hold '', text, or numbers.
// Postgres real/integer columns reject '' / non-numeric strings, so coerce to
// a finite number or null before sending. Negative values also violate the
// builder_inventory CHECK constraints, so clamp those to null too.
function num(v, { nonNegative = false } = {}) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (nonNegative && n < 0) return null;
  return n;
}

function intOr(v, fallback = null) {
  const n = num(v, { nonNegative: true });
  return n === null ? fallback : Math.round(n);
}

function mapInventory(row) {
  return {
    name: row.name,
    type: row.type,
    duration: num(row.duration, { nonNegative: true }),
    fuse_delay: num(row.fuse_delay, { nonNegative: true }),
    lift_delay: num(row.lift_delay, { nonNegative: true }),
    burn_rate: num(row.burn_rate, { nonNegative: true }),
    color: row.color || null,
    available_ct: intOr(row.available_ct, 0),
    youtube_link: row.youtube_link || null,
    image: row.image || null,
    youtube_link_start_sec: intOr(row.youtube_link_start_sec, null),
    metadata: parseJsonOrNull(row.metadata),
    source: row.source || 'user_created',
    unit_cost: num(row.unit_cost, { nonNegative: true }),
  };
}

// ── Show / rack id remapping ─────────────────────────────────────────────────
// Inventory references inside show display_payload + rack cells live under a
// small, well-known set of keys. We remap ONLY those keys (never the ambiguous
// `id`, which at the show-item level is a per-show sequence number, not an
// inventory id). Fuse references are an inventory id stored as `type` on a
// `fuse` object / inside the rack `fuses` map.
const INV_REF_KEYS = new Set(['itemId', 'fireableItemId', 'shellId']);

function remapInvId(v, invMap) {
  if (v === null || v === undefined) return v;
  const mapped = invMap[v] ?? invMap[String(v)];
  return mapped ?? v;
}

function remapFuseObj(fuse, invMap) {
  const out = deepRemap(fuse, invMap);
  if (out && typeof out === 'object' && 'type' in out &&
      (typeof out.type === 'number' || typeof out.type === 'string')) {
    const mapped = invMap[out.type] ?? invMap[String(out.type)];
    if (mapped) out.type = String(mapped);
  }
  return out;
}

function remapFusesMap(fuses, invMap) {
  if (!fuses || typeof fuses !== 'object') return fuses;
  const out = {};
  for (const [fid, f] of Object.entries(fuses)) out[fid] = remapFuseObj(f, invMap);
  return out;
}

function deepRemap(node, invMap) {
  if (Array.isArray(node)) return node.map((n) => deepRemap(n, invMap));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (INV_REF_KEYS.has(k) && (typeof v === 'number' || typeof v === 'string')) {
        out[k] = remapInvId(v, invMap);
      } else if (k === 'fuse' && v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = remapFuseObj(v, invMap);
      } else if (k === 'fuses' && v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = remapFusesMap(v, invMap);
      } else {
        out[k] = deepRemap(v, invMap);
      }
    }
    return out;
  }
  return node;
}

// ── Audio: read local bytes, upload to Storage, rewrite track urls ───────────
function audioContentType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.flac') return 'audio/flac';
  return 'application/octet-stream';
}

function readLocalAudio(filename) {
  const safe = path.basename(filename || '');
  if (!safe) return null;
  const p = path.join(process.cwd(), 'public', 'uploads', 'audio', safe);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

// Upload every local track's bytes to the user's Storage prefix and rewrite the
// url to a signed URL. Tracks already pointing at an absolute URL (e.g. a show
// that originated in the cloud) are left untouched. Returns { audio, warnings }.
async function pushAudio(sb, userId, audioObj) {
  const warnings = [];
  if (!audioObj || typeof audioObj !== 'object' || !Array.isArray(audioObj.tracks)) {
    return { audio: audioObj ?? null, warnings };
  }
  const tracks = [];
  for (const t of audioObj.tracks) {
    if (!t || !t.url || /^https?:\/\//i.test(t.url) || /^data:/i.test(t.url)) {
      tracks.push(t);
      continue;
    }
    const filename = decodeURIComponent(String(t.url).split('?')[0].split('/').pop() || '');
    const bytes = readLocalAudio(filename);
    if (!bytes) {
      warnings.push(`Audio file missing on device: ${filename || t.url}`);
      tracks.push(t);
      continue;
    }
    const ext = path.extname(filename) || '.mp3';
    const key = `audio/${userId}/${crypto.randomUUID()}${ext}`;
    const { error: upErr } = await sb.storage
      .from(AUDIO_BUCKET)
      .upload(key, bytes, { contentType: audioContentType(filename), upsert: true });
    if (upErr) {
      warnings.push(`Audio upload failed (${filename}): ${upErr.message}`);
      tracks.push(t);
      continue;
    }
    const { data: signed, error: signErr } = await sb.storage
      .from(AUDIO_BUCKET)
      .createSignedUrl(key, AUDIO_SIGNED_TTL_S);
    tracks.push({ ...t, key, url: signErr ? t.url : signed.signedUrl });
  }
  return { audio: { ...audioObj, tracks }, warnings };
}

const blank = () => ({ inserted: 0, updated: 0, skipped: 0, errors: [] });

/**
 * Run a push. Returns { ok, report, invMap } where report has per-entity
 * counts + errors and invMap is local inventory id → cloud uuid (kept for the
 * caller / Phase 2B show push).
 */
export async function runPush() {
  const { sb, userId, email } = await getAuthedClient();
  const { inventoryQueries, firingProfileQueries, receiverQueries, showQueries, rackQueries } =
    getQueries();

  const report = {
    account: email,
    inventory: blank(),
    firingProfiles: blank(),
    receivers: blank(),
    shows: blank(),
    racks: blank(),
    warnings: [],
  };

  // ── Inventory ──────────────────────────────────────────────────────────
  const invMap = {}; // local id -> cloud uuid
  const invRows = inventoryQueries.getAll.all();
  for (const row of invRows) {
    const payload = mapInventory(row);
    const hash = hashOf(payload);
    const st = getSyncState('inventory', row.id);
    try {
      if (st?.cloud_id) {
        if (st.last_pushed_hash === hash) {
          invMap[row.id] = st.cloud_id;
          report.inventory.skipped++;
          continue;
        }
        const { data, error } = await sb
          .from(T_INVENTORY)
          .update(payload)
          .eq('id', st.cloud_id)
          .select('id');
        if (error) throw error;
        if (data && data.length > 0) {
          invMap[row.id] = st.cloud_id;
          setSyncState('inventory', row.id, st.cloud_id, hash);
          report.inventory.updated++;
          continue;
        }
        // Row vanished cloud-side (deleted there): fall through to insert.
      }
      const { data, error } = await sb
        .from(T_INVENTORY)
        .insert(payload)
        .select('id')
        .single();
      if (error) throw error;
      invMap[row.id] = data.id;
      setSyncState('inventory', row.id, data.id, hash);
      report.inventory.inserted++;
    } catch (err) {
      report.inventory.errors.push({ id: row.id, name: row.name, error: err?.message || String(err) });
    }
  }

  // ── Firing profiles (depend on inventory uuids) ─────────────────────────
  const profRows = firingProfileQueries.getAll.all();
  for (const row of profRows) {
    const cloudInvId = invMap[row.inventory_id];
    if (!cloudInvId) {
      report.firingProfiles.errors.push({
        inventory_id: row.inventory_id,
        error: 'No cloud inventory mapping (item failed to push?)',
      });
      continue;
    }
    const payload = {
      inventory_id: cloudInvId,
      youtube_link: row.youtube_link || '',
      youtube_link_start_sec: intOr(row.youtube_link_start_sec, 0),
      shot_timestamps: parseJsonOrNull(row.shot_timestamps) ?? [],
    };
    const hash = hashOf(payload);
    const st = getSyncState('firing_profile', row.id);
    try {
      // Upsert by the unique inventory_id (one profile per item).
      const { data: existing, error: selErr } = await sb
        .from(T_PROFILES)
        .select('id')
        .eq('inventory_id', cloudInvId)
        .maybeSingle();
      if (selErr) throw selErr;
      if (existing?.id) {
        if (st?.last_pushed_hash === hash) {
          report.firingProfiles.skipped++;
          setSyncState('firing_profile', row.id, existing.id, hash);
          continue;
        }
        const { error } = await sb.from(T_PROFILES).update(payload).eq('id', existing.id);
        if (error) throw error;
        setSyncState('firing_profile', row.id, existing.id, hash);
        report.firingProfiles.updated++;
      } else {
        const { data, error } = await sb
          .from(T_PROFILES)
          .insert(payload)
          .select('id')
          .single();
        if (error) throw error;
        setSyncState('firing_profile', row.id, data.id, hash);
        report.firingProfiles.inserted++;
      }
    } catch (err) {
      report.firingProfiles.errors.push({
        inventory_id: row.inventory_id,
        error: err?.message || String(err),
      });
    }
  }

  // ── Receivers (keyed by textual ident — no remap) ───────────────────────
  const recRows = receiverQueries.getAll(); // hydrated: cues_data/metadata objects, enabled bool
  for (const row of recRows) {
    const payload = {
      ident: row.id,
      label: row.label || row.id,
      type: row.type,
      cues_data: row.cues_data || {},
      enabled: row.enabled !== false,
      metadata: row.metadata || {},
    };
    const hash = hashOf(payload);
    const st = getSyncState('receiver', row.id);
    try {
      const { data: existing, error: selErr } = await sb
        .from(T_RECEIVERS)
        .select('id')
        .eq('ident', row.id)
        .maybeSingle();
      if (selErr) throw selErr;
      if (existing?.id) {
        if (st?.last_pushed_hash === hash) {
          report.receivers.skipped++;
          setSyncState('receiver', row.id, existing.id, hash);
          continue;
        }
        const { error } = await sb
          .from(T_RECEIVERS)
          .update({
            label: payload.label,
            type: payload.type,
            cues_data: payload.cues_data,
            enabled: payload.enabled,
            metadata: payload.metadata,
          })
          .eq('id', existing.id);
        if (error) throw error;
        setSyncState('receiver', row.id, existing.id, hash);
        report.receivers.updated++;
      } else {
        const { data, error } = await sb
          .from(T_RECEIVERS)
          .insert(payload)
          .select('id')
          .single();
        if (error) throw error;
        setSyncState('receiver', row.id, data.id, hash);
        report.receivers.inserted++;
      }
    } catch (err) {
      report.receivers.errors.push({ ident: row.id, error: err?.message || String(err) });
    }
  }

  // ── Shows (remap inventory ids in display_payload + upload audio) ────────
  const showMap = {}; // local show id -> cloud uuid
  const pushedShows = []; // { cloudId, displayItems } for the rackId second pass
  const showRows = showQueries.getAll.all();
  for (const row of showRows) {
    // Hash the raw local source (stable across pushes) so unchanged shows skip
    // and we don't re-upload audio every time.
    const hash = hashOf({
      name: row.name,
      duration: row.duration,
      version: row.version,
      runtime_version: row.runtime_version,
      display_payload: row.display_payload,
      runtime_payload: row.runtime_payload,
      authorization_code: row.authorization_code,
      protocol: row.protocol,
      audio_file: row.audio_file,
      receiver_locations: row.receiver_locations,
      receiver_labels: row.receiver_labels,
      show_receivers: row.show_receivers,
    });
    const st = getSyncState('show', row.id);
    try {
      const rawItems = parseJsonOrNull(row.display_payload) ?? [];
      const displayItems = Array.isArray(rawItems)
        ? rawItems.map((it) => deepRemap(it, invMap))
        : rawItems;
      const { audio, warnings } = await pushAudio(sb, userId, parseJsonOrNull(row.audio_file));
      warnings.forEach((w) => report.warnings.push(`Show "${row.name}": ${w}`));

      const payload = {
        name: row.name,
        duration: Math.max(0, intOr(row.duration, 0) ?? 0),
        version: String(row.version ?? '1'),
        runtime_version: String(row.runtime_version ?? '0'),
        display_payload: displayItems,
        runtime_payload: parseJsonOrNull(row.runtime_payload) ?? {},
        authorization_code: row.authorization_code ?? '',
        protocol: row.protocol ?? null,
        audio_file: audio ?? null,
        receiver_locations: parseJsonOrNull(row.receiver_locations),
        receiver_labels: parseJsonOrNull(row.receiver_labels),
        show_receivers: parseJsonOrNull(row.show_receivers),
      };

      let cloudId = st?.cloud_id || null;
      if (cloudId) {
        if (st.last_pushed_hash === hash) {
          showMap[row.id] = cloudId;
          pushedShows.push({ cloudId, displayItems });
          report.shows.skipped++;
          continue;
        }
        const { data, error } = await sb
          .from(T_SHOWS)
          .update(payload)
          .eq('id', cloudId)
          .select('id');
        if (error) throw error;
        if (!data || data.length === 0) cloudId = null; // vanished cloud-side
        else report.shows.updated++;
      }
      if (!cloudId) {
        const { data, error } = await sb.from(T_SHOWS).insert(payload).select('id').single();
        if (error) throw error;
        cloudId = data.id;
        report.shows.inserted++;
      }
      setSyncState('show', row.id, cloudId, hash);
      showMap[row.id] = cloudId;
      pushedShows.push({ cloudId, displayItems });
    } catch (err) {
      report.shows.errors.push({ id: row.id, name: row.name, error: err?.message || String(err) });
    }
  }

  // ── Racks (remap show_id + cell/fuse inventory ids) ─────────────────────
  const rackMap = {}; // local rack id -> cloud uuid
  for (const showRow of showRows) {
    const cloudShowId = showMap[showRow.id];
    if (!cloudShowId) continue; // parent show failed / skipped without mapping
    const rackRows = rackQueries.getAll.all(showRow.id);
    for (const rack of rackRows) {
      const payload = {
        show_id: cloudShowId,
        name: rack.name,
        x_rows: Math.max(1, intOr(rack.x_rows, 1) ?? 1),
        x_spacing: num(rack.x_spacing, { nonNegative: true }) ?? 0,
        y_rows: Math.max(1, intOr(rack.y_rows, 1) ?? 1),
        y_spacing: num(rack.y_spacing, { nonNegative: true }) ?? 0,
        cells: deepRemap(parseJsonOrNull(rack.cells) ?? {}, invMap),
        fuses: remapFusesMap(parseJsonOrNull(rack.fuses) ?? {}, invMap),
      };
      const hash = hashOf({ show: showRow.id, cells: rack.cells, fuses: rack.fuses, name: rack.name });
      const st = getSyncState('rack', rack.id);
      try {
        let cloudId = st?.cloud_id || null;
        if (cloudId) {
          if (st.last_pushed_hash === hash) {
            rackMap[rack.id] = cloudId;
            report.racks.skipped++;
            continue;
          }
          const { data, error } = await sb
            .from(T_RACKS)
            .update(payload)
            .eq('id', cloudId)
            .select('id');
          if (error) throw error;
          if (!data || data.length === 0) cloudId = null;
          else report.racks.updated++;
        }
        if (!cloudId) {
          const { data, error } = await sb.from(T_RACKS).insert(payload).select('id').single();
          if (error) throw error;
          cloudId = data.id;
          report.racks.inserted++;
        }
        setSyncState('rack', rack.id, cloudId, hash);
        rackMap[rack.id] = cloudId;
      } catch (err) {
        report.racks.errors.push({ id: rack.id, name: rack.name, error: err?.message || String(err) });
      }
    }
  }

  // ── Second pass: remap rackId back-references inside show items ──────────
  // display_payload items can reference a rack by local rackId (edit-time use).
  // Now that racks have cloud ids, rewrite those and update only the shows that
  // actually changed.
  if (Object.keys(rackMap).length > 0) {
    for (const ps of pushedShows) {
      if (!Array.isArray(ps.displayItems)) continue;
      let changed = false;
      const items = ps.displayItems.map((it) => {
        if (it && typeof it === 'object' && it.rackId != null) {
          const mapped = rackMap[it.rackId] ?? rackMap[String(it.rackId)];
          if (mapped && mapped !== it.rackId) {
            changed = true;
            return { ...it, rackId: mapped };
          }
        }
        return it;
      });
      if (changed) {
        const { error } = await sb.from(T_SHOWS).update({ display_payload: items }).eq('id', ps.cloudId);
        if (error) {
          report.warnings.push(`Failed to link racks into a show: ${error.message}`);
        }
      }
    }
  }

  const errorCount =
    report.inventory.errors.length +
    report.firingProfiles.errors.length +
    report.receivers.errors.length +
    report.shows.errors.length +
    report.racks.errors.length;

  return { ok: errorCount === 0, report, invMap };
}
