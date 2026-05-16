import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  MdRefresh, MdSignalWifi4Bar, MdSignalWifiOff, MdRestartAlt,
  MdExpandLess, MdExpandMore,
} from "react-icons/md";

import useStateAppStore from "@/store/useStateAppStore";
import useAppStore from "@/store/useAppStore";
import useAppMode from "@/design/useAppMode";
import { cn, Stat, Dot, Badge } from "@/design";
import Toast from "../common/Toast";
import { isPollableReceiver } from "@/util/receivers";

// ---------------------------------------------------------------------------
// MobileStatusBar -- mobile twin of `shell/StatusBar.jsx`.
//
// Behavioural parity with the desktop bar (websocket lifecycle, error toast
// stream, dongle restart) is non-negotiable: the bar is also the only place
// in the app that owns the WS connection. We mirror those bits verbatim and
// only redo the *layout*:
//
//   * Default row is a 3-up summary (Link, Dongle, Receivers) plus a
//     time cursor. Sized to fit a 360px-wide phone with no overflow.
//   * Tap-to-expand reveals the full set of pills (Daemon, Show, Cursor)
//     in a stacked sheet directly above the bottom nav.
// ---------------------------------------------------------------------------

const DONGLE_DEFAULTS = {
  addr: "/dev/tty.usbmodem01",
  baud: 115200,
  protocol: "BKYD_TS_HYBRID",
};

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

export default function MobileStatusBar() {
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
  const [expanded, setExpanded] = useState(false);
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

  const linkOk = isConnected && wsAlive;
  const daemonTone = !linkOk ? "neutral" : daemonActive ? "ok" : "danger";
  const daemonLabel = !linkOk ? "—" : daemonActive ? "Active" : "Down";

  let dongleTone = "neutral";
  let dongleLabel = "—";
  if (linkOk && daemonActive) {
    if (!deviceRunning) { dongleTone = "danger"; dongleLabel = "Silent"; }
    else if (!activeProtocol) { dongleTone = "warn"; dongleLabel = "Unbound"; }
    else { dongleTone = "ok"; dongleLabel = activeProtocol; }
  }

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

  const showLabel = !isShowLoaded ? "—" : isShowRunning ? "Running" : "Loaded";
  const showTone = !isShowLoaded ? "neutral" : isShowRunning ? "live" : "ok";

  const cursorText = useMemo(() => {
    const v = Number(fwCursor);
    if (!Number.isFinite(v) || v < 0) return "—";
    const m = Math.floor(v / 60);
    const s = Math.floor(v % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }, [fwCursor]);

  const receiverSummary = useMemo(() => {
    const liveR = stateData.fw_state?.receivers || {};
    const cfgR = systemConfig?.receivers || {};
    const ids = new Set([...Object.keys(liveR), ...Object.keys(cfgR)]);
    let total = 0;
    let online = 0;
    for (const id of ids) {
      const r = liveR[id] || cfgR[id];
      if (!isPollableReceiver(r)) continue;
      total += 1;
      const lmt = liveR[id]?.status?.lmt;
      if (lmt && Date.now() - lmt < 10_000) online++;
    }
    return { total, online };
  }, [stateData.fw_state?.receivers, systemConfig?.receivers]);

  const receiverTone =
    receiverSummary.total === 0
      ? "neutral"
      : receiverSummary.online === receiverSummary.total
      ? "ok"
      : receiverSummary.online === 0
      ? "danger"
      : "warn";

  return (
    <>
      <div className="fixed bottom-20 left-2 right-2 z-[10000] flex flex-col-reverse gap-1.5 pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <Toast message={t.message} onDismiss={() => dismissToast(t.id)} duration={30000} />
          </div>
        ))}
      </div>

      <div className="px-2">
        {/* Top row: hero summary + expander toggle. Tap anywhere on the
            row to flip expanded state; controls within the row stop
            propagation so they keep working. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-2 h-10 text-left"
          aria-expanded={expanded}
          aria-label="Toggle status details"
        >
          {/* Link pill -- mirrors the desktop button's tap-to-reconnect
              behaviour but stops propagation so the row toggle doesn't
              also collapse the sheet. */}
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              isConnected ? disconnectWebSocket() : connectWebSocket();
            }}
            className={cn(
              "inline-flex items-center gap-1 px-1.5 h-7 rounded-sm border text-2xs font-medium shrink-0",
              isConnected && wsAlive
                ? "border-border-subtle text-fg-secondary"
                : "border-danger/50 text-danger-fg bg-danger-bg"
            )}
            title={isConnected ? "Disconnect from daemon" : "Reconnect to daemon"}
          >
            {isConnected && wsAlive ? (
              <MdSignalWifi4Bar className="text-base" aria-hidden />
            ) : (
              <MdSignalWifiOff className="text-base" aria-hidden />
            )}
            {isConnected && wsAlive ? "Link" : (
              <span className="inline-flex items-center gap-1">
                <MdRefresh aria-hidden /> Reconnect
              </span>
            )}
          </span>

          <span className="h-5 w-px bg-border-subtle shrink-0" aria-hidden />

          <span className="inline-flex items-center gap-1.5 min-w-0">
            <Dot tone={dongleTone} pulse={dongleTone === "live"} />
            <span
              className={cn(
                "truncate font-mono text-xs",
                dongleTone === "danger" && "text-danger-fg",
                dongleTone === "warn" && "text-warn-fg",
                dongleTone === "ok" && "text-fg-primary",
                dongleTone === "neutral" && "text-fg-muted"
              )}
              title={`Dongle: ${dongleLabel}`}
            >
              {dongleLabel}
            </span>
            {dongleTone === "ok" && deviceIsTransmitting ? (
              <span
                className="inline-flex items-center gap-0.5 text-2xs text-live font-semibold"
                title="Dongle is actively transmitting"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-live animate-livePulse" />
                TX
              </span>
            ) : null}
          </span>

          <span className="h-5 w-px bg-border-subtle shrink-0" aria-hidden />

          <Stat
            label="Rcv"
            value={`${receiverSummary.online}/${receiverSummary.total}`}
            tone={receiverTone}
            dot
            size="sm"
            numeric
          />

          <span className="ml-auto inline-flex items-center gap-1 shrink-0 pl-1">
            <span className="font-mono text-xs num text-fg-secondary">
              {cursorText}
            </span>
            <span className="text-fg-muted">
              {expanded ? <MdExpandMore /> : <MdExpandLess />}
            </span>
          </span>
        </button>

        {expanded ? (
          <div className="pb-2 pt-1 border-t border-border-subtle grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="eyebrow">Daemon</span>
              <span className={cn(
                "font-medium",
                daemonTone === "ok" && "text-fg-primary",
                daemonTone === "danger" && "text-danger-fg",
                daemonTone === "neutral" && "text-fg-muted"
              )}>{daemonLabel}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="eyebrow">Show</span>
              <span className={cn(
                "font-medium",
                showTone === "ok" && "text-fg-primary",
                showTone === "live" && "text-live-fg",
                showTone === "neutral" && "text-fg-muted"
              )}>{showLabel}</span>
            </div>
            <div className="flex items-center justify-between col-span-2">
              <span className="eyebrow">Cursor</span>
              <span className="font-mono text-base text-fg-primary num">{cursorText}</span>
            </div>
            {dongleTone === "danger" && dongleLabel === "Silent" ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); restartDongle(); }}
                disabled={restartingDongle}
                className={cn(
                  "col-span-2 inline-flex items-center justify-center gap-1.5",
                  "px-2 h-8 rounded-sm border text-xs font-medium",
                  "border-danger/50 text-danger-fg bg-danger-bg",
                  "disabled:opacity-60 disabled:cursor-not-allowed"
                )}
              >
                <MdRestartAlt className={cn(restartingDongle && "animate-spin")} />
                {restartingDongle ? "Restarting…" : "Restart dongle"}
              </button>
            ) : null}
            {mode.id === "manual_fire" ? (
              <div className="col-span-2 flex justify-center">
                <Badge tone="armed" leading={<Dot tone="armed" pulse />}>
                  Manual fire active
                </Badge>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
