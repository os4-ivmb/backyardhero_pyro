import React, { useEffect, useState } from "react";
import axios from "axios";
import { FaTriangleExclamation } from "react-icons/fa6";

import useStateAppStore from "@/store/useStateAppStore";
import { Toggle, Badge, Dot, cn } from "@/design";

// ---------------------------------------------------------------------------
// GpioOverridePanel
//
// Software overrides for the three physical switch inputs the dongle
// reports: ARM, MANUAL FIRE, and SHOW START. The dongle only *reports*
// these switches; the daemon is the sole enforcer, so an override applied
// in the daemon's GPIO shim is indistinguishable from a real switch throw
// to the rest of the system.
//
// Each row exposes:
//   - the live HARDWARE reading (what the physical switch is actually doing)
//   - a desired-value switch (the value to force)
//   - an "Apply override" checkbox that makes the desired value effective
//
// While an override is active the daemon ignores the dongle's reading for
// that input. This is a service/test affordance with real safety weight
// (forcing ARM/MANUAL FIRE on takes the system live), so the row is loud
// when active and the global override bar makes it impossible to forget.
// ---------------------------------------------------------------------------

// Order matches the operator's mental model: start -> arm -> fire.
const SWITCHES = [
  {
    key: "switch",
    label: "Show start",
    hint: "The start/stop switch. On = show start engaged.",
  },
  {
    key: "arm",
    label: "Arm",
    hint: "The arming switch. On = system armed (live fire enabled).",
  },
  {
    key: "manfire",
    label: "Manual fire",
    hint: "The manual-fire key. On = manual fire mode engaged.",
  },
];

function HardwareBadge({ on }) {
  return (
    <Badge
      tone={on ? "ok" : "neutral"}
      leading={<Dot tone={on ? "ok" : "neutral"} />}
    >
      {on ? "Switch ON" : "Switch OFF"}
    </Badge>
  );
}

function OverrideRow({ def, gpio, onCommit }) {
  const ov = gpio?.overrides?.[def.key] || {};
  const hardwareOn = !!gpio?.hardware?.[def.key];
  const upstreamActive = !!ov.active;
  const upstreamOn = ov.on == null ? hardwareOn : !!ov.on;

  // Local mirror so the controls are responsive before the WS echo lands.
  // Re-sync from upstream whenever the daemon's view changes.
  const [active, setActive] = useState(upstreamActive);
  const [on, setOn] = useState(upstreamOn);

  useEffect(() => {
    setActive(upstreamActive);
  }, [upstreamActive]);
  useEffect(() => {
    setOn(upstreamOn);
  }, [upstreamOn]);

  const commit = (nextActive, nextOn) => {
    setActive(nextActive);
    setOn(nextOn);
    onCommit(def.key, nextActive, nextOn);
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-3 rounded-md border px-3 py-3",
        active
          ? "border-armed/60 bg-armed-bg/40"
          : "border-border-subtle bg-surface-1"
      )}
    >
      <div className="min-w-[150px] flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-fg-primary">
            {def.label}
          </span>
          {active ? (
            <Badge tone="armed" leading={<Dot tone="armed" pulse />}>
              Overridden
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-fg-muted leading-snug">{def.hint}</p>
      </div>

      <div className="flex items-center gap-2">
        <span className="eyebrow">Hardware</span>
        <HardwareBadge on={hardwareOn} />
      </div>

      {/* Desired value the override forces. */}
      <Toggle
        id={`gpio-ov-${def.key}-value`}
        checked={on}
        onChange={(next) => commit(active, next)}
        tone="armed"
        label={on ? "Force ON" : "Force OFF"}
      />

      {/* Make the desired value effective. */}
      <label
        htmlFor={`gpio-ov-${def.key}-active`}
        className="inline-flex items-center gap-2 cursor-pointer select-none"
      >
        <input
          id={`gpio-ov-${def.key}-active`}
          type="checkbox"
          checked={active}
          onChange={(e) => commit(e.target.checked, on)}
          className="h-4 w-4 accent-armed cursor-pointer"
        />
        <span className="text-sm text-fg-secondary">Apply override</span>
      </label>
    </div>
  );
}

export default function GpioOverridePanel() {
  const { stateData } = useStateAppStore();
  const gpio = stateData?.fw_state?.gpio || {};

  const commit = async (key, active, on) => {
    try {
      await axios.post(
        "/api/system/cmd_daemon",
        { type: "set_gpio_override", key, active, on },
        { headers: { "Content-Type": "application/json" } },
      );
    } catch {
      /* daemon error log surfaces actual failures */
    }
  };

  const anyActive = SWITCHES.some((s) => gpio?.overrides?.[s.key]?.active);

  const clearAll = async () => {
    await Promise.all(
      SWITCHES.filter((s) => gpio?.overrides?.[s.key]?.active).map((s) =>
        commit(s.key, false, false),
      ),
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-bg/40 px-3 py-2">
        <FaTriangleExclamation className="mt-0.5 shrink-0 text-warn" />
        <p className="text-xs text-fg-secondary leading-snug">
          Software overrides replace the dongle's real switch readings. Forcing{" "}
          <span className="font-semibold text-fg-primary">Arm</span> or{" "}
          <span className="font-semibold text-fg-primary">Manual fire</span> on
          can take the system live without anyone touching the box. Use for
          bench testing and clear overrides before a real show.
        </p>
      </div>

      {SWITCHES.map((def) => (
        <OverrideRow key={def.key} def={def} gpio={gpio} onCommit={commit} />
      ))}

      {anyActive ? (
        <button
          type="button"
          onClick={clearAll}
          className="self-start mt-1 inline-flex items-center gap-2 px-3 h-8 rounded-sm border border-armed/60 text-armed-fg bg-armed-bg hover:bg-armed/20 text-sm font-medium transition-colors"
        >
          Clear all overrides
        </button>
      ) : null}
    </div>
  );
}
