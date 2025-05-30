// stores/useAppStore.js
import { create } from 'zustand';
import axios from 'axios';

const useStateAppStore = create((set, get) => ({
  stateData: {},
  setStateData: (stateData) => {
    set((state) => ({
      stateData
    }));
  }

}));

export default useStateAppStore;
