import { INV_COLOR_CODE, itemColorOf } from "@/constants";
import { asyncConfirm, asyncPrompt } from "@/components/common/AsyncPrompt";
import React, { useState, useRef, memo, useEffect, useMemo } from "react";
import { FaTrash, FaLock, FaLockOpen, FaPencil, FaArrowRightArrowLeft, FaRegClone } from "react-icons/fa6";
import { FiZoomIn, FiZoomOut, FiPlus, FiClock, FiZap, FiX } from "react-icons/fi";
import axios from "axios";
import { cn } from "@/design";
import {
  anyTrackHasBpm,
  generateMultiTrackBeatGrid,
  snapShowTimeToBeat,
  totalShowAudioDuration,
} from "@/utils/audioTracks";
import usePersistentState from "@/utils/usePersistentState";

// ---- Module-level pure helpers ------------------------------------------
// Hoisted out of the Timeline component so they have stable identities and can
// be shared with the memoised <TimelineItem> below (a helper recreated every
// render would defeat the item memo). Behaviour is unchanged from the previous
// in-component definitions.
const MAX_TIME = 60 * 60; // Maximum time (1 hour in seconds)

// Zoom bounds. Every zoom mutation (buttons, wheel, pinch) and the persisted
// value restored on mount are clamped to this band so a runaway wheel spin or a
// corrupt/stale localStorage value can never blank the timeline (width scales
// with zoom, and 0/NaN/∞ collapses the layout with no in-session recovery).
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 200;
const ZOOM_DEFAULT = 40;
const clampZoom = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n)) : ZOOM_DEFAULT;
};

// Coerce timeline numerics defensively (string/undefined startTime|duration).
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Position (as % of timeline width) for an absolute show time.
const calculatePosition = (startTime) => (num(startTime) / MAX_TIME) * 100;

const formatClock = (sec) => {
  if (!Number.isFinite(sec)) return "—";
  const sign = sec < 0 ? "-" : "";
  const a = Math.abs(sec);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${sign}${m}:${s.toFixed(2).padStart(5, "0")}`;
};

// Compact "length" label for the cue box, e.g. "4s", "4.5s", or "1:30".
const fmtDuration = (sec) => {
  const s = num(sec);
  if (s <= 0) return "";
  if (s < 60) return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};

const cakeTypesWithFiringProfiles = (type) =>
  type === "CAKE_200G" ||
  type === "CAKE_350G" ||
  type === "CAKE_500G" ||
  type === "COMPOUND_CAKE";

// Derive a cue's shot-overlay timings + FUSED_LINE step boundaries. This is the
// expensive per-cue work (fused lines / rack shells); it lives here so it can
// be wrapped in a per-item useMemo inside TimelineItem, running only when the
// cue (or the fetched firing profiles / inventory) changes — not on every
// timeline re-render (scroll, playhead, another cue's drag). Returns times in
// the same [start_ms, end_ms(, color)] format the renderer expects.
function computeShots(item, firingProfiles, inventory) {
  const firingProfile =
    cakeTypesWithFiringProfiles(item.type) && item.itemId
      ? firingProfiles[item.itemId]
      : null;
  let shots = firingProfile?.shot_timestamps || [];
  let fusedLineStepBoundariesSec = [];

  if (
    (item.type === "FUSED_AERIAL_LINE" || item.type === "FUSED_SHELL_LINE") &&
    item.shells && item.fuse && item.spacing
  ) {
    const burn_rate = item.fuse.burn_rate || 0;
    const spacing_inches = parseFloat(item.spacing) || 0;
    const fuse_burn_time_per_shell = (spacing_inches / 12) * burn_rate;
    shots = item.shells
      .map((shell, index) => {
        if (!shell) return null;
        let shotStartSec = 0;
        if (index > 0) {
          for (let i = 1; i <= index; i++) shotStartSec += fuse_burn_time_per_shell;
        }
        const shotEndSec = shotStartSec + 1.0;
        return [shotStartSec * 1000, shotEndSec * 1000];
      })
      .filter((shot) => shot !== null);
  }

  if (item.type === "FUSED_LINE" && Array.isArray(item.steps) && item.steps.length > 0) {
    const stepShots = [];
    const offsets = [];
    let acc = 0;
    item.steps.forEach((step, idx) => {
      if (idx > 0) acc += Math.max(0, Number(step.fuseDelay) || 0);
      offsets.push(acc);
      acc += Math.max(0, Number(step.duration) || 0);
    });
    fusedLineStepBoundariesSec = offsets.slice(1);
    item.steps.forEach((step, idx) => {
      const offsetSec = offsets[idx];
      const stepDur = Math.max(0, Number(step.duration) || 0);
      if (step.type === "FUSED_SHELL_LINE" && step.fusedShellLine) {
        const fl = step.fusedShellLine;
        const burn_rate = fl.fuse?.burn_rate || 0;
        const spacing_inches = parseFloat(fl.spacing) || 0;
        const fuse_burn_time_per_shell = (spacing_inches / 12) * burn_rate;
        (fl.shells || []).forEach((shell, sIdx) => {
          if (!shell) return;
          const inStepSec = sIdx * fuse_burn_time_per_shell;
          const startSec = offsetSec + inStepSec;
          const endSec = startSec + 1.0;
          stepShots.push([startSec * 1000, endSec * 1000]);
        });
      } else if (cakeTypesWithFiringProfiles(step.type) && step.itemId && firingProfiles[step.itemId]) {
        const ts = firingProfiles[step.itemId].shot_timestamps || [];
        ts.forEach((shot) => {
          const shotStartMs = shot[0];
          const shotEndMs = shot[1];
          const color = shot.length >= 3 ? shot[2] : null;
          const startMs = offsetSec * 1000 + shotStartMs;
          const endMs = offsetSec * 1000 + shotEndMs;
          if (color) stepShots.push([startMs, endMs, color]);
          else stepShots.push([startMs, endMs]);
        });
      } else {
        const startSec = offsetSec;
        const endSec = offsetSec + Math.max(0.2, stepDur);
        stepShots.push([startSec * 1000, endSec * 1000]);
      }
    });
    shots = stepShots;
  }

  if (item.type === "RACK_SHELLS" && item.fireableItem && item.rackSpacing && inventory.length > 0) {
    const fireableItem = item.fireableItem;
    const rackSpacing = item.rackSpacing;
    if (fireableItem.type === "fused" && fireableItem.fuse && fireableItem.cellData && fireableItem.cells) {
      const fuse = fireableItem.fuse;
      const fuseItem = inventory.find((inv) => inv.type === "FUSE" && inv.id === parseInt(fuse.type));
      const burn_rate = fuseItem?.burn_rate || 0;
      shots = fireableItem.cellData
        .map((cellData, index) => {
          if (!cellData || !cellData.shellId) return null;
          let shotStartSec = 0;
          if (index > 0) {
            for (let i = 1; i <= index; i++) {
              const prevCellKey = fireableItem.cells[i - 1];
              const currentCellKey = fireableItem.cells[i];
              const [x1, y1] = prevCellKey.split("_").map(Number);
              const [x2, y2] = currentCellKey.split("_").map(Number);
              const xDiff = Math.abs(x2 - x1);
              const yDiff = Math.abs(y2 - y1);
              const distance_inches = xDiff * rackSpacing.x + yDiff * rackSpacing.y;
              const fuse_burn_time = (distance_inches / 12) * burn_rate;
              shotStartSec += fuse_burn_time;
            }
          }
          const shotEndSec = shotStartSec + 0.5;
          return [shotStartSec * 1000, shotEndSec * 1000];
        })
        .filter((shot) => shot !== null);
    } else if (fireableItem.type === "single" && fireableItem.cellData && fireableItem.cellData[0]) {
      const cellData = fireableItem.cellData[0];
      const shell = inventory.find((inv) => inv.id === cellData.shellId);
      if (shell) {
        shots = [[0, 0.5 * 1000]];
      }
    }
  }

  return { shots, fusedLineStepBoundariesSec };
}

// One cue on the timeline: its floating label row, duration bar, FUSED_LINE
// step separators and shot-profile overlays. Memoised so that a re-render of
// the Timeline (scroll, playhead tick, another cue's drag) skips every cue
// whose props didn't change — and the expensive computeShots() only runs when
// this cue actually changes. All event wiring goes through the stable
// `handlers` object so the memo isn't defeated by fresh closures.
const TimelineItem = memo(function TimelineItem({
  item, start, width, top, hasNoLength, labelMaxPx,
  barH, rowH, topPad, compactItems,
  showZoneCue, showStartTime, showEndTime,
  isSelected, isDragging, isLocked, canDrag, isReadOnly,
  receiverLabels, firingProfiles, inventory, handlers,
}) {
  const { shots, fusedLineStepBoundariesSec } = useMemo(
    () => computeShots(item, firingProfiles, inventory),
    [item, firingProfiles, inventory]
  );
  const color = itemColorOf(item);

  return (
    <>
      {/* Label row -- floats just above the bar (anchored by its bottom via
          transform, so the gap is the same regardless of font size). It's part
          of the cue's drag/click surface. */}
      {/* Label row — floats just above the bar. The OUTER box spans the cue's
          width so the INNER label can pin to the viewport-left natively via CSS
          `position: sticky` while any of the cue is on screen. The browser
          tracks the scroll pixel-perfectly (synchronously), so the label no
          longer flickers and a scroll doesn't re-render the cue at all (no
          `viewLeftPct` dependency). It's part of the cue's drag/click surface. */}
      <div
        className="absolute"
        style={{
          left: `${start}%`,
          width: `${width}%`,
          minWidth: "1px",
          top: `${top * rowH + topPad}px`,
          height: 0,
          zIndex: 6,
          pointerEvents: "none",
        }}
      >
        <div
          className={cn(
            "sticky left-0 inline-flex w-max items-center gap-1.5 px-1 py-[5px] select-none",
            canDrag ? "cursor-move" : "cursor-pointer",
            isDragging && "opacity-60"
          )}
          style={{
            transform: "translateY(calc(-100% - 1px))",
            maxWidth: "460px",
            pointerEvents: "auto",
            touchAction: canDrag ? "none" : undefined,
          }}
          onPointerDown={(e) => handlers.pointerDown(e, item)}
          onClick={(e) => handlers.click(e, item)}
          onDoubleClick={(e) => handlers.doubleClick(e, item)}
          onContextMenu={(e) => handlers.contextMenu(e, item)}
        >
          {isLocked && (
            <FaLock className="shrink-0 text-fg-secondary text-[9px]" aria-hidden />
          )}
          <span
            className={cn("truncate font-medium text-white", compactItems ? "text-[11px]" : "text-sm")}
            style={{ textShadow: "0 1px 2px rgb(0 0 0 / 0.85)", maxWidth: `${labelMaxPx}px` }}
          >
            {item.name}
          </span>
          {showZoneCue && (
            <span className="shrink-0 rounded-xs bg-white/80 border border-white/40 px-1 py-px text-[10px] font-semibold leading-none text-black shadow-e2 whitespace-nowrap">
              {receiverLabels?.[item.zone] || item.zone}:{item.target}
            </span>
          )}
          {showStartTime && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-xs border border-white/20 bg-emerald-600 px-1 py-px text-[10px] font-semibold leading-none text-white shadow-e2 whitespace-nowrap">
              <span className="inline-flex items-center justify-center h-2.5 w-2 text-[8px] leading-none">▶</span>
              <span className="leading-none">{formatClock(num(item.startTime))}</span>
            </span>
          )}
          {showEndTime && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-xs border border-white/20 bg-red-600 px-1 py-px text-[10px] font-semibold leading-none text-white shadow-e2 whitespace-nowrap">
              <span className="inline-flex items-center justify-center h-2.5 w-2 text-[8px] leading-none -translate-y-px">■</span>
              <span className="leading-none">{formatClock(num(item.startTime) + num(item.duration))}</span>
            </span>
          )}
          {Number.isFinite(item.multiple) && item.multiple > 1 && (
            <span className="shrink-0 px-1 text-[10px] font-mono leading-none bg-surface-base/85 text-fg-primary rounded-sm whitespace-nowrap">
              ×{item.multiple}
            </span>
          )}
          {/* Delete affordance -- always visible. Stops propagation so it
              neither starts a drag nor selects the cue; handlers.delete runs the
              destructive-confirm dialog before removing. */}
          {!isReadOnly && (
            <button
              type="button"
              title="Remove item"
              aria-label="Remove item"
              className="shrink-0 inline-flex items-center justify-center h-4 w-4 rounded-xs leading-none text-white/80 bg-black/40 hover:bg-danger hover:text-danger-fg transition-colors"
              style={{ cursor: "pointer" }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                handlers.delete(item);
              }}
            >
              <FiX className="text-[11px]" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* Main bar -- always spans the cue's duration. */}
      <div
        className={cn(
          "absolute overflow-hidden rounded-sm transition-shadow select-none",
          canDrag ? "cursor-move" : "cursor-pointer",
          isDragging
            ? "opacity-60 ring-2 ring-accent shadow-e3"
            : isLocked
            ? "ring-2 ring-danger shadow-e2"
            : isSelected
            ? "ring-2 ring-accent ring-offset-1 ring-offset-surface-inset"
            : "shadow-e2"
        )}
        style={{
          left: `${start}%`,
          width: hasNoLength ? "max-content" : `${width}%`,
          height: `${barH}px`,
          zIndex: isDragging ? 30 : undefined,
          minWidth: "14px",
          top: `${top * rowH + topPad}px`,
          backgroundColor: color + "80",
          backgroundImage: hasNoLength
            ? "repeating-linear-gradient(45deg, rgba(255,255,255,0) 0, rgba(255,255,255,0) 7px, rgba(255,255,255,0.1) 7px, rgba(255,255,255,0.1) 14px)"
            : undefined,
          borderLeft: `2px solid ${color}`,
          touchAction: canDrag ? "none" : undefined,
        }}
        onPointerDown={(e) => handlers.pointerDown(e, item)}
        onClick={(e) => handlers.click(e, item)}
        onDoubleClick={(e) => handlers.doubleClick(e, item)}
        onContextMenu={(e) => handlers.contextMenu(e, item)}
        onMouseEnter={(e) => handlers.mouseEnter(e, item)}
        onMouseMove={(e) => handlers.mouseMove(e, item)}
        onMouseLeave={() => handlers.mouseLeave()}
      >
        <div className="flex items-center gap-1 h-full pl-1.5 pr-3 pointer-events-none overflow-hidden">
          {hasNoLength ? (
            <>
              <FiZap
                className="shrink-0 text-white text-[11px]"
                style={{ filter: "drop-shadow(0 1px 1px rgb(0 0 0 / 0.7))" }}
                aria-hidden
                title="No length defined"
              />
              <span className="truncate text-white text-[10px] italic" style={{ textShadow: "0 1px 1px rgb(0 0 0 / 0.75)" }}>
                unknown length
              </span>
            </>
          ) : (
            <span className="truncate font-mono text-white text-[10px]" style={{ textShadow: "0 1px 1px rgb(0 0 0 / 0.75)" }}>
              {fmtDuration(item.duration)}
            </span>
          )}
        </div>
      </div>

      {/* Vertical black separators for FUSED_LINE step boundaries */}
      {fusedLineStepBoundariesSec.map((boundarySec, bIdx) => {
        const boundaryLeftPct = calculatePosition(num(item.startTime) + boundarySec);
        return (
          <div
            key={`${item.id}-boundary-${bIdx}`}
            className="absolute pointer-events-none"
            style={{
              left: `${boundaryLeftPct}%`,
              top: `${top * rowH + topPad}px`,
              width: "0px",
              height: `${barH}px`,
              borderLeft: "2px solid #000",
              zIndex: 2,
            }}
          />
        );
      })}

      {/* Shot profile overlays - positioned as siblings to avoid affecting bar layout */}
      {shots.length > 0 && shots.map((shot, shotIndex) => {
        const shotStartSec = shot[0] / 1000;
        const shotEndSec = shot[1] / 1000;
        const shotDuration = shotEndSec - shotStartSec;
        const shotColor = shot.length >= 3 ? shot[2] : null;
        const shotLeft = calculatePosition(num(item.startTime) + shotStartSec);
        const shotWidth = (shotDuration / MAX_TIME) * 100;
        return (
          <div
            key={`${item.id}-shot-${shotIndex}`}
            className="absolute pointer-events-none"
            style={{
              left: `${shotLeft}%`,
              width: `${shotWidth}%`,
              top: `${top * rowH + topPad}px`,
              height: `${barH}px`,
              backgroundColor: "rgba(255, 255, 255, 0.4)",
              borderRadius: "2px",
              zIndex: 1,
            }}
          >
            {shotColor && (
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: "3px",
                  backgroundColor: shotColor,
                  borderRadius: "2px 2px 0 0",
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
});

const Timeline = memo((props) => {
  // Persisted UI prefs (zoom, scroll position, toolbar toggles) are namespaced
  // per view via the `persistKey` prop so the editor and the read-only console
  // keep independent state instead of stomping each other's localStorage. Falls
  // back to the legacy un-namespaced keys when no persistKey is given.
  const persistNs = props.persistKey ? `${props.persistKey}.` : "";
  const pkey = (name) => `byh.timeline.${persistNs}${name}`;
  // Debounced persist: wheel/pinch zoom mutates this continuously, and each
  // change would otherwise fire a synchronous localStorage write on the hot path.
  const [zoomStored, setZoomStored] = usePersistentState(pkey("zoom"), ZOOM_DEFAULT, { debounce: 300 }); // Zoom level (raw, persisted)
  // Read + write through clampZoom so an out-of-range stored value never reaches
  // rendering and no setter (wheel/pinch/buttons) can escape [ZOOM_MIN, ZOOM_MAX].
  // setZoom accepts a value or an updater, mirroring useState's setter.
  const zoom = clampZoom(zoomStored);
  const setZoom = (updater) =>
    setZoomStored((prev) =>
      clampZoom(typeof updater === "function" ? updater(clampZoom(prev)) : updater)
    );
  // Mirror of the zoom in a ref so the once-bound native touch listeners
  // (pinch-to-zoom) can read the current value without re-binding.
  const zoomRef = useRef(ZOOM_DEFAULT);
  zoomRef.current = zoom;
  const {items, setItems} = props; // Track item positions
  const timelineRef = useRef(null); // Reference to the timeline container
  const ticksRef = useRef(null); // Reference to the ticks container
  const isReadOnly = props.readOnly
  const [firingProfiles, setFiringProfiles] = useState({}); // Map of itemId -> firing profile
  const [inventory, setInventory] = useState([]); // Inventory for RACK_SHELLS calculations
  // Tracks the timestamp (ms) of the last copy-place click so a trailing
  // dblclick from the same gesture doesn't also pop the AddItemModal.
  const recentCopyPlaceRef = useRef(0);

  // Right-click context menu state. `null` when closed; otherwise
  // { x, y, item } for an item menu or { x, y, addTime } for the
  // background "add here" menu.
  const [ctxMenu, setCtxMenu] = useState(null);
  const closeCtxMenu = () => setCtxMenu(null);

  // "Swap with" flow: when set, the next item the operator clicks trades
  // start times with this source item. Mirrors the copy-item mode UX.
  const [swapSourceId, setSwapSourceId] = useState(null);

  // Toolbar toggle that swaps the wheel's default: normally the wheel pans
  // horizontally and Shift zooms; when "Scroll zoom" is on a bare wheel zooms
  // and Shift falls back to horizontal panning. Held in a ref too because the
  // wheel listener is a one-time native binding that would otherwise close
  // over a stale value.
  const [scrollZoom, setScrollZoom] = usePersistentState(pkey("scrollZoom"), false);
  const scrollZoomRef = useRef(false);
  scrollZoomRef.current = scrollZoom;

  // Close the context menu on any outside interaction / Escape, and cancel a
  // pending swap on Escape.
  useEffect(() => {
    if (!ctxMenu && swapSourceId == null) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        closeCtxMenu();
        setSwapSourceId(null);
      }
    };
    const onDown = () => closeCtxMenu();
    window.addEventListener("keydown", onKey);
    // Bubble-phase: a mousedown inside the menu calls stopPropagation (see the
    // menu's onMouseDown), which stops the native event before it reaches
    // window, so the button's onClick still runs. Any other click closes.
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onDown, true);
    };
  }, [ctxMenu, swapSourceId]);

  // Parse a "m:ss(.ss)" or bare-seconds string into seconds. Returns null on
  // empty / unparseable / negative input so callers can bail cleanly.
  const parseClock = (str) => {
    if (str == null) return null;
    const s = String(str).trim();
    if (s === "") return null;
    let sec;
    if (s.includes(":")) {
      const parts = s.split(":");
      if (parts.length !== 2) return null;
      const m = Number(parts[0]);
      const ss = Number(parts[1]);
      if (!Number.isFinite(m) || !Number.isFinite(ss)) return null;
      sec = m * 60 + ss;
    } else {
      sec = Number(s);
    }
    if (!Number.isFinite(sec) || sec < 0) return null;
    return sec;
  };

  // ---- Context-menu actions ------------------------------------------------

  const openItemContextMenu = (e, item) => {
    if (isReadOnly || props.copyMode) return;
    e.preventDefault();
    e.stopPropagation();
    clearTooltip();
    setSwapSourceId(null);
    setCtxMenu({ x: e.clientX, y: e.clientY, item });
  };

  const openBackgroundContextMenu = (e) => {
    if (isReadOnly || props.copyMode) return;
    // Item bars stopPropagation in their own onContextMenu, so anything that
    // reaches here is the timeline surface / grid → offer "add here".
    e.preventDefault();
    const el = timelineRef.current;
    if (!el) return;
    const clickX = e.clientX - el.getBoundingClientRect().left + el.scrollLeft;
    const time = (clickX / el.scrollWidth) * maxTime;
    setCtxMenu({ x: e.clientX, y: e.clientY, addTime: Math.max(0, time) });
  };

  const handleAddHere = () => {
    const t = ctxMenu?.addTime ?? 0;
    closeCtxMenu();
    props.openAddModal?.(t);
  };

  const handleMenuEdit = (item) => {
    closeCtxMenu();
    props.openEditModal?.(item);
  };

  const handleMenuDelete = async (item) => {
    closeCtxMenu();
    if (props.onItemDelete) {
      props.onItemDelete(item);
      return;
    }
    if (await asyncConfirm({ message: `Remove "${item.name}" from the show?`, destructive: true })) {
      setItems((prev) => prev.filter((it) => it.id !== item.id));
    }
  };

  const handleStartAt = async (item) => {
    closeCtxMenu();
    if (item.locked) return; // locked cues don't move (the menu item is disabled too)
    const input = await asyncPrompt({
      title: "Set start time",
      message: `When should "${item.name}" start? (m:ss or seconds)`,
      defaultValue: formatClock(num(item.startTime)),
      placeholder: "0:00.00",
    });
    const sec = parseClock(input);
    if (sec == null) return;
    // Keep the cue on-screen: clamp so it can't be pushed past the timeline end.
    const start = Math.max(0, Math.min(sec, maxTime - num(item.duration)));
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, startTime: start } : it)));
  };

  const handleEndAt = async (item) => {
    closeCtxMenu();
    if (item.locked) return; // locked cues don't move (the menu item is disabled too)
    const dur = num(item.duration);
    const input = await asyncPrompt({
      title: "Set end time",
      message: `When should "${item.name}" end? (m:ss or seconds)`,
      defaultValue: formatClock(num(item.startTime) + dur),
      placeholder: "0:00.00",
    });
    const endSec = parseClock(input);
    if (endSec == null) return;
    // Clamp to [0, maxTime - dur] so the cue stays within the timeline bounds.
    const newStart = Math.max(0, Math.min(endSec - dur, maxTime - dur));
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, startTime: newStart } : it)));
  };

  const handleSwapStart = (item) => {
    closeCtxMenu();
    if (item.locked) return; // can't swap a locked cue's time (the menu item is disabled too)
    setSwapSourceId(item.id);
  };

  const handleMenuCopy = (item) => {
    closeCtxMenu();
    props.onCopyItem?.(item);
  };

  const handleToggleLock = (item) => {
    closeCtxMenu();
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, locked: !it.locked } : it)));
  };

  // ---- Hover tooltip (start/end time) --------------------------------------
  // Shows an item's start + end time, but only after the pointer has been
  // still over it for 1s. Any movement re-arms the 1s timer and hides an
  // already-visible tip, so it never trails a moving cursor.
  const [tooltip, setTooltip] = useState(null); // { x, y, item } | null
  const tooltipTimerRef = useRef(null);

  const scheduleTooltip = (e, item) => {
    // Never show the hover tooltip while a drag gesture is in flight.
    if (dragRef.current) return;
    const x = e.clientX;
    const y = e.clientY;
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    // Hide while moving. Functional update returns the same value when already
    // hidden so React bails out and we don't re-render on every mousemove.
    setTooltip((t) => (t ? null : t));
    tooltipTimerRef.current = setTimeout(() => {
      setTooltip({ x, y, item });
    }, 1000);
  };

  const clearTooltip = () => {
    if (tooltipTimerRef.current) {
      clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
    setTooltip((t) => (t ? null : t));
  };

  // Drop any pending tooltip timer on unmount.
  useEffect(() => () => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
  }, []);

  // ---- Pointer-based (video-editor style) cue dragging --------------------
  // Cues follow the cursor live while held, constrained to the timeline. This
  // replaces native HTML5 drag for MOVING items. `dragRef` holds the in-flight
  // gesture; `draggingId` drives the "ghost" styling on the dragged cue.
  const dragRef = useRef(null);
  // Last snapped start committed during the current drag. Lets us skip the
  // setItems (and the whole-timeline re-render it triggers) when consecutive
  // pointermoves resolve to the same grid position — the cause of "snap lag".
  const lastDragBaseRef = useRef(null);
  const [draggingId, setDraggingId] = useState(null);
  // Live drag position, held LOCALLY so a drag doesn't push to the parent's
  // `items` on every pointermove — that used to re-render the whole builder
  // (show stats, target grid, spatial map, …) 60×/s. During a drag we render
  // from `effectiveItems` (items + this override) and only commit the final
  // positions to the parent once, on pointerup. `null` when not dragging;
  // otherwise `{ base }` — the dragged cue's snapped start (multi-drag derives
  // every other selected cue's start from it via the delta, see effectiveItems).
  const [dragOverride, setDragOverride] = useState(null);
  // Horizontal scroll position as a % of the inner content width. Drives the
  // "sticky" cue labels so they stay visible while any of a cue is on screen.
  const [viewLeftPct, setViewLeftPct] = useState(0);
  const [innerWidthPx, setInnerWidthPx] = useState(1);
  // The body's content-box width (clientWidth, i.e. excluding any vertical
  // scrollbar). The body inner div is `100*zoom%` of this; the ruler (which has
  // no scrollbar) is sized to `bodyContentWidth * zoom` px to match it exactly,
  // so the ruler ticks stay aligned with the body gridlines. 0 until measured.
  const [bodyContentWidth, setBodyContentWidth] = useState(0);
  // Visible viewport width as a % of the inner content width. Together with
  // viewLeftPct this defines the on-screen time window, which we use to
  // virtualize the ruler ticks and beat grid (only render what's near view).
  // Defaults to 100 so the very first paint — before we've measured the
  // container — renders everything rather than a blank grid; the mount/scroll
  // updates narrow it immediately.
  const [viewWidthPct, setViewWidthPct] = useState(100);
  const scrollRafRef = useRef(0);
  // When on, the view auto-scrolls to keep the playhead framed during
  // playback. A manual horizontal scroll turns it off (see handleScroll).
  const [followPlayhead, setFollowPlayhead] = usePersistentState(pkey("followPlayhead"), true);
  // Timestamp of the last scroll we performed ourselves (auto-frame / restore),
  // so handleScroll can tell an operator's scroll apart from a programmatic one
  // and not disable follow on our own scrolls.
  const programmaticScrollRef = useRef(0);
  // Last observed scrollLeft, to detect whether a scroll event moved the view
  // horizontally (vertical-only scrolls shouldn't disable follow).
  const lastScrollLeftRef = useRef(0);
  // Debounce timer for persisting the scroll location. Writing localStorage on
  // every scroll frame is a synchronous main-thread write on the hot path; we
  // only need the final resting position, so coalesce to one write after idle.
  const scrollPersistTimerRef = useRef(0);
  const updateViewLeft = () => {
    const el = timelineRef.current;
    if (!el) return;
    const w = el.scrollWidth || 1;
    setViewLeftPct((el.scrollLeft / w) * 100);
    setInnerWidthPx(w);
    setViewWidthPct((el.clientWidth / w) * 100);
    setBodyContentWidth(el.clientWidth);
    // Persist the horizontal scroll location as a FRACTION of the content width
    // (not absolute px), so it restores to the right time even when reopened at a
    // different viewport width or zoom (content width = bodyContentWidth * zoom).
    const frac = el.scrollLeft / w;
    if (scrollPersistTimerRef.current) clearTimeout(scrollPersistTimerRef.current);
    scrollPersistTimerRef.current = setTimeout(() => {
      try {
        window.localStorage.setItem(pkey("scrollFrac"), String(frac));
      } catch {
        /* ignore */
      }
    }, 250);
  };

  // Restore the saved scroll location once, after first layout (zoom is
  // already restored via persistent state, so the content width is correct).
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    try {
      const raw = window.localStorage.getItem(pkey("scrollFrac"));
      const frac = raw != null ? Number(raw) : NaN;
      if (Number.isFinite(frac) && frac > 0) {
        programmaticScrollRef.current = Date.now();
        el.scrollLeft = frac * (el.scrollWidth || 0);
      }
    } catch {
      /* ignore */
    }
    lastScrollLeftRef.current = el.scrollLeft;
    updateViewLeft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Set after a real drag so the trailing click doesn't also select/clear.
  const suppressNextClickRef = useRef(false);

  // Convert an absolute clientX to a show time (seconds) on the timeline.
  const clientXToShowTime = (clientX) => {
    const el = timelineRef.current;
    if (!el) return 0;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    const w = el.scrollWidth || 1;
    return (x / w) * maxTime;
  };

  const onItemPointerMove = (e) => {
    const d = dragRef.current;
    if (!d || d.locked) return;
    // Small threshold so a plain click still selects instead of nudging.
    if (!d.moved && Math.abs(e.clientX - d.startX) < 3) return;
    d.moved = true;
    if (draggingId !== d.id) setDraggingId(d.id);
    clearTooltip();
    const rawStart = clientXToShowTime(e.clientX) - d.grabOffset;
    let base = Math.max(0, rawStart);
    // Snap follows the active grid mode, matching the toolbar (which only shows
    // the seconds-snap dropdown in seconds mode and the beat toggle in beats
    // mode). In beats mode we snap to beat only — the persisted `snapSeconds`
    // from seconds mode is ignored so it can't override beat snapping. Hold Alt
    // to bypass either.
    if (!e.altKey) {
      if (useBeatsGrid) {
        if (snapToBeat) base = Math.max(0, snapTimeToBeat(base));
      } else if (snapSeconds > 0) {
        base = Math.max(0, Math.round(base / snapSeconds) * snapSeconds);
      }
    }
    // Keep the whole cue within the timeline bounds.
    base = Math.max(0, Math.min(base, maxTime - d.dur));
    // Nothing moved this frame (common while snapping across a grid cell): skip
    // the update so we don't re-render for zero visual change. Single- and
    // multi-drag both derive from `base`, so it's a sufficient key for either.
    if (lastDragBaseRef.current === base) return;
    lastDragBaseRef.current = base;
    // Local-only update: render moves via `effectiveItems`; the parent's
    // `items` is left untouched until drop (onItemPointerUp), so the rest of
    // the builder doesn't re-render on every frame of the drag.
    setDragOverride({ base });
  };

  // The exact handler instances attached at pointerdown. Handlers are recreated
  // every render, so we can't rely on the unmount cleanup's captured closures to
  // match what's on `window` — we remember and remove the real ones instead.
  const attachedDragRef = useRef(null);

  const detachDragListeners = () => {
    const a = attachedDragRef.current;
    if (!a) return;
    window.removeEventListener("pointermove", a.move);
    window.removeEventListener("pointerup", a.up);
    attachedDragRef.current = null;
  };

  const onItemPointerUp = (e) => {
    const d = dragRef.current;
    detachDragListeners();
    dragRef.current = null;
    setDraggingId(null);
    if (typeof document !== "undefined") document.body.style.userSelect = "";
    // Commit the drag to the parent ONCE, on drop — the mid-drag moves were
    // local (dragOverride) so the rest of the builder didn't re-render. Use the
    // same math effectiveItems used, keyed off the last snapped base, so the
    // committed positions exactly match what was on screen. Batched with the
    // clear below, so items lands at its final spot with no visual snap-back.
    if (d && d.moved && lastDragBaseRef.current != null) {
      const finalBase = lastDragBaseRef.current;
      const delta = finalBase - d.orig.get(d.id);
      setItems((prev) =>
        prev.map((it) => {
          if (d.isMulti) {
            if (!d.orig.has(it.id) || it.locked) return it;
            const nb = Math.max(0, Math.min(d.orig.get(it.id) + delta, maxTime - num(it.duration)));
            return { ...it, startTime: nb };
          }
          return it.id === d.id ? { ...it, startTime: finalBase } : it;
        })
      );
    }
    setDragOverride(null);
    // A real drag just moved the cue -- swallow the trailing click so it
    // doesn't also select/clear. Deletion now lives on the label's trash icon.
    if (d && d.moved) suppressNextClickRef.current = true;
  };

  const onItemPointerDown = (e, item) => {
    if (isReadOnly || props.copyMode || swapSourceId != null) return;
    if (e.button !== 0) return; // left button only
    if (item.locked) return;    // locked cues don't move
    const selected = props.selectedItems || [];
    const isMulti = selected.length > 1 && selected.some((s) => s.id === item.id);
    const orig = new Map();
    if (isMulti) selected.forEach((s) => orig.set(s.id, num(s.startTime)));
    orig.set(item.id, num(item.startTime));
    lastDragBaseRef.current = null; // fresh gesture — first move always commits
    dragRef.current = {
      id: item.id,
      isMulti,
      orig,
      grabOffset: clientXToShowTime(e.clientX) - num(item.startTime),
      dur: num(item.duration),
      locked: !!item.locked,
      startX: e.clientX,
      moved: false,
    };
    if (typeof document !== "undefined") document.body.style.userSelect = "none";
    // Tear down any listeners left by a still-in-flight prior gesture (e.g. a
    // second pointer going down before the first's pointerup — multi-touch /
    // pen+touch) so we never orphan the earlier handlers on window.
    detachDragListeners();
    // Remember the exact instances so pointerup / unmount remove these same ones.
    attachedDragRef.current = { move: onItemPointerMove, up: onItemPointerUp };
    window.addEventListener("pointermove", onItemPointerMove);
    window.addEventListener("pointerup", onItemPointerUp);
  };

  // Safety: tear down drag listeners if the component unmounts mid-gesture.
  useEffect(() => detachDragListeners, []);

  // Wheel-to-zoom is registered as a native, non-passive listener (see effect
  // below) because React attaches `onWheel` passively at the root, which makes
  // `preventDefault()` a no-op and lets the page scroll while zooming.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const onWheel = (e) => {
      const delta = e.deltaY || e.deltaX;
      e.preventDefault();
      e.stopPropagation();
      // Alt: vertical "virtual" scroll through the stacked rows, in any mode.
      if (e.altKey) {
        el.scrollTop += delta;
        return;
      }
      // Decide zoom vs. horizontal pan. Default: wheel pans, Shift zooms. When
      // "Scroll zoom" is on the roles swap, so a bare wheel zooms and Shift
      // ignores that to fall back to horizontal panning.
      const shouldZoom = scrollZoomRef.current ? !e.shiftKey : e.shiftKey;
      if (shouldZoom) {
        setZoom((prevZoom) => Math.max(0.1, prevZoom - e.deltaY * (prevZoom * 0.001)));
      } else {
        el.scrollLeft += delta;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Pinch-to-zoom for touch (tablet/phone). Registered natively and
  // non-passive so a two-finger gesture can preventDefault the browser's page
  // zoom. One-finger touches are ignored here, so the container keeps its
  // native pan/scroll and single-finger cue dragging (pointer events) works.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    let startDist = 0;
    let startZoom = 0;
    const distOf = (touches) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.hypot(dx, dy);
    };
    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        startDist = distOf(e.touches);
        startZoom = zoomRef.current;
      }
    };
    const onTouchMove = (e) => {
      if (e.touches.length === 2 && startDist > 0) {
        e.preventDefault();
        const scale = distOf(e.touches) / startDist;
        setZoom(Math.max(0.1, Math.min(200, startZoom * scale)));
      }
    };
    const onTouchEnd = (e) => {
      if (e.touches.length < 2) startDist = 0;
    };
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  const handleZoomIn = () => {
    setZoom((prevZoom) => Math.min(200, prevZoom * 1.2));
  };

  const handleZoomOut = () => {
    setZoom((prevZoom) => Math.max(0.1, prevZoom / 1.2));
  };

  const handleTouchStart = (e) => {
    // Prevent default touch behavior to avoid window scrolling
    e.preventDefault();
  };

  const handleTouchMove = (e) => {
    // Prevent default touch behavior to avoid window scrolling
    e.preventDefault();
  };

  // formatClock / fmtDuration are module-level helpers (shared with TimelineItem).

  const handleItemDoubleClick = (e, item) => {
    if (isReadOnly) return;
    if (props.copyMode) return;
    // Stop the timeline-level dblclick (which opens the Add modal) from also
    // firing, and open the edit flow for this item instead.
    e.preventDefault();
    e.stopPropagation();
    props.openEditModal?.(item);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleTimeCursorClick = (e) => {
    const timelineOffset = timelineRef.current.scrollLeft;
    const clickX =
      e.clientX - timelineRef.current.getBoundingClientRect().left + timelineOffset;
    const timelineWidth = timelineRef.current.scrollWidth;
    const cursorTime = (clickX / timelineWidth) * 3600;
    if (props.setTimeCursor && isFinite(cursorTime) && cursorTime >= 0) {
      props.setTimeCursor(cursorTime);
    }
  }

  const handleTimelineClick = (e) => {
    // Swallow the click that trails a drag gesture.
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    // Copy Item flow: in 'select-position' mode a click anywhere on the
    // timeline (background or items) drops the duplicate at that time. Skip
    // the normal "clear selection / move time cursor" behavior.
    if (props.copyMode === "select-position") {
      const timelineOffset = timelineRef.current.scrollLeft;
      const clickX =
        e.clientX - timelineRef.current.getBoundingClientRect().left + timelineOffset;
      const timelineWidth = timelineRef.current.scrollWidth;
      const dropTime = (clickX / timelineWidth) * 3600;
      recentCopyPlaceRef.current = Date.now();
      props.onCopyPlaceClick?.(dropTime);
      return;
    }

    // If clicking on the timeline background (not on an item), clear selection
    if (e.target === e.currentTarget || e.target.className.includes('border-l')) {
      if (props.clearSelection) {
        props.clearSelection();
      }
    }
    
    // Handle time cursor if enabled
    if (props.setTimeCursor) {
      handleTimeCursorClick(e);
    }
  }

  const handleDoubleClick = (e) => {
    // Suppress the AddItemModal if this dblclick is the trailing pair of a
    // copy-place click that just landed.
    if (Date.now() - recentCopyPlaceRef.current < 500) return;

    const timelineOffset = timelineRef.current.scrollLeft;
    const clickX =
      e.clientX - timelineRef.current.getBoundingClientRect().left + timelineOffset;
    const timelineWidth = timelineRef.current.scrollWidth;
    const startTime = (clickX / timelineWidth) * 3600; // Convert position to time in seconds
    // Hold Shift while double-clicking to INSERT: the parent shifts every cue
    // at/after this time back by the new item's duration, making room for it.
    props.openAddModal(startTime, { insert: e.shiftKey });
  };

  const handleDrop = (e) => {
    e.preventDefault();

    // Placing a NEW cue from the inventory list (see InventoryTab). Its drag
    // payload carries `newInventoryId` rather than a timeline item `id`; drop
    // it at the absolute time under the cursor and let the parent open the
    // add flow pre-seeded with that inventory item.
    const newInvId = e.dataTransfer.getData("newInventoryId");
    if (newInvId) {
      const el = timelineRef.current;
      if (el) {
        const dropX = e.clientX - el.getBoundingClientRect().left + el.scrollLeft;
        const dropTime = Math.max(0, (dropX / el.scrollWidth) * maxTime);
        props.onDropInventory?.(parseInt(newInvId, 10), dropTime);
      }
      return;
    }
    // Moving existing cues is handled by the pointer-drag path
    // (onItemPointerDown/Move/Up); the timeline only accepts inventory drops.
  };

  const handleScroll = (e) => {
    // Sync the scroll position of the ticks container with the timeline
    if (ticksRef.current) {
      ticksRef.current.scrollLeft = e.target.scrollLeft;
    }
    // A manual horizontal scroll turns off playhead-follow. Ignore our own
    // programmatic scrolls (auto-frame / restore) and vertical-only scrolls.
    const sl = e.target.scrollLeft;
    const movedX = sl !== lastScrollLeftRef.current;
    lastScrollLeftRef.current = sl;
    if (
      followPlayhead &&
      movedX &&
      Date.now() - programmaticScrollRef.current > 150
    ) {
      setFollowPlayhead(false);
    }
    // Update the sticky-label anchor, throttled to one update per frame.
    if (!scrollRafRef.current) {
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = 0;
        updateViewLeft();
      });
    }
  };

  // Recompute measured widths / scroll position when the zoom changes, once on
  // mount, and when `items` changes (adding/removing cues can toggle the body's
  // vertical scrollbar, which changes its content width and thus the ruler↔body
  // tick alignment).
  useEffect(() => {
    updateViewLeft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, items]);

  useEffect(() => () => {
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    if (scrollPersistTimerRef.current) clearTimeout(scrollPersistTimerRef.current);
  }, []);

  const maxTime = MAX_TIME; // Maximum time (1 hour in seconds)

  // Auto-frame the playhead while time advances. We DON'T smooth-scroll
  // every frame -- that fights manual scroll and burns layout work at
  // 10Hz. Instead we only re-frame when the cursor leaves the viewport,
  // jumping the scroll so the cursor lands ~10% from the left edge.
  // This costs one scrollLeft assignment per "page-flip" of playback.
  useEffect(() => {
    if (!followPlayhead) return;
    const el = timelineRef.current;
    if (!el) return;
    const t = props.timeCursor;
    if (!Number.isFinite(t) || t < 0) return;
    const w = el.scrollWidth;
    if (w <= 0) return;
    const cursorPx = (t / maxTime) * w;
    const view = el.clientWidth;
    if (view <= 0) return;
    const left = el.scrollLeft;
    const right = left + view;
    if (cursorPx < left || cursorPx > right) {
      programmaticScrollRef.current = Date.now();
      el.scrollLeft = Math.max(0, cursorPx - view * 0.1);
    }
  }, [props.timeCursor, zoom, followPlayhead]);

  const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return minutes > 0
      ? `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`
      : `${seconds}`;
  };

  // num() / calculatePosition() are module-level helpers (shared with
  // TimelineItem); num() coerces string/undefined startTime|duration so the
  // stacking overlap math depends on values, not the payload's JS types.

  // Apply the in-flight drag override to `items` for rendering. Returns `items`
  // unchanged when nothing is being dragged (zero cost off the drag path).
  // During a drag it clones only the affected cues — the dragged one, or every
  // selected+unlocked cue for a multi-drag — matching exactly what the old
  // per-move setItems produced; the commit on drop (onItemPointerUp) uses the
  // identical math. Defined here (after `num`/`maxTime`) so it can reference
  // them; the render + stacking read this instead of `items`.
  const effectiveItems = useMemo(() => {
    const d = dragRef.current;
    if (!dragOverride || !d) return items;
    const base = dragOverride.base;
    const delta = base - d.orig.get(d.id);
    return items.map((it) => {
      if (d.isMulti) {
        if (!d.orig.has(it.id) || it.locked) return it;
        const nb = Math.max(0, Math.min(d.orig.get(it.id) + delta, maxTime - num(it.duration)));
        return { ...it, startTime: nb };
      }
      return it.id === d.id ? { ...it, startTime: base } : it;
    });
    // dragRef is a ref (stable across the gesture); dragOverride drives updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, dragOverride]);

  // Lane-stacking layout. Memoised on the inputs it actually depends on
  // (`effectiveItems` — items plus any live drag override — and the content
  // width that sets the no-length cue allowance) so it doesn't re-run on
  // unrelated re-renders (playhead ticks, hover, selection). Using
  // effectiveItems means cues re-lane live as one is dragged over them, without
  // touching the parent's `items`. Also returns a per-item row index so the
  // render loop reads `top` in O(1) instead of an O(n²) findIndex/includes scan.
  const { stackedItems, rowOf } = useMemo(() => {
    // No-length cues render at a fixed pixel width (their "unknown length"
    // box), not a real duration. Give them an effective duration matching that
    // pixel width so the stacker keeps them from overlapping neighbouring cues.
    const noLenSec = innerWidthPx > 0 ? Math.min(maxTime, (150 * maxTime) / innerWidthPx) : 5;
    const effDur = (it) => {
      const d = num(it.duration);
      return d > 0 ? d : noLenSec;
    };
    const stacks = [];
    const rows = new Map();
    effectiveItems.forEach((item) => {
      const start = num(item.startTime);
      const dur = effDur(item);
      let overlapIndex = 0;
      for (let i = 0; i < stacks.length; i++) {
        if (
          !stacks[i].some((other) => {
            const oStart = num(other.startTime);
            const oDur = effDur(other);
            return start < oStart + oDur && start + dur > oStart;
          })
        ) {
          overlapIndex = i;
          break;
        }
        overlapIndex = stacks.length; // New stack
      }
      if (!stacks[overlapIndex]) stacks[overlapIndex] = [];
      stacks[overlapIndex].push(item);
      rows.set(item.id, overlapIndex);
    });
    return { stackedItems: stacks, rowOf: rows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveItems, innerWidthPx]);

  // cakeTypesWithFiringProfiles is a module-level helper (shared with computeShots).

  // Fetch firing profiles for cakes that use shot profiles. Also walks
  // FUSED_LINE steps so cake steps inside a fused line render shot overlays.
  useEffect(() => {
    const fetchFiringProfiles = async () => {
      const profiles = {};
      const itemIds = new Set();
      items.forEach((item) => {
        if (cakeTypesWithFiringProfiles(item.type) && item.itemId) {
          itemIds.add(item.itemId);
        }
        if (item.type === "FUSED_LINE" && Array.isArray(item.steps)) {
          item.steps.forEach((step) => {
            if (cakeTypesWithFiringProfiles(step.type) && step.itemId) {
              itemIds.add(step.itemId);
            }
          });
        }
      });

      const promises = Array.from(itemIds).map(async (itemId) => {
        try {
          const response = await axios.get(`/api/inventory/${itemId}/firing-profile`);
          if (response.data) {
            profiles[itemId] = response.data;
          }
        } catch (error) {
          // Profile doesn't exist for this item, which is fine
          if (error.response?.status !== 404) {
            console.error(`Error fetching firing profile for item ${itemId}:`, error);
          }
        }
      });

      await Promise.all(promises);
      setFiringProfiles(profiles);
    };

    if (items.length > 0) {
      fetchFiringProfiles();
    }
  }, [items]);

  // Fetch inventory if we have RACK_SHELLS items
  useEffect(() => {
    const hasRackShells = items.some(item => item.type === 'RACK_SHELLS');
    if (hasRackShells && inventory.length === 0) {
      const fetchInventory = async () => {
        try {
          const response = await axios.get('/api/inventory');
          setInventory(response.data || []);
        } catch (error) {
          console.error('Failed to fetch inventory for RACK_SHELLS:', error);
        }
      };
      fetchInventory();
    }
  }, [items, inventory.length]);

  // Major/minor tick hierarchy. The previous implementation drew a single
  // dense grid which created the "visual vibration" called out in the brief.
  // Now we render minor ticks faintly (or not at all at low zooms) and
  // major ticks slightly stronger with labels.
  const tickConfig = (() => {
    if (zoom >= 200) return { minor: 0.5, major: 5  };
    if (zoom >= 40)  return { minor: 1,   major: 10 };
    if (zoom >= 3)   return { minor: 10,  major: 60 };
    return                  { minor: 60,  major: 300 };
  })();
  const tickInterval = tickConfig.minor;

  // ---- Viewport virtualization --------------------------------------------
  // The timeline spans a full hour, but only a sliver is on-screen at any zoom.
  // Rendering every ruler tick / beat gridline across the whole hour created
  // thousands of off-screen DOM nodes (≈7,200 minor ticks at max zoom, plus the
  // beat grid). We derive the visible time window from the scroll position and
  // render only what falls inside it, padded by ~one viewport width on each side
  // so a fast scroll never reveals ungenerated gridlines before the next frame.
  const visStartTime = (Math.max(0, viewLeftPct - viewWidthPct) / 100) * maxTime;
  const visEndTime = (Math.min(100, viewLeftPct + viewWidthPct * 2) / 100) * maxTime;

  const handleItemClick = (e, item) => {
    if (isReadOnly) return;

    // Swallow the click that trails a drag gesture so it doesn't re-select or
    // clear the selection / move the time cursor.
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      e.stopPropagation();
      return;
    }

    // Swap flow: an item was armed via the "Swap with…" context-menu action;
    // the next item clicked exchanges start times with it.
    if (swapSourceId != null) {
      e.preventDefault();
      e.stopPropagation();
      const srcId = swapSourceId;
      setSwapSourceId(null);
      if (item.id === srcId) return;
      setItems((prev) => {
        const src = prev.find((i) => i.id === srcId);
        const tgt = prev.find((i) => i.id === item.id);
        // Never move a locked cue, even as the swap target.
        if (!src || !tgt || src.locked || tgt.locked) return prev;
        return prev.map((i) => {
          if (i.id === srcId) return { ...i, startTime: tgt.startTime };
          if (i.id === item.id) return { ...i, startTime: src.startTime };
          return i;
        });
      });
      return;
    }

    // Copy Item flow: in 'select-source' mode an item click picks the source
    // to duplicate. Swallow the event so we don't also single-select / clear.
    if (props.copyMode === "select-source") {
      e.preventDefault();
      e.stopPropagation();
      props.onCopySourceClick?.(item);
      return;
    }

    // In 'select-position' mode, defer entirely to the timeline-level handler
    // so we don't also single-select the item the user clicked through.
    if (props.copyMode === "select-position") {
      return;
    }

    const isCommandClick = e.metaKey || e.ctrlKey; // Command on Mac, Ctrl on Windows/Linux
    
    if (isCommandClick) {
      // Multi-select mode
      e.preventDefault();
      e.stopPropagation();
      props.onItemSelect?.(item, true);
    } else {
      // Single select mode
      props.setSelectedItem?.(item);
      // Clear multi-selection when single clicking
      if (props.clearSelection) {
        props.clearSelection();
      }
    }
  };

  // Minor ticks are drawn very faintly; major ticks are slightly stronger
  // with labels. The first major label always renders, subsequent labels
  // only render at multiples of `tickConfig.major` so we don't have label
  // pile-ups at low zoom.
  const tickCount = Math.ceil(maxTime / tickInterval) + 1;

  // Only the tick indices inside the visible window (see visStartTime/End).
  // Both the ruler and body iterate this instead of all `tickCount` ticks.
  const visibleTickIdxs = [];
  {
    const first = Math.max(0, Math.floor(visStartTime / tickInterval));
    const last = Math.min(tickCount - 1, Math.ceil(visEndTime / tickInterval));
    for (let i = first; i <= last; i++) visibleTickIdxs.push(i);
  }

  // Beat grid derived from each track's per-song BPM. Tracks play
  // sequentially with no gap, so each track's beats are anchored at its
  // cumulative start time within the show. We accept either the new
  // `audioTracks` array prop or the legacy single-bpm props (synthesising
  // a one-element tracks array) so older Timeline consumers keep working
  // until they're migrated.
  const audioTracks = useMemo(() => {
    if (Array.isArray(props.audioTracks)) return props.audioTracks;
    if (props.bpm && props.bpm > 0) {
      return [
        {
          id: "_legacy",
          url: null,
          name: "audio",
          bpm: props.bpm,
          firstBeatOffsetSec: props.firstBeatOffsetSec || 0,
          beatsPerMeasure: props.beatsPerMeasure || 4,
          durationSec: Number.isFinite(props.audioDurationSec)
            ? props.audioDurationSec
            : null,
        },
      ];
    }
    return [];
  }, [
    props.audioTracks,
    props.bpm,
    props.firstBeatOffsetSec,
    props.beatsPerMeasure,
    props.audioDurationSec,
  ]);

  const hasBeats = anyTrackHasBpm(audioTracks);
  const totalAudioDur = useMemo(
    () => totalShowAudioDuration(audioTracks),
    [audioTracks]
  );
  const beatGridMaxSec = useMemo(() => {
    const cap = Number.isFinite(props.audioDurationSec) && props.audioDurationSec > 0
      ? props.audioDurationSec
      : totalAudioDur;
    return cap > 0 ? Math.min(cap, maxTime) : maxTime;
  }, [props.audioDurationSec, totalAudioDur]);

  const beatGrid = useMemo(() => {
    if (!hasBeats) return [];
    return generateMultiTrackBeatGrid({
      tracks: audioTracks,
      maxTimeSec: beatGridMaxSec,
    });
  }, [hasBeats, audioTracks, beatGridMaxSec]);

  // Grid mode toggle in the toolbar: "seconds" keeps the existing
  // mm:ss grid; "beats" replaces the second-grid with measure/beat
  // gridlines aligned to the song. Default to seconds, but flip to
  // beats automatically the first time bpm becomes available so a
  // freshly-detected song "lights up" the grid without an extra click.
  const [gridMode, setGridMode] = usePersistentState(pkey("gridMode"), "seconds");
  // Whether the operator has explicitly picked a grid mode from the toolbar.
  // Once set it's authoritative and persists across reloads, so the auto-adopt
  // below never stomps a saved preference.
  const [gridModeUserSet, setGridModeUserSet] = usePersistentState(pkey("gridModeUserSet"), false);
  useEffect(() => {
    // Auto-adopt beats the first time a BPM becomes available, but only for an
    // operator who hasn't chosen a mode themselves -- so a freshly-detected
    // song lights up the grid without overriding a persisted choice. When no
    // BPM is present, useBeatsGrid already falls back to the seconds grid, so
    // there's no need to force gridMode back.
    if (!gridModeUserSet && hasBeats && gridMode !== "beats") {
      setGridMode("beats");
    }
  }, [hasBeats, gridModeUserSet]); // eslint-disable-line react-hooks/exhaustive-deps

  const useBeatsGrid = gridMode === "beats" && hasBeats;

  // Beats inside the visible window only (see visStartTime/End) — the ruler and
  // body map this instead of the full-hour beat grid, which can run to
  // thousands of gridlines.
  const visibleBeats = useBeatsGrid
    ? beatGrid.filter((b) => b.t >= visStartTime && b.t <= visEndTime)
    : [];

  // Density culling for the beat grid. Driven by the *loosest* track --
  // the one with the slowest tempo (largest beat period, most px per
  // beat). Picking the loosest gives every track the same visual
  // treatment: as long as any track is wide enough to show off-beats /
  // measure labels at this zoom, all tracks do. (If we used a per-track
  // threshold a faster auto-detected track would silently lose its
  // off-beats and measure numbers, which made non-first songs look
  // visually different from the first.)
  const loosestBeatPeriodSec = useMemo(() => {
    let max = 0;
    for (const t of audioTracks) {
      if (t?.bpm && t.bpm > 0) max = Math.max(max, 60 / t.bpm);
    }
    return max;
  }, [audioTracks]);
  const beatsPerMeasureRef = useMemo(() => {
    // Use the largest beatsPerMeasure across tracks so the densest-
    // measure case drives the label stride; anything smaller will then
    // certainly fit too.
    let max = 4;
    for (const t of audioTracks) {
      if (t?.beatsPerMeasure && t.beatsPerMeasure > max) max = t.beatsPerMeasure;
    }
    return max;
  }, [audioTracks]);
  const approxPxPerBeat = useMemo(() => {
    if (!useBeatsGrid || !loosestBeatPeriodSec) return 0;
    const refPx = 1000 * zoom;
    return (loosestBeatPeriodSec / maxTime) * refPx;
  }, [useBeatsGrid, loosestBeatPeriodSec, zoom]);
  const showOffBeats = useBeatsGrid && approxPxPerBeat >= 6;
  const showMeasureLabels =
    useBeatsGrid && approxPxPerBeat * beatsPerMeasureRef >= 28;
  const measureLabelStride = useMemo(() => {
    if (!showMeasureLabels) return 1;
    const measurePx = approxPxPerBeat * beatsPerMeasureRef;
    if (measurePx >= 80) return 1;
    if (measurePx >= 40) return 2;
    if (measurePx >= 28) return 4;
    return 8;
  }, [showMeasureLabels, approxPxPerBeat, beatsPerMeasureRef]);
  const isOffBeatVisible = () => showOffBeats;
  const isMeasureLabelVisible = (b) => {
    if (!b.downbeat || b.measure == null) return false;
    if (!showMeasureLabels) return false;
    return (b.measure - 1) % measureLabelStride === 0;
  };

  // Snap-to-beat for drag/drop. Only meaningful in beats mode; held in
  // local state so it persists across drag operations within a session.
  const [snapToBeat, setSnapToBeat] = usePersistentState(pkey("snapToBeat"), false);

  // Toolbar toggle: when on, each item's label includes the zone:cue
  // badge (e.g. "RX142:1"). Defaults off so the timeline reads cleaner;
  // operators flip it on when they need the routing at a glance.
  const [showZoneCue, setShowZoneCue] = usePersistentState(pkey("showZoneCue"), false);
  // Companion toggles that surface each cue's start and/or end clock on its
  // label, for quick timing readout without hovering.
  const [showStartTime, setShowStartTime] = usePersistentState(pkey("showStartTime"), false);
  const [showEndTime, setShowEndTime] = usePersistentState(pkey("showEndTime"), false);
  // Compact (default) vs taller item bars. Taller bars give the label more
  // vertical breathing room; the row pitch grows with the bar so stacked
  // cues don't overlap.
  const [compactItems, setCompactItems] = usePersistentState(pkey("compactItems"), true);
  const barH = compactItems ? 24 : 62;
  // Approx height the floating label row occupies above the bar (its content
  // height + the 4px transform gap). Used to derive an even ~5px gap between
  // stacked items.
  const labelExtent = compactItems ? 29 : 36;
  const rowGap = 5; // even padding above the label and below the bar
  const rowH = barH + labelExtent + rowGap * 2;
  const topPad = labelExtent + rowGap;
  // Full height of all stacked rows. Drives the inner content div's minHeight
  // so the body can scroll vertically ("virtual scroll") once the rows exceed
  // the viewport, and so the gridlines / time cursor (which pin to the inner
  // div via bottom-0) extend down to the last row instead of stopping at the
  // viewport edge.
  const contentMinHeight = stackedItems.length * rowH + topPad + rowGap;
  // Time-grid snap for dragging cues (seconds; 0 = off). Independent of the
  // beat-snap toggle. Hold Alt while dragging to bypass.
  const [snapSeconds, setSnapSeconds] = usePersistentState(pkey("snapSeconds"), 0);
  const SNAP_OPTIONS = [
    { v: 0, label: "Off" },
    { v: 0.5, label: "½ sec" },
    { v: 1, label: "1 sec" },
    { v: 2, label: "2 sec" },
    { v: 3, label: "3 sec" },
    { v: 4, label: "4 sec" },
    { v: 5, label: "5 sec" },
    { v: 10, label: "10 sec" },
    { v: 15, label: "15 sec" },
    { v: 30, label: "30 sec" },
    { v: 60, label: "1 min" },
  ];

  // Quantise an absolute timeline time (seconds) to the nearest beat in
  // whichever track contains that time. Returns the input unchanged
  // when the grid isn't on or no track at that position has BPM set.
  const snapTimeToBeat = (sec) => {
    if (!useBeatsGrid || !snapToBeat) return sec;
    return snapShowTimeToBeat(audioTracks, sec);
  };

  // Stable event bridge for the memoised <TimelineItem>s. The per-cue handlers
  // close over lots of state, so passing them directly (fresh each render)
  // would defeat the item memo. Instead we keep the latest implementations in a
  // ref (updated every render, like zoomRef above) and hand each item ONE
  // stable object of thin dispatchers — so the item memo only re-renders on
  // real prop changes, not because a handler identity churned.
  const handlersRef = useRef(null);
  handlersRef.current = {
    onItemPointerDown,
    handleItemClick,
    handleItemDoubleClick,
    openItemContextMenu,
    scheduleTooltip,
    clearTooltip,
    handleMenuDelete,
  };
  const itemHandlers = useMemo(
    () => ({
      pointerDown: (e, item) => handlersRef.current.onItemPointerDown(e, item),
      click: (e, item) => handlersRef.current.handleItemClick(e, item),
      doubleClick: (e, item) => handlersRef.current.handleItemDoubleClick(e, item),
      contextMenu: (e, item) => handlersRef.current.openItemContextMenu(e, item),
      mouseEnter: (e, item) => handlersRef.current.scheduleTooltip(e, item),
      mouseMove: (e, item) => handlersRef.current.scheduleTooltip(e, item),
      mouseLeave: () => handlersRef.current.clearTooltip(),
      delete: (item) => handlersRef.current.handleMenuDelete(item),
    }),
    []
  );

  return (
    <div className={cn("w-full", props.bodyFill && "h-full flex flex-col min-h-0")}>
      {/* Zoom controls -- compact, consistent with the rest of the chrome. */}
      <div className="flex items-center justify-between gap-3 px-3 h-9 bg-surface-1 border-b border-border-subtle">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleZoomOut}
            title="Zoom out"
            className="h-7 w-7 inline-flex items-center justify-center rounded-sm text-fg-secondary hover:text-fg-primary hover:bg-surface-3"
          >
            <FiZoomOut aria-hidden />
          </button>
          <span className="eyebrow w-12 text-center num">
            {zoom.toFixed(1)}×
          </span>
          <button
            type="button"
            onClick={handleZoomIn}
            title="Zoom in"
            className="h-7 w-7 inline-flex items-center justify-center rounded-sm text-fg-secondary hover:text-fg-primary hover:bg-surface-3"
          >
            <FiZoomIn aria-hidden />
          </button>
          {/* Grid mode toggle: only relevant once BPM is known. We still
              render it when not available so the affordance is visible,
              just disabled with a tooltip explaining why. */}
          <span className="ml-2 inline-flex items-center gap-1.5">
            <span className="eyebrow">Grid</span>
            <select
              value={gridMode}
              onChange={(e) => {
                setGridMode(e.target.value);
                setGridModeUserSet(true);
              }}
              disabled={!hasBeats}
              title={
                hasBeats
                  ? "Switch the grid lines between seconds and song beats"
                  : "Detect a BPM on the audio to enable beat gridlines"
              }
              className={cn(
                "h-7 rounded-sm bg-surface-2 border border-border-subtle text-xs text-fg-primary",
                "px-1.5 pr-5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              <option value="seconds">Seconds</option>
              <option value="beats" disabled={!hasBeats}>
                Beats
              </option>
            </select>
          </span>
          {/* Time-grid snap for dragging cues. Hold Alt while dragging to
              bypass. Sits next to the grid selector. Hidden in beats mode,
              where the "Snap to beat" toggle governs snapping instead. */}
          {!isReadOnly && !useBeatsGrid && (
            <span className="ml-2 inline-flex items-center gap-1.5">
              <span className="eyebrow">Snap</span>
              <select
                value={snapSeconds}
                onChange={(e) => setSnapSeconds(Number(e.target.value))}
                title="Snap dragged cues to this time grid (hold Alt to bypass)"
                className={cn(
                  "h-7 rounded-sm bg-surface-2 border border-border-subtle text-xs text-fg-primary",
                  "px-1.5 pr-5 cursor-pointer"
                )}
              >
                {SNAP_OPTIONS.map((o) => (
                  <option key={o.v} value={o.v}>{o.label}</option>
                ))}
              </select>
            </span>
          )}
          {/* Snap-to-beat toggle. Only meaningful in beats mode and only
              shown to non-readonly users. Hold Alt during a drop to
              bypass the snap for fine adjustments. */}
          {useBeatsGrid && !isReadOnly && (
            <label
              className="ml-1 inline-flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer select-none"
              title="When on, dragged items snap their start time to the nearest beat. Hold Alt while dropping to bypass."
            >
              <input
                type="checkbox"
                checked={snapToBeat}
                onChange={(e) => setSnapToBeat(e.target.checked)}
              />
              Snap to beat
            </label>
          )}
          <label
            className="ml-1 inline-flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer select-none"
            title="Show the zone:cue badge (e.g. RX142:1) on each timeline item."
          >
            <input
              type="checkbox"
              checked={showZoneCue}
              onChange={(e) => setShowZoneCue(e.target.checked)}
            />
            Show zone:cue
          </label>
          <label
            className="ml-1 inline-flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer select-none"
            title="Show each cue's start time on its label."
          >
            <input
              type="checkbox"
              checked={showStartTime}
              onChange={(e) => setShowStartTime(e.target.checked)}
            />
            Show start time
          </label>
          <label
            className="ml-1 inline-flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer select-none"
            title="Show each cue's end time on its label."
          >
            <input
              type="checkbox"
              checked={showEndTime}
              onChange={(e) => setShowEndTime(e.target.checked)}
            />
            Show end time
          </label>
          <label
            className="ml-1 inline-flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer select-none"
            title="Compact view — smaller item bars. Uncheck for taller bars with larger labels."
          >
            <input
              type="checkbox"
              checked={compactItems}
              onChange={(e) => setCompactItems(e.target.checked)}
            />
            Compact view
          </label>
          {/* Swap the wheel's default so it zooms instead of panning. Shift
              then falls back to horizontal panning; Alt still virt-scrolls. */}
          <label
            className="ml-1 inline-flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer select-none"
            title="When on, the scroll wheel zooms instead of panning. Hold Shift to pan horizontally, Alt to scroll vertically."
          >
            <input
              type="checkbox"
              checked={scrollZoom}
              onChange={(e) => setScrollZoom(e.target.checked)}
            />
            Scroll zoom
          </label>
          {/* Auto-scroll to keep the playhead in view during playback. A manual
              horizontal scroll switches this off automatically. */}
          <label
            className="ml-1 inline-flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer select-none"
            title="Keep the playhead framed while audio plays. Turns off automatically when you scroll the timeline."
          >
            <input
              type="checkbox"
              checked={followPlayhead}
              onChange={(e) => setFollowPlayhead(e.target.checked)}
            />
            Follow playhead
          </label>
        </div>
      </div>

      {/* Ruler -- thin, single-line. Switches between seconds and beats. */}
      <div
        ref={ticksRef}
        className="relative w-full h-7 overflow-hidden bg-surface-inset border-b border-border-subtle"
      >
        {/* Match the body inner div's used width exactly. The body is
            `100*zoom%` of its content box (`clientWidth`, which excludes any
            vertical scrollbar), but the ruler (overflow-hidden) has no
            scrollbar — so equal percentages resolve to different pixel widths
            and the ticks drift from the body gridlines. Sizing to
            `bodyContentWidth * zoom` px keeps them identical (and updates in the
            same render as a zoom change). Falls back to the % until measured. */}
        <div
          className="relative h-full"
          style={{ width: bodyContentWidth > 0 ? `${bodyContentWidth * zoom}px` : `${100 * zoom}%` }}
        >
          {!useBeatsGrid && visibleTickIdxs.map((i) => {
            const t = i * tickInterval;
            const isMajor = (t % tickConfig.major) === 0;
            return (
              <div
                key={i}
                className="absolute top-0 bottom-0"
                style={{ left: `${(t / maxTime) * 100}%` }}
              >
                <div
                  className={cn(
                    "w-px h-full",
                    isMajor ? "bg-border" : "bg-border-subtle/60"
                  )}
                />
                {isMajor ? (
                  <span className="absolute top-1 left-1 text-[10px] text-fg-muted num font-mono whitespace-nowrap">
                    {formatTime(t)}
                  </span>
                ) : null}
              </div>
            );
          })}

          {/* Beat grid on the ruler. Strong cap on each downbeat with a
              measure number; lighter half-height ticks on intermediate
              beats. The first beat of each track (measure === 1) gets a
              brighter cap to mark the song boundary. Density culling is
              per-track so a fast song's beats can't suppress a slow
              song's beats. */}
          {useBeatsGrid && visibleBeats.map((b) => {
            if (!b.downbeat && !isOffBeatVisible(b.trackIndex)) return null;
            const left = `${(b.t / maxTime) * 100}%`;
            const labelVisible = isMeasureLabelVisible(b);
            const isTrackStart = b.downbeat && b.measure === 1;
            return (
              <div
                key={`r-beat-${b.trackIndex}-${b.n}`}
                className="absolute top-0 pointer-events-none"
                style={{ left, height: "100%" }}
              >
                <div
                  className="absolute top-0"
                  style={{
                    width: isTrackStart ? "2px" : "1px",
                    height: b.downbeat ? "100%" : "40%",
                    background: b.downbeat
                      ? "rgb(var(--accent) / 0.85)"
                      : "rgb(var(--accent) / 0.30)",
                  }}
                />
                {labelVisible && (
                  <span
                    className="absolute top-1 left-1 text-[10px] font-mono num leading-none whitespace-nowrap"
                    style={{ color: "rgb(var(--accent))" }}
                  >
                    {b.measure}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Timeline body -- low-contrast grid; cursor is a thin accent line. */}
      <div
        ref={timelineRef}
        className={cn(
          "relative w-full overflow-x-scroll overflow-y-auto bg-surface-inset",
          props.bodyFill
            ? "flex-1 min-h-0"
            : cn("transition-[height] duration-200", props.bodyHeightClass || "h-64"),
          props.copyMode && "ring-1 ring-inset ring-accent",
          swapSourceId != null && "ring-1 ring-inset ring-accent"
        )}
        style={{
          cursor:
            props.copyMode === "select-position"
              ? "crosshair"
              : props.copyMode === "select-source"
              ? "copy"
              : swapSourceId != null
              ? "crosshair"
              : undefined,
        }}
        onDragOver={isReadOnly ? () => {} : handleDragOver}
        onDrop={isReadOnly ? () => {} : handleDrop}
        onScroll={handleScroll}
        onDoubleClick={isReadOnly ? () => {} : handleDoubleClick}
        onClick={handleTimelineClick}
        onContextMenu={openBackgroundContextMenu}
      >
        <div
          className="relative h-full"
          style={{ width: `${100 * zoom}%`, minHeight: `${contentMinHeight}px` }}
        >
          {/* Major/minor seconds grid behind items. Drawn as 1-px columns
              so they don't overlap into a "wall" the way border-left did. */}
          {!useBeatsGrid && visibleTickIdxs.map((i) => {
            const t = i * tickInterval;
            const isMajor = (t % tickConfig.major) === 0;
            // At very low zoom we'd otherwise get hundreds of minor ticks
            // packed into 1px each which produces moire. Skip non-majors
            // when zoom is < 1.5.
            if (!isMajor && zoom < 1.5) return null;
            return (
              <div
                key={i}
                className={cn(
                  "absolute top-0 bottom-0 w-px pointer-events-none",
                  isMajor ? "bg-border-subtle/80" : "bg-border-subtle/30"
                )}
                style={{ left: `${(t / maxTime) * 100}%` }}
              />
            );
          })}

          {/* Beat grid in the body. Strong on the downbeat, light on
              the intermediate beats. The first beat of each track gets
              a thicker bar so song transitions are visible at a glance.
              Sits above the surface but below items (zIndex 0) so cue
              bars stay readable. Density culling is per-track. */}
          {useBeatsGrid && visibleBeats.map((b) => {
            if (!b.downbeat && !isOffBeatVisible(b.trackIndex)) return null;
            const isTrackStart = b.downbeat && b.measure === 1;
            return (
              <div
                key={`b-beat-${b.trackIndex}-${b.n}`}
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{
                  left: `${(b.t / maxTime) * 100}%`,
                  width: isTrackStart ? "2px" : "1px",
                  background: b.downbeat
                    ? isTrackStart
                      ? "rgb(var(--accent) / 0.85)"
                      : "rgb(var(--accent) / 0.55)"
                    : "rgb(var(--accent) / 0.18)",
                  zIndex: 0,
                }}
              />
            );
          })}

          {props.timeCursor != null ? (
            <div
              className="absolute top-0 h-full pointer-events-none"
              style={{
                left: `${(props.timeCursor / maxTime) * 100}%`,
                width: "0px",
                borderLeft: "1px solid rgb(var(--accent))",
                boxShadow: "0 0 6px rgb(var(--accent) / 0.5)",
                zIndex: 5,
              }}
            >
              <span
                className="absolute top-0 -translate-x-1/2 w-2 h-2 rotate-45 bg-accent"
                aria-hidden
              />
            </div>
          ) : null}

          {/* Horizontal lane gridlines -- one per stacked row so items read as
              rows in a grid. Drawn at each row's bar baseline, behind items. */}
          {stackedItems.map((_, rowIdx) => (
            <div
              key={`lane-${rowIdx}`}
              className="absolute left-0 right-0 h-px bg-border-subtle/50 pointer-events-none"
              style={{ top: `${rowIdx * rowH + topPad + barH + rowGap}px`, zIndex: 0 }}
            />
          ))}

          {/* Items */}
          {stackedItems.flat().map((item) => {
            const itemDuration = num(item.duration);
            const start = calculatePosition(item.startTime);
            const width = (itemDuration / maxTime) * 100;
            const hasNoLength = !(itemDuration > 0);
            // Bound the label name to ~the cue's own width (min 90px).
            const labelMaxPx = Math.max((width / 100) * innerWidthPx, 90);
            const isLocked = !!item.locked;
            return (
              <TimelineItem
                key={item.id}
                item={item}
                start={start}
                width={width}
                top={rowOf.get(item.id) ?? 0}
                hasNoLength={hasNoLength}
                labelMaxPx={labelMaxPx}
                barH={barH}
                rowH={rowH}
                topPad={topPad}
                compactItems={compactItems}
                showZoneCue={showZoneCue}
                showStartTime={showStartTime}
                showEndTime={showEndTime}
                isSelected={(props.selectedItems || []).some((s) => s.id === item.id)}
                isDragging={draggingId === item.id}
                isLocked={isLocked}
                canDrag={!isReadOnly && !isLocked}
                isReadOnly={isReadOnly}
                receiverLabels={props.receiverLabels}
                firingProfiles={firingProfiles}
                inventory={inventory}
                handlers={itemHandlers}
              />
            );
          })}
        </div>
      </div>

      {/* Swap-mode banner: shown while an item is armed to trade start times
          with the next one clicked. */}
      {swapSourceId != null && (
        <div className="flex items-center justify-between gap-3 px-3 h-9 bg-accent/10 border-t border-accent text-xs text-fg-primary">
          <span className="inline-flex items-center gap-2">
            <FaArrowRightArrowLeft aria-hidden />
            Click another item to swap start times with{" "}
            <span className="font-medium">
              {items.find((i) => i.id === swapSourceId)?.name}
            </span>
            .
          </span>
          <button
            type="button"
            onClick={() => setSwapSourceId(null)}
            className="h-7 px-2 rounded-sm border border-border-subtle text-fg-secondary hover:text-fg-primary hover:bg-surface-3"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Right-click context menu. Rendered as a fixed overlay so it escapes
          the timeline's overflow clipping. Closes via the window listeners
          registered in the effect above. */}
      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[184px] rounded-md border border-border-subtle bg-surface-2 py-1 shadow-e3 text-sm text-fg-primary"
          style={{
            left: Math.min(ctxMenu.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 200),
            top: Math.min(ctxMenu.y, (typeof window !== "undefined" ? window.innerHeight : 9999) - 260),
          }}
          // Keep clicks inside the menu from bubbling to the window closer
          // before the button handler runs.
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {ctxMenu.item ? (
            <>
              <div className="px-3 py-1.5 text-xs text-fg-muted truncate border-b border-border-subtle mb-1">
                {ctxMenu.item.name}
              </div>
              <ContextMenuItem icon={<FaPencil aria-hidden />} onClick={() => handleMenuEdit(ctxMenu.item)}>
                Edit…
              </ContextMenuItem>
              <ContextMenuItem
                icon={<FiClock aria-hidden />}
                onClick={() => handleStartAt(ctxMenu.item)}
                disabled={!!ctxMenu.item.locked}
                title={ctxMenu.item.locked ? "Unlock the cue to change its time" : undefined}
              >
                Start at…
              </ContextMenuItem>
              <ContextMenuItem
                icon={<FiClock aria-hidden />}
                onClick={() => handleEndAt(ctxMenu.item)}
                disabled={!!ctxMenu.item.locked}
                title={ctxMenu.item.locked ? "Unlock the cue to change its time" : undefined}
              >
                End at…
              </ContextMenuItem>
              <ContextMenuItem
                icon={<FaArrowRightArrowLeft aria-hidden />}
                onClick={() => handleSwapStart(ctxMenu.item)}
                disabled={!!ctxMenu.item.locked}
                title={ctxMenu.item.locked ? "Unlock the cue to swap its time" : undefined}
              >
                Swap with…
              </ContextMenuItem>
              {props.onCopyItem && !props.copyDisabled && (
                <ContextMenuItem
                  icon={<FaRegClone aria-hidden />}
                  onClick={() => handleMenuCopy(ctxMenu.item)}
                >
                  Copy to…
                </ContextMenuItem>
              )}
              <ContextMenuItem
                icon={ctxMenu.item.locked ? <FaLockOpen aria-hidden /> : <FaLock aria-hidden />}
                onClick={() => handleToggleLock(ctxMenu.item)}
              >
                {ctxMenu.item.locked ? "Unlock movement" : "Lock movement"}
              </ContextMenuItem>
              <div className="my-1 border-t border-border-subtle" />
              <ContextMenuItem
                icon={<FaTrash aria-hidden />}
                danger
                onClick={() => handleMenuDelete(ctxMenu.item)}
              >
                Delete
              </ContextMenuItem>
            </>
          ) : (
            <ContextMenuItem icon={<FiPlus aria-hidden />} onClick={handleAddHere}>
              Add inventory here
            </ContextMenuItem>
          )}
        </div>
      )}

      {/* Hover tooltip: start/end time, shown after 1s of stationary hover.
          Fixed + pointer-events-none so it never intercepts the pointer or
          gets clipped by the timeline's overflow. */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none rounded-md border border-border-subtle bg-surface-2 px-2.5 py-1.5 shadow-e3 text-xs text-fg-primary"
          style={{
            left: Math.min(tooltip.x + 12, (typeof window !== "undefined" ? window.innerWidth : 9999) - 160),
            top: Math.min(tooltip.y + 12, (typeof window !== "undefined" ? window.innerHeight : 9999) - 72),
          }}
        >
          <div className="font-medium truncate max-w-[220px]">{tooltip.item.name}</div>
          <div className="mt-0.5 flex items-center gap-3 num font-mono text-fg-secondary">
            <span>Start {formatClock(num(tooltip.item.startTime))}</span>
            <span>End {formatClock(num(tooltip.item.startTime) + num(tooltip.item.duration))}</span>
          </div>
        </div>
      )}
    </div>
  );
});

// Single row in the timeline context menu.
function ContextMenuItem({ icon, children, onClick, danger, disabled, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left",
        danger ? "text-danger" : "text-fg-primary",
        disabled
          ? "opacity-40 cursor-not-allowed"
          : cn("hover:bg-surface-3", danger && "hover:bg-danger/10")
      )}
    >
      <span className="w-3.5 inline-flex justify-center text-[12px] opacity-80">{icon}</span>
      {children}
    </button>
  );
}

export default Timeline;
