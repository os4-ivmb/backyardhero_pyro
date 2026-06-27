import React from "react";
import { FaCheck } from "react-icons/fa";
import { cn } from "@/design";

// Horizontal "Steps" header for the import flow. Highlights the current
// step, checks off completed ones, and — while processing between two
// steps — fills the connector with a determinate progress bar.
//
// Props:
//   steps:    [{ id, label }]
//   current:  active step id
//   progress: 0-100 while processing (drives the connector fill), or null
export default function StepsHeader({ steps, current, progress = null }) {
  return (
    <div className="flex items-center w-full px-1 pb-1">
      {steps.map((step, i) => {
        const isDone = step.id < current;
        const isActive = step.id === current;
        const isLast = i === steps.length - 1;
        // The connector after the active step fills with progress while
        // processing; connectors after completed steps are fully filled.
        const connectorFill = isDone ? 100 : isActive && progress != null ? progress : 0;
        return (
          <React.Fragment key={step.id}>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className={cn(
                  "flex items-center justify-center w-6 h-6 rounded-full border text-xs font-semibold num transition-colors",
                  isDone && "bg-accent border-accent text-accent-fg",
                  isActive && "border-accent text-accent",
                  !isDone && !isActive && "border-border text-fg-muted",
                )}
              >
                {isDone ? <FaCheck className="w-3 h-3" /> : step.id}
              </span>
              <span
                className={cn(
                  "text-xs font-medium whitespace-nowrap",
                  isActive ? "text-fg-primary" : "text-fg-muted",
                )}
              >
                {step.label}
              </span>
            </div>
            {!isLast ? (
              <div className="flex-1 mx-3 h-0.5 rounded-full bg-border-subtle overflow-hidden">
                <div
                  className="h-full bg-accent transition-all duration-200 ease-out"
                  style={{ width: `${connectorFill}%` }}
                />
              </div>
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}
