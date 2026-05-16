import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import {
  FaCheck, FaClock, FaRocket, FaTriangleExclamation, FaCircleCheck,
  FaPlay,
} from "react-icons/fa6";
import { FiUpload, FiX, FiAlertCircle, FiChevronDown } from "react-icons/fi";

import useAppStore from "@/store/useAppStore";
import useStateAppStore from "@/store/useStateAppStore";
import useAppMode from "@/design/useAppMode";
import useShowReceiverVerification from "@/util/useShowReceiverVerification";
import { Card, Button, Badge, Section, cn } from "@/design";
import { protoStatusBadge, protoStatusLabel } from "@/util/protoStatus";
import { isPollableReceiver } from "@/util/receivers";
import { parseAudioField } from "@/utils/audioTracks";
import { computeShowStats, formatShowCreatedAt } from "@/util/showStats";

import ShowHealthStrip from "../../console/ShowHealthStrip";

// ---------------------------------------------------------------------------
// MobileConsolePanel -- mobile-tuned console.
//
// Same data model and action ladder as the desktop ConsolePanel /
// ShowControl pair (everything is derived from the same hooks and the
// same daemon state), but the layout is rebuilt around a single
// dominant primary-action button and a stack of collapsible details.
// We deliberately drop:
//
//   * Timeline — needs horizontal space + drag affordances.
//   * Local-preview play / wavesurfer — preview is a desk workflow.
//   * Audio sync scrubber — fine-grained ±50ms tweaks need a precise
//     pointer; the saved value is still respected at run-time.
//   * Show details errors viewer — collapsed but still surfaces below.
// ---------------------------------------------------------------------------

const formatDuration = (s) => {
  if (!s || !Number.isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  const r = Math.round(s) % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
};

const formatTime = (sec) => {
  const v = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
};

// -----------------------------------------------------------------
// MobileShowPicker -- simplified ShowPicker. One card per show, full
// width, big "Stage" button for thumb tapping.
function MobileShowPicker() {
  const { shows, setStagedShow, inventoryById, loadedShow } = useAppStore();
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return shows;
    return shows.filter((s) => (s.name || "").toLowerCase().includes(q));
  }, [shows, filter]);

  const handleStage = (show) => {
    const items = JSON.parse(show.display_payload || "[]").map((pi) => ({
      ...inventoryById[pi.itemId],
      ...pi,
    }));
    let audioTracks = [];
    let audioFile = null;
    let audioOffsetMs = 0;
    if (show.audio_file) {
      try {
        const r = parseAudioField(JSON.parse(show.audio_file));
        audioTracks = r.tracks;
        audioOffsetMs = r.audioOffsetMs;
        audioFile = audioTracks[0] || null;
      } catch { /* tolerated */ }
    }
    setStagedShow({ ...show, items, audioFile, audioTracks, audioOffsetMs });
  };

  return (
    <div className="px-3 py-4 space-y-3">
      <Section
        title="Stage a show"
        description="Pick a saved show to stage."
      >
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search shows…"
          className="h-10 w-full px-3 rounded-sm bg-surface-1 border border-border text-base text-fg-primary placeholder:text-fg-muted focus:border-accent"
        />

        <div className="flex flex-col gap-2 mt-3">
          {filtered.length === 0 ? (
            <Card padding="lg" tone="neutral" className="text-center">
              <p className="text-fg-secondary">
                {shows.length === 0
                  ? "No shows yet. Build one on a tablet or laptop."
                  : "No shows match your search."}
              </p>
            </Card>
          ) : filtered.map((show) => {
            const isLoaded = loadedShow?.id === show.id;
            const stats = computeShowStats(show, inventoryById);
            return (
              <Card
                key={show.id}
                padding="md"
                tone="neutral"
                className="flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-fg-primary truncate">
                      {show.name || "Untitled show"}
                    </h3>
                    <div className="flex items-center gap-2 mt-1 text-2xs text-fg-muted">
                      <span className="num">{formatDuration(show.duration)}</span>
                      <span>·</span>
                      <span className="num">{stats.cues} cues</span>
                      <span>·</span>
                      <span className="num">{stats.shells} shells</span>
                    </div>
                    <div className="mt-0.5 text-2xs text-fg-muted">
                      Created {formatShowCreatedAt(stats.createdAt)}
                    </div>
                  </div>
                  {isLoaded ? <Badge tone="ok">Loaded</Badge> : null}
                </div>
                <Button
                  size="lg"
                  variant="primary"
                  leading={<FaPlay />}
                  onClick={() => handleStage(show)}
                  className="w-full"
                >
                  Stage
                </Button>
              </Card>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

// -----------------------------------------------------------------
// MobileShowControl: action ladder + countdown + status, all in a
// single tap-friendly card.
function MobileShowControl({ allReceiversOnline, hasErrors, errors, isReadyToFire, countdownSeconds }) {
  const { stagedShow, setStagedShow } = useAppStore();
  const { stateData } = useStateAppStore();
  const { mode, isShowLoaded, protoStatus, isArmed, startSwActive } = useAppMode();
  const showRcvVerification = useShowReceiverVerification();

  const handlerInStartPhase =
    protoStatus && protoStatus.split("_")[0]?.startsWith("START");
  const isLive = handlerInStartPhase || stateData.fw_state?.show_running;
  const waitingClientStart = !!stateData.fw_state?.waiting_for_client_start;
  const dstc = !!stateData.fw_state?.dstc;

  const callDaemon = async (type, body = {}) =>
    axios.post("/api/system/cmd_daemon", { type, ...body }, {
      headers: { "Content-Type": "application/json" },
    });

  const handleLoad = async () => {
    if (!stagedShow?.id) return;
    if (window.prompt("Auth code for this show:") !== stagedShow.authorization_code) {
      window.alert("Auth code is incorrect.");
      return;
    }
    await callDaemon("load_show", { id: stagedShow.id });
  };
  const handleUnload = () => callDaemon("unload_show", { id: stagedShow.id });
  const handleStart = () => callDaemon("start_show");
  const handleStop = () => callDaemon("stop_show");
  const handleUnstage = () => setStagedShow({});

  const primary = useMemo(() => {
    if (isLive) return {
      label: "Abort",
      variant: "danger",
      onClick: handleStop,
      icon: <FiX className="text-2xl" aria-hidden />,
      hint: protoStatusLabel(protoStatus),
    };
    if (!isShowLoaded) {
      if (!isArmed) return {
        label: "Awaiting ARM",
        variant: "warn",
        disabled: true,
        icon: <FaClock aria-hidden />,
        hint: "Turn the ARM key on before loading.",
      };
      if (startSwActive) return {
        label: "Start switch ON",
        variant: "danger",
        disabled: true,
        icon: <FaTriangleExclamation aria-hidden />,
        hint: "Turn the show start switch OFF, then load.",
      };
      if (showRcvVerification.hasError) return {
        label: "Resolve receivers",
        variant: "danger",
        disabled: true,
        icon: <FaTriangleExclamation aria-hidden />,
        hint: showRcvVerification.summary
          ? `Receivers: ${showRcvVerification.summary}`
          : "Show has receiver verification errors",
      };
      return {
        label: "Load show",
        variant: "primary",
        onClick: handleLoad,
        icon: <FiUpload aria-hidden />,
        hint: !allReceiversOnline ? "Some receivers offline" : "Send cues to receivers",
      };
    }
    if (hasErrors) return {
      label: "Resolve errors",
      variant: "warn",
      icon: <FiAlertCircle aria-hidden />,
      disabled: true,
      hint: `${errors?.length || 0} pre-check failure(s)`,
    };
    if (protoStatus === "STOPPED" || protoStatus === "ABORTED") {
      const aborted = protoStatus === "ABORTED";
      return {
        label: aborted ? "Show aborted" : "Show finished",
        variant: aborted ? "warn" : "outline",
        disabled: true,
        icon: aborted
          ? <FaTriangleExclamation aria-hidden />
          : <FaCircleCheck aria-hidden />,
        hint: startSwActive
          ? "Cycle the start switch off to run again."
          : "Run again, or unload.",
      };
    }
    if (waitingClientStart && dstc) return {
      label: "Launch",
      variant: "live",
      onClick: handleStart,
      icon: <FaRocket aria-hidden />,
      hint: "All systems go",
    };
    if (isReadyToFire && !waitingClientStart) {
      if (!isArmed) {
        if (startSwActive) return {
          label: "ARM switch is OFF",
          variant: "danger",
          disabled: true,
          icon: <FaTriangleExclamation aria-hidden />,
          hint: "Start switch is on. Cycle it off, then re-arm.",
        };
        return {
          label: "Awaiting ARM",
          variant: "warn",
          disabled: true,
          icon: <FaClock aria-hidden />,
          hint: "Turn the key on the box",
        };
      }
      if (!startSwActive) return {
        label: "Awaiting start",
        variant: "warn",
        disabled: true,
        icon: <FaClock aria-hidden />,
        hint: "Turn the show start switch on",
      };
    }
    return {
      label: "Standby",
      variant: "outline",
      disabled: true,
      icon: <FaClock aria-hidden />,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isLive, waitingClientStart, dstc, isShowLoaded, hasErrors, isReadyToFire,
    allReceiversOnline, errors?.length, protoStatus, isArmed, startSwActive,
    showRcvVerification.hasError, showRcvVerification.summary,
  ]);

  const statusChip = useMemo(() => {
    if (isLive) {
      if (protoStatus === "STARTED") return { tone: "live", label: protoStatusBadge("STARTED") };
      if (protoStatus === "START_PENDING") return { tone: "armed", label: protoStatusBadge("START_PENDING") };
    }
    if (!isShowLoaded) return { tone: "neutral", label: "Not loaded" };
    if (hasErrors) return { tone: "danger", label: "Checks failed" };
    if (isReadyToFire) return { tone: "ok", label: "Ready" };
    return { tone: "neutral", label: "Loaded" };
  }, [isLive, protoStatus, isShowLoaded, hasErrors, isReadyToFire]);

  const inCountdown = isLive && protoStatus === "START_CONFIRMED";

  return (
    <Card
      padding="md"
      tone={mode.id === "armed" ? "armed" : mode.id === "live" ? "ok" : "raised"}
      className="flex flex-col gap-3"
    >
      {/* Header: name + status (or countdown taking over) */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="eyebrow">Staged show</div>
          <h2 className="text-xl font-semibold text-fg-primary truncate tracking-tight">
            {stagedShow?.name || "Untitled"}
          </h2>
          <div className="mt-0.5 text-2xs text-fg-muted num">
            {formatDuration(stagedShow?.duration)}
            {stagedShow?.items ? ` · ${stagedShow.items.length} cues` : ""}
          </div>
        </div>
        {!inCountdown ? (
          <Badge
            tone={statusChip.tone}
            size="md"
            pulse={statusChip.tone === "live" || statusChip.tone === "armed"}
            className="shrink-0"
          >
            {statusChip.label}
          </Badge>
        ) : null}
      </div>

      {inCountdown ? (
        <div
          role="timer"
          aria-live="polite"
          className={cn(
            "flex flex-col items-center justify-center leading-none text-center",
            "px-4 py-3 rounded-md border",
            "bg-live/10 border-live/60 text-live-fg",
            "shadow-[0_0_0_1px_rgb(var(--live)/0.25),0_0_24px_0_rgb(var(--live)/0.25)]"
          )}
        >
          <span className="eyebrow text-live animate-livePulse">Countdown</span>
          <span className="num text-5xl font-bold tabular-nums tracking-tight mt-1">
            T−{countdownSeconds ?? "—"}
            <span className="text-2xl align-baseline ml-0.5 text-live/70">s</span>
          </span>
        </div>
      ) : null}

      {/* Receiver verification banner */}
      {!isShowLoaded && showRcvVerification.hasError ? (
        <div className="flex items-start gap-2 rounded-sm border border-danger/40 bg-danger-bg/60 px-3 py-2 text-xs text-danger-fg">
          <FaTriangleExclamation className="mt-0.5 shrink-0" aria-hidden />
          <div>
            <div className="font-medium">
              {showRcvVerification.summary || "Receiver verification errors"}
            </div>
            <div className="opacity-80 mt-0.5">
              Fix the affected receivers on the Receivers tab.
            </div>
          </div>
        </div>
      ) : null}

      {/* Hero primary action */}
      <Button
        size="xl"
        variant={primary.variant}
        onClick={primary.onClick}
        disabled={primary.disabled}
        leading={primary.icon}
        className="w-full h-16 text-xl"
      >
        {primary.label}
      </Button>

      {primary.hint ? (
        <div className="text-sm text-fg-secondary leading-snug">
          <span className="eyebrow mr-1">Next:</span>
          {primary.hint}
        </div>
      ) : null}

      {!isShowLoaded && !allReceiversOnline ? (
        <span className="inline-flex items-center gap-1.5 text-warn text-xs">
          <FaTriangleExclamation aria-hidden /> Some receivers offline
        </span>
      ) : null}

      {/* Secondary actions row -- compact, ghost-styled. */}
      <div className="flex items-center gap-2">
        {isShowLoaded && !isLive ? (
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={handleUnload}
          >
            Unload
          </Button>
        ) : null}
        {!isShowLoaded && !isLive ? (
          <Button
            size="sm"
            variant="ghost"
            className="flex-1"
            onClick={handleUnstage}
          >
            Unstage
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

// -----------------------------------------------------------------
// MobileShowDetailsCard: collapsible status + errors. Auto-opens
// when there are errors so they're not missed mid-show.
function MobileShowDetailsCard({ errors = [], protoHandlerStatus }) {
  const hasErrors = errors.length > 0;
  const [open, setOpen] = useState(hasErrors);
  const explainer = protoStatusLabel(protoHandlerStatus);

  return (
    <Card padding="none" tone="neutral" className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 h-12 flex items-center justify-between text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="eyebrow">Show details</span>
          {hasErrors ? (
            <Badge tone="danger">
              {errors.length} error{errors.length === 1 ? "" : "s"}
            </Badge>
          ) : explainer ? (
            <span className="text-xs text-fg-secondary truncate">{explainer}</span>
          ) : null}
        </div>
        <FiChevronDown className={cn("text-lg transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="border-t border-border-subtle p-4 text-sm space-y-3">
          {explainer ? (
            <p className="text-fg-secondary leading-relaxed">{explainer}</p>
          ) : null}
          {hasErrors ? (
            <ul className="space-y-1.5">
              {errors.map((e, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-fg-secondary border-l-2 border-danger/60 pl-3 py-0.5"
                >
                  <span className="font-mono text-xs text-fg-muted mt-0.5">#{i + 1}</span>
                  <span className="break-words">
                    {typeof e === "string" ? e : JSON.stringify(e)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-fg-muted">No errors.</p>
          )}
        </div>
      ) : null}
    </Card>
  );
}

// -----------------------------------------------------------------

export default function MobileConsolePanel() {
  const { stagedShow, shows, setStagedShow, setLoadedShow, inventoryById, systemConfig } = useAppStore();
  const { stateData } = useStateAppStore();
  const { isShowLoaded } = useAppMode();
  const [countdownSeconds, setCountdownSeconds] = useState(null);

  // Sync UI staged/loaded show with daemon's loaded_show_id on first
  // connect. Same logic as the desktop ConsolePanel; lifted here so a
  // mobile-only operator session restores correctly after a reload.
  useEffect(() => {
    if (!stateData.fw_state?.loaded_show_id || !shows.length) return;
    const found = shows.find((s) => s.id === stateData.fw_state.loaded_show_id);
    if (!found) return;
    let parsedItems = [];
    try {
      parsedItems = JSON.parse(found.display_payload).map((pi) => ({
        ...inventoryById[pi.itemId], ...pi,
      }));
    } catch { /* tolerate */ }
    let audioTracks = [];
    let audioFile = null;
    let audioOffsetMs = 0;
    if (found.audio_file) {
      try {
        const r = parseAudioField(JSON.parse(found.audio_file));
        audioTracks = r.tracks;
        audioOffsetMs = r.audioOffsetMs;
        audioFile = audioTracks[0] || null;
      } catch { /* */ }
    }
    const merged = { ...found, items: parsedItems, audioFile, audioTracks, audioOffsetMs };
    setStagedShow(merged);
    setLoadedShow(merged);
  }, [stateData.fw_state?.loaded_show_id, shows, inventoryById, setStagedShow, setLoadedShow]);

  // Countdown ticker for START_CONFIRMED phase. Same algorithm as
  // desktop ConsolePanel.
  useEffect(() => {
    const status = stateData.fw_state?.proto_handler_status;
    const sst = stateData.fw_state?.sst;
    if (status === "START_CONFIRMED" && sst) {
      const tick = () => {
        const remaining = Math.max(0, Math.floor((sst - Date.now()) / 1000));
        setCountdownSeconds(remaining);
      };
      tick();
      const id = setInterval(tick, 1000);
      return () => clearInterval(id);
    }
    setCountdownSeconds(null);
    return undefined;
  }, [stateData.fw_state?.proto_handler_status, stateData.fw_state?.sst]);

  const allReceiversOnline = useMemo(() => {
    if (!stagedShow || !stagedShow.items) return true;
    const receivers = stateData.fw_state?.receivers || systemConfig?.receivers || {};
    const showReceivers = new Set();
    stagedShow.items.forEach((item) => {
      if (!item.zone || !item.target) return;
      Object.entries(receivers).forEach(([k, r]) => {
        if (!isPollableReceiver(r)) return;
        if (r.cues?.[item.zone]?.includes(item.target)) showReceivers.add(k);
      });
    });
    let allOnline = true;
    showReceivers.forEach((k) => {
      const r = receivers[k];
      if (!r) { allOnline = false; return; }
      const lmt = r.status?.lmt;
      if (lmt) { if (Date.now() - lmt > 10_000) allOnline = false; }
      else if (r.connectionStatus !== "good") allOnline = false;
    });
    return allOnline;
  }, [stagedShow, stateData.fw_state?.receivers, systemConfig]);

  const errors = useMemo(() => [
    ...(stateData.fw_state?.fire_check_failures || []),
    ...(stateData.fw_state?.proto_handler_errors || []),
  ], [stateData.fw_state?.fire_check_failures, stateData.fw_state?.proto_handler_errors]);

  const hasErrors = errors.length > 0;
  const isReadyToFire = isShowLoaded && !hasErrors;

  if (!stagedShow?.items) return <MobileShowPicker />;

  return (
    <div className="px-3 py-3 flex flex-col gap-3">
      <MobileShowControl
        allReceiversOnline={allReceiversOnline}
        hasErrors={hasErrors}
        errors={errors}
        isReadyToFire={isReadyToFire}
        countdownSeconds={countdownSeconds}
      />

      <ShowHealthStrip />

      <MobileShowDetailsCard
        errors={errors}
        protoHandlerStatus={stateData.fw_state?.proto_handler_status}
      />
    </div>
  );
}
