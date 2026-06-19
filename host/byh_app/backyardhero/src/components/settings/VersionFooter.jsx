import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  MdRefresh,
  MdCheckCircle,
  MdMemory,
  MdComputer,
  MdRestartAlt,
  MdCloudDownload,
} from "react-icons/md";
import useStateAppStore from "@/store/useStateAppStore";
import useAppStore from "@/store/useAppStore";
import { Badge, Button } from "@/design";
import { HARDWARE } from "@/util/clientEnv";
import { fwOutOfDate } from "@/util/firmwareVersion";

// Settings footer: shows the running Host (desktop app) + Dongle firmware
// versions and whether newer ones are available. Host updates are driven by
// the Electron auto-updater (it downloads in the background and prompts to
// restart); this surface mirrors its state via /api/system/host_update and
// offers a "Restart & install" once an update is downloaded. Dongle freshness
// reuses the existing firmware-latest plumbing (DongleFlashPanel does the
// actual flashing).

// The footer polls host_update while mounted so it reflects the background
// auto-updater (which checks 15s after launch, then every 6h, entirely in the
// Electron main process). We poll slowly when idle so a background
// check/download that starts while Settings is open still surfaces as
// "Downloading…"/"Update ready" without the operator hitting refresh, and
// fast once an update is actively in flight.
const ACTIVE_POLL_MS = 3000;
const IDLE_POLL_MS = 15000;
const ACTIVE_PHASES = new Set(["checking", "downloading"]);

export default function VersionFooter() {
  const { stateData } = useStateAppStore();
  const { latestFirmware, fetchLatestFirmware, systemConfig } = useAppStore();

  const [host, setHost] = useState(null); // /api/system/host_update payload
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const pollRef = useRef(null);

  const fetchHostUpdate = useCallback(async (refresh = false) => {
    try {
      const { data } = await axios.get("/api/system/host_update", {
        params: refresh ? { refresh: 1 } : undefined,
      });
      setHost(data);
      return data;
    } catch (e) {
      // Non-desktop / offline: leave host info null so we just don't render
      // the host row's update controls.
      return null;
    }
  }, []);

  useEffect(() => {
    fetchHostUpdate(false);
  }, [fetchHostUpdate]);

  // Poll continuously while mounted so a background check/download surfaces on
  // its own. Self-scheduling timeout picks the cadence from the latest phase:
  // fast (3s) while checking/downloading, slow (15s) otherwise. This is what
  // lets the badge move idle -> Downloading X% -> Update ready without the
  // operator pressing "Check for updates".
  useEffect(() => {
    let cancelled = false;
    const schedule = (ms) => {
      pollRef.current = setTimeout(tick, ms);
    };
    const tick = async () => {
      const data = await fetchHostUpdate(false);
      if (cancelled) return;
      const active = ACTIVE_PHASES.has(data?.updater?.phase);
      schedule(active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    schedule(IDLE_POLL_MS);
    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [fetchHostUpdate]);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    try {
      // Dongle: refresh the static-site firmware manifest (shared store).
      // Host: bypass the manifest TTL and, on desktop, nudge the Electron
      // updater to re-check its feed too.
      await Promise.all([
        fetchLatestFirmware(true),
        fetchHostUpdate(true),
      ]);
      if (host?.isDesktop) {
        try {
          await axios.post("/api/system/host_update", { action: "check" });
        } catch {
          /* best effort */
        }
        // Give the updater a beat to write its status, then refresh.
        setTimeout(() => fetchHostUpdate(false), 1500);
      }
    } finally {
      setChecking(false);
    }
  }, [fetchLatestFirmware, fetchHostUpdate, host?.isDesktop]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    try {
      await axios.post("/api/system/host_update", { action: "install" });
    } catch {
      setInstalling(false);
    }
    // No reset on success: the app is about to quit + relaunch.
  }, []);

  // Hardware-only surface. The cloud authoring build has no host/dongle.
  if (!HARDWARE) return null;

  const runningHost = host?.running || systemConfig?.host?.app_version || null;
  const isDesktop = !!host?.isDesktop;
  const latestHostVersion = host?.latest?.available ? host.latest.version : null;
  const hostStale = !!host?.latest?.stale;

  const dongleFw = stateData?.fw_state?.dongle_fw_version ?? null;
  const latestDongle = latestFirmware?.dongle?.available
    ? latestFirmware.dongle
    : null;
  const latestDongleVersion = latestDongle?.version ?? null;
  const dongleOutOfDate = fwOutOfDate(dongleFw, latestDongleVersion);

  return (
    <div className="mt-8 pt-4 border-t border-border-subtle">
      <div className="flex items-center justify-between gap-3 mb-3">
        <span className="eyebrow">Versions</span>
        <Button
          variant="ghost"
          size="xs"
          onClick={handleCheck}
          leading={<MdRefresh className={checking ? "animate-spin" : ""} />}
          disabled={checking}
        >
          Check for updates
        </Button>
      </div>

      <div className="flex flex-col gap-2 text-sm">
        <HostRow
          running={runningHost}
          isDesktop={isDesktop}
          latestVersion={latestHostVersion}
          outOfDate={!!host?.outOfDate}
          stale={hostStale}
          updater={host?.updater}
          installing={installing}
          onInstall={handleInstall}
        />
        <DongleRow
          running={dongleFw}
          latestVersion={latestDongleVersion}
          outOfDate={dongleOutOfDate}
          stale={!!latestDongle?.stale}
        />
      </div>
    </div>
  );
}

function VersionLine({ icon, label, value, children }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-fg-muted text-base shrink-0">{icon}</span>
      <span className="eyebrow w-16 shrink-0">{label}</span>
      <span className="font-mono text-fg-primary num">{value}</span>
      {children}
    </div>
  );
}

function HostRow({
  running,
  isDesktop,
  latestVersion,
  outOfDate,
  stale,
  updater,
  installing,
  onInstall,
}) {
  const phase = updater?.phase;
  const pct = updater?.progress_pct;

  let badge = null;
  let action = null;

  if (phase === "downloaded") {
    badge = <Badge tone="ok" size="xs">Update ready</Badge>;
    action = (
      <Button
        variant="primary"
        size="xs"
        leading={<MdRestartAlt />}
        onClick={onInstall}
        loading={installing}
        disabled={installing}
        title={`Restart and install v${updater?.available_version ?? latestVersion ?? ""}`}
      >
        Restart &amp; install
      </Button>
    );
  } else if (phase === "downloading") {
    badge = (
      <Badge tone="live" size="xs">
        Downloading{typeof pct === "number" ? ` ${pct}%` : "…"}
      </Badge>
    );
  } else if (outOfDate && latestVersion) {
    badge = (
      <Badge tone="warn" size="xs" title={`v${latestVersion} available`}>
        Update v{latestVersion} available
      </Badge>
    );
    // On the desktop the updater auto-downloads; show a hint rather than a
    // manual button. Off-desktop (Pi/docker) host updates live in the
    // Network → System update panel.
    if (!isDesktop) {
      action = (
        <span className="text-xs text-fg-muted inline-flex items-center gap-1">
          <MdCloudDownload /> Update via System update
        </span>
      );
    }
  } else if (running) {
    badge = (
      <Badge tone="neutral" size="xs">
        <span className="inline-flex items-center gap-1">
          <MdCheckCircle className="text-ok-fg" /> Up to date
        </span>
      </Badge>
    );
  }

  const value = running ? `v${running}` : "—";

  return (
    <VersionLine icon={<MdComputer />} label="Host" value={value}>
      {badge}
      {action}
      {stale && (
        <span className="text-2xs text-fg-muted">(cached — couldn&apos;t reach server)</span>
      )}
      {phase === "error" && updater?.error && (
        <span className="text-2xs text-danger-fg truncate max-w-[20rem]" title={updater.error}>
          updater: {updater.error}
        </span>
      )}
    </VersionLine>
  );
}

function DongleRow({ running, latestVersion, outOfDate, stale }) {
  let badge = null;
  if (outOfDate && latestVersion) {
    badge = (
      <Badge
        tone="warn"
        size="xs"
        title="Flash in Settings → Debug → Dongle firmware update"
      >
        Update v{latestVersion} available
      </Badge>
    );
  } else if (running != null && latestVersion != null) {
    badge = (
      <Badge tone="neutral" size="xs">
        <span className="inline-flex items-center gap-1">
          <MdCheckCircle className="text-ok-fg" /> Up to date
        </span>
      </Badge>
    );
  }

  const value = running != null ? `v${running}` : "unknown";

  return (
    <VersionLine icon={<MdMemory />} label="Dongle" value={value}>
      {badge}
      {stale && (
        <span className="text-2xs text-fg-muted">(cached — couldn&apos;t reach server)</span>
      )}
    </VersionLine>
  );
}
