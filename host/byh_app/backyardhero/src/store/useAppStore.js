// stores/useAppStore.js
import { create } from 'zustand';
import axios from 'axios';

const useAppStore = create((set, get) => ({
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

  stagedShow: {},
  setStagedShow: (show) => {
    set({ stagedShow: show });
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
    }
  },
  updateInventoryItem: async (id, updatedData) => {
    console.log("ID")
    console.log(id)
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
    }
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
}));

export default useAppStore;
