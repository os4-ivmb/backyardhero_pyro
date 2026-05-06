import React from "react";
import { cn } from "@/design";
import { APP_MODES } from "@/design/useAppMode";

// The single, dominant indicator that tells the operator what state the
// system is in. It supersedes the previous chorus of 8 small pills.
//
// Visual rules:
//  - "design"/"standby"/"ready" stay calm — neutral or success.
//  - "armed"/"manual_fire" use the saturated armed channel.
//  - "live" pulses green.
//  - "disconnected"/"error" use warn/danger respectively.
//
// Sizes:
//   sm — used in dense tab strips where the chrome already telegraphs mode.
//   md — default header position.
//   lg — only used as a hero label inside fullscreen ARMED takeover.
const TONE_STYLES = {
  design:      "bg-surface-3 text-fg-secondary border-border",
  standby:     "bg-surface-3 text-fg-primary border-border",
  ready:       "bg-ok-bg text-ok-fg border-ok/60",
  manual_fire: "bg-armed-bg text-armed-fg border-armed/70",
  armed:       "bg-armed-bg text-armed-fg border-armed shadow-armed",
  live:        "bg-live-bg text-live-fg border-live",
  disconnected:"bg-warn-bg text-warn-fg border-warn/60",
  error:       "bg-danger-bg text-danger-fg border-danger",
};

const SIZES = {
  sm: "h-6 px-2 text-2xs gap-1.5",
  md: "h-8 px-3 text-xs gap-2",
  lg: "h-12 px-5 text-lg gap-3 font-bold tracking-widest",
};

export default function ModeBadge({ mode, size = "md", className }) {
  if (!mode) mode = APP_MODES.design;
  const showsDot = mode.id === "armed" || mode.id === "live" || mode.id === "manual_fire";
  return (
    <span
      role="status"
      aria-label={`Operational mode: ${mode.label}`}
      className={cn(
        "inline-flex items-center rounded-sm border font-semibold uppercase tracking-widest whitespace-nowrap",
        TONE_STYLES[mode.id] || TONE_STYLES.design,
        SIZES[size],
        className
      )}
    >
      {showsDot ? (
        <span
          className={cn(
            "inline-block w-2 h-2 rounded-full",
            mode.id === "live" ? "bg-live animate-livePulse"
              : mode.id === "armed" ? "bg-armed animate-livePulse"
              : "bg-armed"
          )}
          aria-hidden
        />
      ) : null}
      <span>{mode.label}</span>
    </span>
  );
}
