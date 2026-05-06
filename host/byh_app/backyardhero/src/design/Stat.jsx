import React from "react";
import { cn } from "./cn";
import { Dot } from "./Badge";

// A label/value pair with optional status dot. The redesign uses Stat
// blocks in the footer status bar and the show-health row, replacing the
// "8 equally-loud pills" anti-pattern.
//
// Tone is purposefully muted by default; "ok" doesn't change much from
// "neutral" because a passing state should feel like background chrome.

const TONES = {
  neutral: { label: "text-fg-muted",      value: "text-fg-primary" },
  ok:      { label: "text-fg-muted",      value: "text-fg-primary" },
  warn:    { label: "text-warn",          value: "text-warn-fg" },
  danger:  { label: "text-danger",        value: "text-danger-fg" },
  armed:   { label: "text-armed",         value: "text-armed-fg" },
  live:    { label: "text-live",          value: "text-live-fg" },
};

export function Stat({
  label,
  value,
  tone = "neutral",
  dot = false,
  hint,
  size = "md",
  className,
  numeric = false,
  ...rest
}) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <div className={cn("flex flex-col min-w-0", className)} {...rest}>
      <div className="flex items-center gap-1.5">
        {dot ? <Dot tone={tone} pulse={tone === "armed" || tone === "live"} /> : null}
        <span className={cn("eyebrow", t.label)}>{label}</span>
      </div>
      <span
        className={cn(
          "truncate font-medium",
          numeric && "num font-mono",
          size === "sm" ? "text-sm" : size === "lg" ? "text-lg" : "text-base",
          t.value
        )}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </span>
      {hint ? <span className="text-2xs text-fg-muted truncate">{hint}</span> : null}
    </div>
  );
}

export default Stat;
