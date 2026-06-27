import React from "react";
import { Modal } from "@/design";

// Light, nested modal listing every cue mapped to one receiver:
//   cue number -> item (custom) label.
// Opened from the cue-count click target on a receiver tile in step 2.
export default function CueListModal({ isOpen, onClose, receiver, resolvedLabel }) {
  const items = receiver?.items || [];
  const title = resolvedLabel
    ? `Cues — ${receiver?.key} → ${resolvedLabel}`
    : `Cues — ${receiver?.key ?? ""}`;
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      eyebrow={`${items.length} cue${items.length === 1 ? "" : "s"}`}
      size="sm"
      layer={1}
    >
      <ul className="flex flex-col divide-y divide-border-subtle">
        {items.map((it, i) => (
          <li
            key={`${it.target}-${i}`}
            className="flex items-center gap-3 py-1.5 text-sm"
          >
            <span className="num shrink-0 w-10 text-fg-muted tabular-nums">
              #{it.target}
            </span>
            <span className="min-w-0 truncate text-fg-primary">{it.label}</span>
          </li>
        ))}
        {items.length === 0 ? (
          <li className="py-2 text-sm text-fg-muted">No cues on this receiver.</li>
        ) : null}
      </ul>
    </Modal>
  );
}
