import React from "react";
import { cn } from "./cn";

// A neutral container surface. Replaces the dozens of bespoke
// `bg-gray-800 border border-gray-700 rounded-lg ...` blocks.
//
// `tone` is reserved for *abnormal* states — a card highlighting an
// error or an armed condition. Everything else should stay neutral.
const TONES = {
  neutral: "bg-surface-1 border border-border-subtle",
  raised:  "bg-surface-2 border border-border-subtle shadow-e2",
  inset:   "bg-surface-inset border border-border-subtle",
  ok:      "bg-ok-bg/60 border border-ok/40",
  warn:    "bg-warn-bg/60 border border-warn/40",
  danger:  "bg-danger-bg/70 border border-danger/50",
  armed:   "bg-armed-bg/60 border border-armed/50",
};

const PADDINGS = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export function Card({
  tone = "neutral",
  padding = "md",
  as: Tag = "div",
  className,
  children,
  ...rest
}) {
  return (
    <Tag
      className={cn("rounded-md", TONES[tone], PADDINGS[padding], className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({ title, eyebrow, actions, className }) {
  return (
    <div className={cn("flex items-start justify-between gap-3 mb-3", className)}>
      <div className="min-w-0">
        {eyebrow ? <div className="eyebrow mb-1">{eyebrow}</div> : null}
        {title ? (
          <h3 className="text-base font-semibold text-fg-primary truncate">
            {title}
          </h3>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
    </div>
  );
}

export default Card;
