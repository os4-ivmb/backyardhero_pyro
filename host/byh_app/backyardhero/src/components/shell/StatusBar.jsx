import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import useStateAppStore from "@/store/useStateAppStore";
import useAppStore from "@/store/useAppStore";
import useAppMode from "@/design/useAppMode";
import { cn, Stat, Dot, IconButton, Badge } from "@/design";
import { MdRefresh, MdCloseFullscreen, MdOpenInFull, MdSignalWifi4Bar, MdSignalWifiOff, MdRestartAlt } from "react-icons/md";
import Toast from "../common/Toast";
import { isPollableReceiver } from "@/util/receivers";

const DONGLE_DEFAULTS = {
  addr: "/dev/tty.usbmodem01",
  baud: 115200,
  protocol: "BKYD_TS_HYBRID",
};

// ---------------------------------------------------------------------------
// StatusBar — single source of truth for "what is the system doing right now"
//
// Replaces homepanel/Status.jsx. The previous implementation laid out 8
// equally-weighted pills (connection / daemon / TX / manual fire / armed /
// show loaded / TX active / time / show running). The redesign:
//
//   - Groups related stats: Link (daemon+TX+ws) | Show (loaded+running)
//     | Cursor (time) | Receivers (count online).
//   - Demotes "ok" stats to neutral chrome — they only become loud when
//     something goes wrong.
//   - Moves the "ARMED" indicator OUT of here; ARMED is dominant chrome
//     handled by AppShell's armed-rail and the ModeBadge in TopBar.
//
// The websocket connection management itself lives here (it always did, in
// Status.jsx). It's been preserved unchanged behaviourally — only the UI
// is new — so the existing reconnect/heartbeat/error-toast pipeline keeps
// working untouched.
// ---------------------------------------------------------------------------

const MAX_TOASTS = 5;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;

const checkIfLogIsRecent = (log) => {
  const ts = typeof log === "string" && log.match(/\[([^\]]+)\]/);
  if (!ts) return false;
  const t = new Date(ts[1]).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= 5 * 60 * 1000;
};

// 8-segment dongle command-queue saturation indicator. Each segment has a
// fixed colour stepping from green (idle) to red (saturated); the number
// of *lit* segments tracks `depth/capacity`. We always light at least one
// segment when the depth is known so the operator can tell "this widget
// is reporting" vs "no telemetry yet".
const QUEUE_SEGMENT_COUNT = 8;
const QUEUE_SEGMENT_HSL = Array.from({ length: QUEUE_SEGMENT_COUNT }, (_, i) => {
  // Hue 120 (green) → 0 (red), evenly spaced across the 8 steps.
  const hue = 120 - (i / (QUEUE_SEGMENT_COUNT - 1)) * 120;
  return `hsl(${hue.toFixed(0)} 75% 48%)`;
});

function QueueBar({ depth, capacity, className }) {
  if (depth == null || capacity == null || capacity <= 0) return null;
  const fraction = Math.max(0, Math.min(1, depth / capacity));
  // Always show at least one lit segment so a "0/128" reading is
  // visually distinct from "no telemetry available".
  const litCount = Math.max(1, Math.ceil(fraction * QUEUE_SEGMENT_COUNT));
  const tooltip = `Dongle command queue: ${depth}/${capacity}`;
  return (
    <div
      className={cn("flex items-center gap-[2px]", className)}
      role="img"
      aria-label={tooltip}
      title={tooltip}
    >
      {QUEUE_SEGMENT_HSL.map((color, i) => {
        const lit = i < litCount;
        return (
          <span
            key={i}
            className="w-[3px] h-3 rounded-[1px]"
            style={{
              backgroundColor: lit ? color : "rgba(255,255,255,0.10)",
            }}
          />
        );
      })}
    </div>
  );
}

export default function StatusBar() {
  // --- WS lifecycle (preserved from Status.jsx) -----------------------------
  const stateData = useStateAppStore((s) => s.stateData);
  const setStateData = useStateAppStore((s) => s.setStateData);
  const patchStateData = useStateAppStore((s) => s.patchStateData);
  const {
    mode,
    daemonActive,
    deviceRunning,
    deviceIsTransmitting,
    wsAlive,
    isShowLoaded,
    isShowRunning,
    fwCursor,
    activeProtocol,
  } = useAppMode();
  const { systemConfig } = useAppStore();

  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalDisconnectRef = useRef(false);
  const [toasts, setToasts] = useState([]);
  const previousErrorsRef = useRef(new Set());
  const [restartingDongle, setRestartingDongle] = useState(false);

  const scheduleReconnect = useCallback(() => {
    if (intentionalDisconnectRef.current) return;
    if (reconnectTimerRef.current) return;
    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectAttemptRef.current = attempt + 1;
      connectWebSocketRef.current && connectWebSocketRef.current();
    }, delay);
  }, []);

  const connectWebSocketRef = useRef(null);

  const connectWebSocket = useCallback(() => {
    if (socketRef.current && socketRef.current.readyState <= 1) return;
    intentionalDisconnectRef.current = false;
    const socket = new WebSocket(`ws://${window.location.host.split(":")[0]}:8090`);
    socket.onopen = () => {
      setIsConnected(true);
      reconnectAttemptRef.current = 0;
    };
    socket.onmessage = (event) => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload && payload._hb) {
        patchStateData({ fw_last_update: payload.fw_last_update });
      } else {
        setStateData(payload);
      }
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      setIsConnected(false);
      socketRef.current = null;
      scheduleReconnect();
    };
    socketRef.current = socket;
  }, [setStateData, patchStateData, scheduleReconnect]);

  useEffect(() => { connectWebSocketRef.current = connectWebSocket; }, [connectWebSocket]);

  const disconnectWebSocket = useCallback(() => {
    intentionalDisconnectRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
  }, []);

  useEffect(() => {
    connectWebSocket();
    return () => disconnectWebSocket();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Error stream → toasts (preserved) -----------------------------------
  const lastErrorSignatureRef = useRef(null);
  useEffect(() => {
    const fcf = stateData.fw_state?.fire_check_failures || [];
    const phe = stateData.fw_state?.proto_handler_errors || [];
    const fwe = stateData.fw_error || [];
    const fwd = stateData.fw_d_error || [];
    const sig = JSON.stringify([
      fcf.length, fcf[fcf.length - 1] ?? null,
      phe.length, phe[phe.length - 1] ?? null,
      fwe.length, fwe[fwe.length - 1] ?? null,
      fwd.length, fwd[fwd.length - 1] ?? null,
    ]);
    if (sig === lastErrorSignatureRef.current) return;
    lastErrorSignatureRef.current = sig;

    const toString = (e) => typeof e === "string" ? e : JSON.stringify(e);
    const stripTs = (s) => typeof s === "string" ? s.replace(/^\[[^\]]+\]\s*/, "").trim() : toString(s);

    const seen = new Set();
    const newToasts = [];
    const consider = (key, msg) => {
      seen.add(key);
      if (!previousErrorsRef.current.has(key)) {
        newToasts.push({ id: Date.now() + Math.random(), message: msg });
      }
    };
    fcf.forEach((e) => { const m = toString(e); consider(`fcf_${m}`, m); });
    phe.forEach((e) => { const m = toString(e); consider(`phe_${m}`, m); });
    fwe.forEach((e) => { const m = toString(e); consider(`fwe_${m}`, m); });
    fwd.forEach((e) => { if (checkIfLogIsRecent(e)) consider(`fwd_${e}`, stripTs(e)); });
    previousErrorsRef.current = seen;
    if (newToasts.length) {
      setToasts((prev) => {
        const all = [...prev, ...newToasts];
        return all.length > MAX_TOASTS ? all.slice(all.length - MAX_TOASTS) : all;
      });
    }
  }, [
    stateData.fw_state?.fire_check_failures,
    stateData.fw_state?.proto_handler_errors,
    stateData.fw_error,
    stateData.fw_d_error,
  ]);

  const dismissToast = (id) => setToasts((p) => p.filter((t) => t.id !== id));

  // --- Render --------------------------------------------------------------

  // -----------------------------------------------------------------
  // Three independent health signals (web ↔ daemon ↔ dongle). The old
  // UI displayed all three but with equal weight; the previous redesign
  // collapsed them too aggressively into one "Linked · BKYD_TS_HYBRID"
  // string, which stayed green even when the dongle went silent. Now
  // each signal stands on its own:
  //
  //   Link    — websocket from this browser to the daemon backend.
  //   Daemon  — daemon process is reporting (fw_state.daemon_active).
  //   Dongle  — USB radio device heartbeat (device_running) AND its
  //             bound protocol; a live "TX" dot indicates active
  //             outbound traffic (device_is_transmitting).
  // -----------------------------------------------------------------
  const linkOk = isConnected && wsAlive;

  const daemonTone = !linkOk ? "neutral" : daemonActive ? "ok" : "danger";
  const daemonLabel = !linkOk ? "—" : daemonActive ? "Active" : "Down";

  // Dongle states (priority order):
  //   - link not up → not knowable, show "—"
  //   - daemon down → still not knowable
  //   - !device_running → "Silent" (haven't heard from dongle in 10s)
  //   - device_running, no protocol → "Unbound"
  //   - device_running, protocol bound → protocol name (live)
  let dongleTone = "neutral";
  let dongleLabel = "—";
  if (linkOk && daemonActive) {
    if (!deviceRunning) {
      dongleTone = "danger";
      dongleLabel = "Silent";
    } else if (!activeProtocol) {
      dongleTone = "warn";
      dongleLabel = "Unbound";
    } else {
      dongleTone = "ok";
      dongleLabel = activeProtocol;
    }
  }

  // Force-restart the dongle's serial connection on the daemon. This is
  // the same path TxConfig.jsx's "Apply" button takes -- re-issuing
  // `select_serial` with the current rf settings causes the daemon to
  // tear down and re-open the USB serial port and re-init the protocol
  // (msync, channel sync, etc). Useful when the dongle has gone silent
  // because USB hiccupped or the firmware crashed and the host hasn't
  // noticed yet. We surface it inline next to the "Silent" label so the
  // operator doesn't have to dig into TxConfig and click through Apply.
  const rfSettings = stateData.fw_state?.settings?.rf || {};
  const restartDongle = useCallback(async () => {
    if (restartingDongle) return;
    setRestartingDongle(true);
    const payload = {
      type: "select_serial",
      device: rfSettings.addr || DONGLE_DEFAULTS.addr,
      baud: parseInt(rfSettings.baud || DONGLE_DEFAULTS.baud, 10),
      protocol: rfSettings.protocol || DONGLE_DEFAULTS.protocol,
    };
    try {
      await axios.post("/api/system/cmd_daemon", payload, {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || "Failed to restart dongle";
      setToasts((prev) => {
        const next = [...prev, { id: Date.now() + Math.random(), message: `Dongle restart failed: ${msg}` }];
        return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
      });
    } finally {
      setRestartingDongle(false);
    }
  }, [restartingDongle, rfSettings.addr, rfSettings.baud, rfSettings.protocol]);

  // Dongle command-queue saturation. The dongle reports `q`/`qmax` once
  // per second; we render it next to the dongle stat so an operator can
  // tell at a glance "is the radio falling behind on outbound commands?"
  // -- which is the failure mode we'd otherwise only catch by watching
  // `q` climb in the raw status JSON.
  const dongleCmdQueue = stateData.fw_state?.dongle_cmd_queue || null;
  const dongleQueueDepth =
    typeof dongleCmdQueue?.depth === "number" ? dongleCmdQueue.depth : null;
  const dongleQueueCapacity =
    typeof dongleCmdQueue?.capacity === "number" && dongleCmdQueue.capacity > 0
      ? dongleCmdQueue.capacity
      : null;

  const showLabel = !isShowLoaded ? "—" : isShowRunning ? "Running" : "Loaded";
  const showTone = !isShowLoaded ? "neutral" : isShowRunning ? "live" : "ok";

  const cursorText = useMemo(() => {
    const v = Number(fwCursor);
    if (!Number.isFinite(v) || v < 0) return "—";
    const m = Math.floor(v / 60);
    const s = Math.floor(v % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }, [fwCursor]);

  // Receiver summary. Only counts receivers that can actually report
  // status: enabled rows that aren't a transmit-only type. A bilusocn
  // unit is intentionally invisible here -- it has no return channel
  // and would otherwise sit permanently in the "offline" column.
  const receiverSummary = useMemo(() => {
    const liveR = stateData.fw_state?.receivers || {};
    const cfgR = systemConfig?.receivers || {};
    const ids = new Set([...Object.keys(liveR), ...Object.keys(cfgR)]);
    let total = 0;
    let online = 0;
    for (const id of ids) {
      // Prefer the live daemon view of the receiver (it has fresh `lmt`
      // and only includes enabled rows); fall back to systemConfig so we
      // don't drop offline-but-enabled receivers from the denominator.
      const r = liveR[id] || cfgR[id];
      if (!isPollableReceiver(r)) continue;
      total += 1;
      const lmt = liveR[id]?.status?.lmt;
      if (lmt && Date.now() - lmt < 10_000) online++;
    }
    return { total, online };
  }, [stateData.fw_state?.receivers, systemConfig?.receivers]);

  return (
    <>
      <div className="fixed bottom-3 left-3 z-[10000] flex flex-col-reverse gap-1.5 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <Toast message={t.message} onDismiss={() => dismissToast(t.id)} duration={30000} />
          </div>
        ))}
      </div>

      <div
        className="px-3 h-12 flex items-center gap-4 text-sm"
      >
        {/* ─── Link button (web ↔ daemon backend WS) ───────────────────── */}
        <button
          onClick={() => (isConnected ? disconnectWebSocket() : connectWebSocket())}
          className={cn(
            "inline-flex items-center gap-2 px-2 h-7 rounded-sm border transition-colors shrink-0",
            isConnected && wsAlive
              ? "border-border-subtle text-fg-secondary hover:text-fg-primary hover:bg-surface-3"
              : "border-danger/50 text-danger-fg bg-danger-bg hover:bg-danger/20"
          )}
          title={isConnected ? "Disconnect from daemon" : "Reconnect to daemon"}
        >
          {isConnected && wsAlive ? (
            <MdSignalWifi4Bar className="text-base" aria-hidden />
          ) : (
            <MdSignalWifiOff className="text-base" aria-hidden />
          )}
          <span className="font-medium">
            {isConnected && wsAlive ? "Link" : (
              <span className="inline-flex items-center gap-1">
                <MdRefresh aria-hidden /> Reconnect
              </span>
            )}
          </span>
        </button>

        <div className="h-6 w-px bg-border-subtle" aria-hidden />

        {/* ─── Daemon (PC daemon process) ─────────────────────────────── */}
        <Stat label="Daemon" value={daemonLabel} tone={daemonTone} dot size="sm" />

        <div className="h-6 w-px bg-border-subtle" aria-hidden />

        {/* ─── Dongle (USB radio device + bound protocol + TX pulse) ───── */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-1.5">
              <Dot
                tone={dongleTone}
                pulse={dongleTone === "armed" || dongleTone === "live"}
              />
              <span className="eyebrow">Dongle</span>
              {/* Distinct TX pulse — only visible while the daemon reports
                  the device transmitting. Lives next to the dongle stat
                  because that's the signal it qualifies. */}
              {dongleTone === "ok" && deviceIsTransmitting ? (
                <span
                  className="inline-flex items-center gap-1 ml-1 text-2xs text-live font-semibold"
                  title="Dongle is actively transmitting"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-live animate-livePulse" />
                  TX
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "truncate font-medium font-mono text-sm",
                  dongleTone === "danger" && "text-danger-fg",
                  dongleTone === "warn" && "text-warn-fg",
                  dongleTone === "ok" && "text-fg-primary",
                  dongleTone === "neutral" && "text-fg-muted"
                )}
                title={dongleLabel}
              >
                {dongleLabel}
              </span>
              {dongleTone === "danger" && dongleLabel === "Silent" ? (
                <button
                  type="button"
                  onClick={restartDongle}
                  disabled={restartingDongle}
                  className={cn(
                    "inline-flex items-center gap-1 px-1.5 h-5 rounded-sm border text-2xs font-medium transition-colors",
                    "border-danger/50 text-danger-fg bg-danger-bg hover:bg-danger/20",
                    "disabled:opacity-60 disabled:cursor-not-allowed"
                  )}
                  title={`Re-issue select_serial on ${rfSettings.addr || DONGLE_DEFAULTS.addr} @ ${rfSettings.baud || DONGLE_DEFAULTS.baud}`}
                >
                  <MdRestartAlt
                    className={cn("text-sm", restartingDongle && "animate-spin")}
                    aria-hidden
                  />
                  {restartingDongle ? "Restarting…" : "Restart"}
                </button>
              ) : null}
            </div>
          </div>
          {/* Command-queue saturation -- only shown when the dongle has
              actually reported. While the dongle is silent / unbound the
              bar is suppressed so it doesn't pretend to be measuring
              something. */}
          {dongleTone === "ok" && (
            <QueueBar
              depth={dongleQueueDepth}
              capacity={dongleQueueCapacity}
            />
          )}
        </div>

        <div className="h-6 w-px bg-border-subtle" aria-hidden />

        {/* ─── Receivers ─────────────────────────────────────────────── */}
        <Stat
          label="Receivers"
          value={`${receiverSummary.online}/${receiverSummary.total}`}
          tone={
            receiverSummary.total === 0
              ? "neutral"
              : receiverSummary.online === receiverSummary.total
              ? "ok"
              : receiverSummary.online === 0
              ? "danger"
              : "warn"
          }
          dot
          size="sm"
          numeric
        />

        <div className="h-6 w-px bg-border-subtle" aria-hidden />

        {/* ─── Show group ─────────────────────────────────────────────── */}
        <Stat label="Show" value={showLabel} tone={showTone} dot size="sm" />

        {/* ─── Cursor (always visible) ────────────────────────────────── */}
        <div className="flex items-center gap-2 ml-auto">
          <span className="eyebrow">Cursor</span>
          <span className="font-mono text-base text-fg-primary num">{cursorText}</span>
        </div>

        {mode.id === "manual_fire" ? (
          <Badge tone="armed" leading={<Dot tone="armed" pulse />}>
            Manual fire active
          </Badge>
        ) : null}
      </div>
    </>
  );
}
