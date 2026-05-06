import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useStateAppStore from "@/store/useStateAppStore";
import useAppStore from "@/store/useAppStore";
import useAppMode from "@/design/useAppMode";
import { cn, Stat, Dot, IconButton, Badge } from "@/design";
import { MdRefresh, MdCloseFullscreen, MdOpenInFull, MdSignalWifi4Bar, MdSignalWifiOff } from "react-icons/md";
import Toast from "../common/Toast";
import { isPollableReceiver } from "@/util/receivers";

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
//   - Compresses the whole bar to a single hairline row in armed/live.
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

  // Compact mode: in armed/live, the bar collapses to a single thin row
  // showing only the most operationally-critical info (link health + cursor).
  const compact = mode.id === "armed" || mode.id === "live";

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
        className={cn(
          "px-3 flex items-center gap-4 text-sm",
          compact ? "h-7" : "h-12"
        )}
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
          {!compact && (
            <span className="font-medium">
              {isConnected && wsAlive ? "Link" : (
                <span className="inline-flex items-center gap-1">
                  <MdRefresh aria-hidden /> Reconnect
                </span>
              )}
            </span>
          )}
        </button>

        {!compact && <div className="h-6 w-px bg-border-subtle" aria-hidden />}

        {/* ─── Daemon (PC daemon process) ─────────────────────────────── */}
        {!compact && (
          <Stat label="Daemon" value={daemonLabel} tone={daemonTone} dot size="sm" />
        )}

        {!compact && <div className="h-6 w-px bg-border-subtle" aria-hidden />}

        {/* ─── Dongle (USB radio device + bound protocol + TX pulse) ───── */}
        {!compact && (
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
          </div>
        )}

        {!compact && <div className="h-6 w-px bg-border-subtle" aria-hidden />}

        {/* ─── Receivers ─────────────────────────────────────────────── */}
        {!compact && (
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
        )}

        {!compact && <div className="h-6 w-px bg-border-subtle" aria-hidden />}

        {/* ─── Show group ─────────────────────────────────────────────── */}
        {!compact && (
          <Stat label="Show" value={showLabel} tone={showTone} dot size="sm" />
        )}

        {/* ─── Cursor (always visible) ────────────────────────────────── */}
        <div className={cn("flex items-center gap-2 ml-auto", compact && "ml-auto")}>
          <span className="eyebrow">Cursor</span>
          <span className="font-mono text-base text-fg-primary num">{cursorText}</span>
        </div>

        {!compact && mode.id === "manual_fire" ? (
          <Badge tone="armed" leading={<Dot tone="armed" pulse />}>
            Manual fire active
          </Badge>
        ) : null}
      </div>
    </>
  );
}
