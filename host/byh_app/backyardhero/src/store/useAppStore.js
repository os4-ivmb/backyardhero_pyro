// stores/useAppStore.js
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import axios from 'axios';
import { parseAudioField } from '@/utils/audioTracks';

const receiverRowToStoreEntry = (row) => ({
  label: row.label,
  type: row.type,
  cues: row.cues_data || {},
  enabled: !!row.enabled,
  metadata: row.metadata || {},
  configuration_version: row.configuration_version,
  // Receiver-reported config (FW v22+ via the dongle). Null until the
  // first CONFIG_RESPONSE lands; the UI uses null vs 0 to distinguish
  // "haven't queried yet" from "really 0 cues / no boards".
  fw_version: row.fw_version ?? null,
  board_version: row.board_version ?? null,
  cues_available: row.cues_available ?? null,
  config_data: row.config_data || {},
});

// Derive the camelCase, parsed fields (audioTracks/audioFile/audioOffsetMs,
// receiverLocations, receiverLabels, showReceivers) from a raw show row's
// snake_case JSON columns. Mutates and returns `show`.
//
// Every reader of a show — the ShowPicker "Audio" badge, `handleStage`,
// `hydrateStagedShowFromId`, the console — keys off these derived fields and
// the `audio_file` column. This is the SINGLE place that knows how to go
// from the persisted columns to that in-memory shape, so create/update can
// reuse it and stay byte-for-byte consistent with a fresh `fetchShows`.
const normalizeShowRow = (show) => {
  // Parse audio_file JSON string if it exists. Normalises both the legacy
  // single-track shape and the new {tracks:[]} shape into a canonical
  // `audioTracks` array, with `audioFile` kept as a back-compat alias for
  // the first track.
  if (show.audio_file) {
    try {
      const parsed = JSON.parse(show.audio_file);
      const { tracks, audioOffsetMs } = parseAudioField(parsed);
      show.audioTracks = tracks;
      show.audioOffsetMs = audioOffsetMs;
      show.audioFile = tracks[0] || null;
    } catch (e) {
      console.error('Failed to parse audio_file for show:', show.id, e);
      show.audioTracks = [];
      show.audioOffsetMs = 0;
      show.audioFile = null;
    }
  } else {
    show.audioTracks = [];
    show.audioOffsetMs = 0;
    show.audioFile = null;
  }

  // Parse receiver_locations JSON string if it exists
  if (show.receiver_locations) {
    try {
      show.receiverLocations = JSON.parse(show.receiver_locations);
    } catch (e) {
      console.error('Failed to parse receiver_locations for show:', show.id, e);
      show.receiverLocations = null;
    }
  } else {
    show.receiverLocations = null;
  }

  // Parse receiver_labels JSON string if it exists
  if (show.receiver_labels) {
    try {
      show.receiverLabels = JSON.parse(show.receiver_labels);
    } catch (e) {
      console.error('Failed to parse receiver_labels for show:', show.id, e);
      show.receiverLabels = null;
    }
  } else {
    show.receiverLabels = null;
  }

  // Parse show_receivers JSON if present. This is the per-show canonical
  // list of receivers / cue counts, owned by the show itself rather than
  // derived from the global Receivers table. Pre-migration shows have it
  // as null and the builder back-fills on first edit.
  if (show.show_receivers) {
    try {
      const parsed = JSON.parse(show.show_receivers);
      show.showReceivers = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error('Failed to parse show_receivers for show:', show.id, e);
      show.showReceivers = [];
    }
  } else {
    show.showReceivers = [];
  }

  return show;
};

// Build the canonical cached show object after a create/update. The API
// persists the show's audio as the snake_case `audio_file` JSON column,
// derived from the camelCase `audioFile` blob in the request body (see
// pages/api/shows/[id].js + index.js). The store, however, used to merge
// the request body verbatim — which set `audioFile` but left the stale
// `audio_file` string untouched. Because readers key off `audio_file`, a
// freshly-saved song looked gone on unstage/reload and only came back after
// a full app restart (when fetchShows re-read the column). Re-stamp
// `audio_file` from exactly what the server persisted, then normalise, so
// the cache matches SQLite without a round-trip.
const cacheRowFromSave = (base, payload, id) => {
  const merged = { ...base, ...payload, id };
  merged.audio_file = payload.audioFile ? JSON.stringify(payload.audioFile) : null;
  // `audioFile` in the payload is the multi-track blob; normalizeShowRow
  // re-derives the single-track alias from `audio_file`, so drop the blob.
  delete merged.audioFile;
  return normalizeShowRow(merged);
};

// We persist only a tiny subset (the staged show ID) to localStorage. The
// rich `stagedShow` object — items merged with inventory metadata, parsed
// audioFile, etc. — is *re-derived* from the canonical shows/inventory
// data on rehydration. That avoids the classic persistence trap where an
// inventory or show edit silently goes stale because a snapshot of it was
// frozen in localStorage.
const useAppStore = create(persist((set, get) => ({
  // Shows state
  shows: [],
  showById: {}, // Lookup dictionary for shows

  fetchShows: async () => {
    try {
      const { data } = await axios.get('/api/shows');
      const showById = data.reduce((acc, show) => {
        normalizeShowRow(show);
        acc[show.id] = show;
        return acc;
      }, {});
      set({ shows: data, showById });
    } catch (error) {
      console.error('Failed to fetch shows:', error);
    }
  },
  createShow: async (showData) => {
    try {
      const { data } = await axios.post('/api/shows', showData);
      const newShow = cacheRowFromSave({}, showData, data.id);
      set((state) => ({
        shows: [...state.shows, newShow],
        showById: { ...state.showById, [data.id]: newShow },
      }));
      return data.id
    } catch (error) {
      console.error('Failed to create show:', error);
    }
  },
  deleteShow: async (id) => {
    try {
      await axios.delete(`/api/shows/${id}`);
      set((state) => ({
        shows: state.shows.filter((show) => show.id !== id),
        showById: Object.keys(state.showById).reduce((acc, key) => {
          if (key !== id.toString()) acc[key] = state.showById[key];
          return acc;
        }, {}),
        // If the just-deleted show was staged, clear the staging slot
        // (and its persisted id) so the console flips back to the picker.
        ...(state.stagedShowId === id ? { stagedShow: {}, stagedShowId: null } : {}),
      }));
    } catch (error) {
      console.error("Failed to delete show:", error);
    }
  },
  // Returns { ok: true } on success or { ok: false, error } on failure so
  // callers can surface save problems to the operator. Previously this
  // swallowed every error into a console.error, so a rejected save (e.g.
  // payload over the API body limit) looked successful in the UI while the
  // change never persisted. Existing `await updateShow(...)` callers that
  // ignore the return value keep working unchanged.
  updateShow: async (id, updatedData) => {
    try {
      await axios.patch(`/api/shows/${id}`, updatedData);
      set((state) => {
        const base = state.showById[id]
          || state.shows.find((s) => s.id === id)
          || {};
        const updatedShow = cacheRowFromSave(base, updatedData, id);
        return {
          shows: state.shows.map((show) => (show.id === id ? updatedShow : show)),
          showById: { ...state.showById, [id]: updatedShow },
        };
      });
      return { ok: true };
    } catch (error) {
      console.error('Failed to update show:', error);
      const status = error?.response?.status;
      const msg = status === 413
        ? 'Show is too large to save. Try splitting it or removing unused media.'
        : (error?.response?.data?.error || error?.message || 'Failed to save show.');
      return { ok: false, error: msg, status };
    }
  },

  // ---------------------------------------------------------------------
  // Staged show.
  //
  // `stagedShow` is the rich, in-memory object (with items / audio / etc.).
  // `stagedShowId` is a tiny mirror that we persist to localStorage so a
  // page reload can re-stage the same show from the canonical data sources.
  //
  // The pair is kept in sync via setStagedShow(); callers should never
  // touch stagedShowId directly.
  // ---------------------------------------------------------------------
  stagedShow: {},
  stagedShowId: null,
  setStagedShow: (show) => {
    const id = show && typeof show === 'object' && show.id != null ? show.id : null;
    set({ stagedShow: show || {}, stagedShowId: id });
  },

  /**
   * Re-derive the rich `stagedShow` object from `stagedShowId` once
   * `shows` and `inventoryById` are both populated. Idempotent: bails out
   * if there's no persisted id, the show isn't in the list, or stagedShow
   * is already correctly populated. Safe to call on every store update.
   */
  hydrateStagedShowFromId: () => {
    const { stagedShow, stagedShowId, shows, inventoryById } = get();
    if (!stagedShowId) return;
    if (stagedShow?.id === stagedShowId && Array.isArray(stagedShow.items)) return;
    if (!Array.isArray(shows) || shows.length === 0) return;
    const found = shows.find((s) => s.id === stagedShowId);
    if (!found) {
      // Persisted id no longer matches any show (e.g. the show was deleted
      // from another tab / page). Clear it (and any stale rich object) so
      // we don't keep retrying.
      set({ stagedShowId: null, stagedShow: {} });
      return;
    }
    let items = [];
    try {
      items = JSON.parse(found.display_payload || '[]').map((pi) => ({
        ...inventoryById[pi.itemId],
        ...pi,
      }));
    } catch (e) {
      console.error('Failed to parse display_payload for staged show:', e);
    }
    let audioTracks = [];
    let audioFile = null;
    let audioOffsetMs = 0;
    if (found.audio_file) {
      try {
        const parsed = JSON.parse(found.audio_file);
        const r = parseAudioField(parsed);
        audioTracks = r.tracks;
        audioOffsetMs = r.audioOffsetMs;
        audioFile = audioTracks[0] || null;
      } catch (e) {
        console.error('Failed to parse audio_file for staged show:', e);
      }
    }
    // Pass through showReceivers (already parsed during fetchShows). If a
    // caller staged the show before fetchShows ran, fall back to parsing the
    // raw `show_receivers` column here so the hydrated object is complete.
    let showReceivers = Array.isArray(found.showReceivers) ? found.showReceivers : null;
    if (!showReceivers && found.show_receivers) {
      try {
        const parsed = JSON.parse(found.show_receivers);
        showReceivers = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        console.error('Failed to parse show_receivers for staged show:', e);
        showReceivers = [];
      }
    }
    if (!showReceivers) showReceivers = [];
    set({ stagedShow: { ...found, items, audioFile, audioTracks, audioOffsetMs, showReceivers } });
  },

  loadedShow: {},
  setLoadedShow: (show) => {
    set({ loadedShow: show });
  },

  // Inventory state
  inventory: [],
  inventoryById: {}, // Lookup dictionary for inventory
  fetchInventory: async () => {
    try {
      const { data } = await axios.get('/api/inventory');
      const inventoryById = data.reduce((acc, item) => {
        // Parse metadata JSON string if it exists
        if (item.metadata) {
          try {
            item.metadata = JSON.parse(item.metadata);
          } catch (e) {
            console.error('Failed to parse metadata for item:', item.id, e);
            item.metadata = null;
          }
        }
        acc[item.id] = item;
        return acc;
      }, {});
      set({ inventory: data, inventoryById });
    } catch (error) {
      console.error('Failed to fetch inventory:', error);
    }
  },
  createInventoryItem: async (inventoryData) => {
    try {
      const { data } = await axios.post('/api/inventory', inventoryData);
      const newItem = { ...inventoryData, id: data.id };
      set((state) => ({
        inventory: [...state.inventory, newItem],
        inventoryById: { ...state.inventoryById, [data.id]: newItem },
      }));
      // Return the created row so callers can link to it immediately (e.g. the
      // show-import flow links an imported cue to a just-imported catalog item).
      return newItem;
    } catch (error) {
      console.error('Failed to create inventory item:', error);
      throw error;
    }
  },
  updateInventoryItem: async (id, updatedData) => {
    try {
      // Preserve existing metadata if not provided in updatedData
      const existingItem = get().inventoryById[id];
      if (existingItem && !updatedData.metadata && existingItem.metadata) {
        // If metadata exists but wasn't in the update, preserve it
        // Stringify if it's an object (parsed metadata)
        updatedData.metadata = typeof existingItem.metadata === 'string' 
          ? existingItem.metadata 
          : JSON.stringify(existingItem.metadata);
      }
      
      await axios.patch(`/api/inventory/${id}`, updatedData);
      
      // After update, refresh inventory to get the latest data
      await get().fetchInventory();
    } catch (error) {
      console.error('Failed to update inventory item:', error);
      throw error;
    }
  },
  deleteInventoryItem: async (id) => {
    await axios.delete(`/api/inventory/${id}`);
    await get().fetchInventory();
  },
  stateData: {},
  setStateData: (stateData) => {
    set((state) => ({
      stateData
    }));
  },
  systemConfig: {},

  fetchSystemConfig: async () => {
    try {
      const { data } = await axios.get('/api/system/config');
      set({ systemConfig: data });
      // Mirror the receivers block (already overlaid from DB by the API) into
      // the dedicated `receivers` slice so the receivers admin UI doesn't
      // need a second round-trip.
      if (data && data.receivers) {
        set({ receivers: data.receivers });
      }
    } catch (error) {
      console.error('Failed to fetch system Config:', error);
    }
  },

  saveSystemConfig: async (newConfig) => {
    try {
      const { data } = await axios.post('/api/system/config', newConfig);
      set({ systemConfig: newConfig }); // Update the local state
      return data;
    } catch (error) {
      console.error('Failed to save system Config:', error);
      throw error;
    }
  },

  setSystemConfig: (Config) => {
    set({ systemConfig: Config });
  },

  // ---------------------------------------------------------------------------
  // Receivers (DB-backed). The Receivers SQL table is the source of truth.
  // `receivers` is keyed by ident (e.g. "RX163") for fast lookup and to match
  // the legacy systemConfig.receivers shape.
  // ---------------------------------------------------------------------------
  receivers: {},

  fetchReceivers: async () => {
    try {
      const { data } = await axios.get('/api/receivers');
      const byId = {};
      for (const row of data) {
        byId[row.id] = receiverRowToStoreEntry(row);
      }
      set({ receivers: byId });
      return byId;
    } catch (error) {
      console.error('Failed to fetch receivers:', error);
      return {};
    }
  },

  /**
   * Create a new receiver row. `data` must include at least { id, type }; the
   * label defaults to the id, cues_data to a sensible single-zone shape, and
   * enabled to true. Returns the inserted row on success and throws on
   * conflict / validation errors so the UI can surface them.
   */
  createReceiver: async (data) => {
    try {
      const { data: row } = await axios.post('/api/receivers', data);
      set((state) => ({
        receivers: {
          ...state.receivers,
          [row.id]: receiverRowToStoreEntry(row),
        },
        systemConfig: {
          ...state.systemConfig,
          receivers: {
            ...(state.systemConfig?.receivers || {}),
            [row.id]: receiverRowToStoreEntry(row),
          },
        },
      }));
      return row;
    } catch (error) {
      console.error('Failed to create receiver:', error);
      throw error;
    }
  },

  /**
   * PATCH a single receiver. `patch` may include any of: label, type,
   * cues_data, enabled, metadata. Updates local state on success.
   */
  updateReceiver: async (id, patch) => {
    try {
      const { data } = await axios.patch(`/api/receivers/${id}`, patch);
      set((state) => ({
        receivers: {
          ...state.receivers,
          [id]: receiverRowToStoreEntry(data),
        },
        systemConfig: {
          ...state.systemConfig,
          receivers: {
            ...(state.systemConfig?.receivers || {}),
            [id]: receiverRowToStoreEntry(data),
          },
        },
      }));
      return data;
    } catch (error) {
      console.error(`Failed to update receiver ${id}:`, error);
      throw error;
    }
  },

  /**
   * Delete a receiver row outright. Removes it from local state on success.
   * The daemon won't drop it from its poll list until a reload_receivers
   * command is issued, so callers should follow with reloadReceiversOnDaemon().
   */
  deleteReceiver: async (id) => {
    try {
      await axios.delete(`/api/receivers/${id}`);
      set((state) => {
        const receivers = { ...state.receivers };
        delete receivers[id];
        const sysReceivers = { ...(state.systemConfig?.receivers || {}) };
        delete sysReceivers[id];
        return {
          receivers,
          systemConfig: { ...state.systemConfig, receivers: sysReceivers },
        };
      });
    } catch (error) {
      console.error(`Failed to delete receiver ${id}:`, error);
      throw error;
    }
  },

  /**
   * Tell the daemon (and ultimately the dongle) to re-read the Receivers
   * table and reconcile its in-memory poll list. Call this after one or more
   * updateReceiver() calls.
   */
  reloadReceiversOnDaemon: async () => {
    try {
      await axios.post('/api/receivers/reload');
    } catch (error) {
      console.error('Failed to send reload_receivers command:', error);
      throw error;
    }
  },

  /**
   * Force the daemon to re-issue registration for a single receiver. Use this
   * when a receiver was pruned by the dongle (timeout) and needs to come back
   * without disturbing the others.
   */
  retryReceiver: async (id) => {
    try {
      await axios.post(`/api/receivers/${id}/retry`);
    } catch (error) {
      console.error(`Failed to send retry_receiver(${id}):`, error);
      throw error;
    }
  },

  /**
   * Send a CONFIG_QUERY to a single receiver (or all of them when `id` is
   * undefined / null). Optionally set the receiver's fire_duration_ms in
   * the same round-trip. The daemon writes the response back to the
   * Receivers table; UI consumers should refresh via fetchReceivers()
   * after a short delay (~500-1000ms) to pick up the new values.
   */
  fetchReceiverConfig: async (id, { fire_duration_ms } = {}) => {
    try {
      const body = {};
      if (fire_duration_ms !== undefined && fire_duration_ms !== null) {
        body.fire_duration_ms = fire_duration_ms;
      }
      const url = id ? `/api/receivers/${id}/rxcfg` : '/api/receivers/rxcfg';
      await axios.post(url, body);
    } catch (error) {
      console.error(
        `Failed to queue rxcfg(${id ?? 'all'}):`,
        error?.response?.data || error,
      );
      throw error;
    }
  },

  // ---------------------------------------------------------------------------
  // Latest published firmware (from the static site via
  // /api/system/firmware_latest, which fetches + caches server-side). Used to
  // surface "out of date" warnings and the "Flash latest" buttons. Stays null
  // until the first successful fetch; offline / cloud profile just leaves it
  // null so no warnings ever appear and nothing errors.
  //   { receiver: { available, version, link, stale } | null, dongle: {...} }
  // ---------------------------------------------------------------------------
  latestFirmware: { receiver: null, dongle: null },
  latestFirmwareLoading: false,

  /**
   * Fetch the latest firmware metadata. Pass force=true (the "Check for
   * updates" button) to bypass the server-side TTL cache. Never throws --
   * failures (offline, 501 in cloud profile) leave the previous value intact.
   */
  fetchLatestFirmware: async (force = false) => {
    try {
      set({ latestFirmwareLoading: true });
      const { data } = await axios.get('/api/system/firmware_latest', {
        params: force ? { refresh: 1 } : undefined,
      });
      set({
        latestFirmware: {
          receiver: data?.receiver ?? null,
          dongle: data?.dongle ?? null,
        },
      });
      return data;
    } catch (error) {
      console.warn(
        'fetchLatestFirmware failed (offline?):',
        error?.response?.status || error?.message,
      );
      return null;
    } finally {
      set({ latestFirmwareLoading: false });
    }
  },
}), {
  name: 'byh-app-store',
  storage: createJSONStorage(() => (typeof window !== 'undefined' ? window.localStorage : undefined)),
  // Persist only the staged show ID. Everything else is server-owned
  // (shows, inventory, system config, receivers) and gets re-fetched on
  // mount. Heavy in-memory shapes (`stagedShow`) are re-derived from the
  // persisted id once those server fetches complete.
  partialize: (state) => ({ stagedShowId: state.stagedShowId }),
  // Skip rehydration when there's no window (SSR pass) so Next.js
  // pre-renders don't trip on localStorage.
  skipHydration: false,
}));

export default useAppStore;
