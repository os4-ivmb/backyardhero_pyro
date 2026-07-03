import React, { useMemo, useState } from "react";
import { FaCheck, FaSearch } from "react-icons/fa";
import { Button, inputClass, selectClass, cn } from "@/design";
import { getTypeLabel } from "@/constants";

// Inline search/browse of the user's own inventory (text + type filter,
// name-sorted results) for a single cue name. Not a modal — it lives in the
// resolve window's detail pane alongside the catalog search. Picking an item
// calls onSelect(id) to link it to the cue; the row for the current match is
// highlighted. Remount (via a `key`) to re-seed the query when the selected
// cue changes.

const RESULT_LIMIT = 200;

export default function InventorySearch({
  label,
  items,
  selectedId,
  onSelect,
  className,
}) {
  const [query, setQuery] = useState(label || "");
  const [typeFilter, setTypeFilter] = useState("");

  const types = useMemo(() => {
    const s = new Set();
    for (const it of items || []) if (it?.type) s.add(it.type);
    return [...s].sort();
  }, [items]);

  const { results, total } = useMemo(() => {
    const q = (query || "").trim().toLowerCase();
    const matched = [];
    for (const it of items || []) {
      const name = (it?.name || "").toLowerCase();
      if (q && !name.includes(q)) continue;
      if (typeFilter && it?.type !== typeFilter) continue;
      matched.push(it);
    }
    matched.sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || "")),
    );
    return { results: matched.slice(0, RESULT_LIMIT), total: matched.length };
  }, [items, query, typeFilter]);

  return (
    <div className={cn("flex flex-col gap-2.5 min-h-0", className)}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[12rem]">
          <FaSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-muted pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your inventory by name…"
            className={cn(inputClass, "pl-8")}
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className={cn(selectClass, "w-auto")}
          aria-label="Filter by type"
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {getTypeLabel(t)}
            </option>
          ))}
        </select>
      </div>

      <div className="text-2xs text-fg-muted shrink-0">
        {`${total} item${total === 1 ? "" : "s"}${
          total > RESULT_LIMIT ? ` · showing first ${RESULT_LIMIT}` : ""
        }`}
      </div>

      <div className="rounded-md border border-border-subtle overflow-hidden flex-1 min-h-0">
        <div className="h-full overflow-y-auto divide-y divide-border-subtle">
          {results.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-fg-muted">
              No inventory items match your search.
            </div>
          ) : (
            results.map((it) => {
              const active = String(it.id) === String(selectedId);
              return (
                <div
                  key={it.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2",
                    active ? "bg-surface-3/60" : "hover:bg-surface-3/50",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-fg-primary">
                      {it.name}
                    </div>
                    <div className="truncate text-2xs text-fg-muted">
                      {getTypeLabel(it.type)}
                    </div>
                  </div>
                  {active ? (
                    <Button
                      size="xs"
                      variant="subtle"
                      leading={<FaCheck />}
                      onClick={() => onSelect?.(null)}
                    >
                      Matched
                    </Button>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onSelect?.(it.id)}
                    >
                      Use
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
