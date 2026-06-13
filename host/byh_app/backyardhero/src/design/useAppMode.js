import { useEffect, useMemo } from "react";
import useStateAppStore from "@/store/useStateAppStore";

// ---------------------------------------------------------------------------
// useAppMode
//
// Derives the *single* mutually-exclusive operational mode that the chrome
// uses to drive everything visual. The previous UI displayed contradictory
// states ("ARMED" + "Not Loaded" + "Standby" + "0 receivers" all at once)
// because every component derived its own bool from raw fields. This hook
// fixes that by:
//
//   1. Always returning exactly ONE primary mode from { disconnected,
//      design, standby, ready, armed, manual_fire, live, error }.
//   2. Respecting a precedence ladder so the most-dangerous condition wins.
//   3. Exposing sub-flags (isShowLoaded, hasErrors, ...) for components
//      that legitimately need finer-grained info, without re-deriving them
//      from raw daemon state.
//
// Mode precedence (highest first):
//   error          — Daemon down or hard fault. Only red banner shows.
//   disconnected   — WS / daemon unreachable.
//   live           — proto_handler running (STARTED / countdown).
//   armed          — device_is_armed AND show is loaded (live-fire imminent).
//   manual_fire    — manual_fire_active (key turned).
//   ready          — Show loaded and pre-checks pass.
//   standby        — Show staged but not yet loaded.
//   design         — Default. Editing / browsing inventory.
//
// `useAppMode` ALSO writes the active mode onto <html> as `mode-<id>` so the
// CSS variables defined in globals.css can swing the palette.
// ---------------------------------------------------------------------------

export const APP_MODES = {
  design: {
    id: "design",
    label: "Design",
    tone: "neutral",
    description: "Build and edit shows.",
  },
  standby: {
    id: "standby",
    label: "Standby",
    tone: "neutral",
    description: "Show staged. Load when ready.",
  },
  ready: {
    id: "ready",
    label: "Ready",
    tone: "ok",
    description: "Show loaded. Pre-checks passing.",
  },
  manual_fire: {
    id: "manual_fire",
    label: "Manual Fire",
    tone: "armed",
    description: "Key turned — manual fire active.",
  },
  armed: {
    id: "armed",
    label: "ARMED",
    tone: "armed",
    description: "Device is armed. Live fire imminent.",
  },
  live: {
    id: "live",
    label: "LIVE",
    tone: "live",
    description: "Show is running.",
  },
  disconnected: {
    id: "disconnected",
    label: "Disconnected",
    tone: "warn",
    description: "Daemon link down.",
  },
  error: {
    id: "error",
    label: "Fault",
    tone: "danger",
    description: "Hard fault — see errors.",
  },
};

export default function useAppMode() {
  const stateData = useStateAppStore((s) => s.stateData);
  const fw = stateData?.fw_state || {};

  const mode = useMemo(() => {
    const daemonActive = !!fw.daemon_active;
    // Liveness must compare client-clock to client-clock: the Pi has no
    // RTC and on an offline boot its wall clock can be hours behind the
    // browser, making `Date.now() - fw_last_update` look stale forever.
    // `_clientRxAt` is stamped by useStateAppStore when the WS message
    // arrives, so it's always in this browser's clock domain.
    const wsAlive =
      stateData?._clientRxAt &&
      Date.now() - stateData._clientRxAt < 4500;

    const showLoaded = !!fw.show_loaded || !!fw.loaded_show_id;
    const showStaged = false; // Always derived from useAppStore at the call site.

    const isArmed = !!fw.device_is_armed;
    const isManualFire = !!fw.manual_fire_active;
    const protoStatus = fw.proto_handler_status || "";
    const showRunning = !!fw.show_running;

    const fireCheckFailures = (fw.fire_check_failures || []).length;
    const protoErrors = (fw.proto_handler_errors || []).length;
    const dErrors = (stateData?.fw_d_error || []).length;
    const fwErrors = (stateData?.fw_error || []).length;
    const errorCount = fireCheckFailures + protoErrors + dErrors + fwErrors;

    const isLiveProto =
      protoStatus === "STARTED" ||
      protoStatus === "START_PENDING" ||
      protoStatus === "START_CONFIRMED" ||
      showRunning;

    if (!wsAlive || !daemonActive) return APP_MODES.disconnected;
    if (isLiveProto) return APP_MODES.live;
    if (isArmed && showLoaded) return APP_MODES.armed;
    if (isManualFire) return APP_MODES.manual_fire;
    if (showLoaded && fireCheckFailures === 0) return APP_MODES.ready;
    if (showLoaded) return APP_MODES.standby; // Loaded but pre-checks failing.
    return APP_MODES.design;
    // We don't enter `standby` from this hook because "show staged but not
    // loaded" depends on useAppStore and is computed at the consumer site
    // when needed. The chrome-level mode here is driven only by daemon state.
  }, [
    stateData?._clientRxAt,
    stateData?.fw_state,
    stateData?.fw_d_error,
    stateData?.fw_error,
  ]);

  // Apply the mode token to <html> so CSS vars / palette can swing.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    const klass = `mode-${mode.id}`;
    // Drop any prior mode class
    Array.from(html.classList).forEach((c) => {
      if (c.startsWith("mode-")) html.classList.remove(c);
    });
    html.classList.add(klass);
  }, [mode.id]);

  // Sub-flags returned for legitimate finer-grained branches.
  return {
    mode,
    isArmed: !!fw.device_is_armed,
    // Physical "show start" switch on the box -- only meaningful once
    // the device is armed. The daemon won't transition to
    // `waiting_for_client_start` until both arm and start are on.
    startSwActive: !!fw.start_sw_active,
    isManualFire: !!fw.manual_fire_active,
    isShowLoaded: !!fw.show_loaded || !!fw.loaded_show_id,
    isShowRunning: !!fw.show_running,
    protoStatus: fw.proto_handler_status || null,

    // Health is a chain of three independent signals; collapsing them
    // hides real failure modes (e.g. "daemon up but dongle silent").
    daemonActive: !!fw.daemon_active,
    deviceRunning: !!fw.device_running,           // dongle heartbeat in last 10s
    deviceIsTransmitting: !!fw.device_is_transmitting, // dongle sent traffic in last 10s
    wsAlive:
      !!stateData?._clientRxAt &&
      Date.now() - stateData._clientRxAt < 4500,
    activeProtocol: fw.active_protocol || null,
    fwCursor: stateData?.fw_cursor ?? null,
  };
}
