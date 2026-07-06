import React, { useMemo } from "react";
import { FaCheck, FaExclamationTriangle, FaPen } from "react-icons/fa";
import { Button, Badge, cn } from "@/design";

import { uniqueLabels } from "@/util/showImport/itemMatch";

// Step 3: match each distinct imported cue name to an inventory item so cues
// import as real, costed items instead of generic placeholders. Auto-matches
// are seeded before this step; here we summarise coverage and hand off to the
// resolve window for the rest. Nothing here blocks Continue — unmatched names
// simply import as generic placeholders.
export default function Step3MatchItems({
  conversion,
  itemMatches,
  inventoryById,
  onOpenResolve,
}) {
  const labels = useMemo(
    () => uniqueLabels(conversion?.cues || []),
    [conversion],
  );

  const matchedCount = labels.filter(
    (l) => itemMatches?.[l.label] != null,
  ).length;
  const total = labels.length;
  const allMatched = total > 0 && matchedCount === total;

  return (
    <div className="flex flex-col gap-4">
      {allMatched ? (
        <div className="flex items-center gap-2 rounded-sm border border-ok/40 bg-ok-bg/60 px-3 py-2 text-sm text-ok-fg">
          <FaCheck className="w-3.5 h-3.5 shrink-0" />
          Every cue name is matched to an inventory item.
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-sm border border-warn/40 bg-warn-bg/60 px-3 py-2 text-sm text-warn-fg">
          <FaExclamationTriangle className="w-3.5 h-3.5 shrink-0" />
          {total - matchedCount} of {total} cue names aren&apos;t matched — they
          import as generic placeholders unless you resolve them.
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-fg-secondary">
          <span className="num tabular-nums text-fg-primary">{matchedCount}</span>{" "}
          of <span className="num tabular-nums text-fg-primary">{total}</span>{" "}
          names matched
        </div>
        <Button variant="primary" size="sm" leading={<FaPen />} onClick={onOpenResolve}>
          Resolve items…
        </Button>
      </div>

      <ul className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle max-h-64 overflow-y-auto">
        {labels.map(({ label, count }) => {
          const matchId = itemMatches?.[label];
          const inv = matchId != null ? inventoryById?.[matchId] : null;
          const matched = !!inv;
          return (
            <li
              key={label}
              className="flex items-center gap-3 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-fg-primary">
                {label}
                {count > 1 ? (
                  <span className="ml-1.5 text-2xs text-fg-muted num">
                    ×{count}
                  </span>
                ) : null}
              </span>
              {matched ? (
                <span className="min-w-0 max-w-[45%] truncate text-xs text-fg-secondary">
                  {inv.name}
                </span>
              ) : null}
              <Badge tone={matched ? "ok" : "neutral"} size="sm">
                <span className={cn(!matched && "text-fg-muted")}>
                  {matched ? "Matched" : "Generic"}
                </span>
              </Badge>
            </li>
          );
        })}
        {labels.length === 0 ? (
          <li className="px-3 py-2 text-sm text-fg-muted">No cues to match.</li>
        ) : null}
      </ul>
    </div>
  );
}
