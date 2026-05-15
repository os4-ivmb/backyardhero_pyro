import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  MdSystemUpdateAlt,
  MdWifi,
  MdWifiOff,
  MdRefresh,
  MdCheckCircle,
  MdWarning,
  MdRestartAlt,
  MdPowerSettingsNew,
  MdCloudDownload,
} from "react-icons/md";
import useStateAppStore from "@/store/useStateAppStore";
import {
  Button,
  Card,
  Badge,
  Modal,
  Toggle,
  cn,
} from "@/design";

// FW_VERSION: System update panel.
// v1.0.0: Initial version. UI driver for host/run/pi/update.sh, talking
//         to /api/system/update. Mirrors DongleFlashPanel's progress-
//         polling + manual-recovery shape but specialised for an
//         update flow whose last step is "kill the container the UI
//         lives in".
const FW_VERSION = "1.0.0";

// Phase -> badge label/tone. Phases are written by byh-update.py; the
// "container_restarting" phase is purely UI-side -- we synthesize it
// when GET starts failing during a restart_mode=service update.
const PHASE_META = {
  idle:                { label: "Idle",            tone: "neutral" },
  preparing:           { label: "Preparing",       tone: "neutral" },
  preflight:           { label: "Connectivity",    tone: "neutral" },
  updating:            { label: "Updating",        tone: "live"    },
  restarting:          { label: "Restarting",      tone: "warn"    },
  rebooting:           { label: "Rebooting",       tone: "warn"    },
  container_restarting: { label: "Restarting",     tone: "warn"    },
  done:                { label: "Done",            tone: "ok"      },
  error:               { label: "Error",           tone: "danger"  },
};

// Phases where a fresh job can NOT be submitted. We use this both for
// the UI gate (button disabled) and for the post-update poll loop's
// "is the job actually finished?" check.
const ACTIVE_PHASES = new Set([
  "preparing", "preflight", "updating",
  "restarting", "rebooting", "container_restarting",
]);

// step -> human label. Mirrors STEP_FROM_SECTION in byh-update.py.
const STEP_LABELS = {
  git_pull:    "Pulling latest source",
  docker_pull: "Pulling latest Docker image",
  install:     "Re-applying system state",
  restart:     "Restarting the host service",
  reboot:      "Rebooting the Pi",
  done:        "Finalising",
};

// Polling cadence while a job is active. Fast enough that the operator
// sees progress lines stream in, slow enough that we're not hammering
// /data with a re-read every render.
const POLL_INTERVAL_MS = 1500;
// During a restart_mode=service update the container is briefly down.
// We back off retries so we don't pile up failed fetches in the
// browser console -- ~500ms initial doubles up to ~5s.
const RETRY_INITIAL_MS = 500;
const RETRY_MAX_MS     = 5000;
// How long after the last successful poll we keep showing
// "container_restarting" before flipping to an error.
const RESTART_GIVEUP_MS = 90_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTimestamp(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString();
  } catch {
    return iso;
  }
}

function fmtElapsed(startIso, endIso) {
  if (!startIso) return "—";
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(start)) return "—";
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (!Number.isFinite(end) || end < start) return "—";
  const t = end - start;
  if (t < 1000) return `${t} ms`;
  if (t < 60_000) return `${(t / 1000).toFixed(1)} s`;
  const m = Math.floor(t / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return `${m}m ${s}s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function UpdateSettings() {
  const { stateData } = useStateAppStore();

  const [open, setOpen] = useState(false);
  const [statusBundle, setStatusBundle] = useState({ status: { phase: "idle" } });
  const [preflight, setPreflight] = useState(null);
  const [preflightLoading, setPreflightLoading] = useState(false);

  // initial fetch -- includes preflight so the Open-flasher button
  // already knows whether we have internet.
  const fetchInitial = useCallback(async () => {
    setPreflightLoading(true);
    try {
      const { data } = await axios.get("/api/system/update?preflight=1");
      setStatusBundle(data);
      if (data.preflight) setPreflight(data.preflight);
    } catch (e) {
      console.error("[UpdateSettings] initial fetch failed:", e);
    } finally {
      setPreflightLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  const status = statusBundle?.status || { phase: "idle" };
  const phase = status.phase || "idle";
  const phaseMeta = PHASE_META[phase] || PHASE_META.idle;
  const isActive = ACTIVE_PHASES.has(phase);

  const isShowLoaded = !!stateData?.fw_state?.show_loaded;
  const isArmed = !!stateData?.fw_state?.device_is_armed;
  const blockedReason = isShowLoaded
    ? "Cannot update while a show is loaded."
    : isArmed
      ? "Cannot update while the system is armed."
      : null;

  const summary = useMemo(() => {
    if (!status || phase === "idle") return "No update in progress.";
    if (phase === "done") {
      const opts = status.options;
      return `Last update OK${opts ? ` (${describeMode(opts)})` : ""}.`;
    }
    if (phase === "error") {
      return status.error || "Last update failed.";
    }
    if (phase === "restarting" || phase === "container_restarting") {
      return "Restarting the host service — the page may briefly disconnect.";
    }
    if (phase === "rebooting") {
      return "Rebooting the Pi — reconnect once it comes back online.";
    }
    if (phase === "preflight") return "Checking internet connectivity…";
    if (phase === "updating") {
      const step = STEP_LABELS[status.step] || "Updating";
      return `${step}…`;
    }
    return phaseMeta.label;
  }, [status, phase, phaseMeta.label]);

  return (
    <div className="flex flex-col gap-3" data-fw-version={FW_VERSION}>
      <p className="text-xs text-fg-muted leading-snug">
        Pull the latest Backyard Hero source from GitHub and the latest
        Docker image from Docker Hub, re-run <code>install.sh</code> to
        re-apply any system-level changes (systemd units, udev rules,
        AP config), then restart the host service so the new image
        starts running. The Pi must have internet access for this to
        do anything useful — there&apos;s a connectivity check in the
        flasher modal.
      </p>

      <div className="flex items-start gap-3 text-sm">
        <div className="flex flex-col">
          <span className="eyebrow">Status</span>
          <span className="text-base text-fg-primary flex items-center gap-2 mt-0.5">
            <Badge tone={phaseMeta.tone}>{phaseMeta.label}</Badge>
            <span className="text-fg-muted text-xs">{summary}</span>
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          leading={<MdSystemUpdateAlt />}
          className="ml-auto"
        >
          Open updater
        </Button>
      </div>

      <UpdateModal
        isOpen={open}
        onClose={() => setOpen(false)}
        statusBundle={statusBundle}
        setStatusBundle={setStatusBundle}
        preflight={preflight}
        setPreflight={setPreflight}
        preflightLoading={preflightLoading}
        setPreflightLoading={setPreflightLoading}
        blockedReason={blockedReason}
      />
    </div>
  );
}

function describeMode(options) {
  const parts = [];
  if (options.do_source)  parts.push("source");
  if (options.do_image)   parts.push("image");
  if (options.do_install) parts.push("install");
  if      (options.restart_mode === "service") parts.push("restart");
  else if (options.restart_mode === "reboot")  parts.push("reboot");
  return parts.join(" + ") || "no-op";
}

function UpdateModal({
  isOpen,
  onClose,
  statusBundle,
  setStatusBundle,
  preflight,
  setPreflight,
  preflightLoading,
  setPreflightLoading,
  blockedReason,
}) {
  // Form state.
  const [doSource, setDoSource]       = useState(true);
  const [doImage, setDoImage]         = useState(true);
  const [doInstall, setDoInstall]     = useState(true);
  const [restartMode, setRestartMode] = useState("service");
  const [forceOffline, setForceOffline] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting]   = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const status = statusBundle?.status || { phase: "idle" };
  const phase = status.phase || "idle";
  const phaseMeta = PHASE_META[phase] || PHASE_META.idle;
  const isActive = ACTIVE_PHASES.has(phase);

  // Reset transient form state when modal opens fresh, but never when
  // it closes -- keeping the choices around means re-opening mid-update
  // shows the same options the operator just submitted.
  const lastOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !lastOpenRef.current) {
      setSubmitError(null);
    }
    lastOpenRef.current = isOpen;
  }, [isOpen]);

  // Polling loop. Runs while the modal is open; pauses when closed
  // (the parent's badge keeps showing the last-known phase so we don't
  // need to hammer the endpoint with the panel hidden).
  //
  // We deliberately re-create the loop only when `isOpen` toggles --
  // re-creating it on every statusBundle change would overlap multiple
  // tick chains. The trade-off is that the closure captures
  // `statusBundle` from one point in time; we work around that by
  // bouncing reads through a ref that's kept in sync via a separate
  // effect below.
  const statusBundleRef = useRef(statusBundle);
  useEffect(() => { statusBundleRef.current = statusBundle; }, [statusBundle]);

  const lastSuccessRef = useRef(Date.now());
  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    let backoff = POLL_INTERVAL_MS;

    const tick = async () => {
      try {
        const { data } = await axios.get("/api/system/update");
        if (cancelled) return;
        setStatusBundle(data);
        lastSuccessRef.current = Date.now();
        backoff = POLL_INTERVAL_MS;
      } catch {
        if (cancelled) return;
        // Failed poll. If we were tracking an active update, the
        // container is probably mid-restart -- synthesise a
        // container_restarting status so the UI doesn't freeze on the
        // last "updating" frame. Read the latest known status through
        // the ref so we don't compare against the snapshot captured
        // when this effect first mounted.
        const elapsed = Date.now() - lastSuccessRef.current;
        const last = statusBundleRef.current?.status;
        const wasActive = last && ACTIVE_PHASES.has(last.phase);
        if (wasActive) {
          if (elapsed > RESTART_GIVEUP_MS) {
            setStatusBundle({
              status: {
                ...last,
                phase: "error",
                error:
                  `No response from /api/system/update for ${Math.round(
                    elapsed / 1000,
                  )}s. The container may have failed to restart. ` +
                  `Check 'journalctl -u byh-host' on the Pi.`,
              },
            });
          } else {
            setStatusBundle({
              status: {
                ...last,
                phase: "container_restarting",
              },
            });
          }
        }
        backoff = Math.min(RETRY_MAX_MS, backoff * 2);
      }
      if (!cancelled) {
        setTimeout(tick, backoff);
      }
    };
    const t = setTimeout(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const refreshPreflight = useCallback(async () => {
    setPreflightLoading(true);
    try {
      const { data } = await axios.get("/api/system/update?preflight=1");
      setStatusBundle(data);
      if (data.preflight) setPreflight(data.preflight);
    } catch (e) {
      console.error("[UpdateSettings] preflight refresh failed:", e);
    } finally {
      setPreflightLoading(false);
    }
  }, [setPreflight, setPreflightLoading, setStatusBundle]);

  const handleStart = useCallback(async () => {
    setSubmitError(null);
    if (blockedReason) {
      setSubmitError(blockedReason);
      return;
    }
    setSubmitting(true);
    try {
      await axios.post("/api/system/update", {
        do_source:   doSource,
        do_image:    doImage,
        do_install:  doInstall,
        restart_mode: restartMode,
        force:       forceOffline,
      });
      // We don't await completion -- update.sh runs for 30s+ and ends
      // by killing this very container. The poll loop below picks the
      // result up from the post-restart status file.
    } catch (e) {
      setSubmitError(e?.response?.data?.error || e.message);
    } finally {
      setSubmitting(false);
    }
  }, [blockedReason, doSource, doImage, doInstall, restartMode, forceOffline]);

  const internetOk     = !!preflight?.internet_ok;
  const internetUnknown = preflight === null;
  const canSubmit = !isActive
    && !submitting
    && !blockedReason
    && (internetOk || forceOffline);

  const noStepsSelected =
    !doSource && !doImage && !doInstall && restartMode === "none";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Update Backyard Hero"
      eyebrow="Pi system update"
      size="2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            leading={<MdSystemUpdateAlt />}
            onClick={handleStart}
            disabled={!canSubmit || noStepsSelected}
            loading={submitting}
          >
            {isActive
              ? "Update in progress…"
              : submitting
                ? "Queueing…"
                : "Start update"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {blockedReason && (
          <div className="flex items-center gap-2 px-3 py-2 bg-warn-bg/60 border border-warn/40 text-warn-fg text-sm rounded-sm">
            <MdWarning /> {blockedReason}
          </div>
        )}

        {submitError && (
          <div className="flex items-center gap-2 px-3 py-2 bg-danger-bg/60 border border-danger/40 text-danger-fg text-sm rounded-sm">
            <MdWarning /> {submitError}
          </div>
        )}

        <ConnectivityCard
          preflight={preflight}
          loading={preflightLoading}
          unknown={internetUnknown}
          onRefresh={refreshPreflight}
        />

        {!isActive && (
          <UpdateOptionsForm
            doSource={doSource} setDoSource={setDoSource}
            doImage={doImage} setDoImage={setDoImage}
            doInstall={doInstall} setDoInstall={setDoInstall}
            restartMode={restartMode} setRestartMode={setRestartMode}
            advancedOpen={advancedOpen} setAdvancedOpen={setAdvancedOpen}
            forceOffline={forceOffline} setForceOffline={setForceOffline}
            internetOk={internetOk}
            internetUnknown={internetUnknown}
          />
        )}

        {(isActive || phase === "done" || phase === "error") && (
          <ProgressCard status={status} phaseMeta={phaseMeta} />
        )}
      </div>
    </Modal>
  );
}

function ConnectivityCard({ preflight, loading, unknown, onRefresh }) {
  const ok = !!preflight?.internet_ok;
  const gh = preflight?.probes?.github;
  const dh = preflight?.probes?.dockerhub;
  return (
    <Card padding="md" tone="inset">
      <div className="flex items-center gap-2 mb-2">
        <span className="eyebrow">Internet connectivity</span>
        <Button
          variant="ghost"
          size="xs"
          leading={<MdRefresh />}
          onClick={onRefresh}
          loading={loading}
          className="ml-auto"
        >
          Re-check
        </Button>
      </div>
      <div className="flex items-center gap-2 text-sm">
        {unknown ? (
          <span className="text-fg-muted inline-flex items-center gap-1">
            <MdRefresh className="animate-spin" /> Checking…
          </span>
        ) : ok ? (
          <span className="text-ok-fg inline-flex items-center gap-1">
            <MdWifi /> Online
          </span>
        ) : (
          <span className="text-warn-fg inline-flex items-center gap-1">
            <MdWifiOff /> No connectivity
          </span>
        )}
      </div>
      {preflight && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 mt-2 text-xs text-fg-muted">
          <ProbeRow label="GitHub"     probe={gh} />
          <ProbeRow label="Docker Hub" probe={dh} />
        </div>
      )}
    </Card>
  );
}

function ProbeRow({ label, probe }) {
  if (!probe) return null;
  return (
    <div className="flex items-center gap-2 truncate">
      <span className="w-24 shrink-0">{label}</span>
      {probe.ok ? (
        <span className="text-ok-fg inline-flex items-center gap-1">
          <MdCheckCircle /> {probe.detail}
        </span>
      ) : (
        <span className="text-warn-fg inline-flex items-center gap-1 truncate">
          <MdWifiOff /> <span className="truncate">{probe.detail}</span>
        </span>
      )}
    </div>
  );
}

function UpdateOptionsForm({
  doSource, setDoSource,
  doImage,  setDoImage,
  doInstall, setDoInstall,
  restartMode, setRestartMode,
  advancedOpen, setAdvancedOpen,
  forceOffline, setForceOffline,
  internetOk, internetUnknown,
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 text-sm">
        <span className="eyebrow">After the update</span>
        <RestartModeRadio
          value={restartMode}
          onChange={setRestartMode}
        />
      </div>

      <button
        type="button"
        className="self-start text-xs text-fg-muted hover:text-fg-primary underline"
        onClick={() => setAdvancedOpen((v) => !v)}
      >
        {advancedOpen ? "Hide advanced options" : "Show advanced options"}
      </button>

      {advancedOpen && (
        <Card padding="md" tone="inset">
          <div className="flex flex-col gap-3 text-sm">
            <span className="eyebrow">Update steps</span>
            <ToggleRow
              checked={doSource}
              onChange={setDoSource}
              title="Pull latest source"
              hint="git pull --ff-only in the repo. Updates host scripts (install.sh, update.sh, AP config). Skip if you've made local edits to the repo on the Pi."
            />
            <ToggleRow
              checked={doImage}
              onChange={setDoImage}
              title="Pull latest Docker image"
              hint="docker compose pull. Updates the Next.js app + Python daemon to the newest os4ivmb/backyardhero:latest. This is where most updates actually live."
            />
            <ToggleRow
              checked={doInstall}
              onChange={setDoInstall}
              title="Re-run install.sh"
              hint="Re-applies system state (systemd units, udev rules, AP config). Idempotent. Skip if you know nothing system-level changed."
            />

            <div className="border-t border-border-subtle my-1" />

            <span className="eyebrow">If offline</span>
            <ToggleRow
              checked={forceOffline}
              onChange={setForceOffline}
              title="Run anyway"
              hint="Continue even though the connectivity check failed. The git/docker steps will likely fail but a re-install + restart still works."
              warn={!internetOk && !internetUnknown}
            />
          </div>
        </Card>
      )}
    </div>
  );
}

function RestartModeRadio({ value, onChange }) {
  const options = [
    {
      key: "service",
      label: "Restart host service",
      hint: "~15s. Stops + restarts byh-host.service so the new Docker image becomes the running container. The web UI briefly disconnects.",
      icon: <MdRestartAlt />,
    },
    {
      key: "reboot",
      label: "Reboot the Pi",
      hint: "~45s. Use after install.sh changed something at the systemd / udev / sysctl level that needs a clean boot to take effect.",
      icon: <MdPowerSettingsNew />,
    },
    {
      key: "none",
      label: "Don't restart",
      hint: "Pull the new bits but keep running the old image until the next manual restart. Useful for staging an update overnight.",
      icon: <MdCloudDownload />,
    },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      {options.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            className={cn(
              "flex flex-col items-start gap-1 text-left p-3 rounded-sm border transition-colors",
              active
                ? "border-accent bg-accent/10 text-fg-primary"
                : "border-border bg-surface hover:border-border-strong text-fg-secondary",
            )}
          >
            <span className="inline-flex items-center gap-2 text-sm font-semibold">
              {o.icon} {o.label}
            </span>
            <span className="text-xs text-fg-muted leading-snug">
              {o.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ToggleRow({ checked, onChange, title, hint, warn }) {
  // Toggle is itself a <label>, so we feed it our title/hint via its
  // built-in label/description props rather than wrapping with another
  // <label> (nested labels are invalid HTML and break click-to-toggle).
  return (
    <Toggle
      checked={checked}
      onChange={onChange}
      label={
        <span className={cn(warn ? "text-warn-fg" : undefined)}>
          {title}
        </span>
      }
      description={hint}
    />
  );
}

function ProgressCard({ status, phaseMeta }) {
  const phase = status?.phase || "idle";
  const step  = status?.step;
  const stepLabel = STEP_LABELS[step] || (step || null);
  const log = Array.isArray(status?.log_tail) ? status.log_tail : [];

  return (
    <Card padding="md" tone="inset">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone={phaseMeta.tone}>{phaseMeta.label}</Badge>
          {stepLabel && phase !== "done" && phase !== "error" && (
            <span className="text-sm text-fg-secondary">
              {stepLabel}…
            </span>
          )}
          {phase === "done" && (
            <span className="text-sm text-ok-fg inline-flex items-center gap-1">
              <MdCheckCircle /> Update complete
            </span>
          )}
          {phase === "error" && status?.error && (
            <span className="text-sm text-danger-fg truncate max-w-[36rem]">
              {status.error}
            </span>
          )}
        </div>
        <div className="text-xs text-fg-muted whitespace-nowrap">
          {fmtElapsed(status?.started_at, status?.ended_at)}
        </div>
      </div>

      {(phase === "restarting" || phase === "container_restarting" || phase === "rebooting") && (
        <div className="flex items-start gap-2 text-xs text-warn-fg bg-warn-bg/40 border border-warn/30 rounded-sm px-3 py-2 mb-2">
          <MdRestartAlt className="mt-0.5 shrink-0 animate-pulse" />
          <div className="leading-snug">
            {phase === "rebooting"
              ? "The Pi is rebooting. Reconnect to its WiFi network in ~45s, then reload this page."
              : "The host service is restarting. This page will briefly disconnect; it should refresh on its own once the new container is up."}
          </div>
        </div>
      )}

      {log.length > 0 && (
        <pre className="max-h-48 overflow-auto text-[11px] leading-snug text-fg-muted bg-bg-deep p-2 rounded font-mono whitespace-pre-wrap break-all">
          {log.join("\n")}
        </pre>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-fg-muted tabular-nums num">
        <span>started: {fmtTimestamp(status?.started_at)}</span>
        <span>updated: {fmtTimestamp(status?.updated_at)}</span>
        {status?.exit_code != null && (
          <span>update.sh exit {status.exit_code}</span>
        )}
      </div>
    </Card>
  );
}
