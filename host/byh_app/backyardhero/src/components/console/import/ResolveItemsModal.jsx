import React, { useEffect, useMemo, useState } from "react";
import { FaCheck, FaDownload, FaBoxOpen } from "react-icons/fa";
import { Modal, Button, Badge, selectClass, cn } from "@/design";
import useAppStore from "@/store/useAppStore";

import { uniqueLabels } from "@/util/showImport/itemMatch";
import {
  fetchCatalogRecords,
  buildCatalogIndex,
  suggestCatalogRecord,
  catalogRecordToInventoryPayload,
} from "@/util/showImport/catalog";
import { getTypeLabel } from "@/constants";
import CatalogSearch from "./CatalogSearch";
import InventorySearch from "./InventorySearch";

// The "resolve name conflicts" window, as a single master–detail surface: the
// cue-name list on the left, and the selected cue's resolver + full catalog
// search inline on the right. For each cue you can assign an existing inventory
// item, import the matching (or any searched) catalog product, or leave it as a
// generic placeholder. Unresolved names sort to the top.
export default function ResolveItemsModal({
  isOpen,
  onClose,
  cues,
  itemMatches,
  onSetMatch,
}) {
  const inventory = useAppStore((s) => s.inventory);
  const inventoryById = useAppStore((s) => s.inventoryById);
  const createInventoryItem = useAppStore((s) => s.createInventoryItem);

  const [records, setRecords] = useState(null); // null = not loaded yet
  const [catalogError, setCatalogError] = useState(null);
  const [busy, setBusy] = useState(() => new Set()); // labels mid-import
  const [importingAll, setImportingAll] = useState(false);
  const [selected, setSelected] = useState(null); // active cue name
  const [searchTab, setSearchTab] = useState("inventory"); // "inventory" | "catalog"

  const labels = useMemo(() => uniqueLabels(cues || []), [cues]);

  // Inventory options for the dropdown (non-fuse, name-sorted).
  const invOptions = useMemo(
    () =>
      (inventory || [])
        .filter((it) => it && it.type !== "FUSE")
        .slice()
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    [inventory],
  );

  const catalogIndex = useMemo(
    () => (records ? buildCatalogIndex(records) : new Map()),
    [records],
  );

  // Unresolved first, then alphabetical, so the work-to-do is at the top.
  const orderedLabels = useMemo(() => {
    return labels
      .map((l) => ({ ...l, matched: itemMatches?.[l.label] != null }))
      .sort((a, b) => {
        if (a.matched !== b.matched) return a.matched ? 1 : -1;
        return a.label.localeCompare(b.label);
      });
  }, [labels, itemMatches]);

  // Load the catalog once when the window opens.
  useEffect(() => {
    if (!isOpen || records != null) return;
    let alive = true;
    fetchCatalogRecords()
      .then((recs) => alive && setRecords(recs))
      .catch((e) => {
        if (!alive) return;
        setRecords([]);
        setCatalogError(e?.message || "Failed to load the catalog.");
      });
    return () => {
      alive = false;
    };
  }, [isOpen, records]);

  // Keep a valid selection: default to the first (unresolved-first) cue and
  // recover if the selected one disappears.
  useEffect(() => {
    if (!isOpen) return;
    if (selected && labels.some((l) => l.label === selected)) return;
    setSelected(orderedLabels[0]?.label ?? null);
  }, [isOpen, labels, orderedLabels, selected]);

  const markBusy = (label, on) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(label);
      else next.delete(label);
      return next;
    });

  // Import a specific catalog record into inventory and link it to the label.
  const importRecord = async (label, rec) => {
    if (!rec || !label) return null;
    markBusy(label, true);
    try {
      const created = await createInventoryItem(
        catalogRecordToInventoryPayload(rec),
      );
      if (created?.id != null) onSetMatch(label, created.id);
      return created;
    } catch {
      return null;
    } finally {
      markBusy(label, false);
    }
  };

  const importFromCatalog = (label) =>
    importRecord(label, suggestCatalogRecord(label, catalogIndex));

  const importAllSuggested = async () => {
    setImportingAll(true);
    try {
      for (const { label } of labels) {
        if (itemMatches?.[label] != null) continue;
        if (!suggestCatalogRecord(label, catalogIndex)) continue;
        // eslint-disable-next-line no-await-in-loop
        await importFromCatalog(label);
      }
    } finally {
      setImportingAll(false);
    }
  };

  const unmatchedWithSuggestion = orderedLabels.filter(
    (l) => !l.matched && suggestCatalogRecord(l.label, catalogIndex),
  ).length;

  const selectedRow = orderedLabels.find((l) => l.label === selected) || null;
  const selectedMatchId = selected != null ? itemMatches?.[selected] : null;
  const selectedInv =
    selectedMatchId != null ? inventoryById?.[selectedMatchId] : null;
  const selectedSuggestion = selected
    ? suggestCatalogRecord(selected, catalogIndex)
    : null;
  const selectedBusy = selected ? busy.has(selected) : false;

  const footer = (
    <Button variant="outline" onClick={onClose}>
      Done
    </Button>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Match imported items"
      eyebrow={`${labels.length} distinct cue name${labels.length === 1 ? "" : "s"}`}
      size="3xl"
      layer={1}
      footer={footer}
      footerStart={
        <Button
          variant="subtle"
          size="sm"
          leading={<FaBoxOpen />}
          onClick={importAllSuggested}
          loading={importingAll}
          disabled={records == null || unmatchedWithSuggestion === 0 || importingAll}
          title={
            records == null
              ? "Loading catalog…"
              : `Import ${unmatchedWithSuggestion} exact catalog match${unmatchedWithSuggestion === 1 ? "" : "es"}`
          }
        >
          Import all matches
          {unmatchedWithSuggestion > 0 ? ` (${unmatchedWithSuggestion})` : ""}
        </Button>
      }
    >
      {/* Cancel the Modal body's px-5 py-4 so the master/detail divider is
          full-bleed (cn is a plain joiner, so a p-0 override wouldn't win). */}
      <div className="flex flex-col md:flex-row h-[62vh] min-h-0 -mx-5 -my-4">
        {/* Master: cue-name list */}
        <div className="md:w-64 shrink-0 border-b md:border-b-0 md:border-r border-border-subtle overflow-y-auto max-h-40 md:max-h-none">
          <ul className="flex flex-col">
            {orderedLabels.map(({ label, count, matched }) => {
              const active = label === selected;
              return (
                <li key={label}>
                  <button
                    type="button"
                    onClick={() => setSelected(label)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 text-left border-l-2 transition-colors",
                      active
                        ? "bg-surface-3/60 border-accent"
                        : "border-transparent hover:bg-surface-3/30",
                    )}
                  >
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full shrink-0",
                        matched ? "bg-ok" : "bg-fg-disabled",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-fg-primary">
                      {label}
                    </span>
                    {count > 1 ? (
                      <span className="text-2xs text-fg-muted num shrink-0">
                        ×{count}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
            {orderedLabels.length === 0 ? (
              <li className="px-3 py-3 text-sm text-fg-muted">
                No cue names to match.
              </li>
            ) : null}
          </ul>
        </div>

        {/* Detail: resolver + catalog search for the selected cue */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-3 p-4">
          {catalogError ? (
            <div className="rounded-sm border border-warn/40 bg-warn-bg/60 px-3 py-2 text-xs text-warn-fg shrink-0">
              {catalogError} You can still assign existing inventory items.
            </div>
          ) : null}

          {selectedRow ? (
            <>
              <div className="flex items-center gap-2 min-w-0 shrink-0">
                <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-primary">
                  {selectedRow.label}
                  {selectedRow.count > 1 ? (
                    <span className="ml-1.5 text-2xs text-fg-muted num">
                      ×{selectedRow.count}
                    </span>
                  ) : null}
                </h4>
                {selectedRow.matched ? (
                  <Badge
                    tone="ok"
                    size="sm"
                    leading={<FaCheck className="w-2.5 h-2.5" />}
                  >
                    Matched
                  </Badge>
                ) : (
                  <Badge tone="neutral" size="sm">
                    Generic
                  </Badge>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap shrink-0">
                <select
                  value={selectedMatchId != null ? String(selectedMatchId) : ""}
                  onChange={(e) => onSetMatch(selected, e.target.value || null)}
                  className={cn(selectClass, "flex-1 min-w-[12rem]")}
                >
                  <option value="">— Generic (no match) —</option>
                  {selectedInv &&
                  !invOptions.some(
                    (it) => String(it.id) === String(selectedInv.id),
                  ) ? (
                    <option value={String(selectedInv.id)}>
                      {selectedInv.name}
                      {selectedInv.type
                        ? ` · ${getTypeLabel(selectedInv.type)}`
                        : ""}
                    </option>
                  ) : null}
                  {invOptions.map((it) => (
                    <option key={it.id} value={String(it.id)}>
                      {it.name}
                      {it.type ? ` · ${getTypeLabel(it.type)}` : ""}
                    </option>
                  ))}
                </select>

                {selectedSuggestion && !selectedRow.matched ? (
                  <Button
                    size="sm"
                    variant="primary"
                    leading={<FaDownload />}
                    onClick={() => importFromCatalog(selected)}
                    loading={selectedBusy}
                    disabled={selectedBusy}
                    title={`Import "${selectedSuggestion.fw_name}" (${getTypeLabel(
                      selectedSuggestion.type,
                    )}) from the catalog`}
                  >
                    Import match
                  </Button>
                ) : null}
              </div>

              <div className="border-t border-border-subtle pt-3 flex-1 min-h-0 flex flex-col">
                <div className="flex items-center gap-1 mb-2 shrink-0">
                  <TabButton
                    active={searchTab === "inventory"}
                    onClick={() => setSearchTab("inventory")}
                  >
                    Your inventory
                  </TabButton>
                  <TabButton
                    active={searchTab === "catalog"}
                    onClick={() => setSearchTab("catalog")}
                  >
                    Catalog
                  </TabButton>
                </div>
                {searchTab === "inventory" ? (
                  <InventorySearch
                    key={`inv-${selected}`}
                    label={selected}
                    items={invOptions}
                    selectedId={selectedMatchId}
                    onSelect={(id) => onSetMatch(selected, id)}
                    className="flex-1 min-h-0"
                  />
                ) : (
                  <CatalogSearch
                    key={`cat-${selected}`}
                    label={selected}
                    records={records}
                    onImport={(rec) => importRecord(selected, rec)}
                    className="flex-1 min-h-0"
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-fg-muted">
              Select a cue name to resolve it.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-2.5 py-1 text-xs rounded-sm border transition-colors",
        active
          ? "border-accent bg-surface-3/60 text-fg-primary"
          : "border-transparent text-fg-muted hover:bg-surface-3/30",
      )}
    >
      {children}
    </button>
  );
}
