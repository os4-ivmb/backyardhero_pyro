import useStateFields from "@/store/useStateFields";
import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { FaKey, FaTriangleExclamation } from "react-icons/fa6";

import { serverElapsedMs } from "@/store/useStateAppStore";
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
//   - Native: every enabled receiver is listed (filterable when there are
//     many). Clicking one shows its fire grid with continuity / online /
//     battery readouts. The selection persists locally.
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

const SELECTED_RECEIVER_KEY = "byh.manualFire.selectedReceiver";

function compareZoneKeys(a, b) {
  const an = Number(a);
  const bn = Number(b);
  const aNum = Number.isFinite(an);
  const bNum = Number.isFinite(bn);
  if (aNum && bNum && an !== bn) return an - bn;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return String(a).localeCompare(String(b));
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

function continuitySummary(receiver, targets) {
  let ok = 0;
  let open = 0;
  for (const target of targets) {
    const c = cueHasContinuity(receiver, target);
    if (c === true) ok += 1;
    else if (c === false) open += 1;
  }
  return { ok, open, known: ok + open };
}

function ReceiverListRow({ entry, label, receiver, online, selected, onSelect }) {
  const battery = batteryPercent(receiver);
  const cont = continuitySummary(receiver, entry.targets);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors",
        selected
          ? "border-accent bg-accent/10"
          : "border-border-subtle bg-surface-1 hover:border-border hover:bg-surface-2",
        !online && !selected && "opacity-70",
      )}
    >
      <Dot tone={online ? "ok" : "danger"} pulse={online} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-fg-primary">{label}</div>
        <div className="truncate text-[11px] text-fg-muted">
          Zone {entry.zone}
          {label !== entry.id ? ` · ${entry.id}` : ""}
          {` · ${entry.targets.length} cue${entry.targets.length === 1 ? "" : "s"}`}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className={cn(
          "text-[10px] font-medium uppercase tracking-wider",
          online ? "text-ok-fg" : "text-danger-fg",
        )}>
          {online ? "Online" : "Offline"}
        </div>
        <div className="num text-[10px] text-fg-muted">
          {cont.known > 0 ? `${cont.ok}/${entry.targets.length} cont` : null}
          {cont.known > 0 && battery != null ? " · " : null}
          {battery != null ? `${battery}%` : null}
        </div>
      </div>
    </button>
  );
}

function ReceiverFireGrid({
  zone,
  label,
  receiverId,
  receiver,
  targets,
  online,
  cueAssignmentMap,
  showCueAssignments,
  onFire,
}) {
  const battery = batteryPercent(receiver);
  return (
    <Card tone="armed" padding="md" className={cn("flex flex-col gap-3", !online && "opacity-70")}>
      <div className="flex items-start gap-2 min-w-0">
        <Dot tone={online ? "ok" : "danger"} pulse={online} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-fg-primary">{label}</div>
          <div className="truncate text-xs text-fg-muted">
            Zone {zone}
            {label !== receiverId ? ` · ${receiverId}` : ""}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn(
            "text-xs font-medium uppercase tracking-wider",
            online ? "text-ok-fg" : "text-danger-fg",
          )}>
            {online ? "Online" : "Offline"}
          </div>
          {battery != null ? (
            <div className="num text-xs text-fg-muted">Battery {battery}%</div>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-1.5">
        {targets.map((target, index) => {
          const continuity = cueHasContinuity(receiver, target);
          const assignedItem = showCueAssignments
            ? cueAssignmentMap[`${zone}:${target}`]
            : null;
          return (
            <FireCueButton
              key={`${target}-${index}`}
              zone={zone}
              target={target}
              disabled={!online}
              continuity={continuity}
              assignmentLabel={formatCueAssignment(assignedItem)}
              assignmentType={formatCueType(assignedItem)}
              assignmentImage={cueAssignmentImage(assignedItem)}
              onClick={() => onFire(zone, target, online)}
            />
          );
        })}
      </div>
    </Card>
  );
}

function receiverLabel(receiver, id) {
  return (
    receiver?.label ||
    receiver?.status?.ident ||
    receiver?.status?.node ||
    id
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
  const [selectedKey, setSelectedKey] = usePersistentState(SELECTED_RECEIVER_KEY, null);
  const [query, setQuery] = useState("");

  const rows = useMemo(
    () => zones.map((entry) => {
      const receiver = receiverMap?.[entry.id];
      return {
        entry,
        receiver,
        label: receiverLabel(receiver, entry.id),
        online: receiverIsOnline(receiver, receiverTimeoutMs, stateData),
      };
    }),
    [zones, receiverMap, receiverTimeoutMs, stateData],
  );

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(({ entry, label }) =>
      [label, entry.id, `zone ${entry.zone}`, String(entry.zone)]
        .some((s) => String(s).toLowerCase().includes(q)),
    );
  }, [rows, query]);

  const selected = rows.find((row) => row.entry.key === selectedKey) || null;
  const onlineCount = rows.filter((row) => row.online).length;

  if (zones.length === 0) {
    return (
      <Card padding="lg" className="text-center">
        <p className="text-sm text-fg-muted">
          No active receivers. Enable one on the Receivers tab, then come back.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted max-w-2xl">
        Pick a receiver to show its cues, then tap a cue to fire it.
        {showCueAssignments ? " Staged show assignments are shown on matching cues." : ""}
        {" "}A green dot is continuity. Red means the cue is open.
      </p>

      <div className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="order-2 md:order-1 flex flex-col gap-2 min-w-0">
          <div className="flex items-center justify-between text-[11px] text-fg-muted">
            <span className="eyebrow">Receivers</span>
            <span className="num">{onlineCount}/{rows.length} online</span>
          </div>
          {rows.length > 6 ? (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name, ID or zone"
              className="h-9 w-full rounded-sm bg-surface-1 border border-border px-2.5 text-sm text-fg-primary focus:border-accent"
            />
          ) : null}
          <div className="flex flex-col gap-1.5 md:max-h-[70vh] md:overflow-y-auto md:pr-1">
            {filteredRows.length === 0 ? (
              <p className="px-1 py-2 text-xs text-fg-muted">No receivers match “{query}”.</p>
            ) : filteredRows.map((row) => (
              <ReceiverListRow
                key={row.entry.key}
                entry={row.entry}
                label={row.label}
                receiver={row.receiver}
                online={row.online}
                selected={row.entry.key === selectedKey}
                onSelect={() => setSelectedKey(row.entry.key)}
              />
            ))}
          </div>
        </div>

        {/* On phone the grid sits above the list so the selected
            receiver's cues stay reachable without scrolling a long list. */}
        <div className="order-1 md:order-2 min-w-0">
          {selected ? (
            <ReceiverFireGrid
              zone={selected.entry.zone}
              label={selected.label}
              receiverId={selected.entry.id}
              receiver={selected.receiver}
              targets={selected.entry.targets}
              online={selected.online}
              cueAssignmentMap={cueAssignmentMap}
              showCueAssignments={showCueAssignments}
              onFire={onFire}
            />
          ) : (
            <Card padding="lg" className="hidden text-center md:block">
              <p className="text-sm text-fg-muted">Select a receiver to show its fire grid.</p>
            </Card>
          )}
        </div>
      </div>
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
  const stateData = useStateFields(["fw_state.active_protocol", "fw_state.device_is_armed", "fw_state.loaded_show_id", "fw_state.manual_fire_active", "fw_state.receivers", "fw_state.settings", "fw_state.show_loaded"]);
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
      description="Direct cue ignition. Pick a receiver, then fire its cues."
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
