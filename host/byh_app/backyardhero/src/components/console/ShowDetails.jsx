import React, { useState } from "react";
import { Card, Badge, cn } from "@/design";
import { FiChevronDown, FiAlertTriangle } from "react-icons/fi";
import { protoStatusLabel } from "@/util/protoStatus";

// Collapsible details drawer. Replaces the always-visible MultiShowSection
// tab strip. Holds:
//   - Status explainer (proto handler stage in human language).
//   - Pre-check / proto handler errors, if any.
//
// Default: collapsed. Auto-opens if there are errors so the operator
// doesn't miss them.

export default function ShowDetails({ errors = [], protoHandlerStatus }) {
  const hasErrors = errors.length > 0;
  const [open, setOpen] = useState(hasErrors);
  const explainer = protoStatusLabel(protoHandlerStatus);

  // Tabs: "Status" / "Errors". If errors present, default to errors tab.
  const [tab, setTab] = useState(hasErrors ? "errors" : "status");

  return (
    <Card padding="none" tone="neutral" className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 h-10 flex items-center justify-between text-left hover:bg-surface-2/60 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <span className="eyebrow">Show details</span>
          {hasErrors ? (
            <Badge tone="danger" leading={<FiAlertTriangle />}>
              {errors.length} error{errors.length === 1 ? "" : "s"}
            </Badge>
          ) : explainer ? (
            <span className="text-sm text-fg-secondary truncate">{explainer}</span>
          ) : (
            <span className="text-sm text-fg-muted">No active status</span>
          )}
        </div>
        <FiChevronDown className={cn("text-lg transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="border-t border-border-subtle">
          <div className="flex border-b border-border-subtle px-2">
            {[
              { id: "status", label: "Status" },
              { id: "errors", label: `Pre-check errors${hasErrors ? ` (${errors.length})` : ""}` },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "h-9 px-3 text-sm border-b-2 transition-colors",
                  tab === t.id
                    ? "text-fg-primary border-accent"
                    : "text-fg-muted border-transparent hover:text-fg-secondary"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="p-4 text-sm">
            {tab === "status" ? (
              <p className="text-fg-secondary leading-relaxed">
                {explainer || "No active status."}
              </p>
            ) : hasErrors ? (
              <ul className="space-y-1.5">
                {errors.map((e, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-fg-secondary border-l-2 border-danger/60 pl-3 py-0.5"
                  >
                    <span className="font-mono text-xs text-fg-muted mt-0.5">
                      #{i + 1}
                    </span>
                    <span className="break-words">
                      {typeof e === "string" ? e : JSON.stringify(e)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-fg-muted">No errors.</p>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
