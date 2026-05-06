// stores/useAppStore.js
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import axios from 'axios';

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
        // Parse audio_file JSON string if it exists
        if (show.audio_file) {
          try {
            show.audioFile = JSON.parse(show.audio_file);
          } catch (e) {
            console.error('Failed to parse audio_file for show:', show.id, e);
            show.audioFile = null;
          }
        } else {
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
      const newShow = { ...showData, id: data.id };
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
  updateShow: async (id, updatedData) => {
    try {
      console.log(updatedData)
      await axios.patch(`/api/shows/${id}`, updatedData);
      set((state) => ({
        shows: state.shows.map((show) => (show.id === id ? { ...show, ...updatedData } : show)),
        showById: {
          ...state.showById,
          [id]: { ...state.showById[id], ...updatedData },
        },
      }));
    } catch (error) {
      console.error('Failed to update show:', error);
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
    let audioFile = null;
    if (found.audio_file) {
      try {
        audioFile = JSON.parse(found.audio_file);
      } catch (e) {
        console.error('Failed to parse audio_file for staged show:', e);
      }
    }
    set({ stagedShow: { ...found, items, audioFile } });
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
        byId[row.id] = {
          label: row.label,
          type: row.type,
          cues: row.cues_data || {},
          enabled: !!row.enabled,
          metadata: row.metadata || {},
          configuration_version: row.configuration_version,
        };
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
          [row.id]: {
            label: row.label,
            type: row.type,
            cues: row.cues_data || {},
            enabled: !!row.enabled,
            metadata: row.metadata || {},
            configuration_version: row.configuration_version,
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
          [id]: {
            label: data.label,
            type: data.type,
            cues: data.cues_data || {},
            enabled: !!data.enabled,
            metadata: data.metadata || {},
            configuration_version: data.configuration_version,
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
