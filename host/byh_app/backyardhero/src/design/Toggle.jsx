import React from "react";
import { cn } from "./cn";

// Switch primitive. Used wherever the prior UI rolled a checkbox + custom
// label. Pure visual control -- no animation jank, just a tokenised track
// that fills with --accent when on. Optional inline label and helper.
//
// Pass `tone="armed" | "danger"` to use a louder colour for safety toggles
// (e.g. "Require continuity" -- on means "block firing on bad continuity").

const TONES = {
  accent: { on: "bg-accent border-accent", off: "bg-surface-inset border-border" },
  armed:  { on: "bg-armed border-armed",   off: "bg-surface-inset border-border" },
  danger: { on: "bg-danger border-danger", off: "bg-surface-inset border-border" },
};

export function Toggle({
  id,
  checked,
  onChange,
  disabled,
  label,
  description,
  tone = "accent",
  className,
}) {
  const t = TONES[tone] || TONES.accent;
  const handleToggle = () => {
    if (disabled) return;
    onChange?.(!checked);
  };
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex items-start gap-3 cursor-pointer select-none",
        disabled && "cursor-not-allowed opacity-60",
        className
      )}
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={!!checked}
        disabled={disabled}
        onClick={handleToggle}
        className={cn(
          "relative shrink-0 mt-0.5 inline-flex h-5 w-9 items-center rounded-full",
          "border transition-colors duration-150",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          checked ? t.on : t.off,
          disabled && "cursor-not-allowed"
        )}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 rounded-full bg-fg-primary shadow-e1",
            "transition-transform duration-150 ease-snap",
            checked ? "translate-x-[18px]" : "translate-x-0.5"
          )}
          aria-hidden
        />
      </button>
      {(label || description) ? (
        <span className="min-w-0 flex flex-col gap-0.5">
          {label ? (
            <span className="text-sm text-fg-primary leading-tight">{label}</span>
          ) : null}
          {description ? (
            <span className="text-xs text-fg-muted leading-snug">{description}</span>
          ) : null}
        </span>
      ) : null}
    </label>
  );
}

export default Toggle;
