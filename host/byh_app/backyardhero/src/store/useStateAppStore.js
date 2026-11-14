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

// The WS server sends static receiver config (label, type, cues, metadata)
// as a separate `{ _rcfg, rev }` message whenever it changes, and the
// regular payload carries only live status per receiver plus
// `fw_state.receivers_rev`. Join them back so every component keeps reading
// `fw_state.receivers[ident].cues / .label / .status` unchanged. Payloads
// from an older WS server (no receivers_rev) pass through untouched.
const joinReceivers = (stateData, receiverConfig) => {
  const fwState = stateData?.fw_state;
  if (!fwState || !fwState.receivers_rev || !receiverConfig) return stateData;
  const live = fwState.receivers || {};
  // Only the live fields come from the payload side: when re-joining a
  // cached (already joined) state, its old config must not win.
  const liveOnly = (l) => {
    const out = {};
    if (l && 'status' in l) out.status = l.status;
    if (l && 'drift' in l) out.drift = l.drift;
    return out;
  };
  const joined = {};
  for (const [ident, cfg] of Object.entries(receiverConfig)) {
    joined[ident] = { ...cfg, ...liveOnly(live[ident]) };
  }
  for (const [ident, l] of Object.entries(live)) {
    if (!joined[ident]) joined[ident] = liveOnly(l);
  }
  return { ...stateData, fw_state: { ...fwState, receivers: joined } };
};

const useStateAppStore = create((set, get) => ({
  stateData: {},
  // Latest `_rcfg` from the WS server and its revision.
  receiverConfig: null,
  receiverConfigRev: null,
  setStateData: (stateData) => {
    const now = Date.now();
    const joined = joinReceivers(stateData, get().receiverConfig);
    set(() => ({
      stateData: {
        ...joined,
        _clientRxAt: now,
        _clockOffsetMs: computeClockOffset(stateData, 0),
      },
    }));
  },
  // One entry point for every WS frame: receiver config, heartbeat, or a
  // full payload.
  handleSocketMessage: (payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (payload._rcfg) {
      set(() => ({ receiverConfig: payload._rcfg, receiverConfigRev: payload.rev ?? null }));
      // Re-join the cached state so an edited receiver shows up before
      // the next full payload.
      const current = get().stateData;
      if (current?.fw_state?.receivers_rev) {
        const joined = joinReceivers(current, payload._rcfg);
        set(() => ({ stateData: { ...current, fw_state: joined.fw_state } }));
      }
      return;
    }
    if (payload._hb) {
      // Heartbeats carry the fields the server leaves out of its change
      // detection: daemon liveness and system stats.
      const current = get().stateData;
      const partial = { fw_last_update: payload.fw_last_update };
      if (payload.fw_system !== undefined) partial.fw_system = payload.fw_system;
      if (payload.daemon_active !== undefined && current?.fw_state) {
        partial.fw_state = {
          ...current.fw_state,
          daemon_active: payload.daemon_active,
          ...(payload.daemon_lup !== undefined ? { daemon_lup: payload.daemon_lup } : {}),
        };
      }
      get().patchStateData(partial);
      return;
    }
    get().setStateData(payload);
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
