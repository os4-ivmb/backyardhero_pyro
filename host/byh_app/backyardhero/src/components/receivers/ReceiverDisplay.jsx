import useAppStore from "@/store/useAppStore"
import useStateAppStore from "@/store/useStateAppStore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { 
  MdBatteryFull, 
  MdBatteryAlert, 
  MdBatteryUnknown, 
  MdSignalWifi4Bar, 
  MdSignalWifiOff, 
  MdPlayArrow,
  MdAccessTime,
  MdAssignment,
  MdLock,
  MdLockOpen,
  MdRefresh,
  MdWarning,
  MdAdd,
  MdClose
} from 'react-icons/md';
import { FaSpinner } from 'react-icons/fa';
import ShowHealth from "../homepanel/ShowHealth";

// FW_VERSION: Frontend version tracking for ReceiverDisplay component
// v1.0.0: Initial version - Basic receiver display with battery, connectivity, and cue status
// v1.1.0: Added health bar at top of receiver cards displaying successPercent (0-100% with red-to-green gradient)
// v1.2.0: Increased connection timeout threshold from 5 seconds to 10 seconds
// v1.3.0: Added latency scale bar (1s=100%/green, 10s=0%/red) with smooth animations, moved health bar to bottom with percentage text
// v1.4.0: DB-backed receivers; lock-toggle edit mode (label, enable, cue count); per-receiver retry button; daemon reload on save
const FW_VERSION = "1.4.0";

// Helper: derive the cue count from a receiver's cues_data map. With the
// current "id-as-zone" convention each receiver has exactly one zone, so we
// just take the length of its first array. This stays consistent with how
// the edit UI writes back changes (1..N under the receiver's id zone).
function cueCountFromCues(cuesObj) {
  if (!cuesObj) return 0;
  const firstZone = Object.keys(cuesObj)[0];
  if (!firstZone) return 0;
  const arr = cuesObj[firstZone];
  return Array.isArray(arr) ? arr.length : 0;
}

function buildCuesData(ident, count) {
  const safe = Math.max(0, Math.min(256, parseInt(count, 10) || 0));
  return { [ident]: Array.from({ length: safe }, (_, i) => i + 1) };
}

function SingleReceiver({
  rcv_name,
  receiver,
  showMapping,
  showId,
  receiverLabel,
  // Edit-mode props (all optional)
  editMode = false,
  pendingEdit, // { label?, enabled?, cueCount? } | undefined
  onPendingEditChange, // (id, patch) => void
  onRetry, // (id) => void
  retryBusy = false,
}) {
  const [popup, setPopup] = useState(null);
  const receiverRef = useRef(null);
  const [smoothedLatency, setSmoothedLatency] = useState(0);
  const latencyRef = useRef(0);

  const handleTargetClick = (target, item, event) => {
    if (item) {
      const rect = event.target.getBoundingClientRect();
      const containerRect = receiverRef.current.getBoundingClientRect();
      setPopup({
        target,
        item,
        position: {
          top: rect.top - containerRect.top,
          left: rect.left - containerRect.left + rect.width / 2,
        },
      });
    } else {
      setPopup(null);
    }
  };

  let isSynced = false;
  if(receiver.drift){
    if(receiver.drift < 5000){
      isSynced = true;
    }
  }

  // Calculate battery level from status if available (convert 0–256 into a percentage)
  let batteryLevel;
  if (receiver.status && receiver.status.battery != null) {
    batteryLevel = Math.floor((receiver.status.battery / 256) * 100);
  } else {
    batteryLevel = receiver.battery || "N/A";
  }

  // Determine connectivity using the last message timestamp (lmt)
  let isConnectionGood;
  let latency = 0;
  let txmtLatency = 0;
  if (receiver.status && receiver.status.lmt) {
    latency = Date.now() - receiver.status.lmt
    isConnectionGood = (latency <= 10000);
  } else {
    isConnectionGood = receiver.connectionStatus === "good";
  }

  // Smooth latency value to reduce jumpiness (exponential moving average)
  useEffect(() => {
    if (receiver.status && receiver.status.lmt && latency > 0) {
      // Use exponential moving average with smoothing factor of 0.9 (highly responsive)
      // Higher value = more responsive, lower value = smoother but slower
      const smoothingFactor = 0.8;
      const newSmoothed = latencyRef.current === 0 
        ? latency 
        : latencyRef.current + (latency - latencyRef.current) * smoothingFactor;
      
      latencyRef.current = newSmoothed;
      setSmoothedLatency(newSmoothed);
    } else {
      latencyRef.current = 0;
      setSmoothedLatency(0);
    }
  }, [latency, receiver.status?.lmt]);

  // Use smoothed latency for both display and bar calculation for consistency
  const latencyForDisplay = smoothedLatency > 0 ? smoothedLatency : latency;
  const lfx = (latencyForDisplay / 1000).toFixed(1)

  // Calculate latency percentage for visual bar (0 sec = 100%, 10 sec = 0%)
  // Use smoothed latency so bar moves smoothly
  // 5 seconds = 50% (halfway point)
  let latencyPercent = null;
  if (receiver.status && receiver.status.lmt && latencyForDisplay >= 0) {
    if (lfx <= 1) {
      latencyPercent = 100;
    } else if (lfx >= 10) {
      latencyPercent = 0;
    } else {
      // Linear interpolation: 100% at 0s, 0% at 10s
      latencyPercent = 100 - (lfx / 10) * 100;
    }
    // Clamp to ensure valid percentage
    latencyPercent = Math.max(0, Math.min(100, latencyPercent));
  }

  // Get successPercent for health bar (0-100)
  const successPercent = receiver.status?.successPercent ?? null;
  const healthPercent = successPercent !== null ? Math.max(0, Math.min(100, successPercent)) : null;

  // Determine battery styling and icon based on level
  const batteryClass =
    typeof batteryLevel === 'number'
      ? batteryLevel > 20
        ? 'text-green-400'
        : 'text-red-400'
      : 'text-gray-400';

  const BatteryIcon =
    typeof batteryLevel === 'number'
      ? batteryLevel > 20
        ? MdBatteryFull
        : MdBatteryAlert
      : MdBatteryUnknown;

  const firstZone = Object.keys(receiver.cues || {})[0]
  // Disabled receivers (DB row enabled=false) render at lower opacity even if
  // they happen to have stale status data; they're not being polled.
  const isEnabled = receiver.enabled !== false;
  const dimmed = !isEnabled || !isConnectionGood;
  const bgColor = "bg-gray-800" + (dimmed ? " opacity-50" : " opacity-100")

  // Pending edit values (fall back to current values on the row).
  const editLabel = pendingEdit?.label !== undefined
    ? pendingEdit.label
    : (receiver.label || rcv_name);
  const editEnabled = pendingEdit?.enabled !== undefined
    ? pendingEdit.enabled
    : isEnabled;
  const editCueCount = pendingEdit?.cueCount !== undefined
    ? pendingEdit.cueCount
    : cueCountFromCues(receiver.cues);

  // The retry button is visible whenever the receiver is enabled — it's the
  // only way to recover a pruned receiver without restarting the daemon.
  const showRetry = isEnabled && typeof onRetry === 'function';

  return (
    <div
      ref={receiverRef}
      className={`border rounded-xl p-4 ${bgColor} text-white shadow-md dark:bg-gray-700 dark:border-gray-600 flex flex-col gap-3 w-72 relative`}
    >
      {/* Receiver Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          {receiverLabel ? (
            <>
              <span>{receiverLabel}</span>
              <span className="text-gray-500 text-sm font-normal">({rcv_name})</span>
            </>
          ) : (
            <span>{rcv_name}</span>
          )}
        </h2>

        {isConnectionGood ? (
        <div className="flex items-center gap-2">
            
          <BatteryIcon className={batteryClass} />
          <span className="text-sm text-gray-400">
            {typeof batteryLevel === 'number' ? batteryLevel : "N/A"}%
          </span>

          {/* Connectivity Indicator */}
          {isConnectionGood ? (
            <MdSignalWifi4Bar className="text-green-400" />
          ) : (
            <MdSignalWifiOff className="text-red-400" />
          )}

          {/* New Status Icons */}
          {receiver.status && (
            <>
              {/* Loading Icon */}
              <FaSpinner
                className={
                  receiver.status.showId === showId && receiver.status.loadComplete
                    ? "text-green-400"
                    : "text-gray-400"
                }
                title="Loading Status"
              />
              {/* Start Ready Icon */}
              <MdPlayArrow
                className={
                  receiver.status.startReady ? "text-green-400" : "text-gray-400"
                }
                title="Start Ready"
              />
            </>
          )}
        </div>
        ):(
          <div className="text-red-400 text-sm flex items-center gap-2 ">
            {receiver.type && receiver.type[0] == 'B' ? '' : (isEnabled ? 'Not Connected' : 'Disabled')}
          </div>
        )}
      </div>

      {/* Retry connection button. Always available when enabled (even when
          edit mode is locked) so a pruned receiver can be re-added on the
          fly. Hidden for one-way TX-only types — there's nothing to poll. */}
      {showRetry && receiver.type !== 'BILUSOCN_433_TX_ONLY' && (
        <div className="flex">
          <button
            type="button"
            disabled={retryBusy}
            onClick={() => onRetry(rcv_name)}
            className={`ml-auto flex items-center gap-1 px-2 py-1 text-xs rounded
              ${retryBusy
                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`}
            title="Retry connection (re-register with dongle)"
          >
            <MdRefresh className={retryBusy ? 'animate-spin' : ''} />
            Retry
          </button>
        </div>
      )}

      {/* Cues Section */}
      <b className="text-gray-300 mt-1 mb-1">Cues</b>
      <div className="flex flex-wrap gap-2 mt-1">
        {firstZone && receiver.cues[firstZone] && receiver.cues[firstZone].map((target, k) => {
          // In the previous version, showMapping was keyed by zone. With a single zone, we assume:
          const item = showMapping?.[firstZone]?.[target]
          const borderClass = item ? "border-4 border-purple-800" : "border border-gray-500";

          // Determine if this cue is active by checking the continuity bits.
          // receiver.continuity is an array of 4 64-bit numbers covering 256 outputs.
          let continuityActive = false;
          if (receiver.status?.continuity && receiver.status?.continuity.length === 2) {
            const blockIndex = Math.floor(k / 64);
            const bitIndex = k % 64;
            const block = receiver.status.continuity[blockIndex];
            if (block !== undefined) {
              // Use BigInt to safely handle 64-bit operations.
              continuityActive = (BigInt(block) & (BigInt(1) << BigInt(bitIndex))) !== BigInt(0);
            }
          }
          const bgClass = continuityActive ? "bg-green-400" : "bg-red-200";

          return (
            <div
              key={k}
              className={`px-4 py-2 rounded-lg text-sm text-black ${bgClass} cursor-pointer ${borderClass}`}
              onClick={(e) => handleTargetClick(target, item, e)}
            >
              {target}
            </div>
          );
        })}
      </div>

      {/* Popup for Item Details */}
      {popup && (
        <div
          className="absolute bg-gray-700 text-white p-4 rounded-md shadow-lg border border-gray-500"
          style={{
            top: `${popup.position.top}px`,
            left: `${popup.position.left}px`,
            transform: "translate(-50%, -100%)",
            zIndex: 10,
          }}
        >
          <h4 className="text-sm font-semibold">{popup.item.name}</h4>
          {popup.item.image && (
            <img
              src={popup.item.image}
              alt={popup.item.name}
              className="mt-2 w-24 h-24 object-cover rounded-md"
            />
          )}
          <button
            className="mt-2 px-2 py-1 text-sm bg-red-500 rounded-md hover:bg-red-600"
            onClick={() => setPopup(null)}
          >
            Close
          </button>
        </div>
      )}

      {/* New Latency Display Section */}
      {isConnectionGood && (
        <div className="text-sm text-gray-400 mt-auto pt-2 border-t border-gray-700">
          <div className="flex items-center justify-center gap-1 mb-2">
            <MdAccessTime />
            <span>Latency: {lfx}s (RTT: {txmtLatency}ms)</span>
          </div>
          {/* Latency Bar */}
          {latencyPercent !== null && (
            <div className="relative w-full">
              <div className="w-full h-1 bg-gray-700 rounded-full overflow-hidden opacity-80">
                <div
                  className="h-full transition-all duration-1000 ease-out"
                  style={{
                    width: `${latencyPercent}%`,
                    backgroundColor: latencyPercent >= 50 
                      ? `rgba(${Math.floor(225 * (1 - (latencyPercent - 50) / 50))}, 225, 0, 0.85)` 
                      : `rgba(225, ${Math.floor(225 * (latencyPercent / 50))}, 0, 0.85)`
                  }}
                  title={`Latency Quality: ${latencyPercent.toFixed(0)}%`}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Health Bar - Muted at bottom */}
      {healthPercent !== null && (
        <div className="relative w-full mt-2">
          {/* Percentage text above the bar end */}
          <div
            className="absolute text-xs text-gray-500 -top-4 transition-all duration-300 ease-out"
            style={{
              left: `${healthPercent}%`,
              transform: 'translateX(-50%)'
            }}
          >
            {healthPercent}%
          </div>
          {/* Health bar */}
          <div className="w-full h-1 bg-gray-700 rounded-full overflow-hidden opacity-80">
            <div
              className="h-full transition-all duration-300 ease-out"
              style={{
                width: `${healthPercent}%`,
                backgroundColor: healthPercent >= 50 
                  ? `rgba(${Math.floor(225 * (1 - (healthPercent - 50) / 50))}, 225, 0, 0.85)` 
                  : `rgba(225, ${Math.floor(225 * (healthPercent / 50))}, 0, 0.85)`
              }}
              title={`Success Rate: ${healthPercent}%`}
            />
          </div>
        </div>
      )}

      {/* Edit panel — only rendered while the page is unlocked. All inputs
          are uncontrolled-style: we forward changes up via onPendingEditChange
          so the parent can stage them and surface the dirty indicator. */}
      {editMode && (
        <div className="mt-3 pt-3 border-t border-gray-600 flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2 text-gray-200">
            <input
              type="checkbox"
              checked={editEnabled}
              onChange={(e) =>
                onPendingEditChange?.(rcv_name, { enabled: e.target.checked })
              }
              className="h-4 w-4"
            />
            <span>Enabled (poll from dongle)</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Label</span>
            <input
              type="text"
              value={editLabel}
              onChange={(e) =>
                onPendingEditChange?.(rcv_name, { label: e.target.value })
              }
              className="w-full px-2 py-1 rounded bg-gray-900 border border-gray-600 text-white"
              placeholder={rcv_name}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-xs text-gray-400 whitespace-nowrap"># Cues</span>
            <input
              type="number"
              min={0}
              max={256}
              value={editCueCount}
              onChange={(e) =>
                onPendingEditChange?.(rcv_name, {
                  cueCount: Math.max(0, parseInt(e.target.value, 10) || 0),
                })
              }
              className="w-20 px-2 py-1 rounded bg-gray-900 border border-gray-600 text-white"
            />
            <span className="text-xs text-gray-500">
              writes 1..N under zone "{rcv_name}"
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

export default function ReceiverDisplay({ setCurrentTab }) {
    const {
      stagedShow,
      systemConfig,
      receivers: dbReceivers,
      fetchReceivers,
      createReceiver,
      updateReceiver,
      reloadReceiversOnDaemon,
      retryReceiver,
    } = useAppStore();
    const { stateData } = useStateAppStore()
    const [ targetRcvMap, setTargetRcvMap ] = useState({});
    const [showUnusedReceivers, setShowUnusedReceivers] = useState(false);
    const [showDisabledReceivers, setShowDisabledReceivers] = useState(false);
    const [receiverLabels, setReceiverLabels] = useState({});

    // Edit-mode state
    const [unlocked, setUnlocked] = useState(false);
    // pendingEdits: { [rcvId]: { label?, enabled?, cueCount? } }
    const [pendingEdits, setPendingEdits] = useState({});
    const [savingEdits, setSavingEdits] = useState(false);
    const [retryBusy, setRetryBusy] = useState({}); // { [rcvId]: true }

    // Add-receiver form state. Controlled inputs live here so the form
    // survives editing surrounding cards. The form is only rendered when the
    // page is unlocked (see render below).
    const [addFormOpen, setAddFormOpen] = useState(false);
    const [addForm, setAddForm] = useState({
      id: "",
      label: "",
      type: "",
      cueCount: 8,
    });
    const [addBusy, setAddBusy] = useState(false);
    const [addError, setAddError] = useState(null);

    // Load receivers from DB on mount (and once whenever the page is
    // mounted) so the edit UI always reflects the current persisted state.
    useEffect(() => {
      fetchReceivers().catch((e) => console.error('fetchReceivers failed:', e));
    }, [fetchReceivers]);

    // Load receiver labels from show data
    useEffect(() => {
      if (stagedShow?.receiverLabels) {
        setReceiverLabels(stagedShow.receiverLabels);
      } else if (stagedShow?.receiver_labels) {
        try {
          const parsedLabels = JSON.parse(stagedShow.receiver_labels);
          setReceiverLabels(parsedLabels);
        } catch (e) {
          console.error('Failed to parse receiver_labels for show:', stagedShow.id, e);
        }
      } else {
        setReceiverLabels({});
      }
    }, [stagedShow]);

    // Merge DB receivers (definition: cues, label, type, enabled) with the
    // live status payload from the daemon (battery, lmt, continuity, ...).
    // The DB is iterated as the canonical list — fw_state status is overlaid
    // when present.
    const receivers = useMemo(() => {
      const live = stateData.fw_state?.receivers || {};
      const out = {};
      for (const id of Object.keys(dbReceivers || {})) {
        const def = dbReceivers[id];
        const liveRow = live[id] || {};
        out[id] = {
          ...def,
          // Status / drift come from the daemon's broadcast.
          status: liveRow.status,
          drift: liveRow.drift,
          // Keep cues from the DB definition, not from the live row, so cue
          // edits show immediately in edit mode without waiting for a daemon
          // reload.
          cues: def.cues,
          // Pass the receiver's current `enabled` flag through (the
          // SingleReceiver component dims when disabled).
          enabled: def.enabled,
        };
      }
      return out;
    }, [dbReceivers, stateData.fw_state?.receivers]);

    useEffect(() => {
      // Build a lookup table for zones and targets to receivers
      const lookupTable = {};
      Object.keys(receivers).forEach((receiverKey) => {
        const receiver = receivers[receiverKey];
        if (!receiver?.cues) return;
        Object.keys(receiver.cues).forEach((zoneKey) => {
          receiver.cues[zoneKey].forEach((target) => {
            lookupTable[`${zoneKey}:${target}`] = receiverKey;
          });
        });
      });

      // If stagedShow exists, process display_payload
      if (stagedShow?.items) {
        const map = {};
        stagedShow.items.forEach((payloadItem) => {
          const { itemId, zone, target } = payloadItem;
          const receiverKey = lookupTable[`${zone}:${target}`];
          if (receiverKey) {
            if (!map[receiverKey]) map[receiverKey] = {};
            if (!map[receiverKey][zone]) map[receiverKey][zone] = {};
            map[receiverKey][zone][target] = payloadItem;
          }
        });
        setTargetRcvMap(map);
      } else {
        setTargetRcvMap({});
      }
    }, [receivers, stagedShow]);

    // Edit-mode helpers ------------------------------------------------------
    const isShowLoaded = !!stateData.fw_state?.show_loaded;
    const hasPendingEdits = Object.keys(pendingEdits).length > 0;

    const handlePendingEditChange = useCallback((id, patch) => {
      setPendingEdits((prev) => {
        const next = { ...prev };
        const merged = { ...(next[id] || {}), ...patch };
        // If the merged edit equals the current persisted state, drop the
        // entry so the dirty indicator clears when the user reverts manually.
        const def = dbReceivers?.[id];
        if (def) {
          const currentLabel = def.label || id;
          const currentEnabled = def.enabled !== false;
          const currentCueCount = cueCountFromCues(def.cues);
          const noLabelChange = merged.label === undefined || merged.label === currentLabel;
          const noEnabledChange = merged.enabled === undefined || merged.enabled === currentEnabled;
          const noCueChange = merged.cueCount === undefined || merged.cueCount === currentCueCount;
          if (noLabelChange && noEnabledChange && noCueChange) {
            delete next[id];
            return next;
          }
        }
        next[id] = merged;
        return next;
      });
    }, [dbReceivers]);

    const handleRetry = useCallback(async (id) => {
      setRetryBusy((prev) => ({ ...prev, [id]: true }));
      try {
        await retryReceiver(id);
      } catch (e) {
        console.error('Retry failed', e);
      } finally {
        // Brief debounce so the spinning icon is visible even on a fast queue.
        setTimeout(() => {
          setRetryBusy((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }, 800);
      }
    }, [retryReceiver]);

    const handleLockClick = useCallback(async () => {
      if (!unlocked) {
        // Unlocking: only allowed when no show is loaded.
        if (isShowLoaded) return;
        setUnlocked(true);
        return;
      }
      // Locking: persist any pending edits, then ask the daemon to reload.
      if (!hasPendingEdits) {
        setUnlocked(false);
        return;
      }
      setSavingEdits(true);
      try {
        const ids = Object.keys(pendingEdits);
        for (const id of ids) {
          const def = dbReceivers?.[id];
          if (!def) continue;
          const edit = pendingEdits[id];
          const patch = {};
          if (edit.label !== undefined && edit.label !== (def.label || id)) {
            patch.label = edit.label;
          }
          if (edit.enabled !== undefined && edit.enabled !== (def.enabled !== false)) {
            patch.enabled = edit.enabled;
          }
          if (
            edit.cueCount !== undefined &&
            edit.cueCount !== cueCountFromCues(def.cues)
          ) {
            patch.cues_data = buildCuesData(id, edit.cueCount);
          }
          if (Object.keys(patch).length === 0) continue;
          await updateReceiver(id, patch);
        }
        // Tell the daemon (and ultimately the dongle) to reconcile its
        // poll list with the new DB state.
        await reloadReceiversOnDaemon();
        setPendingEdits({});
        setUnlocked(false);
      } catch (e) {
        console.error('Failed to save receiver edits:', e);
        // Stay unlocked so the user can correct / retry.
      } finally {
        setSavingEdits(false);
      }
    }, [
      unlocked,
      isShowLoaded,
      hasPendingEdits,
      pendingEdits,
      dbReceivers,
      updateReceiver,
      reloadReceiversOnDaemon,
    ]);

    const lockTitle = unlocked
      ? (hasPendingEdits ? 'Save changes & reload dongle' : 'Lock (no changes)')
      : (isShowLoaded
        ? 'Cannot edit while a show is loaded — unload first'
        : 'Unlock to edit receivers');

    // ---- Add-receiver form -------------------------------------------------
    // The list of selectable receiver types comes from systemcfg.json's
    // `types` block (still the source of truth for hardware capabilities).
    const availableTypes = useMemo(
      () => Object.keys(systemConfig?.types || {}),
      [systemConfig?.types]
    );

    const closeAddForm = useCallback(() => {
      setAddFormOpen(false);
      setAddError(null);
      setAddForm({ id: "", label: "", type: "", cueCount: 8 });
    }, []);

    const openAddForm = useCallback(() => {
      setAddError(null);
      setAddForm((f) => ({
        ...f,
        // Pre-select the first available type so the form is submittable
        // without an extra click on a single-type system.
        type: f.type || availableTypes[0] || "",
      }));
      setAddFormOpen(true);
    }, [availableTypes]);

    const handleAddSubmit = useCallback(async (e) => {
      e?.preventDefault?.();
      setAddError(null);
      const id = (addForm.id || "").trim();
      const label = (addForm.label || "").trim() || id;
      const type = addForm.type;
      const cueCount = Math.max(0, Math.min(256, parseInt(addForm.cueCount, 10) || 0));

      if (!id) { setAddError("ID is required."); return; }
      if (dbReceivers && dbReceivers[id]) {
        setAddError(`Receiver "${id}" already exists.`);
        return;
      }
      if (!type) { setAddError("Type is required."); return; }
      // The dongle parses node IDs out of "RX<digits>". We don't enforce it
      // strictly (BILUSOCN_433_TX_ONLY doesn't go over the dongle), but we
      // warn when it's clearly going to break addressing.
      if (type === "BKYD_TS_24_1" && !/^RX\d+$/i.test(id)) {
        setAddError(
          'BKYD_TS_24_1 receivers must be named "RX<digits>" (e.g. RX163) — ' +
          'the dongle parses the node ID out of the ident.'
        );
        return;
      }

      setAddBusy(true);
      try {
        await createReceiver({
          id,
          label,
          type,
          cues_data: buildCuesData(id, cueCount),
          enabled: true,
        });
        // New rows count as a config change; surface the dirty indicator on
        // the lock button so the user knows the daemon needs a reload. We
        // model it as an empty pendingEdits entry that always diffs as a
        // no-op against current — but we use a sentinel ident to mark dirty.
        setPendingEdits((prev) => ({ ...prev, [id]: { _added: true } }));
        closeAddForm();
      } catch (err) {
        const apiMsg = err?.response?.data?.error;
        setAddError(apiMsg || err?.message || "Failed to create receiver.");
      } finally {
        setAddBusy(false);
      }
    }, [addForm, dbReceivers, createReceiver, closeAddForm]);

    // When not in edit mode we hide disabled receivers in their own collapsed
    // section at the bottom — a disabled receiver isn't being polled by the
    // dongle, so it just clutters the live status grid. In edit mode every
    // receiver is rendered inline so the user can re-enable them.
    const isReceiverDisabled = (rcv) => rcv?.enabled === false;
    const visibleReceiverKeys = unlocked
      ? Object.keys(receivers)
      : Object.keys(receivers).filter((k) => !isReceiverDisabled(receivers[k]));
    const disabledReceiverKeys = unlocked
      ? []
      : Object.keys(receivers).filter((k) => isReceiverDisabled(receivers[k]));

    // Calculate system health metrics
    const calculateSystemHealth = () => {
      const onlineReceivers = Object.entries(receivers).filter(([ident, receiver]) => {
        if (!receiver.status || !receiver.status.lmt) return false;
        const latency = Date.now() - receiver.status.lmt;
        return latency <= 10000; // 10 second timeout
      });

      if (onlineReceivers.length === 0) {
        return { avgLatencyPercent: null, worstLatencyPercent: null, worstLatencyIdent: null, avgSuccessPercent: null, worstSuccessPercent: null, worstSuccessIdent: null, continuityPercent: null, continuityCount: null, continuityTotal: null };
      }

      // Calculate latency metrics with ident tracking
      const latencyData = onlineReceivers.map(([ident, receiver]) => {
        const latency = Date.now() - receiver.status.lmt;
        const lfx = latency / 1000;
        let percent;
        if (lfx <= 1) percent = 100;
        else if (lfx >= 10) percent = 0;
        else percent = 100 - (lfx / 10) * 100;
        return { ident, percent };
      });

      const avgLatencyPercent = latencyData.reduce((sum, d) => sum + d.percent, 0) / latencyData.length;
      const worstLatency = latencyData.reduce((worst, current) => current.percent < worst.percent ? current : worst);
      const worstLatencyPercent = worstLatency.percent;
      const worstLatencyIdent = worstLatency.ident;

      // Calculate success percent metrics with ident tracking
      const successData = onlineReceivers
        .map(([ident, receiver]) => ({
          ident,
          percent: receiver.status?.successPercent ?? null
        }))
        .filter(d => d.percent !== null);

      if (successData.length === 0) {
        return { avgLatencyPercent, worstLatencyPercent, worstLatencyIdent, avgSuccessPercent: null, worstSuccessPercent: null, worstSuccessIdent: null, continuityPercent: null, continuityCount: null, continuityTotal: null };
      }

      const avgSuccessPercent = successData.reduce((sum, d) => sum + d.percent, 0) / successData.length;
      const worstSuccess = successData.reduce((worst, current) => current.percent < worst.percent ? current : worst);
      const worstSuccessPercent = worstSuccess.percent;
      const worstSuccessIdent = worstSuccess.ident;

      // Calculate continuity metrics (only if show is loaded)
      let continuityPercent = null;
      let continuityCount = null;
      let continuityTotal = null;
      
      if (stagedShow && targetRcvMap && Object.keys(targetRcvMap).length > 0) {
        let totalCues = 0;
        let connectedCues = 0;
        
        Object.entries(receivers).forEach(([receiverKey, receiver]) => {
          const receiverMapping = targetRcvMap[receiverKey];
          if (!receiverMapping || !receiver.cues) return;
          
          // Iterate through all zones and targets in the receiver
          Object.entries(receiver.cues).forEach(([zoneKey, targets]) => {
            const zoneMapping = receiverMapping[zoneKey];
            if (!zoneMapping) return;
            
            targets.forEach((target, targetIndex) => {
              // Only count cues that have items assigned in the show
              if (zoneMapping[target]) {
                totalCues++;
                
                // Check continuity for this cue
                if (receiver.status?.continuity && receiver.status.continuity.length === 2) {
                  const blockIndex = Math.floor(targetIndex / 64);
                  const bitIndex = targetIndex % 64;
                  const block = receiver.status.continuity[blockIndex];
                  if (block !== undefined) {
                    const continuityActive = (BigInt(block) & (BigInt(1) << BigInt(bitIndex))) !== BigInt(0);
                    if (continuityActive) {
                      connectedCues++;
                    }
                  }
                }
              }
            });
          });
        });
        
        if (totalCues > 0) {
          continuityTotal = totalCues;
          continuityCount = connectedCues;
          continuityPercent = (connectedCues / totalCues) * 100;
        }
      }

      return { avgLatencyPercent, worstLatencyPercent, worstLatencyIdent, avgSuccessPercent, worstSuccessPercent, worstSuccessIdent, continuityPercent, continuityCount, continuityTotal };
    };

    const systemHealth = calculateSystemHealth();

    return (
        <div className="w-full">
            <ShowHealth />
            {/* System Health Bar - Fixed at top */}
            {(systemHealth.avgLatencyPercent !== null || systemHealth.avgSuccessPercent !== null || systemHealth.continuityPercent !== null) && (
              <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-700 py-2 px-3">
                <div className="max-w-7xl mx-auto">
                  <div className="flex gap-4">
                    {/* Latency Health Bar */}
                    {systemHealth.avgLatencyPercent !== null && (
                      <div className="flex-1">
                        <div className="text-xs text-gray-500 mb-0.5">Latency</div>
                        <div className="relative w-full h-1.5 bg-gray-800 rounded-full overflow-visible">
                          {/* Average bar with full 0-100 color gradient */}
                          <div
                            className="absolute h-full transition-all duration-1000 ease-out rounded-full"
                            style={{
                              width: `${systemHealth.avgLatencyPercent}%`,
                              backgroundColor: systemHealth.avgLatencyPercent >= 50 
                                ? `rgba(${Math.floor(225 * (1 - (systemHealth.avgLatencyPercent - 50) / 50))}, 225, 0, 0.85)` 
                                : `rgba(225, ${Math.floor(225 * (systemHealth.avgLatencyPercent / 50))}, 0, 0.85)`
                            }}
                          />
                          {/* Red tick marker for worst value */}
                          <div
                            className="absolute top-0 w-0.5 h-full bg-red-500 transition-all duration-1000 ease-out"
                            style={{
                              left: `${systemHealth.worstLatencyPercent}%`,
                              transform: 'translateX(-50%)',
                              boxShadow: '0 0 4px 2px rgba(239, 68, 68, 0.5)'
                            }}
                          />
                          {/* Worst receiver ident */}
                          {systemHealth.worstLatencyIdent && (
                            <div
                              className="absolute text-[10px] text-gray-300 transition-all duration-1000 ease-out whitespace-nowrap z-10"
                              style={{
                                left: `${systemHealth.worstLatencyPercent}%`,
                                top: '-14px',
                                transform: 'translateX(-100%)',
                                marginRight: '4px',
                                textShadow: '0 1px 2px rgba(0, 0, 0, 0.8), 0 0 4px rgba(0, 0, 0, 0.6)'
                              }}
                            >
                              {systemHealth.worstLatencyIdent}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {/* Success Percent Health Bar */}
                    {systemHealth.avgSuccessPercent !== null && (
                      <div className="flex-1">
                        <div className="text-xs text-gray-500 mb-0.5">Success Rate</div>
                        <div className="relative w-full h-1.5 bg-gray-800 rounded-full overflow-visible">
                          {/* Average bar with full 0-100 color gradient */}
                          <div
                            className="absolute h-full transition-all duration-1000 ease-out rounded-full"
                            style={{
                              width: `${systemHealth.avgSuccessPercent}%`,
                              backgroundColor: systemHealth.avgSuccessPercent >= 50 
                                ? `rgba(${Math.floor(225 * (1 - (systemHealth.avgSuccessPercent - 50) / 50))}, 225, 0, 0.85)` 
                                : `rgba(225, ${Math.floor(225 * (systemHealth.avgSuccessPercent / 50))}, 0, 0.85)`
                            }}
                          />
                          {/* Red tick marker for worst value */}
                          <div
                            className="absolute top-0 w-0.5 h-full bg-red-500 transition-all duration-1000 ease-out"
                            style={{
                              left: `${systemHealth.worstSuccessPercent}%`,
                              transform: 'translateX(-50%)',
                              boxShadow: '0 0 4px 2px rgba(239, 68, 68, 0.5)'
                            }}
                          />
                          {/* Worst receiver ident */}
                          {systemHealth.worstSuccessIdent && (
                            <div
                              className="absolute text-[10px] text-gray-300 transition-all duration-1000 ease-out whitespace-nowrap z-10"
                              style={{
                                left: `${systemHealth.worstSuccessPercent}%`,
                                top: '-14px',
                                transform: 'translateX(-100%)',
                                marginRight: '4px',
                                textShadow: '0 1px 2px rgba(0, 0, 0, 0.8), 0 0 4px rgba(0, 0, 0, 0.6)'
                              }}
                            >
                              {systemHealth.worstSuccessIdent}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Header with Show Loadout button + edit lock */}
            <div className="flex justify-between items-center p-4 border-b border-gray-700">
                <h1 className="text-2xl font-bold text-white">Receivers</h1>
                <div className="flex items-center gap-3">
                    {stagedShow && (
                        <button
                            onClick={() => setCurrentTab('loadout')}
                            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                        >
                            <MdAssignment />
                            View Show Loadout
                        </button>
                    )}
                    {/* Add receiver — only available in edit mode. Toggles an
                        inline form between the header and the receiver grid. */}
                    {unlocked && (
                        <button
                            onClick={() => addFormOpen ? closeAddForm() : openAddForm()}
                            disabled={savingEdits}
                            title={addFormOpen ? 'Cancel add' : 'Add a new receiver'}
                            className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-white ${
                              addFormOpen
                                ? 'bg-gray-600 hover:bg-gray-500'
                                : 'bg-emerald-600 hover:bg-emerald-700'
                            }`}
                        >
                            {addFormOpen ? <MdClose className="text-xl" /> : <MdAdd className="text-xl" />}
                            <span className="text-sm">{addFormOpen ? 'Cancel' : 'Add Receiver'}</span>
                        </button>
                    )}
                    {/* Lock toggle: gated on show-loaded state. While unlocked
                        clicking it persists pending edits and asks the daemon
                        to reload its receiver map. The "!" badge surfaces
                        unsaved changes. */}
                    <button
                        onClick={handleLockClick}
                        disabled={savingEdits || (!unlocked && isShowLoaded)}
                        title={lockTitle}
                        className={`relative flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-white
                          ${savingEdits ? 'bg-gray-600 cursor-wait' :
                            (!unlocked && isShowLoaded) ? 'bg-gray-700 opacity-50 cursor-not-allowed' :
                            unlocked ? (hasPendingEdits ? 'bg-amber-600 hover:bg-amber-700' : 'bg-gray-700 hover:bg-gray-600')
                                     : 'bg-gray-700 hover:bg-gray-600'}`}
                    >
                        {unlocked
                          ? <MdLockOpen className="text-xl" />
                          : <MdLock className="text-xl" />}
                        <span className="text-sm">
                          {savingEdits ? 'Saving…'
                            : unlocked ? (hasPendingEdits ? 'Save & Lock' : 'Lock')
                            : 'Edit'}
                        </span>
                        {hasPendingEdits && !savingEdits && (
                          <span
                            className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 flex items-center justify-center text-[10px] font-bold"
                            title="Unsaved changes"
                          >
                            !
                          </span>
                        )}
                    </button>
                </div>
            </div>

            {unlocked && isShowLoaded && (
              <div className="px-4 py-2 bg-amber-900/40 border-b border-amber-700 text-amber-200 text-sm flex items-center gap-2">
                <MdWarning />
                A show is currently loaded — unload it before editing receivers.
              </div>
            )}

            {/* Add-receiver form. Visible only when the page is unlocked AND
                the user has explicitly opened the form. The submit handler
                creates the row in the DB; locking later triggers the daemon
                reload that will register the new receiver with the dongle. */}
            {unlocked && addFormOpen && (
              <form
                onSubmit={handleAddSubmit}
                className="px-4 py-3 border-b border-gray-700 bg-gray-800/60"
              >
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-gray-400">ID</span>
                    <input
                      type="text"
                      value={addForm.id}
                      onChange={(e) =>
                        setAddForm((f) => ({ ...f, id: e.target.value }))
                      }
                      placeholder="RX163"
                      className="bg-gray-900 text-white text-sm rounded border border-gray-600 px-2 py-1 w-32"
                      autoFocus
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-gray-400">Label</span>
                    <input
                      type="text"
                      value={addForm.label}
                      onChange={(e) =>
                        setAddForm((f) => ({ ...f, label: e.target.value }))
                      }
                      placeholder="(defaults to ID)"
                      className="bg-gray-900 text-white text-sm rounded border border-gray-600 px-2 py-1 w-48"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-gray-400">Type</span>
                    <select
                      value={addForm.type}
                      onChange={(e) =>
                        setAddForm((f) => ({ ...f, type: e.target.value }))
                      }
                      className="bg-gray-900 text-white text-sm rounded border border-gray-600 px-2 py-1"
                    >
                      <option value="" disabled>
                        Select type…
                      </option>
                      {availableTypes.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-gray-400"># Cues</span>
                    <input
                      type="number"
                      min={0}
                      max={256}
                      value={addForm.cueCount}
                      onChange={(e) =>
                        setAddForm((f) => ({ ...f, cueCount: e.target.value }))
                      }
                      className="bg-gray-900 text-white text-sm rounded border border-gray-600 px-2 py-1 w-24"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={addBusy}
                    className={`px-4 py-1.5 rounded text-white text-sm ${
                      addBusy
                        ? 'bg-gray-600 cursor-wait'
                        : 'bg-emerald-600 hover:bg-emerald-700'
                    }`}
                  >
                    {addBusy ? 'Adding…' : 'Add'}
                  </button>
                  <button
                    type="button"
                    onClick={closeAddForm}
                    disabled={addBusy}
                    className="px-3 py-1.5 rounded text-gray-200 text-sm bg-gray-700 hover:bg-gray-600"
                  >
                    Cancel
                  </button>
                </div>
                {addError && (
                  <div className="mt-2 text-sm text-red-400 flex items-center gap-2">
                    <MdWarning /> {addError}
                  </div>
                )}
                <p className="mt-2 text-xs text-gray-500">
                  After adding, click the lock to save and reload receivers on the dongle.
                </p>
              </form>
            )}

            {/* Used Receivers (filtered to enabled-only when locked) */}
            {stagedShow && Object.keys(targetRcvMap).length > 0 && (
                <div className="flex flex-wrap gap-5 p-4 justify-center">
                    {visibleReceiverKeys
                        .filter(rcv_key => targetRcvMap[rcv_key])
                        .map((rcv_key, i) => (
                            <SingleReceiver
                              key={i}
                              rcv_name={rcv_key}
                              receiver={receivers[rcv_key]}
                              showMapping={targetRcvMap[rcv_key]}
                              showId={stagedShow?.id}
                              receiverLabel={receiverLabels[rcv_key]}
                              editMode={unlocked}
                              pendingEdit={pendingEdits[rcv_key]}
                              onPendingEditChange={handlePendingEditChange}
                              onRetry={handleRetry}
                              retryBusy={!!retryBusy[rcv_key]}
                            />
                        ))}
                </div>
            )}

            {/* Unused Receivers - Collapsible (filtered to enabled-only when locked) */}
            {stagedShow && Object.keys(targetRcvMap).length > 0 && (() => {
                const unusedKeys = visibleReceiverKeys.filter(k => !targetRcvMap[k]);
                if (unusedKeys.length === 0) return null;
                return (
                    <div className="border-t border-gray-700">
                        <button
                            onClick={() => setShowUnusedReceivers(!showUnusedReceivers)}
                            className="w-full px-4 py-2 text-left text-sm text-slate-400 hover:text-slate-300 hover:bg-slate-800 transition-colors flex items-center justify-between"
                        >
                            <span>Unused Receivers ({unusedKeys.length})</span>
                            <span className="text-xs">{showUnusedReceivers ? '▼' : '▶'}</span>
                        </button>
                        {showUnusedReceivers && (
                            <div className="flex flex-wrap gap-5 p-4 justify-center">
                                {unusedKeys.map((rcv_key, i) => (
                                    <SingleReceiver
                                      key={i}
                                      rcv_name={rcv_key}
                                      receiver={receivers[rcv_key]}
                                      showMapping={targetRcvMap[rcv_key]}
                                      showId={stagedShow?.id}
                                      receiverLabel={receiverLabels[rcv_key]}
                                      editMode={unlocked}
                                      pendingEdit={pendingEdits[rcv_key]}
                                      onPendingEditChange={handlePendingEditChange}
                                      onRetry={handleRetry}
                                      retryBusy={!!retryBusy[rcv_key]}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                );
            })()}

            {/* All Receivers (when no show is staged; filtered to enabled-only when locked) */}
            {(!stagedShow || Object.keys(targetRcvMap).length === 0) && (
                <div className="flex flex-wrap gap-5 p-4 justify-center">
                    {visibleReceiverKeys.map((rcv_key, i) => (
                        <SingleReceiver
                          key={i}
                          rcv_name={rcv_key}
                          receiver={receivers[rcv_key]}
                          showMapping={targetRcvMap[rcv_key]}
                          showId={stagedShow?.id}
                          receiverLabel={receiverLabels[rcv_key]}
                          editMode={unlocked}
                          pendingEdit={pendingEdits[rcv_key]}
                          onPendingEditChange={handlePendingEditChange}
                          onRetry={handleRetry}
                          retryBusy={!!retryBusy[rcv_key]}
                        />
                    ))}
                </div>
            )}

            {/* Disabled Receivers - Collapsed by default; only rendered when
                locked, since edit mode already shows all receivers inline. */}
            {!unlocked && disabledReceiverKeys.length > 0 && (
                <div className="border-t border-gray-700">
                    <button
                        onClick={() => setShowDisabledReceivers(!showDisabledReceivers)}
                        className="w-full px-4 py-2 text-left text-sm text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors flex items-center justify-between"
                    >
                        <span>Disabled Receivers ({disabledReceiverKeys.length})</span>
                        <span className="text-xs">{showDisabledReceivers ? '▼' : '▶'}</span>
                    </button>
                    {showDisabledReceivers && (
                        <div className="flex flex-wrap gap-5 p-4 justify-center">
                            {disabledReceiverKeys.map((rcv_key, i) => (
                                <SingleReceiver
                                  key={i}
                                  rcv_name={rcv_key}
                                  receiver={receivers[rcv_key]}
                                  showMapping={targetRcvMap[rcv_key]}
                                  showId={stagedShow?.id}
                                  receiverLabel={receiverLabels[rcv_key]}
                                  editMode={unlocked}
                                  pendingEdit={pendingEdits[rcv_key]}
                                  onPendingEditChange={handlePendingEditChange}
                                  onRetry={handleRetry}
                                  retryBusy={!!retryBusy[rcv_key]}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}