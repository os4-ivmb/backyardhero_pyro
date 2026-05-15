import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  MdSystemUpdateAlt,
  MdWarning,
  MdCheckCircle,
  MdStop,
  MdReplay,
  MdMemory,
} from "react-icons/md";
import useStateAppStore from "@/store/useStateAppStore";
import { Button, Card, Badge, Modal, cn } from "@/design";

// FW_VERSION: Dongle firmware update panel
// v1.0.0: Initial multi-file version (app + boot_app0, optional full reflash).
// v1.1.0: Simplified to a single-.bin upload. The dongle ships with firmware
//         already on it and never self-OTAs, so a UI flash is *only* ever
//         "push a new app". Bootloader / partitions / boot_app0 don't change
//         between builds and don't need re-uploading. Full reflash stays
//         available via the CLI (devices/utils/flash_dongle.py --full).
const FW_VERSION = "1.1.0";

// Cap on the uploaded app .bin. Mirrors MAX_IMAGE_BYTES in the API
// endpoint. The dongle's app sits around ~340KB; 4MB is generous
// headroom for any future partition scheme that gives it more code
// space.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Phase -> label + tone. Matches the bridge's FlashJob.PHASES set.
const PHASE_META = {
  idle:               { label: "Idle",               tone: "neutral" },
  preparing:          { label: "Preparing",          tone: "neutral" },
  connecting:         { label: "Connecting",         tone: "neutral" },
  writing:            { label: "Writing",            tone: "live"    },
  verifying:          { label: "Verifying",          tone: "warn"    },
  rebooting:          { label: "Rebooting",          tone: "warn"    },
  needs_manual_reset: { label: "Manual reset",       tone: "warn"    },
  done:               { label: "Done",               tone: "ok"      },
  error:              { label: "Error",              tone: "danger"  },
  aborted:            { label: "Aborted",            tone: "danger"  },
};
const ACTIVE_PHASES = new Set([
  "preparing", "connecting", "writing", "verifying", "rebooting",
  "needs_manual_reset",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function arrayBufferToBase64(buf) {
  const CHUNK = 0x8000;
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fmtBytes(b) {
  if (b == null || !Number.isFinite(b)) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtElapsed(startMs, endMs) {
  if (!startMs) return "—";
  const t = endMs ? endMs - startMs : Date.now() - startMs;
  if (t < 0) return "—";
  if (t < 1000) return `${t} ms`;
  return `${(t / 1000).toFixed(1)} s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DongleFlashPanel() {
  const { stateData } = useStateAppStore();
  const [open, setOpen] = useState(false);

  const dongleOta = stateData?.fw_state?.dongle_ota || null;
  const dongleFw  = stateData?.fw_state?.dongle_fw_version ?? null;
  const isShowLoaded = !!stateData?.fw_state?.show_loaded;
  const isArmed = !!stateData?.fw_state?.device_is_armed;
  // The receiver-OTA panel and dongle update share the dongle radio,
  // so block one while the other is active. The daemon enforces this
  // too, but the UI gating means the operator never gets a confusing
  // "queued, then immediately rejected" round-trip.
  const receiverOtaPhase = stateData?.fw_state?.ota?.phase;
  const receiverOtaActive = ["submitted", "prep", "streaming", "finalizing"]
    .includes(receiverOtaPhase);

  const blockedReason = isShowLoaded
    ? "Cannot flash the dongle while a show is loaded."
    : isArmed
      ? "Cannot flash the dongle while the system is armed."
      : receiverOtaActive
        ? "Cannot flash the dongle while a receiver OTA flash is in flight."
        : null;

  const phase = dongleOta?.phase || "idle";
  const phaseMeta = PHASE_META[phase] || PHASE_META.idle;
  const isActive = ACTIVE_PHASES.has(phase);

  const summary = useMemo(() => {
    if (!dongleOta || phase === "idle") {
      if (dongleFw != null) {
        return `Dongle running v${dongleFw}. No update in progress.`;
      }
      return "No update in progress.";
    }
    if (phase === "done") {
      return `Dongle update OK${dongleFw != null ? ` (now v${dongleFw})` : ""}.`;
    }
    if (phase === "needs_manual_reset") {
      return "Waiting for BOOT+RESET on the dongle.";
    }
    if (phase === "error" || phase === "aborted") {
      const err = dongleOta.error || dongleOta.driver_error || "see logs";
      return `${phase}: ${err}`;
    }
    const pct = dongleOta.overall_pct ?? 0;
    return `${phaseMeta.label.toLowerCase()} (${pct}%)`;
  }, [dongleOta, phase, phaseMeta.label, dongleFw]);

  return (
    <div className="flex flex-col gap-3" data-fw-version={FW_VERSION}>
      <p className="text-xs text-fg-muted leading-snug">
        Push a freshly-built <code>os4_dongle_v&lt;N&gt;.bin</code> onto the
        physical dongle plugged into this host. The bridge releases the
        USB-CDC port for esptool, writes the new app image at
        <code> 0x10000</code>, and reattaches once the chip reboots — no
        shell access required. The dongle keeps no persistent state of its
        own (radio channel and system ID are re-pushed by the host on every
        reconnect), so an app refresh is always safe. Bootloader and
        partition table never change between builds and aren&apos;t touched.
        For a true full reflash (new partition scheme, brick recovery), use
        the <code>flash_dongle.py --full</code> CLI on the host.
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
          Open flasher
        </Button>
      </div>

      <FlashModal
        isOpen={open}
        onClose={() => setOpen(false)}
        dongleOta={dongleOta}
        dongleFw={dongleFw}
        phase={phase}
        isActive={isActive}
        blockedReason={blockedReason}
      />
    </div>
  );
}

function FlashModal({
  isOpen,
  onClose,
  dongleOta,
  dongleFw,
  phase,
  isActive,
  blockedReason,
}) {
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [confirmDisruptive, setConfirmDisruptive] = useState(false);
  const fileInputRef = useRef(null);

  // Wipe form when modal closes so a successful flash doesn't leave
  // stale state lurking next time the operator opens it.
  useEffect(() => {
    if (isOpen) return;
    setSubmitError(null);
    setFile(null);
    setConfirmDisruptive(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [isOpen]);

  const handlePick = useCallback((e) => {
    setSubmitError(null);
    const f = e.target.files?.[0] || null;
    if (!f) {
      setFile(null);
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      setSubmitError(
        `File too large (${fmtBytes(f.size)}; max ${fmtBytes(MAX_IMAGE_BYTES)}).`,
      );
      return;
    }
    if (f.size === 0) {
      setSubmitError("File is empty.");
      return;
    }
    // build_dongle.sh emits four bins -- try to nudge the operator
    // away from picking one of the three non-app ones by accident.
    const lower = f.name.toLowerCase();
    if (
      lower.endsWith(".bootloader.bin") ||
      lower.endsWith(".partitions.bin") ||
      lower.endsWith(".boot_app0.bin")
    ) {
      setSubmitError(
        `${f.name} looks like a bootloader/partitions/boot_app0 image, ` +
        `not the app. Pick the file named like os4_dongle_v<N>.bin (no infix).`,
      );
      return;
    }
    setFile(f);
  }, []);

  const handleStart = useCallback(async () => {
    setSubmitError(null);
    if (blockedReason) {
      setSubmitError(blockedReason);
      return;
    }
    if (!confirmDisruptive) {
      setSubmitError("Confirm the disruption checkbox before starting.");
      return;
    }
    if (!file) {
      setSubmitError("Pick a dongle .bin file first.");
      return;
    }

    setSubmitting(true);
    try {
      const buf = await file.arrayBuffer();
      await axios.post("/api/system/dongle_flash", {
        name: file.name,
        image_b64: arrayBufferToBase64(buf),
      });
    } catch (e) {
      setSubmitError(e?.response?.data?.error || e.message);
    } finally {
      setSubmitting(false);
    }
  }, [blockedReason, confirmDisruptive, file]);

  const handleAbort = useCallback(async () => {
    try {
      await axios.delete("/api/system/dongle_flash");
    } catch (e) {
      setSubmitError(e?.response?.data?.error || e.message);
    }
  }, []);

  const handleContinue = useCallback(async () => {
    try {
      await axios.patch("/api/system/dongle_flash");
    } catch (e) {
      setSubmitError(e?.response?.data?.error || e.message);
    }
  }, []);

  const phaseMeta = PHASE_META[phase] || PHASE_META.idle;
  const pct = dongleOta?.overall_pct ?? 0;
  const showProgress =
    isActive ||
    phase === "done" ||
    phase === "error" ||
    phase === "aborted";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Update dongle firmware"
      eyebrow="Host-side flash"
      size="2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {phase === "needs_manual_reset" ? (
            <Button
              variant="primary"
              leading={<MdReplay />}
              onClick={handleContinue}
            >
              I&apos;ve BOOT+RESET&apos;d it — retry
            </Button>
          ) : null}
          {isActive ? (
            <Button variant="danger" leading={<MdStop />} onClick={handleAbort}>
              Abort flash
            </Button>
          ) : (
            <Button
              variant="primary"
              leading={<MdSystemUpdateAlt />}
              onClick={handleStart}
              disabled={
                submitting ||
                !!blockedReason ||
                !file ||
                !confirmDisruptive
              }
              loading={submitting}
            >
              {submitting ? "Submitting…" : "Start flash"}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
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

        <div className="flex items-center gap-2 text-sm">
          <MdMemory className="text-fg-muted" />
          <span className="eyebrow">Currently running</span>
          <span className="text-fg-primary num">
            {dongleFw != null ? `v${dongleFw}` : "unknown"}
          </span>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="eyebrow">Dongle firmware (.bin)</span>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".bin,application/octet-stream"
              onChange={handlePick}
              className="text-sm text-fg-secondary file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-bg-raised file:text-fg-primary hover:file:bg-bg-elev"
              disabled={isActive}
            />
            {file && (
              <span className="text-xs text-fg-muted whitespace-nowrap num">
                {fmtBytes(file.size)}
              </span>
            )}
          </div>
          <span className="text-xs text-fg-muted">
            Pick the app image from <code>devices/os4_dongle/bin/</code> —
            named like <code>os4_dongle_v&lt;N&gt;.bin</code> (or the
            <code> latest.bin </code>symlink). Written at <code>0x10000</code>.
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm select-none mt-1">
          <input
            type="checkbox"
            checked={confirmDisruptive}
            onChange={(e) => setConfirmDisruptive(e.target.checked)}
            disabled={isActive}
            className="mt-1"
          />
          <span className="text-fg-secondary">
            I understand the dongle will disconnect for ~10 seconds while
            it&apos;s flashed and rebooted. The host service stays up; the
            daemon will reconnect to the dongle automatically afterward.
          </span>
        </label>

        {phase === "needs_manual_reset" && (
          <Card padding="md" tone="warn">
            <div className="flex items-start gap-2 text-sm text-warn-fg">
              <MdWarning className="mt-0.5 shrink-0" />
              <div className="flex flex-col gap-1">
                <span className="font-semibold">
                  Auto-reset failed — manual bootloader entry needed.
                </span>
                <ol className="list-decimal ml-5 text-fg-secondary space-y-0.5">
                  <li>Press and HOLD the BOOT button on the dongle.</li>
                  <li>While still holding BOOT, press and release RESET.</li>
                  <li>Release BOOT.</li>
                  <li>Click the &ldquo;I&apos;ve BOOT+RESET&apos;d it&rdquo; button below.</li>
                </ol>
              </div>
            </div>
          </Card>
        )}

        {showProgress && dongleOta && (
          <Card padding="md" tone="inset">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Badge tone={phaseMeta.tone}>{phaseMeta.label}</Badge>
                <span className="text-sm text-fg-secondary">
                  {dongleOta.current_offset
                    ? `${dongleOta.current_offset}${dongleOta.current_offset_pct ? ` (${dongleOta.current_offset_pct}%)` : ""}`
                    : ""}
                </span>
              </div>
              <div className="text-xs text-fg-muted">
                {fmtElapsed(dongleOta.started_ms, dongleOta.ended_ms)}
              </div>
            </div>
            <div className="w-full h-2 bg-bg-deep rounded overflow-hidden">
              <div
                className={cn(
                  "h-full transition-all duration-150",
                  phase === "done"
                    ? "bg-ok"
                    : phase === "error" || phase === "aborted"
                      ? "bg-danger"
                      : "bg-accent",
                )}
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-fg-muted tabular-nums num">
              <span>{pct}%</span>
              <span>{fmtBytes(dongleOta.total_bytes)} total</span>
              {dongleOta.exit_code != null && (
                <span>esptool exit {dongleOta.exit_code}</span>
              )}
              {dongleOta.error && (
                <span className="text-danger-fg">{dongleOta.error}</span>
              )}
              {dongleOta.driver_error && (
                <span className="text-warn-fg">
                  driver: {dongleOta.driver_error}
                </span>
              )}
            </div>
            {Array.isArray(dongleOta.log_tail) && dongleOta.log_tail.length > 0 && (
              <pre className="mt-3 max-h-32 overflow-auto text-[11px] leading-snug text-fg-muted bg-bg-deep p-2 rounded font-mono whitespace-pre-wrap break-all">
                {dongleOta.log_tail.join("\n")}
              </pre>
            )}
            {phase === "done" && (
              <div className="mt-3 flex items-center gap-2 text-sm text-ok-fg">
                <MdCheckCircle /> Dongle rebooted; bridge has reattached.
              </div>
            )}
          </Card>
        )}
      </div>
    </Modal>
  );
}
