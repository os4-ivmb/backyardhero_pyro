import React from "react";
import { cn } from "./cn";

// Compact status pill. Calm by default; semantic variants only exist for
// "abnormal or actionable" states per the redesign brief — when a state
// is normal/idle it should look like neutral chrome, not a coloured pill.

const TONES = {
  neutral:
    "bg-surface-3 text-fg-secondary border-border-subtle",
  ok:
    "bg-ok-bg text-ok-fg border-ok/40",
  warn:
    "bg-warn-bg text-warn-fg border-warn/40",
  danger:
    "bg-danger-bg text-danger-fg border-danger/40",
  armed:
    "bg-armed-bg text-armed-fg border-armed/60",
  live:
    "bg-live-bg text-live-fg border-live/60",
  accent:
    "bg-accent-muted text-accent-fg border-accent/40",
};

const SIZES = {
  xs: "h-4 px-1.5 text-2xs",
  sm: "h-5 px-2 text-xs",
  md: "h-6 px-2.5 text-xs",
};

export function Badge({
  tone = "neutral",
  size = "sm",
  leading,
  children,
  pulse = false,
  className,
  ...rest
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border font-medium uppercase tracking-wider whitespace-nowrap",
        TONES[tone],
        SIZES[size],
        pulse && "animate-livePulse",
        className
      )}
      {...rest}
    >
      {leading ? <span className="shrink-0 -ml-0.5">{leading}</span> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

// Indicator dot used in dense status rows where even a Badge is too noisy.
export function Dot({ tone = "neutral", pulse = false, className }) {
  const color =
    tone === "ok" ? "bg-ok"
    : tone === "warn" ? "bg-warn"
    : tone === "danger" ? "bg-danger"
    : tone === "armed" ? "bg-armed"
    : tone === "live" ? "bg-live"
    : tone === "accent" ? "bg-accent"
    : "bg-fg-disabled";
  return (
    <span
      className={cn(
        "inline-block w-2 h-2 rounded-full shrink-0",
        color,
        pulse && "animate-livePulse",
        className
      )}
      aria-hidden
    />
  );
}

export default Badge;
