import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { FaKey, FaTriangleExclamation } from "react-icons/fa6";

import useStateAppStore, { serverElapsedMs } from "@/store/useStateAppStore";
import useAppStore from "@/store/useAppStore";
import { Card, Button, Section, Badge, Dot, cn } from "@/design";
import { mergeCues } from "../builder/ShowBuilder";
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
//   - Native: DB-backed receivers (BKYD_TS_24_1 etc.) -- the operator picks
//     a zone (== receiver ident) and we render one cue per slot the
//     receiver actually exposes, with continuity/online/battery readouts.
//   - Bilusocn / 433 MHz: one-way TX broadcast. There is no DB receiver
//     row in the new world (Bilusocn zones live on shows now), so there's
//     nothing to poll. Operator types a dipswitch zone (1-128) and we
//     render the fixed 12-cue grid -- the daemon translates straight to
//     a TX packet without going through the resolver.
//
// Affordances:
//   - "Turn key" / "ARM switch" gates are the focal pieces when manual fire
//     isn't actually fire-capable.
//   - The fire grid uses the dedicated `armed` button variant — not just
//     "blue" — so the operator's mental model maps to "this is dangerous".
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

export default function ManualFirePanel() {
  const [zone, setZone] = useState(0);
  const [targets, setTargets] = useState([]);
  const [devMap, setDevMap] = useState({});
  const [activeKind, setActiveKind] = useState(RECEIVER_KIND_NATIVE);
  // Bilusocn-tab state: a free-form zone number the operator types, kept
  // as a string for the input field so we can render an empty box. The
  // fire handlers parse + clamp on send.
  const [bilusocnZoneInput, setBilusocnZoneInput] = useState("1");
  const { stateData } = useStateAppStore();
  const { systemConfig, stagedShow } = useAppStore();

  const fw = stateData.fw_state || {};
  const receiverMap = fw.receivers || systemConfig.receivers || EMPTY_RECEIVER_MAP;
  const showLoaded = !!fw.show_loaded || !!fw.loaded_show_id;
  const hasProtocol = !!fw.active_protocol;
  const keyTurned = !!fw.manual_fire_active;
  const armSwitchActive = !!fw.device_is_armed;
  const receiverTimeoutMs = fw.settings?.receiver_timeout_ms || 10_000;

  // Compute the primary blocker (if any). Priority: show-loaded → no
  // protocol → manual key → arm switch.
  const blocker = useMemo(() => {
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
  }, [showLoaded, hasProtocol, keyTurned, armSwitchActive]);

  useEffect(() => {
    if (!blocker && receiverMap) {
      setDevMap(mergeCues(receiverMap));
    } else {
      setDevMap({});
    }
  }, [blocker, receiverMap]);

  // Native fire goes through the daemon's DB-resolved path; Bilusocn
  // bypasses resolution entirely (no DB row exists for the zone) and
  // is dispatched as a direct TX packet on the daemon side. We tag the
  // payload with `kind` so the daemon picks the right path.
  const fireNative = async (target) => {
    if (blocker) return;
    await axios.post(
      "/api/system/cmd_daemon",
      {
        type: "manual_fire",
        data: { zone, target, kind: RECEIVER_KIND_NATIVE },
      },
      { headers: { "Content-Type": "application/json" } },
    );
  };

  const fireBilusocn = async (target) => {
    if (blocker) return;
    const z = parseInt(bilusocnZoneInput, 10);
    if (!Number.isFinite(z) || z < 1 || z > BILUSOCN_MANUAL_FIRE_ZONE_MAX) return;
    await axios.post(
      "/api/system/cmd_daemon",
      {
        type: "manual_fire",
        data: { zone: String(z), target, kind: RECEIVER_KIND_BILUSOCN },
      },
      { headers: { "Content-Type": "application/json" } },
    );
  };

  const handleZoneChange = (e) => {
    setZone(e.target.value);
    setTargets(devMap[e.target.value] || []);
  };

  const zones = Object.keys(devMap);

  const selectedReceiver = useMemo(() => {
    if (!zone) return null;
    return (
      Object.values(receiverMap).find(
        (receiver) =>
          isPollableReceiver(receiver) &&
          Array.isArray(receiver.cues?.[zone])
      ) || null
    );
  }, [receiverMap, zone]);

  const selectedReceiverOnline = useMemo(() => {
    if (!selectedReceiver) return null;
    const lmt = selectedReceiver.status?.lmt;
    if (lmt) return serverElapsedMs(lmt, stateData) <= receiverTimeoutMs;
    return selectedReceiver.connectionStatus === "good";
  }, [selectedReceiver, receiverTimeoutMs, stateData]);

  const selectedReceiverLabel =
    selectedReceiver?.label ||
    selectedReceiver?.status?.ident ||
    selectedReceiver?.status?.node ||
    null;

  const cueAssignmentMap = useMemo(
    () => buildCueAssignmentMap(stagedShow?.items),
    [stagedShow?.items]
  );
  const showCueAssignments = !showLoaded && !!stagedShow?.id;

  // Pick a sensible default zone when devMap loads.
  useEffect(() => {
    if (!zones.length) return;
    if (!zone || !devMap[zone]) {
      setZone(zones[0]);
      setTargets(devMap[zones[0]] || []);
    }
  }, [zones.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Bilusocn fixed cue grid -----------------------------------------
  // Bilusocn zones always expose 12 cues (three 4ch dipswitch ranges
  // tile 1-4 / 5-8 / 9-12). We synthesize the array client-side instead
  // of consulting devMap because Bilusocn fire bypasses DB receivers
  // entirely.
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
      description="Direct cue ignition. Used for testing and for shows that aren't loaded into the timeline."
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
            <>
              {/* Zone selector */}
              <Card padding="md" tone="raised">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[160px]">
                    <label className="eyebrow block mb-1">Zone</label>
                    <select
                      value={zone}
                      onChange={handleZoneChange}
                      className="h-10 w-full rounded-sm bg-surface-1 border border-border px-2.5 text-sm text-fg-primary focus:border-accent"
                    >
                      {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                    </select>
                  </div>
                  <p className="text-xs text-fg-muted max-w-xs">
                    Choose a zone, then tap a target below to fire it once. Fire
                    commands are dispatched directly to the receiver.
                    {showCueAssignments ? " Staged show assignments are shown on matching cues." : ""}
                  </p>
                </div>
                {selectedReceiver ? (
                  <div className="mt-3 pt-3 border-t border-border-subtle flex flex-wrap items-center gap-2 text-xs">
                    <Badge
                      tone={selectedReceiverOnline ? "ok" : "danger"}
                      leading={<Dot tone={selectedReceiverOnline ? "ok" : "danger"} pulse={selectedReceiverOnline} />}
                    >
                      {selectedReceiverOnline ? "Receiver online" : "Receiver offline"}
                    </Badge>
                    <span className="text-fg-secondary truncate">
                      {selectedReceiverLabel}
                    </span>
                    {selectedReceiver.status?.battery != null ? (
                      <span className="num text-fg-muted">
                        Battery {Math.floor((selectedReceiver.status.battery / 256) * 100)}%
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </Card>

              {/* Fire grid (native) */}
              <Card padding="md" tone="armed">
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                  {targets.length === 0 ? (
                    <p className="col-span-full text-fg-muted text-sm text-center py-8">
                      No targets registered for this zone.
                    </p>
                  ) : targets.map((t) => {
                    const continuity = selectedReceiver
                      ? cueHasContinuity(selectedReceiver, t)
                      : null;
                    const assignedItem = showCueAssignments
                      ? cueAssignmentMap[`${zone}:${t}`]
                      : null;
                    const assignmentLabel = formatCueAssignment(assignedItem);
                    const assignmentType = formatCueType(assignedItem);
                    const assignmentImage = cueAssignmentImage(assignedItem);
                    const continuityLabel =
                      continuity === true
                        ? "continuity present"
                        : continuity === false
                        ? "no continuity"
                        : "continuity unknown";
                    return (
                      <Button
                        key={t}
                        size="xl"
                        variant="armed"
                        onClick={() => fireNative(t)}
                        className={cn(
                          "relative h-24 px-2 flex-col gap-1",
                          assignmentLabel ? "ring-2 ring-accent/60" : ""
                        )}
                        title={
                          selectedReceiver
                            ? `Cue ${t}: ${continuityLabel}${assignmentLabel ? ` · ${assignmentLabel}` : ""}`
                            : `Fire cue ${t}${assignmentLabel ? ` · ${assignmentLabel}` : ""}`
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
                        {selectedReceiver ? (
                          <span
                            className={cn(
                              "absolute bottom-1.5 left-1/2 z-10 -translate-x-1/2",
                              "inline-flex items-center gap-1 rounded bg-surface-base/70 px-1.5 py-0.5 text-[9px] leading-none font-medium uppercase tracking-wider",
                              continuity === true && "text-ok-fg",
                              continuity === false && "text-danger-fg",
                              continuity == null && "text-fg-muted"
                            )}
                          >
                            <Dot
                              tone={
                                continuity === true
                                  ? "ok"
                                  : continuity === false
                                  ? "danger"
                                  : "neutral"
                              }
                            />
                            {continuity === true
                              ? "Cont."
                              : continuity === false
                              ? "Open"
                              : "Unknown"}
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
