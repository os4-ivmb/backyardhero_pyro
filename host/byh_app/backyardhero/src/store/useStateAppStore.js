// stores/useAppStore.js
import { create } from 'zustand';

// Receive timing is separate from operator state. A Pi can boot without
// NTP, so liveness uses client time and receiver timestamps use clockOffsetMs.
const computeClockOffset = (payload, fallback) => {
  const serverNow = payload?.fw_last_update;
  if (typeof serverNow !== 'number') return fallback ?? 0;
  const offset = Date.now() - serverNow;
  return fallback !== undefined && Math.abs(offset - fallback) < 250 ? fallback : offset;
};

// "How long ago, in the browser's frame, was this server-stamped time?"
// Subtracts the cached clock offset before differencing so an offline-boot
// Pi (clock hours behind the browser) doesn't make every receiver `lmt`
// look stale. Falls back to a plain Date.now() diff when no offset is
// known yet (first message hasn't arrived) -- that just degrades to the
// old behaviour, which is what callers would have done anyway.
//
// The optional state argument is retained for existing callers; the offset
// comes from the store so heartbeat timing never changes operator state.
// Missing timestamps are treated as offline.
export const serverElapsedMs = (serverTs, _stateData) => {
  if (typeof serverTs !== 'number' || !Number.isFinite(serverTs)) {
    return Infinity;
  }
  const offset = useStateAppStore.getState().clockOffsetMs;
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

// Retain equal subtrees so JSON snapshots preserve narrow subscriptions.
const shareUnchanged = (previous, next) => {
  if (Object.is(previous, next)) return previous;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object' || Array.isArray(previous) !== Array.isArray(next)) return next;
  const keys = Object.keys(next);
  let unchanged = keys.length === Object.keys(previous).length;
  const result = Array.isArray(next) ? [] : {};
  for (const key of keys) {
    result[key] = shareUnchanged(previous[key], next[key]);
    if (!Object.is(result[key], previous[key])) unchanged = false;
  }
  return unchanged ? previous : result;
};

const useStateAppStore = create((set, get) => ({
  stateData: {},
  clientRxAt: 0,
  clockOffsetMs: 0,
  receiverConfig: null,
  receiverConfigRev: null,
  setStateData: (stateData) => {
    const current = get();
    const joined = joinReceivers(stateData, current.receiverConfig);
    set({
      stateData: shareUnchanged(current.stateData, joined),
      clientRxAt: Date.now(),
      clockOffsetMs: computeClockOffset(stateData, current.clockOffsetMs),
    });
  },
  handleSocketMessage: (payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (payload._rcfg) {
      set({ receiverConfig: payload._rcfg, receiverConfigRev: payload.rev ?? null });
      const current = get().stateData;
      if (current?.fw_state?.receivers_rev) {
        set({ stateData: shareUnchanged(current, joinReceivers(current, payload._rcfg)) });
      }
      return;
    }
    if (payload._hb) {
      const current = get().stateData;
      const partial = {};
      if (payload.fw_system !== undefined) partial.fw_system = payload.fw_system;
      if (payload.daemon_active !== undefined && current?.fw_state && payload.daemon_active !== current.fw_state.daemon_active) {
        partial.fw_state = { ...current.fw_state, daemon_active: payload.daemon_active };
      }
      get().patchStateData(partial, payload);
      return;
    }
    get().setStateData(payload);
  },
  patchStateData: (partial, timing = partial) => {
    set((state) => ({
      clientRxAt: Date.now(),
      clockOffsetMs: computeClockOffset(timing, state.clockOffsetMs),
      stateData: shareUnchanged(state.stateData, { ...state.stateData, ...partial }),
    }));
  },
}));

export default useStateAppStore;
