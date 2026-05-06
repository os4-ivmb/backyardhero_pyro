import React, { useState } from "react";
import axios from "axios";
import useStateAppStore from "@/store/useStateAppStore";
import { Toggle } from "@/design";

// Single boolean toggle for daemon-side verbose logging. Auto-commits on
// change -- no explicit Save -- because a one-bit setting doesn't earn a
// dirty-state UI. We optimistically mirror the new value into the local
// store so the toggle is responsive even before the WS pushes the echo.

export default function DebugModeToggle() {
  const { stateData, setStateData } = useStateAppStore();
  const upstream = !!stateData?.fw_state?.settings?.debug_mode;
  const [busy, setBusy] = useState(false);

  const onChange = async (next) => {
    if (busy) return;
    setBusy(true);
    // Optimistic: nudge the store so the switch flips immediately.
    setStateData({
      ...stateData,
      fw_state: {
        ...(stateData?.fw_state || {}),
        settings: {
          ...(stateData?.fw_state?.settings || {}),
          debug_mode: next ? 1 : 0,
        },
      },
    });
    try {
      await axios.post(
        "/api/system/cmd_daemon",
        { type: "set_debug_mode", debug_mode: next ? 1 : 0 },
        { headers: { "Content-Type": "application/json" } },
      );
    } catch {
      // Roll back the optimistic flip if the daemon refused.
      setStateData({
        ...stateData,
        fw_state: {
          ...(stateData?.fw_state || {}),
          settings: {
            ...(stateData?.fw_state?.settings || {}),
            debug_mode: upstream ? 1 : 0,
          },
        },
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Toggle
      id="debug-mode"
      checked={upstream}
      onChange={onChange}
      disabled={busy}
      label="Debug mode"
      description="Verbose logging on the daemon and dongle. Leave off for shows."
    />
  );
}
