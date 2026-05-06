import React from "react";
import { cn } from "./cn";

// Standard form-field chrome: small uppercase eyebrow label, optional hint
// underneath, and a tokenised input/select string consumers can reuse.
//
// Replaces the three or four different label/input idioms scattered through
// the show builder modals. Keeping the input className exported (not just
// the wrapper) lets us style native <select> / <input type="number"> the
// same way without having to re-implement them as components.

export const fieldLabelClass =
  "block text-fg-secondary text-2xs uppercase tracking-wider font-semibold mb-1";

export const fieldHintClass =
  "text-fg-muted text-xs mt-1 leading-snug";

export const inputClass =
  "h-9 w-full rounded-sm bg-surface-inset border border-border px-2.5 text-sm text-fg-primary placeholder:text-fg-muted focus:border-accent transition-colors";

export const selectClass = inputClass + " appearance-none pr-7 cursor-pointer";

export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label ? (
        <label htmlFor={htmlFor} className={fieldLabelClass}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="text-xs text-danger-fg mt-1 leading-snug">{error}</p>
      ) : hint ? (
        <p className={fieldHintClass}>{hint}</p>
      ) : null}
    </div>
  );
}

export default Field;
