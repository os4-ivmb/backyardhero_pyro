import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { FaKey, FaTriangleExclamation } from "react-icons/fa6";
import { MdDragIndicator } from "react-icons/md";

import useStateAppStore, { serverElapsedMs } from "@/store/useStateAppStore";
import useAppStore from "@/store/useAppStore";
import useAppMode from "@/design/useAppMode";
import { Card, Button, Section, Badge, Dot, cn } from "@/design";
import usePersistentState from "@/utils/usePersistentState";
import { isPollableReceiver } from "@/util/receivers";
import {
  BILUSOCN_ZONE_CUES,
  RECEIVER_KIND_BILUSOCN,
  RECEIVER_KIND_NATIVE,
} from "@/util/showReceivers";

// ---------------------------------------------------------------------------
// ManualFirePanel: redesigned around the mode-gate pattern.
//
// Previously this screen showed the firing grid all the time and put a
// blocking red banner on top when a precondition wasn't met. The redesign
// inverts that: the firing grid only renders when the system is genuinely
// ready (active protocol + manual_fire_active + device_is_armed + no loaded
// show). Otherwise we show a clear, large "gate" describing the missing
// condition.
//
// Two tabs split the firing surface by RF transport:
//   - Native: every enabled receiver is on screen at once, with its cues,
//     laid out across a firing field. The operator can drag each receiver
//     to where that rack sits (left / center / right) so a manual sequence
//     doesn't mean flipping a zone menu between shots. Positions persist
//     locally. Until they're placed, receivers spread across the field in
//     zone order.
//   - Bilusocn / 433 MHz: one-way TX broadcast. There is no DB receiver
//     row in the new world (Bilusocn zones live on shows now), so there's
//     nothing to poll. Operator types a dipswitch zone (1-128) and we
//     render the fixed 12-cue grid -- the daemon translates straight to
//     a TX packet without going through the resolver.
//
// Affordances:
//   - "Turn key" / "ARM switch" gates are the focal pieces when manual fire
//     isn't actually fire-capable.
//   - Cue buttons use the dedicated `armed` treatment so the operator's
//     mental model maps to "this is dangerous".
//   - Dragging is a separate "Move receivers" mode. Cues don't fire while
//     a receiver is being placed.
// ---------------------------------------------------------------------------

const EMPTY_RECEIVER_MAP = {};

// Manual-fire zone bound for Bilusocn. We deliberately cap below the
// modal's 1-256 because the BSC TX packet encoder folds zone numbers
// above ~123 into negative bits (see `BSCFireTranslator.translate_zone_
// target_to_tx_pkg` on the daemon). 128 keeps the input round and well
// inside the safe range without exposing the encoder quirk to ops.
const BILUSOCN_MANUAL_FIRE_ZONE_MAX = 128;

function GateCard({ icon, title, body, tone = "warn" }) {
  return (
    <Card tone={tone === "danger" ? "danger" : "warn"} padding="lg" className="text-center">
      <div className={cn(
        "mx-auto mb-3 inline-flex items-center justify-center w-14 h-14 rounded-full",
        tone === "danger" ? "bg-danger/15 text-danger" : "bg-warn/15 text-warn"
      )}>
        <span className="text-2xl">{icon}</span>
      </div>
      <h3 className="text-lg font-semibold text-fg-primary">{title}</h3>
      <p className="mt-1 text-sm text-fg-secondary max-w-md mx-auto">{body}</p>
    </Card>
  );
}

function cueHasContinuity(receiver, target) {
  const cont = receiver?.status?.continuity;
  if (!Array.isArray(cont) || cont.length < 1) return null;

  const cue = Number(target);
  if (!Number.isFinite(cue) || cue < 1) return null;

  const bit = cue - 1;
  const block = Math.floor(bit / 64);
  const pos = bit % 64;
  if (cont[block] == null) return null;

  try {
    const big = typeof cont[block] === "bigint" ? cont[block] : BigInt(cont[block]);
    return (big & (BigInt(1) << BigInt(pos))) !== BigInt(0);
  } catch {
    return null;
  }
}

function formatCueAssignment(item) {
  if (!item) return null;

  if (item.type === "FUSED_LINE" && Array.isArray(item.steps)) {
    const stepNames = item.steps.map((step) => step?.name).filter(Boolean);
    return item.name || stepNames.join(" + ") || "Fused line";
  }

  const qty = Number.isFinite(item.multiple) && item.multiple > 1
    ? ` x${item.multiple}`
    : "";
  return `${item.name || item.type || "Assigned item"}${qty}`;
}

function formatCueType(item) {
  if (!item?.type) return null;
  return item.type
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cueAssignmentImage(item) {
  if (!item) return null;
  if (item.image) return item.image;

  if (item.type === "FUSED_LINE" && Array.isArray(item.steps)) {
    return item.steps.find((step) => step?.image)?.image || null;
  }

  return null;
}

function CueAssignmentBackground({ image, label }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [image]);

  if (!image || failed) return null;

  return (
    <img
      src={image}
      alt={label || "Assigned item"}
      className="absolute inset-0 h-full w-full rounded-md object-cover opacity-25 pointer-events-none"
      loading="lazy"
      onError={() => setFailed(true)}
      aria-hidden="true"
    />
  );
}

function buildCueAssignmentMap(items) {
  if (!Array.isArray(items)) return {};

  return items.reduce((map, item) => {
    if (item?.zone == null || item?.target == null) return map;
    map[`${item.zone}:${item.target}`] = item;
    return map;
  }, {});
}

// Firing-field geometry. Cards are a fixed width (the receivers-tab card
// is w-72) so a cue stays the same size no matter how the field is
// stretched. Positions are stored as percentages of the field: x is the
// card center, y is the card top. Only positions the operator has dragged
// are persisted; everyone else is spread across the field in zone order.
const FIELD_LAYOUT_KEY = "byh.manualFire.fieldLayout";
const FIELD_CARD_WIDTH = 288;
const FIELD_CARD_GAP = 16;
const FIELD_EDGE = 16;
const FIELD_AUDIENCE_PX = 40;
// 5-wide cue grid, matching the receivers tab. h-14 rows + gap-1.5.
const FIELD_CUE_COLS = 5;
const FIELD_CUE_ROW_PX = 56;
const FIELD_CUE_GAP_PX = 6;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function compareZoneKeys(a, b) {
  const an = Number(a);
  const bn = Number(b);
  const aNum = Number.isFinite(an);
  const bNum = Number.isFinite(bn);
  if (aNum && bNum && an !== bn) return an - bn;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return String(a).localeCompare(String(b));
}

function estimateCardHeight(cueCount) {
  const rows = Math.max(1, Math.ceil((cueCount || 1) / FIELD_CUE_COLS));
  const grid = rows * FIELD_CUE_ROW_PX + Math.max(0, rows - 1) * FIELD_CUE_GAP_PX;
  // Header + card padding + a little slack so the last row isn't clipped.
  return 76 + grid + 16;
}

function fieldHeightFor(zones, fieldWidth) {
  const count = Math.max(zones.length, 1);
  const width = Math.max(fieldWidth || 960, FIELD_CARD_WIDTH + FIELD_EDGE * 2);
  const cols = Math.max(
    1,
    Math.min(
      count,
      Math.floor((width - FIELD_EDGE * 2 + FIELD_CARD_GAP) / (FIELD_CARD_WIDTH + FIELD_CARD_GAP)),
    ),
  );
  const rows = Math.ceil(count / cols);
  const tallest = Math.max(...zones.map((z) => estimateCardHeight(z.targets.length)), 180);
  // Extra vertical room so a rack can sit forward or back of the others.
  return rows * tallest + Math.max(0, rows - 1) * FIELD_CARD_GAP + 150;
}

function autoPosition(index, zones, fieldWidth, fieldHeight) {
  const count = zones.length;
  const width = Math.max(fieldWidth || 960, 1);
  const height = Math.max(fieldHeight || 1, 1);
  const cols = Math.max(
    1,
    Math.min(
      count,
      Math.floor((width - FIELD_EDGE * 2 + FIELD_CARD_GAP) / (FIELD_CARD_WIDTH + FIELD_CARD_GAP)),
    ),
  );
  const col = index % cols;
  const row = Math.floor(index / cols);
  const inRow = Math.min(cols, count - row * cols);
  const usable = Math.max(0, width - FIELD_CARD_WIDTH - FIELD_EDGE * 2);
  const centerX = inRow <= 1
    ? width / 2
    : FIELD_EDGE + FIELD_CARD_WIDTH / 2 + (usable * col) / (inRow - 1);
  const stride = Math.max(...zones.map((z) => estimateCardHeight(z.targets.length))) + FIELD_CARD_GAP;
  const top = FIELD_EDGE + row * stride;
  return {
    x: (centerX / width) * 100,
    y: (top / height) * 100,
  };
}

function readSavedPos(layout, key) {
  const pos = layout?.[key];
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null;
  return pos;
}

// Keep a card inside the field even if a saved percentage was recorded
// against a taller field (fewer cues now, shorter stage).
function placeOnField(pos, cueCount, fieldWidth, fieldHeight) {
  if (!fieldWidth || !fieldHeight) return pos;
  const halfPct = (FIELD_CARD_WIDTH / 2 / fieldWidth) * 100;
  const maxTopPx = Math.max(0, fieldHeight - estimateCardHeight(cueCount) - FIELD_AUDIENCE_PX);
  return {
    x: clamp(pos.x, halfPct, Math.max(halfPct, 100 - halfPct)),
    y: clamp(pos.y, 0, (maxTopPx / fieldHeight) * 100),
  };
}

function receiverIsOnline(receiver, timeoutMs, stateData) {
  const lmt = receiver?.status?.lmt;
  if (lmt) return serverElapsedMs(lmt, stateData) <= timeoutMs;
  return receiver?.connectionStatus === "good";
}

function batteryPercent(receiver) {
  if (receiver?.status?.battery == null) return null;
  return Math.floor((receiver.status.battery / 256) * 100);
}

function listNativeZones(receiverMap) {
  const list = [];
  for (const [id, receiver] of Object.entries(receiverMap || {})) {
    if (!isPollableReceiver(receiver)) continue;
    const cues = receiver?.cues;
    if (!cues || typeof cues !== "object") continue;
    for (const [zone, targets] of Object.entries(cues)) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      list.push({
        key: `${id}::${zone}`,
        id,
        zone,
        targets,
      });
    }
  }
  list.sort((a, b) => compareZoneKeys(a.zone, b.zone) || String(a.id).localeCompare(String(b.id)));
  return list;
}

function FireCueButton({
  zone,
  target,
  disabled,
  onClick,
  continuity,
  assignmentLabel,
  assignmentType,
  assignmentImage,
}) {
  const continuityLabel =
    continuity === true
      ? "continuity present"
      : continuity === false
      ? "no continuity"
      : "continuity unknown";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={
        [
          `Zone ${zone} · cue ${target}`,
          continuityLabel,
          assignmentType,
          assignmentLabel,
        ].filter(Boolean).join(" · ")
      }
      aria-label={`Fire zone ${zone} cue ${target}${assignmentLabel ? `, ${assignmentLabel}` : ""}`}
      className={cn(
        "relative flex h-14 min-w-0 flex-col items-center justify-center rounded-md border px-0.5",
        "font-semibold text-armed-fg",
        "disabled:cursor-not-allowed",
        continuity === false
          ? "bg-danger/10 border-danger/70 hover:bg-danger/20"
          : "bg-armed/15 border-armed/60 hover:bg-armed/25 hover:border-armed active:bg-armed/35",
        assignmentLabel && "ring-2 ring-accent/60",
      )}
    >
      <CueAssignmentBackground image={assignmentImage} label={assignmentLabel} />
      <span className="absolute right-1 top-1 z-10" title={continuityLabel}>
        <Dot
          tone={
            continuity === true
              ? "ok"
              : continuity === false
              ? "danger"
              : "neutral"
          }
        />
      </span>
      <span className="relative z-10 block text-base leading-none">{target}</span>
      {assignmentLabel ? (
        <span className="relative z-10 mt-0.5 block max-w-full truncate px-0.5 text-[9px] font-medium leading-tight text-fg-primary normal-case tracking-normal">
          {assignmentLabel}
        </span>
      ) : null}
    </button>
  );
}

function ReceiverFireCard({
  zoneKey,
  zone,
  label,
  receiverId,
  receiver,
  targets,
  online,
  cueAssignmentMap,
  showCueAssignments,
  arranging,
  dragging,
  onFire,
  className,
  positioned = false,
  style,
  onDragStart,
  onDragMove,
  onDragEnd,
}) {
  const battery = batteryPercent(receiver);
  return (
    <div
      data-fire-card={zoneKey}
      className={cn(positioned ? "absolute w-72" : className)}
      style={positioned ? style : undefined}
    >
    <Card
      tone="raised"
      padding="sm"
      className={cn(
        "relative flex flex-col gap-2",
        !online && "opacity-60",
        arranging && "ring-2 ring-accent/40",
        dragging && "shadow-lg",
      )}
    >
      <div className="flex items-start gap-2 min-w-0">
        {arranging ? (
          <MdDragIndicator className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
        ) : (
          <Dot tone={online ? "ok" : "danger"} pulse={online} className="mt-1.5" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg-primary">{label}</div>
          <div className="truncate text-[11px] text-fg-muted">
            Zone {zone}
            {label !== receiverId ? ` · ${receiverId}` : ""}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn(
            "text-[10px] font-medium uppercase tracking-wider",
            online ? "text-ok-fg" : "text-danger-fg",
          )}>
            {online ? "Online" : "Offline"}
          </div>
          {battery != null ? (
            <div className="num text-[10px] text-fg-muted">{battery}%</div>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {targets.map((target, index) => {
          const continuity = cueHasContinuity(receiver, target);
          const assignedItem = showCueAssignments
            ? cueAssignmentMap[`${zone}:${target}`]
            : null;
          const assignmentLabel = formatCueAssignment(assignedItem);
          const assignmentType = formatCueType(assignedItem);
          const assignmentImage = cueAssignmentImage(assignedItem);
          return (
            <FireCueButton
              key={`${target}-${index}`}
              zone={zone}
              target={target}
              disabled={!online}
              continuity={continuity}
              assignmentLabel={assignmentLabel}
              assignmentType={assignmentType}
              assignmentImage={assignmentImage}
              onClick={() => onFire(zone, target, online)}
            />
          );
        })}
      </div>
      {arranging ? (
        <div
          className="absolute inset-0 z-10 cursor-grab touch-none active:cursor-grabbing"
          aria-label={`Drag ${label}`}
          onPointerDown={(event) => onDragStart(event, zoneKey)}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        />
      ) : null}
    </Card>
    </div>
  );
}

function NativeManualFire({
  receiverMap,
  stateData,
  receiverTimeoutMs,
  cueAssignmentMap,
  showCueAssignments,
  onFire,
}) {
  const zones = useMemo(() => listNativeZones(receiverMap), [receiverMap]);
  const [savedLayout, setSavedLayout] = usePersistentState(FIELD_LAYOUT_KEY, {}, { debounce: 200 });
  const [arranging, setArranging] = useState(false);
  const [draggingKey, setDraggingKey] = useState(null);
  const [fieldWidth, setFieldWidth] = useState(0);
  const fieldRef = useRef(null);
  const dragRef = useRef(null);

  const hasCustomLayout = zones.some((zone) => readSavedPos(savedLayout, zone.key));
  const fieldHeight = fieldHeightFor(zones, fieldWidth);

  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      setFieldWidth((prev) => (prev === width ? prev : width));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [zones.length]);

  const beginDrag = (event, key) => {
    if (!arranging) return;
    if (event.button != null && event.button !== 0) return;
    const field = fieldRef.current;
    const card = event.currentTarget.closest("[data-fire-card]");
    if (!field || !card) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const cardRect = card.getBoundingClientRect();
    dragRef.current = {
      key,
      pointerId: event.pointerId,
      offX: event.clientX - (cardRect.left + cardRect.width / 2),
      offY: event.clientY - cardRect.top,
      cardW: cardRect.width,
      cardH: cardRect.height,
    };
    setDraggingKey(key);
  };

  const moveDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const field = fieldRef.current;
    if (!field) return;
    const rect = field.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const center = event.clientX - drag.offX - rect.left;
    const top = event.clientY - drag.offY - rect.top;
    const half = drag.cardW / 2;
    const minCenter = half + 8;
    const maxCenter = Math.max(minCenter, rect.width - half - 8);
    const maxTop = Math.max(0, rect.height - drag.cardH - FIELD_AUDIENCE_PX);
    const x = (clamp(center, minCenter, maxCenter) / rect.width) * 100;
    const y = (clamp(top, 0, maxTop) / rect.height) * 100;
    setSavedLayout((prev) => {
      const base = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
      const cur = base[drag.key];
      if (cur && Math.abs(cur.x - x) < 0.05 && Math.abs(cur.y - y) < 0.05) return prev;
      return { ...base, [drag.key]: { x, y } };
    });
  };

  const endDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    dragRef.current = null;
    setDraggingKey(null);
  };

  const resetLayout = () => {
    dragRef.current = null;
    setDraggingKey(null);
    setArranging(false);
    setSavedLayout({});
  };

  const stackZones = useMemo(() => {
    // Phone has no field, so follow the same left-to-right / back-to-front
    // order the desktop field would use, including any placed positions.
    const nominalWidth = 1200;
    const nominalHeight = fieldHeightFor(zones, nominalWidth);
    const orderKey = (entry, index) => {
      const pos = readSavedPos(savedLayout, entry.key)
        || autoPosition(index, zones, nominalWidth, nominalHeight);
      return pos.y * 1000 + pos.x;
    };
    return zones
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => orderKey(a.entry, a.index) - orderKey(b.entry, b.index))
      .map(({ entry }) => entry);
  }, [zones, savedLayout]);

  const cardProps = (entry) => {
    const receiver = receiverMap?.[entry.id];
    const label =
      receiver?.label ||
      receiver?.status?.ident ||
      receiver?.status?.node ||
      entry.id;
    return {
      zoneKey: entry.key,
      zone: entry.zone,
      label,
      receiverId: entry.id,
      receiver,
      targets: entry.targets,
      online: receiverIsOnline(receiver, receiverTimeoutMs, stateData),
      cueAssignmentMap,
      showCueAssignments,
      onFire,
    };
  };

  const hint = arranging
    ? "Drag each receiver to where that rack sits. Left and right are as you look toward the audience. Cues stay locked until you tap Done."
    : hasCustomLayout
    ? "Tap a cue to fire it. Receivers stay where you placed them."
    : "Every active receiver is on the field, spread out by zone. Move them to match the yard, then tap a cue to fire.";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-fg-muted max-w-2xl">
          <span className="md:hidden">
            Every active receiver is listed with its cues. Tap a cue to fire it.
          </span>
          <span className="hidden md:inline">{hint}</span>
          {showCueAssignments ? " Staged show assignments are shown on matching cues." : ""}
          {" "}
          A green dot is continuity. Red means the cue is open.
        </p>
        <div className="hidden md:flex items-center gap-2">
          {hasCustomLayout ? (
            <Button size="sm" variant="ghost" onClick={resetLayout}>
              Reset positions
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={arranging ? "primary" : "outline"}
            onClick={() => {
              dragRef.current = null;
              setDraggingKey(null);
              setArranging((on) => !on);
            }}
          >
            {arranging ? "Done" : "Move receivers"}
          </Button>
        </div>
      </div>

      {zones.length === 0 ? (
        <Card padding="lg" className="text-center">
          <p className="text-sm text-fg-muted">
            No active receivers. Enable one on the Receivers tab, then come back.
          </p>
        </Card>
      ) : (
        <>
          <div className="flex flex-col gap-4 md:hidden">
            {stackZones.map((entry) => (
              <ReceiverFireCard
                key={entry.key}
                {...cardProps(entry)}
                arranging={false}
                className="w-full"
              />
            ))}
          </div>

          <div
            ref={fieldRef}
            className={cn(
              "relative hidden w-full overflow-hidden rounded-md border border-border-subtle bg-surface-inset md:block",
              arranging && "select-none ring-2 ring-accent/50",
            )}
            style={{ height: fieldHeight }}
          >
            <div
              className="pointer-events-none absolute inset-y-0 left-1/2 z-0 w-px bg-border-subtle"
              aria-hidden
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex h-9 items-end justify-between border-t border-border-subtle bg-surface-2/90 px-3 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
              <span>Left</span>
              <span>Audience</span>
              <span>Right</span>
            </div>
            {zones.map((entry, index) => {
              const width = fieldWidth || fieldRef.current?.clientWidth || 0;
              const saved = readSavedPos(savedLayout, entry.key);
              const pos = placeOnField(
                saved || autoPosition(index, zones, width || 960, fieldHeight),
                entry.targets.length,
                width,
                fieldHeight,
              );
              return (
                <ReceiverFireCard
                  key={entry.key}
                  {...cardProps(entry)}
                  arranging={arranging}
                  dragging={draggingKey === entry.key}
                  positioned
                  style={{
                    left: `${pos.x}%`,
                    top: `${pos.y}%`,
                    transform: "translateX(-50%)",
                    zIndex: draggingKey === entry.key ? 30 : 1,
                  }}
                  onDragStart={beginDrag}
                  onDragMove={moveDrag}
                  onDragEnd={endDrag}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default function ManualFirePanel() {
  const [activeKind, setActiveKind] = useState(RECEIVER_KIND_NATIVE);
  // Bilusocn-tab state: a free-form zone number the operator types, kept
  // as a string for the input field so we can render an empty box. The
  // fire handlers parse + clamp on send.
  const [bilusocnZoneInput, setBilusocnZoneInput] = useState("1");
  // Surfaces client-side command failures (HTTP 200 only means "file
  // written", not "daemon accepted" — but a failed POST should still be
  // visible rather than silent, W5).
  const [fireError, setFireError] = useState(null);
  const { stateData } = useStateAppStore();
  const { systemConfig, stagedShow } = useAppStore();
  const { wsAlive, daemonActive } = useAppMode();

  const fw = stateData.fw_state || {};
  const receiverMap = fw.receivers || systemConfig.receivers || EMPTY_RECEIVER_MAP;
  const showLoaded = !!fw.show_loaded || !!fw.loaded_show_id;
  const hasProtocol = !!fw.active_protocol;
  const keyTurned = !!fw.manual_fire_active;
  const armSwitchActive = !!fw.device_is_armed;
  const receiverTimeoutMs = fw.settings?.receiver_timeout_ms || 10_000;

  // Compute the primary blocker (if any). Priority: link-down → show-loaded
  // → no protocol → manual key → arm switch.
  const blocker = useMemo(() => {
    // W5: never present a clickable fire grid against frozen telemetry.
    // If the WS link is stale or the daemon is down we can't trust ANY
    // of the flags below, so gate the whole surface first.
    if (!wsAlive || !daemonActive) return {
      icon: <FaTriangleExclamation />,
      title: "Daemon link is down",
      body: "The live connection to the firing controller is stale. Manual fire is disabled until telemetry resumes.",
      tone: "danger",
    };
    if (showLoaded) return {
      icon: <FaTriangleExclamation />,
      title: "Manual fire disabled while a show is loaded",
      body: "Unload the active show on the Console tab before using manual fire.",
      tone: "danger",
    };
    if (!hasProtocol) return {
      icon: <FaTriangleExclamation />,
      title: "No active firing protocol",
      body: "Wait for the daemon to bind to a transmitter and an active protocol, then come back.",
      tone: "warn",
    };
    if (!keyTurned) return {
      icon: <FaKey />,
      title: "Turn the key on the box",
      body: "Manual fire requires the physical key on the firing controller to be in the manual position. Once turned, the fire grid will appear here.",
      tone: "warn",
    };
    if (!armSwitchActive) return {
      icon: <FaTriangleExclamation />,
      title: "ARM switch is off",
      body: "Manual fire commands are blocked until the controller is armed. Turn the ARM switch on to reveal the fire grid.",
      tone: "danger",
    };
    return null;
  }, [wsAlive, daemonActive, showLoaded, hasProtocol, keyTurned, armSwitchActive]);

  // Native fire goes through the daemon's DB-resolved path; Bilusocn
  // bypasses resolution entirely (no DB row exists for the zone) and
  // is dispatched as a direct TX packet on the daemon side. We tag the
  // payload with `kind` so the daemon picks the right path.
  const fireNative = async (zone, target, online) => {
    if (blocker) return;
    // W5: don't fire against a receiver we believe is offline.
    if (online === false) {
      setFireError(`Receiver for zone ${zone} appears offline — fire blocked.`);
      return;
    }
    setFireError(null);
    try {
      await axios.post(
        "/api/system/cmd_daemon",
        {
          type: "manual_fire",
          data: { zone, target, kind: RECEIVER_KIND_NATIVE },
        },
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (e) {
      setFireError(
        `Failed to send fire command for zone ${zone} cue ${target}: ${e?.message || e}`,
      );
    }
  };

  const fireBilusocn = async (target) => {
    if (blocker) return;
    const z = parseInt(bilusocnZoneInput, 10);
    if (!Number.isFinite(z) || z < 1 || z > BILUSOCN_MANUAL_FIRE_ZONE_MAX) return;
    setFireError(null);
    try {
      await axios.post(
        "/api/system/cmd_daemon",
        {
          type: "manual_fire",
          data: { zone: String(z), target, kind: RECEIVER_KIND_BILUSOCN },
        },
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (e) {
      setFireError(
        `Failed to send Bilusocn fire for zone ${z} cue ${target}: ${e?.message || e}`,
      );
    }
  };

  const cueAssignmentMap = useMemo(
    () => buildCueAssignmentMap(stagedShow?.items),
    [stagedShow?.items]
  );
  const showCueAssignments = !showLoaded && !!stagedShow?.id;

  // ---- Bilusocn fixed cue grid -----------------------------------------
  // Bilusocn zones always expose 12 cues (three 4ch dipswitch ranges
  // tile 1-4 / 5-8 / 9-12). We synthesize the array client-side because
  // Bilusocn fire bypasses DB receivers entirely.
  const bilusocnTargets = useMemo(
    () => Array.from({ length: BILUSOCN_ZONE_CUES }, (_, i) => i + 1),
    [],
  );
  const bilusocnZoneNum = useMemo(() => {
    const n = parseInt(bilusocnZoneInput, 10);
    return Number.isFinite(n) ? n : null;
  }, [bilusocnZoneInput]);
  const bilusocnZoneValid =
    bilusocnZoneNum != null
    && bilusocnZoneNum >= 1
    && bilusocnZoneNum <= BILUSOCN_MANUAL_FIRE_ZONE_MAX;

  return (
    <Section
      title="Manual fire"
      description="Direct cue ignition. Every active receiver stays on screen, so a left–center–right sequence doesn't mean switching zones."
      actions={
        keyTurned && armSwitchActive && !blocker
          ? <Badge tone="armed" pulse>Manual fire active</Badge>
          : keyTurned && !armSwitchActive
          ? <Badge tone="danger">ARM switch off</Badge>
          : <Badge tone="neutral">Idle</Badge>
      }
    >
      {blocker ? (
        <GateCard icon={blocker.icon} title={blocker.title} body={blocker.body} tone={blocker.tone} />
      ) : (
        <div className="space-y-4">
          {fireError ? (
            <Card tone="danger" padding="md" className="flex items-start gap-2">
              <FaTriangleExclamation className="mt-0.5 shrink-0 text-danger" />
              <div className="text-sm text-danger-fg">{fireError}</div>
            </Card>
          ) : null}
          {/* Tab strip: Native vs Bilusocn / 433 MHz. Mirrors the same
              two-kind split used by the show builder's Add Receiver
              modal so the operator's mental model stays consistent
              across the app. */}
          <div className="flex border-b border-border-subtle">
            <ManualFireKindTab
              active={activeKind === RECEIVER_KIND_NATIVE}
              onClick={() => setActiveKind(RECEIVER_KIND_NATIVE)}
              label="Native"
            />
            <ManualFireKindTab
              active={activeKind === RECEIVER_KIND_BILUSOCN}
              onClick={() => setActiveKind(RECEIVER_KIND_BILUSOCN)}
              label="Bilusocn / 433 MHz"
            />
          </div>

          {activeKind === RECEIVER_KIND_NATIVE ? (
            <NativeManualFire
              receiverMap={receiverMap}
              stateData={stateData}
              receiverTimeoutMs={receiverTimeoutMs}
              cueAssignmentMap={cueAssignmentMap}
              showCueAssignments={showCueAssignments}
              onFire={fireNative}
            />
          ) : (
            <>
              {/* Zone input (Bilusocn) */}
              <Card padding="md" tone="raised">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[160px] max-w-[200px]">
                    <label className="eyebrow block mb-1">Zone</label>
                    <input
                      type="number"
                      min={1}
                      max={BILUSOCN_MANUAL_FIRE_ZONE_MAX}
                      value={bilusocnZoneInput}
                      onChange={(e) => setBilusocnZoneInput(e.target.value)}
                      placeholder={`1-${BILUSOCN_MANUAL_FIRE_ZONE_MAX}`}
                      className="h-10 w-full rounded-sm bg-surface-1 border border-border px-2.5 text-sm text-fg-primary focus:border-accent"
                    />
                  </div>
                  <p className="text-xs text-fg-muted max-w-md">
                    Bilusocn 433MHz is one-way TX -- there's no receiver to
                    poll, so no online / continuity readouts. Type the zone
                    number set on your TX modules' dipswitches, then tap a
                    cue to broadcast it.
                    {showCueAssignments ? " Staged show assignments are shown on matching cues." : ""}
                  </p>
                </div>
                {!bilusocnZoneValid ? (
                  <div className="mt-3 pt-3 border-t border-border-subtle text-xs text-warn-fg">
                    Zone must be a number between 1 and {BILUSOCN_MANUAL_FIRE_ZONE_MAX}.
                  </div>
                ) : null}
              </Card>

              {/* Fire grid (Bilusocn) */}
              <Card padding="md" tone="armed">
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                  {bilusocnTargets.map((t) => {
                    // Stage show assignments are keyed by item.zone (the
                    // showReceivers entry id). Bilusocn show entries use
                    // the zone number stringified, so a lookup against
                    // String(zone):cue lines up with what the show
                    // builder writes.
                    const assignedItem =
                      showCueAssignments && bilusocnZoneNum != null
                        ? cueAssignmentMap[`${bilusocnZoneNum}:${t}`]
                        : null;
                    const assignmentLabel = formatCueAssignment(assignedItem);
                    const assignmentType = formatCueType(assignedItem);
                    const assignmentImage = cueAssignmentImage(assignedItem);
                    return (
                      <Button
                        key={t}
                        size="xl"
                        variant="armed"
                        disabled={!bilusocnZoneValid}
                        onClick={() => fireBilusocn(t)}
                        className={cn(
                          "relative h-24 px-2 flex-col gap-1",
                          assignmentLabel ? "ring-2 ring-accent/60" : ""
                        )}
                        title={
                          bilusocnZoneValid
                            ? `Fire zone ${bilusocnZoneNum} · cue ${t}${assignmentLabel ? ` · ${assignmentLabel}` : ""}`
                            : "Enter a valid zone first"
                        }
                      >
                        <CueAssignmentBackground
                          image={assignmentImage}
                          label={assignmentLabel}
                        />
                        {assignmentType ? (
                          <span className="absolute left-1.5 top-1.5 z-10 max-w-[55%] truncate rounded bg-surface-base/70 px-1.5 py-0.5 text-[9px] leading-none font-semibold uppercase tracking-wider text-fg-secondary">
                            {assignmentType}
                          </span>
                        ) : null}
                        <span className="relative z-10 block text-2xl leading-none">{t}</span>
                        {assignmentLabel ? (
                          <span className="relative z-10 mx-auto mt-0.5 block max-w-full truncate rounded bg-surface-base/65 px-1 text-[10px] leading-tight text-fg-primary normal-case tracking-normal">
                            {assignmentLabel}
                          </span>
                        ) : null}
                      </Button>
                    );
                  })}
                </div>
              </Card>
            </>
          )}
        </div>
      )}
    </Section>
  );
}

// Single tab button for the manual-fire kind switcher. Style mirrors the
// in-show-builder tab strip so the modal/main-page surfaces feel like a
// consistent family.
function ManualFireKindTab({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-4 py-2 font-medium text-sm",
        active
          ? "text-accent border-b-2 border-accent"
          : "text-fg-muted hover:text-fg-secondary",
      )}
    >
      {label}
    </button>
  );
}
