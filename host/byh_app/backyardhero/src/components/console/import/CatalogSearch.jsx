import React, { useMemo, useState } from "react";
import { FaDownload, FaSearch, FaYoutube } from "react-icons/fa";
import { Button, inputClass, selectClass, cn } from "@/design";
import { getTypeLabel } from "@/constants";

// Inline catalog search/browse (text + type + brand filters, name-sorted
// results) for a single cue name. Not a modal — it lives in the resolve
// window's detail pane. Picking a product calls onImport(rec); the parent
// imports it into inventory and links it. Remount (via a `key`) to re-seed the
// query when the selected cue changes.

const RESULT_LIMIT = 200;

export default function CatalogSearch({ label, records, onImport, className }) {
  const [query, setQuery] = useState(label || "");
  const [typeFilter, setTypeFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [importingKey, setImportingKey] = useState(null);

  const loading = records == null;

  const brands = useMemo(() => {
    const s = new Set();
    for (const r of records || []) if (r?.brand) s.add(r.brand);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [records]);

  const types = useMemo(() => {
    const s = new Set();
    for (const r of records || []) if (r?.type) s.add(r.type);
    return [...s].sort();
  }, [records]);

  const { results, total } = useMemo(() => {
    const q = (query || "").trim().toLowerCase();
    const matched = [];
    for (const r of records || []) {
      const name = (r?.fw_name || "").toLowerCase();
      const brand = (r?.brand || "").toLowerCase();
      if (q && !(name.includes(q) || brand.includes(q))) continue;
      if (typeFilter && r?.type !== typeFilter) continue;
      if (brandFilter && r?.brand !== brandFilter) continue;
      matched.push(r);
    }
    matched.sort((a, b) =>
      String(a.fw_name || "").localeCompare(String(b.fw_name || "")),
    );
    return { results: matched.slice(0, RESULT_LIMIT), total: matched.length };
  }, [records, query, typeFilter, brandFilter]);

  const handleImport = async (rec, key) => {
    setImportingKey(key);
    try {
      await onImport?.(rec);
    } finally {
      setImportingKey(null);
    }
  };

  return (
    <div className={cn("flex flex-col gap-2.5 min-h-0", className)}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[12rem]">
          <FaSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-muted pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the catalog by name or brand…"
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
        <select
          value={brandFilter}
          onChange={(e) => setBrandFilter(e.target.value)}
          className={cn(selectClass, "w-auto max-w-[12rem]")}
          aria-label="Filter by brand"
        >
          <option value="">All brands</option>
          {brands.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>

      <div className="text-2xs text-fg-muted shrink-0">
        {loading
          ? "Loading catalog…"
          : `${total} match${total === 1 ? "" : "es"}${
              total > RESULT_LIMIT ? ` · showing first ${RESULT_LIMIT}` : ""
            }`}
      </div>

      <div className="rounded-md border border-border-subtle overflow-hidden flex-1 min-h-0">
        <div className="h-full overflow-y-auto divide-y divide-border-subtle">
          {loading ? (
            <div className="px-3 py-8 text-center text-sm text-fg-muted">
              Loading catalog…
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-fg-muted">
              No catalog products match your search.
            </div>
          ) : (
            results.map((rec, i) => {
              const key = `${rec.fw_name}-${rec.brand || ""}-${i}`;
              return (
                <div
                  key={key}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-surface-3/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate text-sm text-fg-primary">
                        {rec.fw_name}
                      </span>
                      {rec.yt_url ? (
                        <FaYoutube
                          className="w-3 h-3 text-danger shrink-0"
                          title="Has video"
                        />
                      ) : null}
                    </div>
                    <div className="truncate text-2xs text-fg-muted">
                      {getTypeLabel(rec.type)}
                      {rec.brand ? ` · ${rec.brand}` : ""}
                      {rec.duration ? ` · ${rec.duration}s` : ""}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="primary"
                    leading={<FaDownload />}
                    onClick={() => handleImport(rec, key)}
                    loading={importingKey === key}
                    disabled={importingKey != null}
                  >
                    Import
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
