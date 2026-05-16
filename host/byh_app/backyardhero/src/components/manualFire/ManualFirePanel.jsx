import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { FaKey, FaTriangleExclamation } from "react-icons/fa6";

import useStateAppStore from "@/store/useStateAppStore";
import useAppStore from "@/store/useAppStore";
import { Card, Button, Section, Badge, Dot, cn } from "@/design";
import { mergeCues } from "../builder/ShowBuilder";
import { isPollableReceiver } from "@/util/receivers";

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
// Affordances:
//   - "Turn key" / "ARM switch" gates are the focal pieces when manual fire
//     isn't actually fire-capable.
//   - The fire grid uses the dedicated `armed` button variant — not just
//     "blue" — so the operator's mental model maps to "this is dangerous".
// ---------------------------------------------------------------------------

const EMPTY_RECEIVER_MAP = {};

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

  const fireLocation = async (target) => {
    if (blocker) return;
    await axios.post("/api/system/cmd_daemon",
      { type: "manual_fire", data: { zone, target } },
      { headers: { "Content-Type": "application/json" } });
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
    if (lmt) return Date.now() - lmt <= receiverTimeoutMs;
    return selectedReceiver.connectionStatus === "good";
  }, [selectedReceiver, receiverTimeoutMs, stateData.fw_last_update]);

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

          {/* Fire grid */}
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
                    onClick={() => fireLocation(t)}
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
        </div>
      )}
    </Section>
  );
}
