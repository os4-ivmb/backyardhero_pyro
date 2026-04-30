// stores/useAppStore.js
import { create } from 'zustand';
import axios from 'axios';

const useStateAppStore = create((set, get) => ({
  stateData: {},
  setStateData: (stateData) => {
    set((state) => ({
      stateData
    }));
  },
  // Shallow-merge into stateData. Used for WebSocket heartbeat frames
  // (which only carry `fw_last_update`) so we don't wipe the rest of
  // the cached daemon state.
  patchStateData: (partial) => {
    set((state) => ({
      stateData: { ...state.stateData, ...partial },
    }));
  }

}));

export default useStateAppStore;
