import React, { forwardRef } from "react";
import { cn } from "./cn";

// Single source of truth for buttons across the app. Variants encode
// *intent*, sizes encode *density*. The previous codebase rolled bespoke
// classnames at every call site (16 different shades of "primary"), which
// was the root cause of the "excessive button color variety" issue.

const SIZES = {
  xs: "h-6 px-2 text-xs gap-1.5 rounded-sm",
  sm: "h-8 px-3 text-sm gap-2 rounded",
  md: "h-9 px-3.5 text-sm gap-2 rounded",
  lg: "h-11 px-4 text-base gap-2.5 rounded-md",
  xl: "h-14 px-6 text-lg gap-3 rounded-md font-semibold",
};

const VARIANTS = {
  // The default neutral button — used for almost everything.
  ghost:
    "bg-transparent text-fg-secondary hover:text-fg-primary hover:bg-surface-3 border border-transparent",
  // Quiet bordered control — secondary actions in headers.
  outline:
    "bg-surface-1 text-fg-primary border border-border hover:bg-surface-2 hover:border-border-strong",
  // The single primary action on a screen.
  primary:
    "bg-accent text-accent-fg border border-accent hover:brightness-110 active:brightness-95 font-semibold",
  // Subdued primary — for staged secondary CTAs.
  subtle:
    "bg-surface-3 text-fg-primary border border-border hover:bg-surface-2 hover:border-border-strong",
  // Reserved for destructive or dangerous flows (delete, abort).
  danger:
    "bg-danger/15 text-danger-fg border border-danger/60 hover:bg-danger/25 hover:border-danger font-semibold",
  // Reserved for live-fire / launch — green-pulse, never used elsewhere.
  live:
    "bg-live/15 text-live-fg border border-live/60 hover:bg-live/25 hover:border-live font-semibold",
  // ARMED, e.g. the unmistakable "ARM" or "DISARM" toggle.
  armed:
    "bg-armed/15 text-armed-fg border border-armed/60 hover:bg-armed/25 hover:border-armed font-semibold",
  // Warning intent — load, override, etc.
  warn:
    "bg-warn/12 text-warn-fg border border-warn/50 hover:bg-warn/20 hover:border-warn",
};

export const Button = forwardRef(function Button(
  {
    as: Tag = "button",
    size = "md",
    variant = "outline",
    leading,
    trailing,
    className,
    children,
    disabled,
    loading,
    ...rest
  },
  ref
) {
  return (
    <Tag
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap select-none",
        "transition-colors duration-150 ease-snap",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent",
        SIZES[size],
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {loading ? (
        <span
          className="inline-block w-3 h-3 rounded-full border-2 border-current border-r-transparent animate-spin"
          aria-hidden
        />
      ) : null}
      {leading ? <span className="-ml-0.5 shrink-0">{leading}</span> : null}
      <span className="truncate">{children}</span>
      {trailing ? <span className="-mr-0.5 shrink-0">{trailing}</span> : null}
    </Tag>
  );
});

export default Button;
