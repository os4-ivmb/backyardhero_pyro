import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  FaPlay, FaPause, FaCheck, FaClock, FaRocket, FaTriangleExclamation, FaCircleCheck,
} from "react-icons/fa6";
import { FiUpload, FiX, FiAlertCircle } from "react-icons/fi";
import WaveSurfer from "wavesurfer.js";

import useAppStore from "@/store/useAppStore";
import useStateAppStore from "@/store/useStateAppStore";
import useAppMode from "@/design/useAppMode";
import { Card, Button, Badge, Stat, IconButton, cn } from "@/design";
import { protoStatusBadge, protoStatusLabel } from "@/util/protoStatus";

// ---------------------------------------------------------------------------
// ShowControl: the single hero surface that drives a staged show.
//
// The redesign brief called out "Multiple competing primary actions" — Play,
// Load, Armed, Manual Fire, Unstage all at the same visual weight. This
// component fixes that by deriving exactly ONE primary action at a time from
// the live show + daemon state. The action ladder runs top-down; the first
// matching rule wins, and load-state precedence is enforced before any
// load-dependent daemon flag is consulted (the daemon can carry stale
// `waiting_for_client_start` / `dstc` between sessions):
//
//   Live (proto handler running)        → Primary: "Abort"            (only)
//   No show staged                      → (component not rendered)
//   Staged, not loaded, ARM off         → Primary: "Awaiting ARM"     (warn, disabled)
//   Staged, not loaded, start sw on     → Primary: "Start switch ON"  (danger, disabled)
//   Staged, not loaded                  → Primary: "Load"             Secondary: Unstage / Preview
//   Loaded, errors                      → Primary: "Resolve errors"   Secondary: Unload
//   Loaded, post-show (STOPPED/ABORTED) → Primary: "Show finished"    hint: cycle switch / unload
//   Loaded, awaiting client start       → Primary: "Launch"           Secondary: Abort
//   Loaded, ok, ARM off, start on       → Primary: "ARM switch is OFF" (danger)
//   Loaded, ok, not armed               → Primary: "Awaiting ARM"     hint: "Turn the key on the box"
//   Loaded, armed, start switch off     → Primary: "Awaiting start"   hint: "Turn the show start switch on"
//   Anything else (transients)          → Primary: "Standby"          (outline, disabled)
//
// Preview play/pause for the local timeline cursor lives here too because
// it's a workflow concern (preview before load), but it's explicitly
// secondary-styled and disabled once the show is loaded.
// ---------------------------------------------------------------------------

const formatTime = (sec) => {
  const v = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
};

function MiniWave({ audioFile, isPlaying }) {
  const ref = useRef(null);
  const ws = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!ref.current || ws.current || !audioFile?.url) return;
    try {
      ws.current = WaveSurfer.create({
        container: ref.current,
        waveColor: "#5b6470",
        progressColor: "#608ec4",
        cursorColor: "transparent",
        barWidth: 1, barRadius: 1, cursorWidth: 0,
        height: 28, barGap: 1, normalize: true, interact: false,
      });
      ws.current.on("ready", () => setReady(true));
      ws.current.on("error", () => setReady(false));
      ws.current.load(audioFile.url);
    } catch { /* ignore */ }
    return () => {
      if (ws.current && ready) {
        try { ws.current.pause(); ws.current.destroy(); } catch { /* */ }
      }
      ws.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioFile?.url]);

  useEffect(() => {
    if (!ws.current || !ready) return;
    try {
      if (isPlaying) ws.current.play();
      else { ws.current.pause(); ws.current.seekTo(0); }
    } catch { /* */ }
  }, [isPlaying, ready]);

  if (!audioFile?.url) return null;
  return <div ref={ref} className="w-40 rounded-sm bg-surface-inset" aria-hidden />;
}

// Big countdown widget used in the show-control header during the
// seconds-to-start phase (proto_handler_status === "START_CONFIRMED").
// Replaces the small "Ready" / "Running" badge so the operator can see
// the time-to-zero from across the room. Large tabular numerics with a
// gentle pulse on the eyebrow; the digit itself stays static so the
// number is never blurry mid-tick.
function CountdownDisplay({ seconds }) {
  const display = Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  return (
    <div
      className={cn(
        "flex flex-col items-end justify-center leading-none",
        "px-4 py-2 rounded-md border",
        "bg-live/10 border-live/60 text-live-fg",
        "shadow-[0_0_0_1px_rgb(var(--live)/0.25),0_0_24px_0_rgb(var(--live)/0.25)]"
      )}
      role="timer"
      aria-live="polite"
      aria-label={display != null ? `T minus ${display} seconds` : "Countdown"}
    >
      <span className="eyebrow text-live animate-livePulse">Countdown</span>
      <span className="num text-5xl font-bold tabular-nums tracking-tight mt-0.5">
        {display != null ? `T−${display}` : "T−"}
        <span className="text-2xl align-baseline ml-0.5 text-live/70">s</span>
      </span>
    </div>
  );
}

export default function ShowControl({
  timeCursor, setTimeCursor,
  isPlaying, setIsPlaying,
  audioIsPlaying, onAudioTimeUpdate,
  countdownSeconds,
  isReadyToFire, hasErrors, allReceiversOnline,
  errors,
}) {
  const { stagedShow, setStagedShow } = useAppStore();
  const { stateData } = useStateAppStore();
  const { mode, isShowLoaded, protoStatus, isArmed, startSwActive } = useAppMode();

  // ---------------------------------------------------------------------
  // Action derivation. We compute the next primary action exactly once,
  // and label every other affordance as "secondary" / icon-only.
  // ---------------------------------------------------------------------
  const handlerInStartPhase = protoStatus &&
    protoStatus.split("_")[0]?.startsWith("START");
  const isLive = handlerInStartPhase || stateData.fw_state?.show_running;
  const waitingClientStart = !!stateData.fw_state?.waiting_for_client_start;
  const dstc = !!stateData.fw_state?.dstc;

  const callDaemon = async (type, body = {}) => {
    await axios.post("/api/system/cmd_daemon", { type, ...body }, {
      headers: { "Content-Type": "application/json" },
    });
  };

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

  // Primary action descriptor: { label, variant, onClick, icon, hint, disabled }
  const primary = useMemo(() => {
    // ABORT always wins -- if the proto handler is running we want a
    // single red button, regardless of any other flags.
    if (isLive) return {
      label: "Abort",
      variant: "danger",
      onClick: handleStop,
      icon: <FiX className="text-xl" aria-hidden />,
      hint: protoStatusLabel(protoStatus),
    };
    // Loading is a hard precondition for every other "loaded" branch.
    // Check it before consulting any of the load-dependent flags (the
    // daemon can carry stale `waiting_for_client_start` / `dstc` from a
    // previous session and would otherwise mislead us into showing
    // "Launch" while the show is unloaded).
    if (!isShowLoaded) {
      // Two physical preconditions on the box, in order:
      //   1. ARM key on. The daemon technically lets the load through
      //      while disarmed but immediately fails pre-checks ("System
      //      is not armed. Re-arm, then reload the show."), leaving
      //      the operator in a broken loaded state. Gate it here.
      //   2. Start switch off. The daemon refuses outright with
      //      "Cannot load a show when the START button is active."
      if (!isArmed) return {
        label: "Awaiting ARM",
        variant: "warn",
        disabled: true,
        icon: <FaClock aria-hidden />,
        hint: "Turn the ARM key on before loading.",
      };
      if (startSwActive) return {
        label: "Start switch is ON",
        variant: "danger",
        disabled: true,
        icon: <FaTriangleExclamation aria-hidden />,
        hint: "Turn the show start switch OFF, then load.",
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
    // Post-show. The proto handler settles into STOPPED on natural
    // completion or ABORTED when stopped/errored. The daemon does NOT
    // unload the show or auto-cycle the start switch, so we end up
    // with show_loaded=true, show_running=false, and (typically)
    // start_sw_active still true from before the show. Tell the
    // operator the show is done and what to do next.
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
          ? "Cycle the start switch off to run again, or unload."
          : "Run again, or unload to stage another show.",
      };
    }
    if (waitingClientStart && dstc) return {
      label: "Launch",
      variant: "live",
      onClick: handleStart,
      icon: <FaRocket aria-hidden />,
      hint: "All systems go",
    };
    // Loaded + pre-checks pass, but we haven't yet been handed control to
    // launch. Two physical preconditions on the box: ARM key, then the
    // SHOW START switch. We tell the operator which one is missing rather
    // than parking on a generic "awaiting hardware" message.
    if (isReadyToFire && !waitingClientStart) {
      if (!isArmed) {
        // The daemon does NOT reset start_sw_active when the operator
        // disarms with the start switch still flipped on, so this combo
        // is a real, observable state. Call it out explicitly: if the
        // operator arms again the daemon will be in start-pending and
        // they may have meant to abort instead.
        if (startSwActive) return {
          label: "ARM switch is OFF",
          variant: "danger",
          disabled: true,
          icon: <FaTriangleExclamation aria-hidden />,
          hint: "Start switch is on. Turn the ARM key back on, or cycle the start switch off first.",
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
        label: "Awaiting start switch",
        variant: "warn",
        disabled: true,
        icon: <FaClock aria-hidden />,
        hint: "Turn the show start switch on",
      };
      // Armed + start switch on but the daemon hasn't asserted
      // waiting_for_client_start yet. This is a sub-second transient
      // (WS lag) or means delegate_start_to_client is off and the
      // proto handler is about to take over. Fall through to the
      // generic Standby default below rather than invent a label.
    }
    return {
      label: "Standby",
      variant: "outline",
      disabled: true,
      icon: <FaClock aria-hidden />,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, waitingClientStart, dstc, isShowLoaded, hasErrors, isReadyToFire,
      allReceiversOnline, errors?.length, protoStatus, isArmed, startSwActive]);

  // Status chip describing show pre-checks (calm wording, single source).
  // Note: the T-N countdown is *not* rendered here -- during
  // START_CONFIRMED the top-right slot switches to a dedicated large
  // countdown widget below. This keeps the badge for chrome states only.
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

  // Are we in the seconds-to-start countdown? Only true once the proto
  // handler is confirmed; pre-start hasn't picked a start time yet.
  const inCountdown = isLive && protoStatus === "START_CONFIRMED";

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  const previewDisabled = isShowLoaded || isLive;

  return (
    <Card
      padding="md"
      tone={mode.id === "armed" ? "armed" : mode.id === "live" ? "ok" : "raised"}
      className="flex flex-col gap-3"
    >
      {/* Header: name + status chip + actions overflow */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="eyebrow">Staged show</div>
          <h2 className="text-2xl font-semibold text-fg-primary truncate tracking-tight">
            {stagedShow?.name || "Untitled"}
          </h2>
        </div>

        {inCountdown ? (
          <CountdownDisplay seconds={countdownSeconds} />
        ) : (
          <Badge tone={statusChip.tone} size="md" pulse={statusChip.tone === "live" || statusChip.tone === "armed"}>
            {statusChip.label}
          </Badge>
        )}

        {/* Secondary actions live in the top-right; never compete with primary. */}
        <div className="flex items-center gap-1.5">
          {isShowLoaded && !isLive ? (
            <Button size="sm" variant="outline" onClick={handleUnload}>Unload</Button>
          ) : null}
          {!isShowLoaded && !isLive ? (
            <Button size="sm" variant="ghost" onClick={handleUnstage}>Unstage</Button>
          ) : null}
        </div>
      </div>

      {/* Primary action row: ONE button, hero size. */}
      <div className="flex items-center gap-4 flex-wrap">
        <Button
          size="xl"
          variant={primary.variant}
          onClick={primary.onClick}
          disabled={primary.disabled}
          leading={primary.icon}
          className="min-w-[220px]"
        >
          {primary.label}
        </Button>

        {primary.hint ? (
          <div className="flex flex-col">
            <span className="eyebrow">Next</span>
            <span className="text-sm text-fg-secondary">{primary.hint}</span>
          </div>
        ) : null}

        {!isShowLoaded && !allReceiversOnline ? (
          <span className="inline-flex items-center gap-1.5 text-warn text-xs">
            <FaTriangleExclamation aria-hidden /> Some receivers offline
          </span>
        ) : null}

        {/* Preview cluster: subdued, right-justified. */}
        <div className="ml-auto flex items-center gap-2">
          <MiniWave audioFile={stagedShow?.audioFile} isPlaying={isPlaying || audioIsPlaying} />
          <IconButton
            label={isPlaying ? "Pause preview" : "Play preview"}
            variant="outline"
            disabled={previewDisabled}
            onClick={() => setIsPlaying(!isPlaying)}
          >
            {isPlaying ? <FaPause /> : <FaPlay />}
          </IconButton>
          <Stat
            label="Cursor"
            size="sm"
            numeric
            value={`${formatTime(timeCursor)} / ${formatTime(stagedShow?.duration || 0)}`}
          />
        </div>
      </div>
    </Card>
  );
}
