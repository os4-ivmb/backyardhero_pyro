import React from "react";
import { cn } from "./cn";

// Horizontal two-or-more choice. One recessed track, selected option as a
// raised chip. Used for mutually exclusive settings that aren't a dropdown
// (dongle USB/Wireless, new-show Timeline/Stepped).

export function SegmentedControl({
  id,
  label,
  value,
  onChange,
  options,
  disabled = false,
  className,
}) {
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex p-1 rounded-full bg-surface-inset border border-border",
        className,
      )}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => {
              if (!disabled) onChange?.(opt.value);
            }}
            className={cn(
              "h-8 px-5 rounded-full text-sm transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              "disabled:cursor-not-allowed disabled:opacity-60",
              selected
                ? "bg-surface-3 text-fg-primary font-semibold border border-border"
                : "text-fg-muted hover:text-fg-secondary border border-transparent",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
