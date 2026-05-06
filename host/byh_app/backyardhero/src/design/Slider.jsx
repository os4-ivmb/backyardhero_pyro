import React, { forwardRef } from "react";
import { cn } from "./cn";

// Range slider primitive. Replaces the bespoke `bg-gray-300 dark:bg-gray-700`
// inputs scattered through the settings page. Renders a tokenised track with
// the filled portion highlighted in --accent and a slim, focusable thumb.
//
// Two change channels:
//   onChange   fires on every drag tick (string value, like the native event)
//   onCommit   fires once on pointer release (used to debounce daemon writes)
//
// `value` should be numeric. Min/max default to 0/100 so it's a drop-in for
// "this is a percentage" cases without spelling them out.

export const Slider = forwardRef(function Slider(
  {
    id,
    value,
    onChange,
    onCommit,
    min = 0,
    max = 100,
    step = 1,
    disabled,
    className,
    ariaLabel,
  },
  ref
) {
  const numeric = Number(value);
  const safe = Number.isFinite(numeric)
    ? Math.min(Math.max(numeric, min), max)
    : min;
  const pct = ((safe - min) / Math.max(1, max - min)) * 100;

  return (
    <div
      className={cn(
        "relative flex items-center h-9",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
    >
      {/* Track + filled portion (decorative; native input sits on top). */}
      <div
        className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-surface-inset border border-border-subtle pointer-events-none"
        aria-hidden
      />
      <div
        className="absolute left-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-accent pointer-events-none"
        style={{ width: `${pct}%` }}
        aria-hidden
      />
      <input
        ref={ref}
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={safe}
        onChange={onChange}
        onPointerUp={onCommit}
        onKeyUp={(e) => {
          // Treat keyboard arrow release the same as pointer release so
          // committing the value isn't mouse-only.
          if (
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
             "Home", "End", "PageUp", "PageDown"].includes(e.key)
          ) {
            onCommit?.(e);
          }
        }}
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          "relative z-10 w-full h-9 bg-transparent appearance-none cursor-pointer",
          "focus:outline-none",
          // Webkit / Chromium thumb
          "[&::-webkit-slider-thumb]:appearance-none",
          "[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4",
          "[&::-webkit-slider-thumb]:rounded-full",
          "[&::-webkit-slider-thumb]:bg-fg-primary",
          "[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-accent",
          "[&::-webkit-slider-thumb]:shadow-e1",
          "[&::-webkit-slider-thumb]:transition-transform",
          "[&::-webkit-slider-thumb]:hover:scale-110",
          // Firefox thumb
          "[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4",
          "[&::-moz-range-thumb]:rounded-full",
          "[&::-moz-range-thumb]:bg-fg-primary",
          "[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-accent",
          "[&::-moz-range-thumb]:cursor-pointer",
          // Track resets so our painted track shows through
          "[&::-webkit-slider-runnable-track]:bg-transparent",
          "[&::-moz-range-track]:bg-transparent",
          // Focus ring on the thumb itself
          "focus-visible:[&::-webkit-slider-thumb]:ring-2",
          "focus-visible:[&::-webkit-slider-thumb]:ring-accent/40"
        )}
      />
    </div>
  );
});

export default Slider;
