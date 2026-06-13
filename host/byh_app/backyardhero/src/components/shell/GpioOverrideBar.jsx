import React, { useMemo } from "react";
import axios from "axios";
import { FaTriangleExclamation } from "react-icons/fa6";

import useStateAppStore from "@/store/useStateAppStore";
import { Dot, cn } from "@/design";

// ---------------------------------------------------------------------------
// GpioOverrideBar
//
// Persistent, anchored banner that appears whenever ANY physical switch
// input (arm / show start / manual fire) is being forced by a software
// override (see settings/GpioOverridePanel). Overrides silently replace the
// dongle's real switch readings, so this bar exists purely so an operator
// can never forget the system is in a forced state -- it's loud, sits in
// the bottom chrome above the status bar, and offers a one-tap "Clear".
//
// Renders nothing when no override is active, so it stays out of the way.
// ---------------------------------------------------------------------------

const LABELS = {
  switch: "Show start",
  arm: "Arm",
  manfire: "Manual fire",
};

export default function GpioOverrideBar({ compact = false }) {
  const stateData = useStateAppStore((s) => s.stateData);
  const overrides = stateData?.fw_state?.gpio?.overrides || {};

  const active = useMemo(
    () =>
      Object.entries(overrides)
        .filter(([, v]) => v?.active)
        .map(([key, v]) => ({ key, on: !!v.on })),
    [overrides],
  );

  if (active.length === 0) return null;

  const clearAll = async () => {
    await Promise.all(
      active.map((o) =>
        axios.post(
          "/api/system/cmd_daemon",
          { type: "set_gpio_override", key: o.key, active: false, on: false },
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
  };

  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 border-b border-armed/60 bg-armed-bg",
        "text-armed-fg",
        compact ? "px-2 h-7 text-2xs" : "px-3 h-8 text-xs",
      )}
    >
      <FaTriangleExclamation className="shrink-0" aria-hidden />
      <span className="font-semibold uppercase tracking-widest whitespace-nowrap">
        SW override
      </span>
      <div className="flex items-center gap-2 min-w-0 overflow-x-auto">
        {active.map((o) => (
          <span
            key={o.key}
            className="inline-flex items-center gap-1 whitespace-nowrap"
          >
            <Dot tone="armed" pulse={o.on} />
            {LABELS[o.key] || o.key}
            <span className="font-semibold">{o.on ? "ON" : "OFF"}</span>
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={clearAll}
        className="ml-auto shrink-0 inline-flex items-center px-2 h-5 rounded-sm border border-armed/70 hover:bg-armed/20 font-medium transition-colors"
      >
        Clear
      </button>
    </div>
  );
}
