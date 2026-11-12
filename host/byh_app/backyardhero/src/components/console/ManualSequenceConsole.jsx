import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  FaArrowLeft, FaArrowRight, FaCircleCheck, FaKey, FaPlay, FaStop, FaTriangleExclamation,
} from "react-icons/fa6";
import { MdOutlineSwapHoriz } from "react-icons/md";

import useAppStore from "@/store/useAppStore";
import useStateAppStore, { serverElapsedMs } from "@/store/useStateAppStore";
import useAppMode from "@/design/useAppMode";
import { Card, Button, Badge, Dot, cn } from "@/design";
import { itemColorOf, getTypeLabel } from "@/constants";
import usePersistentState from "@/utils/usePersistentState";
import { isPollableReceiver } from "@/util/receivers";
import {
  RECEIVER_KIND_BILUSOCN,
  RECEIVER_KIND_NATIVE,
  isBilusocnEntry,
} from "@/util/showReceivers";
import {
  STEP_FIRE_STAGGERED,
  eventMatchesFireKey,
  groupItemsIntoSteps,
  reconcileSequence,
  showConfigOf,
} from "@/util/showConfig";
import ShowHealthStrip from "./ShowHealthStrip";
import { setStepPressHandler, useStepButtonBound } from "@/util/stepHardwareButton";

// ---------------------------------------------------------------------------
// Console for manual-sequence shows. There is no load / countdown: each step
// is fired with the daemon's existing `manual_fire` command (one per cue), so
// the box must be in the same state manual fire needs -- ARM key, start
// switch and manual-fire key all on.
//
//   Start  arms the operator's fire key. Each press fires the current step
//          and advances the carousel. Interval steps send their cues top
//          to bottom, `intervalMs` apart; Stop, a lost precondition or
//          leaving the console cancels any cues not yet sent.
//   Jog    always available. Disarms the fire key and lets ←/→ pick a step;
//          Start must be pressed again before the fire key is live.
// ---------------------------------------------------------------------------

// Ignore a second fire-key press this soon after the last one so a bouncy
// clicker can't skip a step.
const FIRE_LOCKOUT_MS = 250;

function isEditableTarget(el) {
  const tag = el?.tagName;
  return !!el?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function StepCard({ step, variant, itemStatus, receiverLabels, fired }) {
  const current = variant === "current";
  const staggered = step.fireMode === STEP_FIRE_STAGGERED && step.items.length > 1;
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-md border bg-surface-2 transition-all duration-300 ease-snap",
        current && "w-80 lg:w-96 min-h-[18rem] border-2 p-4",
        variant === "prev" && "w-44 min-h-[11rem] p-3 opacity-35 border-border-subtle",
        variant === "next" && "w-52 min-h-[13rem] p-3 opacity-75 border-border",
        variant === "next2" && "w-44 min-h-[11rem] p-3 opacity-55 border-border-subtle",
        current && fired?.live ? "border-live shadow-live" : current && "border-border-strong shadow-e3",
      )}
      aria-current={current ? "step" : undefined}
    >
      <span
        className={cn(
          "absolute right-3 top-2 num font-bold tabular-nums leading-none",
          current ? "text-5xl text-fg-primary" : "text-2xl text-fg-secondary"
        )}
      >
        {step.number}
      </span>
      <div className={cn("eyebrow", current ? "mb-1" : "mb-0.5")}>
        {variant === "prev" ? (fired?.prev ? "Fired" : "Previous") : current ? "Current step" : "Up next"}
      </div>
      <div className={cn("text-2xs text-fg-muted pr-10", current ? "mb-3" : "mb-2")}>
        {staggered ? `Interval · ${step.intervalMs}ms apart` : "Fire All"}
      </div>
      <div className={cn("flex flex-col pr-10", current ? "gap-2" : "gap-1")}>
        {step.items.length === 0 ? (
          <div className="text-xs text-fg-muted">No cues in this step</div>
        ) : null}
        {step.items.map((item, itemIndex) => {
          const status = itemStatus(item);
          return (
            <div
              key={item.id}
              className={cn(
                "flex items-stretch gap-2 rounded-sm border border-border-subtle bg-surface-1",
                current ? "pr-2" : "pr-1"
              )}
            >
              <span
                className="w-1.5 shrink-0 rounded-l-sm"
                style={{ backgroundColor: itemColorOf(item) }}
                aria-hidden
              />
              <div className={cn("min-w-0 flex-1", current ? "py-1.5" : "py-1")}>
                <div className={cn("truncate font-medium text-fg-primary", current ? "text-base" : "text-xs")}>
                  {item.name || getTypeLabel(item.type) || "Cue"}
                </div>
                {current ? (
                  <div className="truncate text-2xs text-fg-muted">
                    {getTypeLabel(item.type)} · {receiverLabels?.[item.zone] || item.zone}:{item.target}
                  </div>
                ) : null}
              </div>
              {staggered && current ? (
                <span className="self-center num text-2xs tabular-nums text-fg-muted">
                  +{itemIndex * step.intervalMs}ms
                </span>
              ) : null}
              <span className="self-center" title={status.title}>
                <Dot tone={status.tone} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ManualSequenceConsole() {
  const { stagedShow, setStagedShow, systemConfig } = useAppStore();
  const { stateData } = useStateAppStore();
  const { wsAlive, daemonActive, isArmed, startSwActive, isManualFire, isShowLoaded } = useAppMode();

  const config = useMemo(() => showConfigOf(stagedShow), [stagedShow]);
  const steps = useMemo(() => {
    const r = reconcileSequence(config.steps, stagedShow?.items);
    return groupItemsIntoSteps(r.steps, r.items);
  }, [config.steps, stagedShow?.items]);
  const fireKey = config.fireKey;
  const hardwareButton = useStepButtonBound();

  // Position survives a page reload mid-show. `steps.length` means "past the
  // last step" (sequence complete).
  const [cursor, setCursor] = usePersistentState(`byh.sequence.cursor.${stagedShow?.id}`, 0);
  const index = Math.max(0, Math.min(Number(cursor) || 0, steps.length));
  const complete = steps.length > 0 && index >= steps.length;

  const [started, setStarted] = useState(false);
  const [jogging, setJogging] = useState(false);
  const [fireError, setFireError] = useState(null);
  const [lastFired, setLastFired] = useState(null);

  const kindByZone = useMemo(() => {
    const out = {};
    for (const entry of stagedShow?.showReceivers || []) {
      if (entry?.id != null) {
        out[String(entry.id)] = isBilusocnEntry(entry) ? RECEIVER_KIND_BILUSOCN : RECEIVER_KIND_NATIVE;
      }
    }
    return out;
  }, [stagedShow?.showReceivers]);

  const receivers = stateData.fw_state?.receivers || systemConfig?.receivers || {};
  const receiverTimeoutMs = stateData.fw_state?.settings?.receiver_timeout_ms || 10_000;
  const itemStatus = (item) => {
    if (kindByZone[String(item.zone)] === RECEIVER_KIND_BILUSOCN) {
      return { tone: "neutral", title: "433 MHz one-way TX (no status)" };
    }
    const r = Object.values(receivers).find(
      (rx) => isPollableReceiver(rx) && rx.cues?.[item.zone]?.includes(item.target)
    );
    if (!r) return { tone: "neutral", title: "No status from this receiver" };
    const lmt = r.status?.lmt;
    const online = lmt ? serverElapsedMs(lmt, stateData) <= receiverTimeoutMs : r.connectionStatus === "good";
    return online
      ? { tone: "ok", title: "Receiver online" }
      : { tone: "danger", title: "Receiver offline" };
  };

  const receiverLabels = useMemo(() => {
    const out = {};
    for (const entry of stagedShow?.showReceivers || []) {
      if (entry?.id && entry.label) out[entry.id] = entry.label;
    }
    return out;
  }, [stagedShow?.showReceivers]);

  // Everything the daemon's manual-fire path checks, plus what the console
  // itself needs. Listed in the order the operator should resolve them: the
  // daemon logs an error if the start switch flips before ARM / manual fire.
  const checks = [
    { id: "link", ok: wsAlive && daemonActive, label: "Controller link", fix: "Telemetry from the firing controller is stale." },
    { id: "loaded", ok: !isShowLoaded, label: "No timeline show loaded", fix: "Unload the loaded show first." },
    { id: "arm", ok: isArmed, label: "ARM key on", fix: "Turn the ARM key on the box." },
    { id: "manual", ok: isManualFire, label: "Manual fire key on", fix: "Turn the manual fire key on the box." },
    { id: "start", ok: startSwActive, label: "Show start switch on", fix: "Turn the show start switch on." },
    {
      id: "firekey",
      ok: !!fireKey || hardwareButton != null,
      label: hardwareButton ? `Input ${hardwareButton} bound` : "Fire key set",
      fix: "Bind a hardware button on the status strip, or set a fire key in Editor → Show Details.",
    },
    { id: "steps", ok: steps.length > 0, label: "Steps defined", fix: "Add steps to this show in the Editor." },
  ];
  const blocker = checks.find((c) => !c.ok) || null;
  const ready = !blocker;
  const canStart = ready && !complete;

  // Interval-step cues still waiting for their slot: timeout id -> resolver
  // that settles the cue as cancelled.
  const pendingFiresRef = useRef(new Map());
  const cancelPendingFires = useCallback(() => {
    for (const [t, cancel] of pendingFiresRef.current) {
      clearTimeout(t);
      cancel();
    }
    pendingFiresRef.current.clear();
  }, []);
  useEffect(() => cancelPendingFires, [cancelPendingFires]);

  // Losing any precondition (key turned off, link drop, ...) disarms the
  // fire key and drops unsent interval cues; the operator has to press
  // Start again.
  useEffect(() => {
    if (started && !canStart) setStarted(false);
  }, [started, canStart]);
  useEffect(() => {
    if (!ready) cancelPendingFires();
  }, [ready, cancelPendingFires]);

  const fireLockRef = useRef(0);
  const fireCurrent = useCallback(async () => {
    const now = Date.now();
    if (now - fireLockRef.current < FIRE_LOCKOUT_MS) return;
    const step = steps[index];
    if (!step) return;
    fireLockRef.current = now;
    const next = index + 1;
    setCursor(next);
    if (next >= steps.length) setStarted(false);
    setFireError(null);

    const sendFire = (item) => {
      const kind = kindByZone[String(item.zone)] || RECEIVER_KIND_NATIVE;
      return axios.post(
        "/api/system/cmd_daemon",
        {
          type: "manual_fire",
          data: {
            zone: kind === RECEIVER_KIND_BILUSOCN ? String(item.zone) : item.zone,
            target: Number(item.target),
            kind,
          },
        },
        { headers: { "Content-Type": "application/json" } },
      );
    };
    const CANCELLED = Symbol("cancelled");
    const spacingMs = step.fireMode === STEP_FIRE_STAGGERED ? step.intervalMs : 0;
    const results = await Promise.allSettled(
      step.items.map((item, i) => {
        if (i === 0 || !spacingMs) return sendFire(item);
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            pendingFiresRef.current.delete(t);
            sendFire(item).then(resolve, reject);
          }, i * spacingMs);
          pendingFiresRef.current.set(t, () => resolve(CANCELLED));
        });
      })
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    const cancelled = results.filter((r) => r.status === "fulfilled" && r.value === CANCELLED).length;
    setLastFired({ number: step.number, at: now, failed });
    const problems = [];
    if (failed) {
      problems.push(`${failed} of ${step.items.length} fire command${step.items.length === 1 ? "" : "s"} failed to send`);
    }
    if (cancelled) {
      problems.push(`${cancelled} cue${cancelled === 1 ? " was" : "s were"} cancelled before firing`);
    }
    if (problems.length) setFireError(`Step ${step.number}: ${problems.join("; ")}.`);
  }, [steps, index, kindByZone, setCursor]);

  const jog = useCallback(
    (delta) => setCursor((c) => {
      const last = Math.max(0, steps.length - 1);
      return Math.max(0, Math.min(last, (Number(c) || 0) + delta));
    }),
    [steps.length, setCursor]
  );

  const keyStateRef = useRef({});
  keyStateRef.current = { started, jogging, fireKey, fireCurrent, jog };
  const fireRef = useRef(fireCurrent);
  fireRef.current = fireCurrent;
  const startedRef = useRef(started);
  startedRef.current = started;
  useEffect(() => setStepPressHandler(() => {
    if (startedRef.current) fireRef.current();
  }), []);
  useEffect(() => {
    const onKey = (e) => {
      const s = keyStateRef.current;
      if (isEditableTarget(e.target)) return;
      if (typeof document !== "undefined" && document.querySelector('[role="dialog"]')) return;
      if (s.started && eventMatchesFireKey(e, s.fireKey)) {
        e.preventDefault();
        if (!e.repeat) s.fireCurrent();
        return;
      }
      if (s.jogging && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        s.jog(e.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Buttons keep focus after a click; a focused button would also "click" on
  // Space/Enter, so drop focus whenever the controls change state.
  const blurActive = () => {
    if (typeof document !== "undefined") document.activeElement?.blur?.();
  };

  const handleStart = () => {
    blurActive();
    setJogging(false);
    if (started) cancelPendingFires();
    setStarted((v) => !v);
  };

  const handleJog = () => {
    blurActive();
    cancelPendingFires();
    setStarted(false);
    setJogging((v) => !v);
  };

  const handleUnstage = () => {
    cancelPendingFires();
    setStarted(false);
    setStagedShow({});
  };

  const prev = steps[index - 1];
  const current = steps[index];
  const next1 = steps[index + 1];
  const next2 = steps[index + 2];
  const firedPrev = lastFired && prev && lastFired.number === prev.number;

  const statusChip = started
    ? { tone: "live", label: "Fire key live", pulse: true }
    : jogging
    ? { tone: "accent", label: "Jog", pulse: false }
    : complete
    ? { tone: "ok", label: "Sequence complete", pulse: false }
    : ready
    ? { tone: "neutral", label: "Ready to start", pulse: false }
    : { tone: "warn", label: "Not ready", pulse: false };

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-3">
      <Card padding="md" tone={started ? "armed" : "raised"} className="flex flex-col gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="eyebrow">Staged show · Manual sequence</div>
            <h2 className="text-2xl font-semibold text-fg-primary truncate tracking-tight">
              {stagedShow?.name || "Untitled"}
            </h2>
          </div>
          <Badge tone={statusChip.tone} size="md" pulse={statusChip.pulse}>
            {statusChip.label}
          </Badge>
          {!started ? (
            <Button size="sm" variant="ghost" onClick={handleUnstage}>Unstage</Button>
          ) : null}
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          <Button
            size="xl"
            variant={started ? "danger" : "live"}
            onClick={handleStart}
            disabled={!started && !canStart}
            leading={started ? <FaStop aria-hidden /> : <FaPlay aria-hidden />}
            className="min-w-[200px]"
          >
            {started ? "Stop" : "Start"}
          </Button>
          <Button
            size="xl"
            variant={jogging ? "primary" : "outline"}
            onClick={handleJog}
            leading={<MdOutlineSwapHoriz className="text-2xl" aria-hidden />}
            className="min-w-[140px]"
            aria-pressed={jogging}
          >
            Jog
          </Button>
          {jogging ? (
            <div className="flex items-center gap-1.5">
              <Button size="lg" variant="outline" onClick={() => jog(-1)} aria-label="Previous step">
                <FaArrowLeft aria-hidden />
              </Button>
              <Button size="lg" variant="outline" onClick={() => jog(1)} aria-label="Next step">
                <FaArrowRight aria-hidden />
              </Button>
            </div>
          ) : null}

          <div className="ml-auto flex items-baseline gap-2" aria-live="polite">
            <span className="eyebrow">Step</span>
            <span className="num text-display font-bold tabular-nums text-fg-primary">
              {complete ? "✓" : steps.length ? index + 1 : "—"}
            </span>
            <span className="num text-xl text-fg-muted tabular-nums">/ {steps.length}</span>
          </div>
        </div>

        {started ? (
          <div className="flex items-center gap-3 rounded-md border-2 border-live/70 bg-live/10 px-4 py-3 shadow-live">
            <FaKey className="text-2xl text-live shrink-0" aria-hidden />
            <div className="min-w-0">
              <div className="eyebrow text-live animate-livePulse">Fire key live</div>
              <div className="text-lg font-semibold text-live-fg">
                Press{" "}
                {fireKey ? (
                  <kbd className="mx-1 rounded border border-live/60 bg-surface-base/60 px-2 py-0.5 font-mono">{fireKey.label}</kbd>
                ) : null}
                {fireKey && hardwareButton ? " or " : null}
                {hardwareButton ? <span className="font-mono">input {hardwareButton}</span> : null}
                {" "}to fire step {index + 1}
              </div>
            </div>
          </div>
        ) : jogging ? (
          <div className="flex items-center gap-3 rounded-md border border-accent/50 bg-accent-muted/30 px-4 py-3">
            <MdOutlineSwapHoriz className="text-2xl text-accent shrink-0" aria-hidden />
            <div className="text-sm text-fg-secondary">
              Use <kbd className="font-mono text-fg-primary">←</kbd> / <kbd className="font-mono text-fg-primary">→</kbd> to
              choose a step. The fire key is disarmed — press <span className="font-semibold text-fg-primary">Start</span> to re-arm it.
            </div>
          </div>
        ) : blocker ? (
          <div className="flex items-start gap-2 rounded-sm border border-warn/40 bg-warn-bg/40 px-3 py-2 text-sm text-warn-fg">
            <FaTriangleExclamation className="mt-0.5 shrink-0" aria-hidden />
            <div>{blocker.fix}</div>
          </div>
        ) : complete ? (
          <div className="flex items-center gap-2 rounded-sm border border-ok/40 bg-ok-bg/40 px-3 py-2 text-sm text-ok-fg">
            <FaCircleCheck className="shrink-0" aria-hidden />
            <div>All {steps.length} steps fired. Jog back to fire a step again.</div>
          </div>
        ) : (
          <div className="text-sm text-fg-secondary">
            Press <span className="font-semibold text-fg-primary">Start</span> to arm step fire
            {fireKey ? <> (<span className="font-mono text-fg-primary">{fireKey.label}</span>)</> : null}
            {hardwareButton ? <> (input {hardwareButton})</> : null}.
          </div>
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {checks.filter((c) => c.id !== "loaded" || !c.ok).map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1.5 text-xs text-fg-secondary">
              <Dot tone={c.ok ? "ok" : "warn"} /> {c.label}
            </span>
          ))}
        </div>

        {fireError ? (
          <div className="flex items-start gap-2 rounded-sm border border-danger/40 bg-danger-bg/60 px-3 py-2 text-xs text-danger-fg">
            <FaTriangleExclamation className="mt-0.5 shrink-0" aria-hidden />
            <div>{fireError}</div>
          </div>
        ) : null}
      </Card>

      <ShowHealthStrip connectivityOnly />

      <Card padding="none" tone="inset" className="overflow-hidden">
        {steps.length === 0 ? (
          <div className="p-10 text-center text-sm text-fg-muted">
            This show has no steps yet. Add some in the Editor.
          </div>
        ) : (
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 py-8 min-h-[22rem]">
            <div className="hidden md:flex justify-end">
              {prev ? (
                <StepCard
                  step={prev}
                  variant="prev"
                  itemStatus={itemStatus}
                  receiverLabels={receiverLabels}
                  fired={{ prev: firedPrev }}
                />
              ) : null}
            </div>
            <div className="flex justify-center col-span-3 md:col-span-1">
              {current ? (
                <StepCard
                  key={current.id}
                  step={current}
                  variant="current"
                  itemStatus={itemStatus}
                  receiverLabels={receiverLabels}
                  fired={{ live: started }}
                />
              ) : (
                <div className="w-80 lg:w-96 min-h-[18rem] flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-ok/50 text-ok-fg">
                  <FaCircleCheck className="text-4xl" aria-hidden />
                  <div className="text-lg font-semibold">Sequence complete</div>
                </div>
              )}
            </div>
            <div className="hidden md:flex justify-start items-center gap-3">
              {next1 ? (
                <StepCard step={next1} variant="next" itemStatus={itemStatus} receiverLabels={receiverLabels} />
              ) : null}
              {next2 ? (
                <StepCard step={next2} variant="next2" itemStatus={itemStatus} receiverLabels={receiverLabels} />
              ) : null}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
