import React, { forwardRef } from "react";
import { cn } from "./cn";

// Square icon-only button. Always wears a tooltip-via-title attribute so
// icon-only chrome stays discoverable (the previous design failed this on
// the inventory tag column).

const SIZES = {
  sm: "h-7 w-7 text-sm",
  md: "h-9 w-9 text-base",
  lg: "h-11 w-11 text-lg",
};

const VARIANTS = {
  ghost:
    "bg-transparent text-fg-secondary hover:text-fg-primary hover:bg-surface-3",
  outline:
    "bg-surface-1 text-fg-secondary border border-border hover:text-fg-primary hover:border-border-strong",
  danger:
    "text-danger hover:text-danger-fg hover:bg-danger/15",
};

export const IconButton = forwardRef(function IconButton(
  { size = "md", variant = "ghost", label, className, children, ...rest },
  ref
) {
  if (!label && !rest["aria-label"]) {
    // Avoid silently shipping an inaccessible icon-only control.
    if (process.env.NODE_ENV !== "production") {
      console.warn("IconButton requires a `label` (becomes title + aria-label).");
    }
  }
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex items-center justify-center rounded-sm transition-colors duration-150 ease-snap",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        SIZES[size],
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export default IconButton;
