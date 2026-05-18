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
  MdAssignment,
  MdLock,
  MdLockOpen,
  MdRefresh,
  MdWarning,
  MdAdd,
  MdClose,
  MdSettingsBackupRestore,
} from 'react-icons/md';
import { FaSpinner } from 'react-icons/fa';
import { FaCircleQuestion, FaTriangleExclamation } from 'react-icons/fa6';
import ShowHealth from "../homepanel/ShowHealth";
import { isPollableReceiver } from "@/util/receivers";
import { SHOW_RECEIVER_STATUS } from "@/util/showReceivers";
import useShowReceiverVerification from "@/util/useShowReceiverVerification";

// FW_VERSION: Frontend version tracking for ReceiverDisplay component
// v1.0.0: Initial version - Basic receiver display with battery, connectivity, and cue status
// v1.1.0: Added health bar at top of receiver cards displaying successPercent (0-100% with red-to-green gradient)
// v1.2.0: Increased connection timeout threshold from 5 seconds to 10 seconds
// v1.3.0: Added latency scale bar (1s=100%/green, 10s=0%/red) with smooth animations, moved health bar to bottom with percentage text
// v1.4.0: DB-backed receivers; lock-toggle edit mode (label, enable, cue count); per-receiver retry button; daemon reload on save
// v1.5.0: Drop the analog freshness bar in favour of a 3-tone status (green/orange/red) keyed off raw seconds, plus a top-level segmented bar with one segment per enabled receiver.
// v1.5.1: Tighten cue chip sizing and force a 5-wide cue grid on receiver cards.
// v1.5.2: Use px-3 cue chip padding for a little more breathing room inside the 5-wide grid.
// v1.6.0: Receiver-reported config (paired with receiver FW v22+ / dongle FW v16+):
//   * Per-receiver "fetch config" icon button on actively connected cards.
//   * Dropped the manual "# Cues" input -- cues_data is now auto-derived from
//     the receiver's NUM_BOARDS detection (cues_available in the rxcfg
//     response). The card surfaces FW / board version and the live
//     cue-count read so operators have a single source of truth.
// v1.7.0: Add an optional "Force zones" override in the edit panel
//   (multiples of 8, plus "Don't force"). When set, persisted into
//   config_data.force_cues_available; the daemon ignores subsequent
//   NUM_BOARDS reads for the cues_data sync, and the UI displays the
//   forced count with a "(forced)" suffix.
const FW_VERSION = "1.7.0";

// Selectable values for the "Force zones" override on non-Bilusocn
// receivers. 0 means "no override" -- read the receiver's NUM_BOARDS
// detection. The non-zero values are multiples of 8 because every
// physical cue board is 8 outputs (NUM_LEDS = 8 * NUM_BOARDS), so
// forcing a non-multiple has no useful interpretation on the wire.
const FORCE_ZONES_OPTIONS = [0, 8, 16, 24, 32, 40, 48, 56, 64];

// Read the host-side cue-count override out of a receiver row's
// config_data, returning 0 when unset / invalid (the "Don't force"
// option). Only accepts positive integers; the daemon enforces the
// same on persistence.
function getForceCuesAvailable(receiver) {
  const v = receiver?.config_data?.force_cues_available;
  if (v == null) return 0;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// "Effective" cue count = forced override (when set) or the
// receiver-reported cues_available. Returns null when neither is
// known (operator hasn't fetched cfg yet AND nothing's pinned).
function effectiveCueCount(receiver) {
  const forced = getForceCuesAvailable(receiver);
  if (forced > 0) return forced;
  const reported = receiver?.cues_available;
  return reported == null ? null : reported;
}

// Discrete freshness tones. Operators were misreading the analog bar as
// "the radio is laggy" when it was just polling cadence; the discrete
// version makes "is this receiver still talking to me?" unambiguous.
//   green : last seen <= 4s
//   orange: 4s < last seen <= 8s
//   red   : last seen > 8s, or no lmt at all
const FRESHNESS_OK_MS   = 4000;
const FRESHNESS_WARN_MS = 8000;
function freshnessTone(freshnessMs) {
  if (freshnessMs == null || !Number.isFinite(freshnessMs)) return 'danger';
  if (freshnessMs <= FRESHNESS_OK_MS)   return 'ok';
  if (freshnessMs <= FRESHNESS_WARN_MS) return 'warn';
  return 'danger';
}
const TONE_DOT_BG = {
  ok:     'bg-green-500',
  warn:   'bg-orange-500',
  danger: 'bg-red-500',
};
const TONE_TEXT = {
  ok:     'text-green-400',
  warn:   'text-orange-400',
  danger: 'text-red-400',
};

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

// ---------------------------------------------------------------------------
// Bilusocn 4ch (BILUSOCN_433_TX_ONLY) legacy helpers.
//
// New 433MHz zones are configured per-show in the show builder; the
// daemon synthesizes 4-cue receiver rows on the fly at stage time. The
// helpers below only exist to render any pre-rework Bilusocn rows that
// still live in the DB so operators can recognise + delete them.
// ---------------------------------------------------------------------------
const BILUSOCN_TYPE = 'BILUSOCN_433_TX_ONLY';
const BILUSOCN_RANGE_LEN = 4;
const DEFAULT_BILUSOCN_ZONE = 1;
const DEFAULT_BILUSOCN_RANGE_START = 1;

function isBilusocnType(type) {
  return type === BILUSOCN_TYPE;
}

// Pulls { zone, rangeStart } out of a cues_data map. Falls back to the
// defaults (zone 1, range 1-4) when the map is empty or malformed so the
// edit UI always has sane initial values.
function parseBilusocnCues(cuesObj) {
  if (!cuesObj) {
    return { zone: DEFAULT_BILUSOCN_ZONE, rangeStart: DEFAULT_BILUSOCN_RANGE_START };
  }
  const zoneKey = Object.keys(cuesObj)[0];
  if (!zoneKey) {
    return { zone: DEFAULT_BILUSOCN_ZONE, rangeStart: DEFAULT_BILUSOCN_RANGE_START };
  }
  const zone = parseInt(zoneKey, 10) || DEFAULT_BILUSOCN_ZONE;
  const arr = cuesObj[zoneKey];
  const rangeStart =
    Array.isArray(arr) && arr.length > 0
      ? Number(arr[0]) || DEFAULT_BILUSOCN_RANGE_START
      : DEFAULT_BILUSOCN_RANGE_START;
  return { zone, rangeStart };
}

// Build a cues_data payload of the form { "<zone>": [start, start+1, +2, +3] }.
function buildBilusocnCuesData(zone, rangeStart) {
  const z = Math.max(1, Math.min(256, parseInt(zone, 10) || DEFAULT_BILUSOCN_ZONE));
  const start = parseInt(rangeStart, 10) || DEFAULT_BILUSOCN_RANGE_START;
  return {
    [String(z)]: Array.from({ length: BILUSOCN_RANGE_LEN }, (_, i) => start + i),
  };
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
  // Receiver-config fetch (FW v22+ / dongle FW v16+)
  onFetchConfig, // (id) => Promise<void> | void
  fetchConfigBusy = false,
  // When true, render the per-card debug info row (Cues / FW / Board /
  // Fire ms). Off by default to keep the live status grid scannable;
  // toggled from the Receivers page header by the operator.
  debugDisplay = false,
}) {
  const [popup, setPopup] = useState(null);
  const receiverRef = useRef(null);

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

  // `freshness` (ms): wall-clock time since the dongle last heard from
  // this receiver. Bounded below by the dongle's TDMA poll cadence
  // (clock_sync_interval_ms / numReceivers). Surfaced only as a tone on
  // the WiFi icon -- the literal number was just visual noise that
  // operators were misreading as RF lag.
  let isConnectionGood;
  let freshness = null;
  if (receiver.status && receiver.status.lmt) {
    freshness = Date.now() - receiver.status.lmt;
    isConnectionGood = (freshness <= 10000);
  } else {
    isConnectionGood = receiver.connectionStatus === "good";
  }
  const tone = freshnessTone(freshness);
  const lfx = freshness != null ? (freshness / 1000).toFixed(1) : "—";

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

  // Bilusocn 4ch modules have a shared zone and a fixed 4-cue range
  // (dipswitched). Surface the zone + range explicitly instead of "# Cues"
  // since it can never not be 4.
  const isBilusocn = isBilusocnType(receiver.type);
  const bilusocnCurrent = isBilusocn ? parseBilusocnCues(receiver.cues) : null;

  // Host-side "Force zones" override. 0 means "don't force" (use the
  // receiver-reported cues_available). Pending value falls back to the
  // currently-persisted override.
  const currentForceZones = getForceCuesAvailable(receiver);
  const editForceZones = pendingEdit?.forceZones !== undefined
    ? pendingEdit.forceZones
    : currentForceZones;
  // What the card *thinks* the receiver has, for the non-edit display.
  // Forced value takes precedence; otherwise the receiver-reported
  // cues_available (which may be null when no rxcfg has landed yet).
  const displayCueCount = effectiveCueCount(receiver);
  const isForcedActive = currentForceZones > 0;

  // The retry button is visible whenever the receiver is enabled — it's the
  // only way to recover a pruned receiver without restarting the daemon.
  const showRetry = isEnabled && typeof onRetry === 'function';

  return (
    <div
      ref={receiverRef}
      className={`border rounded-xl p-4 ${bgColor} text-white shadow-md dark:bg-gray-700 dark:border-gray-600 flex flex-col gap-3 w-72 relative ${
        isBilusocn ? "border-amber-500/60" : ""
      }`}
    >
      {/* Deprecation banner for legacy Bilusocn rows. New 433MHz zones
          live on the show, not in the receivers DB; we leave existing
          rows visible (read-mostly) so operators can clean them up
          themselves -- delete is the only edit we still allow. See
          `availableTypes` in the parent for the add-side block. */}
      {isBilusocn && (
        <div className="rounded-md border border-amber-500/50 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
          <div className="font-semibold mb-0.5">Deprecated Bilusocn row</div>
          <div className="text-amber-300/90">
            Bilusocn 433MHz zones are now configured per-show in the show builder
            ("Bilusocn / 433 MHz" tab on Add Receiver/Zone). Delete this row and
            re-add the zone in your shows -- the daemon synthesizes the modules
            ephemerally at stage time.
          </div>
        </div>
      )}

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

          {/* Connectivity indicator. Tone-coloured by freshness so the
              card-level icon mirrors the segmented strip up top: green
              <=4s, orange <=8s, red beyond that or no link at all. */}
          {isConnectionGood ? (
            <MdSignalWifi4Bar
              className={TONE_TEXT[tone]}
              title={`Last seen ${lfx}s ago`}
            />
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

      {/* Per-card action row: retry connection + fetch receiver config.
          Both are always available when enabled (even when edit mode is
          locked) so a pruned receiver can be re-added on the fly and an
          operator can refresh the rxcfg snapshot mid-show without
          touching anything else. Hidden for one-way TX-only types --
          there's nothing to poll, no rxcfg to fetch. */}
      {showRetry && receiver.type !== 'BILUSOCN_433_TX_ONLY' && (
        <div className="flex gap-2">
          {typeof onFetchConfig === 'function' && (
            <button
              type="button"
              disabled={fetchConfigBusy || !isConnectionGood}
              onClick={() => onFetchConfig(rcv_name)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded
                ${fetchConfigBusy || !isConnectionGood
                  ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                  : 'bg-gray-700 hover:bg-gray-600 text-gray-200'}`}
              title={
                isConnectionGood
                  ? 'Fetch receiver config (NUM_BOARDS, fire duration, FW)'
                  : 'Receiver is not connected'
              }
            >
              <MdSettingsBackupRestore className={fetchConfigBusy ? 'animate-spin' : ''} />
              Fetch cfg
            </button>
          )}
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

      {/* Receiver-reported config snapshot. Shown when we've gotten at
          least one CONFIG_RESPONSE for this receiver OR an operator
          has pinned a force_cues_available override (the override is
          authoritative even before the first rxcfg lands).
          Hidden in edit mode because the edit panel surfaces the same
          numbers in a writable shape. Also hidden unless the operator
          toggles "Debug Display" up top -- on a busy show the row is
          mostly noise once you've verified it once. */}
      {!editMode && debugDisplay && (receiver.cues_available != null || isForcedActive) && (
        <div className="text-xs text-gray-400 flex flex-wrap gap-x-3 gap-y-1">
          <span>
            Cues: <span className="text-gray-200">{displayCueCount ?? '—'}</span>
            {isForcedActive && (
              <span
                className="text-amber-400 ml-1"
                title={
                  receiver.cues_available != null
                    ? `Receiver reports ${receiver.cues_available} cues; host forced to ${currentForceZones}`
                    : `Host forced to ${currentForceZones} cues (receiver hasn't reported yet)`
                }
              >
                (forced)
              </span>
            )}
          </span>
          {receiver.fw_version != null && (
            <span>FW <span className="text-gray-200">v{receiver.fw_version}</span></span>
          )}
          {receiver.board_version != null && (
            <span>Board <span className="text-gray-200">v{receiver.board_version}</span></span>
          )}
          {receiver.config_data?.fire_duration_ms != null && (
            <span>
              Fire <span className="text-gray-200">{receiver.config_data.fire_duration_ms}ms</span>
            </span>
          )}
        </div>
      )}

      {/* Cues Section. For Bilusocn the zone is independent of ident, so
          surface it in the header to disambiguate sibling modules sharing
          the same zone. */}
      <b className="text-gray-300 mt-1 mb-1">
        {isBilusocn && firstZone
          ? `Zone ${firstZone} • Cues ${bilusocnCurrent.rangeStart}-${bilusocnCurrent.rangeStart + BILUSOCN_RANGE_LEN - 1}`
          : 'Cues'}
      </b>
      <div className="grid grid-cols-5 gap-2 mt-1">
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
              className={`min-w-0 h-10 px-3 rounded-lg text-sm text-black flex items-center justify-center ${bgClass} cursor-pointer ${borderClass}`}
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
          {isBilusocn ? (
            // Legacy Bilusocn rows are read-mostly: the only edit we
            // still surface in the locked panel is enable/disable +
            // label (above) so operators can quiet them while they
            // migrate. Zone / range edits are intentionally gone --
            // delete the row and re-add the zone in the show builder.
            <div className="rounded border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
              Zone <span className="num text-amber-100">{bilusocnCurrent?.zone ?? '—'}</span>{' '}
              · cues{' '}
              <span className="num text-amber-100">
                {bilusocnCurrent?.rangeStart ?? '—'}-
                {bilusocnCurrent
                  ? bilusocnCurrent.rangeStart + BILUSOCN_RANGE_LEN - 1
                  : '—'}
              </span>
              <div className="mt-1 text-amber-300/80">
                Editing zone / dipswitch range is no longer supported here.
                Delete this row and re-add the zone in the show builder.
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-gray-400">Force zones (optional)</span>
              <select
                value={editForceZones}
                onChange={(e) =>
                  onPendingEditChange?.(rcv_name, {
                    forceZones: parseInt(e.target.value, 10) || 0,
                  })
                }
                className="px-2 py-1 rounded bg-gray-900 border border-gray-600 text-white text-xs"
              >
                {FORCE_ZONES_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "Don't force" : `${n} cues`}
                  </option>
                ))}
              </select>
              <span className="text-xs text-gray-500">
                {receiver.cues_available != null ? (
                  <>
                    Receiver reports{' '}
                    <span className="text-gray-300">{receiver.cues_available}</span>{' '}
                    cues from NUM_BOARDS detection.
                  </>
                ) : (
                  <>
                    Receiver hasn't reported yet -- click "Fetch cfg" once it's online.
                  </>
                )}
                {' '}When forced, the host treats this receiver as having exactly
                that many cues regardless of what cfg fetch returns.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Placeholder tile rendered in place of a real receiver card when the show
// references a receiver that doesn't currently exist on the system, or one
// that has been disabled. Operators see one of these per problem so the
// remediation path (Receivers admin → add/enable) is obvious without
// having to cross-reference the show data.
function ErrorReceiverTile({ entry, kind }) {
  const icon =
    kind === SHOW_RECEIVER_STATUS.MISSING ? (
      <FaCircleQuestion className="text-red-400" size={28} />
    ) : (
      <FaTriangleExclamation className="text-red-400" size={28} />
    );
  const title = entry.label ? `${entry.label} (${entry.id})` : entry.id;
  const message =
    kind === SHOW_RECEIVER_STATUS.MISSING
      ? "Not on this system."
      : "Disabled.";
  const hint =
    kind === SHOW_RECEIVER_STATUS.MISSING
      ? "Add it on the Receivers page (or remove it from the show)."
      : "Re-enable it to load this show.";
  return (
    <div className="border rounded-xl p-4 bg-gray-800 text-white shadow-md border-red-500/70 flex flex-col gap-3 w-72 relative">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          <span>{title}</span>
        </h2>
        {icon}
      </div>
      <div className="text-sm text-red-300">
        <div className="font-medium">{message}</div>
        <div className="text-xs text-red-300/80 mt-1">{hint}</div>
      </div>
      <div className="text-xs text-gray-500">
        Show expects {entry.cues} cue{entry.cues === 1 ? "" : "s"}.
      </div>
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
      fetchReceiverConfig,
    } = useAppStore();
    const { stateData } = useStateAppStore()
    const [ targetRcvMap, setTargetRcvMap ] = useState({});
    const [showUnusedReceivers, setShowUnusedReceivers] = useState(false);
    const [showDisabledReceivers, setShowDisabledReceivers] = useState(false);
    const [receiverLabels, setReceiverLabels] = useState({});

    // "Debug Display" toggle. Persisted to localStorage so the operator
    // doesn't have to re-enable it after every page navigation. When on,
    // each card shows a Cues / FW / Board / Fire row pulled from the
    // receiver's last rxcfg response. Off by default -- the row is
    // mostly noise once the fleet has been verified, and the live
    // status icons + cue grid carry the day-to-day signal.
    const [debugDisplay, setDebugDisplay] = useState(() => {
      if (typeof window === 'undefined') return false;
      try { return window.localStorage.getItem('byh.receivers.debugDisplay') === '1'; }
      catch { return false; }
    });
    useEffect(() => {
      if (typeof window === 'undefined') return;
      try { window.localStorage.setItem('byh.receivers.debugDisplay', debugDisplay ? '1' : '0'); }
      catch { /* localStorage unavailable -- ignore */ }
    }, [debugDisplay]);

    // Show-level verification. When a show is staged this drives the
    // top-level error grid (one tile per receiver entry, colour-coded by
    // status) plus the menu-bar X badge in the parent shell.
    const verification = useShowReceiverVerification();

    // Edit-mode state
    const [unlocked, setUnlocked] = useState(false);
    // pendingEdits: { [rcvId]: { label?, enabled?, cueCount? } }
    const [pendingEdits, setPendingEdits] = useState({});
    const [savingEdits, setSavingEdits] = useState(false);
    const [retryBusy, setRetryBusy] = useState({}); // { [rcvId]: true }
    const [fetchConfigBusy, setFetchConfigBusy] = useState({}); // { [rcvId]: true }

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
          const currentForceZones = getForceCuesAvailable(def);
          const noLabelChange = merged.label === undefined || merged.label === currentLabel;
          const noEnabledChange = merged.enabled === undefined || merged.enabled === currentEnabled;
          const noCueChange = merged.cueCount === undefined || merged.cueCount === currentCueCount;
          const noForceChange =
            merged.forceZones === undefined || merged.forceZones === currentForceZones;
          // Bilusocn has separate zone+rangeStart fields. For BYH receivers
          // these stay undefined, so the checks below are no-ops.
          const bilusocnCurrent = isBilusocnType(def.type) ? parseBilusocnCues(def.cues) : null;
          const noZoneChange = merged.zone === undefined
            || (bilusocnCurrent && merged.zone === bilusocnCurrent.zone);
          const noRangeChange = merged.rangeStart === undefined
            || (bilusocnCurrent && merged.rangeStart === bilusocnCurrent.rangeStart);
          if (
            noLabelChange &&
            noEnabledChange &&
            noCueChange &&
            noForceChange &&
            noZoneChange &&
            noRangeChange
          ) {
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

    // Fire a CONFIG_QUERY at one receiver and re-pull the DB after a
    // short delay so the new fw / cues_available / fire_duration_ms
    // surface in the UI without the operator having to refresh.
    //
    // 1.5s is enough for: dongle to dispatch the query+followup
    // (~50ms), receiver to respond (~10ms), daemon to ingest +
    // sqlite-write (~50ms), state file flush (debounced to <500ms).
    // The fetchReceivers GET reads straight from SQLite so it's
    // authoritative even before the broadcast state file catches up.
    const handleFetchConfig = useCallback(async (id) => {
      setFetchConfigBusy((prev) => ({ ...prev, [id]: true }));
      try {
        await fetchReceiverConfig(id);
        // The daemon writes the response asynchronously; wait briefly
        // before re-fetching so the new row reflects the rxcfg.
        setTimeout(() => {
          fetchReceivers().catch((e) =>
            console.error('fetchReceivers post-rxcfg failed:', e),
          );
        }, 1500);
      } catch (e) {
        console.error('Fetch config failed', e);
      } finally {
        setTimeout(() => {
          setFetchConfigBusy((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }, 1500);
      }
    }, [fetchReceiverConfig, fetchReceivers]);

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
          if (isBilusocnType(def.type)) {
            // Bilusocn rebuilds cues_data from zone + range when either
            // changes, since both pieces collaborate to form the single
            // { [zone]: [start..start+3] } entry.
            const current = parseBilusocnCues(def.cues);
            const newZone = edit.zone !== undefined ? edit.zone : current.zone;
            const newRangeStart = edit.rangeStart !== undefined
              ? edit.rangeStart
              : current.rangeStart;
            if (newZone !== current.zone || newRangeStart !== current.rangeStart) {
              patch.cues_data = buildBilusocnCuesData(newZone, newRangeStart);
            }
          } else if (
            edit.cueCount !== undefined &&
            edit.cueCount !== cueCountFromCues(def.cues)
          ) {
            patch.cues_data = buildCuesData(id, edit.cueCount);
          }

          // Force-zones override: persisted into config_data and also
          // immediately reflected in cues_data so the UI / show builder
          // see the new cue count without having to wait for the next
          // rxcfg sync from the daemon. When set to 0 ("Don't force") we
          // delete the override key and fall back to the receiver-
          // reported cues_available.
          if (!isBilusocnType(def.type) && edit.forceZones !== undefined) {
            const currentForce = getForceCuesAvailable(def);
            if (edit.forceZones !== currentForce) {
              const existingCfg = (def.config_data && typeof def.config_data === 'object')
                ? def.config_data
                : {};
              const nextCfg = { ...existingCfg };
              if (edit.forceZones > 0) {
                nextCfg.force_cues_available = edit.forceZones;
              } else {
                delete nextCfg.force_cues_available;
              }
              patch.config_data = nextCfg;

              // Recompute cues_data to match the new effective count.
              // Force > 0  -> use the forced count.
              // Force == 0 -> fall back to cues_available; if that's
              //               unknown, leave cues_data alone (the next
              //               rxcfg will fix it).
              const effective = edit.forceZones > 0
                ? edit.forceZones
                : (def.cues_available != null ? def.cues_available : null);
              if (effective != null) {
                patch.cues_data = buildCuesData(id, effective);
              }
            }
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
    // `types` block (still the source of truth for hardware
    // capabilities). BILUSOCN_433_TX_ONLY is intentionally filtered out:
    // Bilusocn 433MHz zones are now defined per-show in the show
    // builder ("Bilusocn / 433 MHz" tab on Add Receiver/Zone), and the
    // daemon synthesizes ephemeral receiver rows for them at stage
    // time. There is nothing to save on /receivers anymore.
    const availableTypes = useMemo(
      () => Object.keys(systemConfig?.types || {}).filter((t) => t !== BILUSOCN_TYPE),
      [systemConfig?.types]
    );

    const closeAddForm = useCallback(() => {
      setAddFormOpen(false);
      setAddError(null);
      setAddForm({
        id: "",
        label: "",
        type: "",
        cueCount: 8,
      });
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

      if (!id) { setAddError("ID is required."); return; }
      if (dbReceivers && dbReceivers[id]) {
        setAddError(`Receiver "${id}" already exists.`);
        return;
      }
      if (!type) { setAddError("Type is required."); return; }
      // Defensive guard: BILUSOCN_433_TX_ONLY is filtered out of the
      // type dropdown (Bilusocn zones live on shows now), but block at
      // submit too in case stale form state slips through.
      if (isBilusocnType(type)) {
        setAddError(
          'Bilusocn 433MHz zones are now configured per-show. ' +
          'Add the zone in the show builder under "Bilusocn / 433 MHz".'
        );
        return;
      }
      // The dongle parses node IDs out of "RX<digits>". Warn when the
      // pattern won't match -- the dongle won't be able to address it.
      if (type === "BKYD_TS_24_1" && !/^RX\d+$/i.test(id)) {
        setAddError(
          'BKYD_TS_24_1 receivers must be named "RX<digits>" (e.g. RX163) — ' +
          'the dongle parses the node ID out of the ident.'
        );
        return;
      }

      const cueCount = Math.max(0, Math.min(256, parseInt(addForm.cueCount, 10) || 0));
      const cuesData = buildCuesData(id, cueCount);

      setAddBusy(true);
      try {
        await createReceiver({
          id,
          label,
          type,
          cues_data: cuesData,
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

    // Calculate system health metrics.
    //
    // The freshness rollup is now a segmented bar: one slot per *enabled*
    // (pollable) receiver -- not just online ones -- so disabled rows
    // never show up but a receiver that has gone fully silent still
    // occupies its slot, coloured red. Operators can tell at a glance
    // "5/6 of my mortars are alive" without having to read text.
    const calculateSystemHealth = () => {
      const pollableEntries = Object.entries(receivers)
        .filter(([_, r]) => isPollableReceiver(r))
        .sort(([a], [b]) => a.localeCompare(b)); // stable order = stable segment positions

      const freshnessSegments = pollableEntries.map(([ident, receiver]) => {
        const lmt = receiver?.status?.lmt;
        const fresh = (typeof lmt === 'number')
          ? Date.now() - lmt
          : null;
        return { ident, tone: freshnessTone(fresh) };
      });

      // Online = anything we've heard from in the last 10s. Used by the
      // success-rate / continuity panels which only make sense for
      // currently-talking nodes.
      const onlineReceivers = pollableEntries.filter(([_, receiver]) => {
        if (!receiver.status || !receiver.status.lmt) return false;
        return Date.now() - receiver.status.lmt <= 10000;
      });

      if (onlineReceivers.length === 0) {
        return { freshnessSegments, avgSuccessPercent: null, worstSuccessPercent: null, worstSuccessIdent: null, continuityPercent: null, continuityCount: null, continuityTotal: null };
      }

      // Calculate success percent metrics with ident tracking
      const successData = onlineReceivers
        .map(([ident, receiver]) => ({
          ident,
          percent: receiver.status?.successPercent ?? null
        }))
        .filter(d => d.percent !== null);

      if (successData.length === 0) {
        return { freshnessSegments, avgSuccessPercent: null, worstSuccessPercent: null, worstSuccessIdent: null, continuityPercent: null, continuityCount: null, continuityTotal: null };
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

      return { freshnessSegments, avgSuccessPercent, worstSuccessPercent, worstSuccessIdent, continuityPercent, continuityCount, continuityTotal };
    };

    const systemHealth = calculateSystemHealth();

    return (
        <div className="w-full">
            <ShowHealth />
            {/* System Health Bar - Fixed at top */}
            {(systemHealth.freshnessSegments.length > 0 || systemHealth.avgSuccessPercent !== null || systemHealth.continuityPercent !== null) && (
              <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-700 py-2 px-3">
                <div className="max-w-7xl mx-auto">
                  <div className="flex gap-4">
                    {/* Freshness strip: one fixed-width segment per enabled
                        receiver, coloured by that receiver's freshness
                        tone. Operators can read "5/6 alive" from a glance
                        rather than parsing a sliding average. Stable sort
                        order so segment positions don't reshuffle when a
                        receiver flips state. */}
                    {systemHealth.freshnessSegments.length > 0 && (
                      <div className="flex-1">
                        <div className="text-xs text-gray-500 mb-0.5">Freshness</div>
                        <div className="flex w-full h-1.5 gap-0.5 rounded-full overflow-hidden bg-gray-800">
                          {systemHealth.freshnessSegments.map((seg) => (
                            <div
                              key={seg.ident}
                              className={`flex-1 ${TONE_DOT_BG[seg.tone]}`}
                              title={`${seg.ident}: ${
                                seg.tone === 'ok' ? 'fresh' :
                                seg.tone === 'warn' ? 'stale' : 'lost'
                              }`}
                            />
                          ))}
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
                    {/* Operator-only debug toggle. Persisted to
                        localStorage so it survives navigation but doesn't
                        leak into a different operator's session. */}
                    <label
                      className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer select-none hover:text-gray-200"
                      title="Show per-card Cues / FW / Board / Fire row"
                    >
                      <input
                        type="checkbox"
                        checked={debugDisplay}
                        onChange={(e) => setDebugDisplay(e.target.checked)}
                        className="h-3.5 w-3.5 accent-amber-500"
                      />
                      Debug Display
                    </label>
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

            {/* Show-staged: the canonical list of receivers is the show's own
                showReceivers array (now in-memory via the verification hook).
                We render one tile per entry, choosing between a real
                SingleReceiver card (with a red outline when the DB receiver
                doesn't have enough cues) and an ErrorReceiverTile for the
                missing/disabled cases. The Unused Receivers (DB receivers
                NOT referenced by the show) still collapse below. */}
            {verification.hasStagedShow && (
                <div className="flex flex-wrap gap-5 p-4 justify-center">
                    {verification.results.map((r, i) => {
                        const id = r.entry.id;
                        if (r.status === SHOW_RECEIVER_STATUS.MISSING ||
                            r.status === SHOW_RECEIVER_STATUS.DISABLED) {
                            return (
                                <ErrorReceiverTile
                                    key={`err-${id}-${i}`}
                                    entry={r.entry}
                                    kind={r.status}
                                />
                            );
                        }
                        const isInsufficient = r.status === SHOW_RECEIVER_STATUS.INSUFFICIENT;
                        // SingleReceiver doesn't natively know how to render
                        // the "insufficient cues" border so we wrap it in a
                        // red-outlined frame and overlay the explanation.
                        const tile = (
                            <SingleReceiver
                              key={`ok-${id}-${i}`}
                              rcv_name={id}
                              receiver={receivers[id]}
                              showMapping={targetRcvMap[id]}
                              showId={stagedShow?.id}
                              receiverLabel={r.entry.label || receiverLabels[id]}
                              editMode={unlocked}
                              pendingEdit={pendingEdits[id]}
                              onPendingEditChange={handlePendingEditChange}
                              onRetry={handleRetry}
                              retryBusy={!!retryBusy[id]}
                              onFetchConfig={handleFetchConfig}
                              fetchConfigBusy={!!fetchConfigBusy[id]}
                              debugDisplay={debugDisplay}
                            />
                        );
                        if (!isInsufficient) return tile;
                        return (
                            <div
                                key={`insuf-${id}-${i}`}
                                className="rounded-xl ring-2 ring-red-500/70 ring-offset-2 ring-offset-gray-900 relative"
                            >
                                <div className="absolute -top-2 left-3 right-3 bg-gray-900 px-1 z-10 text-xs text-red-300 font-medium">
                                    Show needs {r.entry.cues} cues, receiver has {r.have}
                                </div>
                                {tile}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Unused Receivers - Collapsible. Under per-show receivers an
                "unused" receiver is one that exists in the DB but isn't
                referenced by the show's showReceivers list. */}
            {verification.hasStagedShow && (() => {
                const referenced = new Set(verification.results.map((r) => r.entry.id));
                const unusedKeys = visibleReceiverKeys.filter((k) => !referenced.has(k));
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
                                      onFetchConfig={handleFetchConfig}
                                      fetchConfigBusy={!!fetchConfigBusy[rcv_key]}
                                      debugDisplay={debugDisplay}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                );
            })()}

            {/* All Receivers (when no show is staged; filtered to enabled-only when locked) */}
            {!verification.hasStagedShow && (
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
                          onFetchConfig={handleFetchConfig}
                          fetchConfigBusy={!!fetchConfigBusy[rcv_key]}
                          debugDisplay={debugDisplay}
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
                                  onFetchConfig={handleFetchConfig}
                                  fetchConfigBusy={!!fetchConfigBusy[rcv_key]}
                                  debugDisplay={debugDisplay}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}