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
      await axios.patch(`/api/inventory/${id}`, updatedData);
      set((state) => ({
        inventory: state.inventory.map((item) =>
          item.id === id ? { ...item, ...updatedData } : item
        ),
        inventoryById: {
          ...state.inventoryById,
          [id]: { ...state.inventoryById[id], ...updatedData },
        },
      }));
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
      await axios.post('/api/system/configg', newConfig);
      set({ systemConfig: newConfig }); // Update the local state
    } catch (error) {
      console.error('Failed to save system Config:', error);
    }
  },

  setSystemConfig: (Config) => {
    set({ systemConfig: Config });
  },
}));

export default useAppStore;
