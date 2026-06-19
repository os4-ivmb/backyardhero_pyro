import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  MdSystemUpdateAlt,
  MdWarning,
  MdCheckCircle,
  MdStop,
  MdRefresh,
  MdCloudDownload,
} from "react-icons/md";
import useStateAppStore from "@/store/useStateAppStore";
import useAppStore from "@/store/useAppStore";
import {
  Button,
  Card,
  Badge,
  Modal,
  selectClass,
  cn,
} from "@/design";
import { fwOutOfDate } from "@/util/firmwareVersion";

// FW_VERSION: OTA flash panel
// v1.0.0: Initial version - lets the operator pick an online receiver and
//         a firmware app .bin file, then drive an OTA flash to completion
//         with live progress from fw_state.ota.
const FW_VERSION = "1.0.0";

// Cap matches the API endpoint's MAX_IMAGE_BYTES (4MB). Chosen to give
// headroom over the current ~340KB receiver image without letting the
// browser shovel a multi-MB file at the dongle by accident.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Phase -> human label + tone, kept in sync with OtaPhase on the daemon.
const PHASE_META = {
  idle:        { label: "Idle",       tone: "neutral" },
  submitted:   { label: "Queued",     tone: "neutral" },
  prep:        { label: "Handshake",  tone: "neutral" },
  streaming:   { label: "Streaming",  tone: "live"    },
  finalizing:  { label: "Finalizing", tone: "warn"    },
  done:        { label: "Done",       tone: "ok"      },
  error:       { label: "Error",      tone: "danger"  },
  aborted:     { label: "Aborted",    tone: "danger"  },
};
const ACTIVE_PHASES = new Set(["submitted", "prep", "streaming", "finalizing"]);

// Helpers ------------------------------------------------------------------

function arrayBufferToBase64(buf) {
  // Convert in chunks so we don't blow out the call stack on big buffers.
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

// Pick out receivers that are valid OTA targets:
//   * they're DB-registered (we have their ident),
//   * they're not Bilusocn 433 TX-only (no NRF radio),
//   * they have a recent `lmt` (status from the dongle, ergo online).
function useFlashableReceivers() {
  const { stateData } = useStateAppStore();
  const { receivers: dbReceivers, fetchReceivers } = useAppStore();
  useEffect(() => {
    fetchReceivers().catch((e) => console.error("fetchReceivers failed:", e));
  }, [fetchReceivers]);

  return useMemo(() => {
    const live = stateData?.fw_state?.receivers || {};
    const out = [];
    const now = Date.now();
    for (const id of Object.keys(dbReceivers || {})) {
      const def = dbReceivers[id];
      if (!def?.enabled) continue;
      if (def.type === "BILUSOCN_433_TX_ONLY") continue;
      const liveRow = live[id];
      const lmt = liveRow?.status?.lmt;
      const online = lmt != null && now - lmt < 10000;
      out.push({
        id,
        label: def.label || id,
        online,
        battery: liveRow?.status?.battery ?? null,
        fw_version: def.fw_version ?? null,
      });
    }
    out.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
    return out;
  }, [dbReceivers, stateData?.fw_state?.receivers]);
}

// Component ----------------------------------------------------------------

export default function OtaFlashPanel() {
  const { stateData } = useStateAppStore();
  const { latestFirmware, fetchLatestFirmware } = useAppStore();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  const latestReceiver = latestFirmware?.receiver?.available
    ? latestFirmware.receiver
    : null;
  const latestReceiverVersion = latestReceiver?.version ?? null;

  const handleCheck = useCallback(async () => {
    setChecking(true);
    try {
      await fetchLatestFirmware(true);
    } finally {
      setChecking(false);
    }
  }, [fetchLatestFirmware]);

  const ota = stateData?.fw_state?.ota || null;
  const isShowLoaded = !!stateData?.fw_state?.show_loaded;
  const isArmed = !!stateData?.fw_state?.device_is_armed;
  const blockedReason = isShowLoaded
    ? "Cannot OTA flash while a show is loaded."
    : isArmed
      ? "Cannot OTA flash while the system is armed."
      : null;

  const phase = ota?.phase || "idle";
  const phaseMeta = PHASE_META[phase] || PHASE_META.idle;
  const isActive = ACTIVE_PHASES.has(phase);

  // Live one-line summary in the settings card. Once the modal is closed
  // mid-flash this lets the operator see something is in progress without
  // re-opening the dialog.
  const summary = useMemo(() => {
    if (!ota || phase === "idle") return "No firmware push in progress.";
    if (phase === "done") {
      return `${ota.target_ident}: flashed ${fmtBytes(ota.total_bytes)} OK.`;
    }
    if (phase === "error" || phase === "aborted") {
      return `${ota.target_ident}: ${phase} – ${ota.error || "see logs"}`;
    }
    return `${ota.target_ident}: ${phaseMeta.label.toLowerCase()} (${ota.progress_pct ?? 0}%)`;
  }, [ota, phase, phaseMeta.label]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted leading-snug">
        Push a freshly-built receiver firmware image (the <code>.bin</code> from
        <code> build_receiver.sh</code>) over the air to one online receiver.
        The dongle drops back to single-target mode and bumps to 2 Mbps for
        the duration; the receiver re-flashes itself and reboots.
      </p>

      <div className="flex items-start gap-3 text-sm">
        <div className="flex flex-col">
          <span className="eyebrow">Status</span>
          <span className="text-base text-fg-primary flex items-center gap-2 mt-0.5">
            <Badge tone={phaseMeta.tone}>{phaseMeta.label}</Badge>
            <span className="text-fg-muted text-xs">{summary}</span>
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCheck}
            leading={<MdRefresh className={checking ? "animate-spin" : ""} />}
            disabled={checking}
          >
            Check for updates
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(true)}
            leading={<MdSystemUpdateAlt />}
          >
            Open flasher
          </Button>
        </div>
      </div>

      {latestReceiverVersion != null && (
        <p className="text-xs text-fg-muted">
          Latest receiver firmware: v{latestReceiverVersion}.
          {latestReceiver?.stale ? " (cached — couldn't reach the server)" : ""}
          {" "}Open the flasher to push it to a receiver.
        </p>
      )}

      <FlashModal
        isOpen={open}
        onClose={() => setOpen(false)}
        ota={ota}
        phase={phase}
        isActive={isActive}
        blockedReason={blockedReason}
        latestReceiverVersion={latestReceiverVersion}
      />
    </div>
  );
}

function FlashModal({
  isOpen,
  onClose,
  ota,
  phase,
  isActive,
  blockedReason,
  latestReceiverVersion = null,
}) {
  const flashable = useFlashableReceivers();
  const [selectedIdent, setSelectedIdent] = useState("");
  const [file, setFile] = useState(null);
  const [rate, setRate] = useState(2);
  const [submitting, setSubmitting] = useState(false);
  const [latestBusy, setLatestBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const fileInputRef = useRef(null);

  // Wipe form on close so the operator doesn't see stale state next time.
  useEffect(() => {
    if (isOpen) return;
    setSubmitError(null);
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [isOpen]);

  // Pre-pick the active OTA target if one's running, otherwise the first
  // online receiver. Avoids the "select disabled" footgun where the
  // operator has to manually re-pick mid-flash.
  useEffect(() => {
    if (ota?.target_ident && isActive) {
      setSelectedIdent(ota.target_ident);
      return;
    }
    if (selectedIdent && flashable.some((r) => r.id === selectedIdent)) return;
    const firstOnline = flashable.find((r) => r.online);
    setSelectedIdent(firstOnline?.id || "");
  }, [flashable, ota?.target_ident, isActive, selectedIdent]);

  const handleFile = useCallback((e) => {
    setSubmitError(null);
    const f = e.target.files?.[0] || null;
    if (!f) {
      setFile(null);
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      setSubmitError(`File too large (${fmtBytes(f.size)}; max ${fmtBytes(MAX_IMAGE_BYTES)}).`);
      setFile(null);
      return;
    }
    if (f.size === 0) {
      setSubmitError("File is empty.");
      setFile(null);
      return;
    }
    setFile(f);
  }, []);

  const handleStart = useCallback(async () => {
    setSubmitError(null);
    if (!selectedIdent) {
      setSubmitError("Pick a receiver.");
      return;
    }
    if (!file) {
      setSubmitError("Pick a firmware .bin file.");
      return;
    }
    if (blockedReason) {
      setSubmitError(blockedReason);
      return;
    }
    setSubmitting(true);
    try {
      const buf = await file.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      await axios.post("/api/system/ota_flash", {
        ident: selectedIdent,
        file_name: file.name,
        image_b64: b64,
        rate,
      });
    } catch (e) {
      setSubmitError(e?.response?.data?.error || e.message);
    } finally {
      setSubmitting(false);
    }
  }, [selectedIdent, file, rate, blockedReason]);

  // Flash the latest published receiver firmware to the selected receiver --
  // the host downloads the .bin from the static site, no manual file pick.
  const handleFlashLatest = useCallback(async () => {
    setSubmitError(null);
    if (!selectedIdent) {
      setSubmitError("Pick a receiver.");
      return;
    }
    if (blockedReason) {
      setSubmitError(blockedReason);
      return;
    }
    setLatestBusy(true);
    try {
      await axios.post("/api/system/flash_latest", {
        device: "receiver",
        ident: selectedIdent,
        rate,
      });
    } catch (e) {
      setSubmitError(e?.response?.data?.error || e.message);
    } finally {
      setLatestBusy(false);
    }
  }, [selectedIdent, rate, blockedReason]);

  const handleAbort = useCallback(async () => {
    try {
      await axios.delete("/api/system/ota_flash");
    } catch (e) {
      setSubmitError(e?.response?.data?.error || e.message);
    }
  }, []);

  const phaseMeta = PHASE_META[phase] || PHASE_META.idle;
  const pct = ota?.progress_pct ?? 0;
  const showProgress = ACTIVE_PHASES.has(phase) || phase === "done" || phase === "error" || phase === "aborted";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="OTA flash receiver"
      eyebrow="Firmware update"
      size="2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {isActive ? (
            <Button variant="danger" leading={<MdStop />} onClick={handleAbort}>
              Abort flash
            </Button>
          ) : (
            <>
              {latestReceiverVersion != null && (
                <Button
                  variant="subtle"
                  leading={<MdCloudDownload />}
                  onClick={handleFlashLatest}
                  disabled={latestBusy || submitting || !!blockedReason || !selectedIdent}
                  loading={latestBusy}
                  title={`Download os4_receiver_v${latestReceiverVersion}.bin and OTA it to the selected receiver`}
                >
                  Flash latest (v{latestReceiverVersion})
                </Button>
              )}
              <Button
                variant="primary"
                leading={<MdSystemUpdateAlt />}
                onClick={handleStart}
                disabled={submitting || latestBusy || !!blockedReason || !selectedIdent || !file}
                loading={submitting}
              >
                {submitting ? "Submitting…" : "Start flash"}
              </Button>
            </>
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

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="eyebrow">Receiver</span>
            <select
              value={selectedIdent}
              onChange={(e) => setSelectedIdent(e.target.value)}
              className={selectClass}
              disabled={isActive}
            >
              <option value="">— pick one —</option>
              {flashable.map((r) => {
                const upd = fwOutOfDate(r.fw_version, latestReceiverVersion);
                return (
                  <option key={r.id} value={r.id} disabled={!r.online}>
                    {r.label}
                    {r.label !== r.id ? ` (${r.id})` : ""}
                    {r.online ? "" : " · offline"}
                    {upd ? ` · update → v${latestReceiverVersion}` : ""}
                  </option>
                );
              })}
            </select>
            <span className="text-xs text-fg-muted">
              Only online, NRF-capable receivers are listed.
              {latestReceiverVersion != null
                ? " “update” marks receivers older than the latest firmware."
                : ""}
            </span>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="eyebrow">RF data rate during flash</span>
            <select
              value={rate}
              onChange={(e) => setRate(parseInt(e.target.value, 10))}
              className={selectClass}
              disabled={isActive}
            >
              <option value={2}>2 Mbps (fastest, ~30s)</option>
              <option value={1}>1 Mbps (compromise)</option>
              <option value={0}>250 kbps (most reliable)</option>
            </select>
            <span className="text-xs text-fg-muted">
              Both sides hop to this rate during the transfer.
            </span>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="eyebrow">Firmware image (.bin)</span>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".bin,application/octet-stream"
              onChange={handleFile}
              className="text-sm text-fg-secondary file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-bg-raised file:text-fg-primary hover:file:bg-bg-elev"
              disabled={isActive}
            />
            {file && (
              <span className="text-xs text-fg-muted">
                {fmtBytes(file.size)}
              </span>
            )}
          </div>
          <span className="text-xs text-fg-muted">
            Use the <code>os4_receiver_v&lt;N&gt;.bin</code> from <code>devices/utils/build_receiver.sh</code>.
            Bootloader / partitions are first-flash only and aren't sent.
          </span>
        </label>

        {showProgress && ota && (
          <Card padding="md" tone="inset">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Badge tone={phaseMeta.tone}>{phaseMeta.label}</Badge>
                <span className="text-sm text-fg-secondary">
                  {ota.target_ident || "—"}
                  {ota.file_name ? ` · ${ota.file_name}` : ""}
                </span>
              </div>
              <div className="text-xs text-fg-muted">
                {fmtElapsed(ota.started_ms,
                  phase === "done" || phase === "error" || phase === "aborted"
                    ? ota.last_event_ms
                    : null
                )}
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
                      : "bg-accent"
                )}
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-fg-muted tabular-nums num">
              <span>{pct}%</span>
              <span>
                {ota.chunks_acked}/{ota.total_chunks} chunks
              </span>
              <span>
                {fmtBytes(ota.bytes_acked)} / {fmtBytes(ota.total_bytes)}
              </span>
              {!!ota.chunks_retried && (
                <span className={ota.chunks_retried > 20 ? "text-warn-fg" : ""}>
                  {ota.chunks_retried} retries
                </span>
              )}
              {ota.crc32_hex && <span>CRC32 {ota.crc32_hex}</span>}
              {ota.rate != null && (
                <span>
                  {ota.rate === 2 ? "2 Mbps" : ota.rate === 1 ? "1 Mbps" : "250 kbps"}
                </span>
              )}
              {ota.error && (
                <span className="text-danger-fg">{ota.error}</span>
              )}
            </div>
            {phase === "done" && (
              <div className="mt-3 flex items-center gap-2 text-sm text-ok-fg">
                <MdCheckCircle /> Receiver rebooted and re-joined the fleet.
              </div>
            )}
          </Card>
        )}
      </div>
    </Modal>
  );
}
