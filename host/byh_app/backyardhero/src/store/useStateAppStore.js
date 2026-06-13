// stores/useAppStore.js
import { create } from 'zustand';
import axios from 'axios';

// We stamp every inbound WS message with `_clientRxAt = Date.now()` and
// derive `_clockOffsetMs = clientNow - fw_last_update`. The Pi has no
// RTC, so on an offline boot (no NTP reachable) its wall clock can be
// hours behind the browser's. Comparing client-clock to server-clock
// timestamps (e.g. Date.now() - fw_last_update < 4500 for the "Link"
// indicator) is then permanently false even though the WS is happily
// delivering messages. `_clientRxAt` lets liveness checks stay in a
// single clock domain; `_clockOffsetMs` lets server-stamped fields
// (receiver `lmt`, etc.) be normalised to the client clock without
// every call site having to know.
const computeClockOffset = (payload, fallback) => {
  const serverNow = payload?.fw_last_update;
  if (typeof serverNow !== 'number') return fallback ?? 0;
  return Date.now() - serverNow;
};

// "How long ago, in the browser's frame, was this server-stamped time?"
// Subtracts the cached clock offset before differencing so an offline-boot
// Pi (clock hours behind the browser) doesn't make every receiver `lmt`
// look stale. Falls back to a plain Date.now() diff when no offset is
// known yet (first message hasn't arrived) -- that just degrades to the
// old behaviour, which is what callers would have done anyway.
//
// Pass `stateData` (from useStateAppStore) so call sites can read it
// straight out of the same state subscription they already have:
//
//   const stateData = useStateAppStore(s => s.stateData);
//   const online = serverElapsedMs(receiver.status.lmt, stateData) < 10_000;
//
// Returns Infinity when serverTs is missing/non-numeric so a `< N` check
// is unambiguously false (treat unknown as "definitely not recent").
export const serverElapsedMs = (serverTs, stateData) => {
  if (typeof serverTs !== 'number' || !Number.isFinite(serverTs)) {
    return Infinity;
  }
  const offset = stateData?._clockOffsetMs ?? 0;
  return Date.now() - offset - serverTs;
};

const useStateAppStore = create((set, get) => ({
  stateData: {},
  setStateData: (stateData) => {
    const now = Date.now();
    set(() => ({
      stateData: {
        ...stateData,
        _clientRxAt: now,
        _clockOffsetMs: computeClockOffset(stateData, 0),
      },
    }));
  },
  // Shallow-merge into stateData. Used for WebSocket heartbeat frames
  // (which only carry `fw_last_update`) so we don't wipe the rest of
  // the cached daemon state.
  patchStateData: (partial) => {
    const now = Date.now();
    set((state) => ({
      stateData: {
        ...state.stateData,
        ...partial,
        _clientRxAt: now,
        _clockOffsetMs: computeClockOffset(
          partial,
          state.stateData?._clockOffsetMs ?? 0,
        ),
      },
    }));
  }

}));

export default useStateAppStore;
