import React, { useState, useMemo, useEffect } from "react";
import axios from "axios";
import { MdEdit, MdMoreVert } from "react-icons/md";
import { FaImage, FaVideo, FaChartLine, FaTriangleExclamation } from "react-icons/fa6";
import { FaCheckCircle, FaUpload } from "react-icons/fa";
import { FiPackage } from "react-icons/fi";

import { INV_TYPES, getTypeLabel } from "@/constants";
import {
  Card, Button, IconButton, Badge, Section,
  Table, THead, TH, TBody, TR, TD, cn,
} from "@/design";
import { asyncAlert } from "@/components/common/AsyncPrompt";

import ShotProfileModal from "./ShotProfileModal";
import ShellPackEditor from "./ShellPackEditor";
import ImportCatalogModal from "./ImportCatalogModal";

// Inventory categories. Each tab declares the raw item types it owns and
// the columns to render. The tab strip is calm — count chips, no
// background fills on inactive tabs.
const TAB_CONFIG = {
  multishot: {
    label: "Multishot",
    types: ["CAKE_FOUNTAIN", "CAKE_200G", "CAKE_350G", "CAKE_500G", "COMPOUND_CAKE", "GENERIC"],
    columns: ["name", "type", "duration", "delay", "qty", "unitCost", "tags", "source"],
  },
  artillery: {
    label: "Artillery",
    types: ["AERIAL_SHELL"],
    columns: ["name", "fuseDelay", "liftDelay", "qty", "unitCost", "tags", "source", "shells"],
  },
  fuse: {
    label: "Fuse",
    types: ["FUSE"],
    columns: ["name", "color", "burnRate", "qty", "unitCost", "source"],
  },
};
const TAB_KEYS = Object.keys(TAB_CONFIG);
const ATTENTION_TYPES = new Set(
  Object.keys(INV_TYPES).filter((k) => k.startsWith("CAKE_") || k === "COMPOUND_CAKE")
);

const fmtCurrency = (val) =>
  val == null || val === "" || Number.isNaN(Number(val))
    ? "—"
    : `$${Number(val).toFixed(2)}`;

const fmtInt = (val) => {
  const n = Number(val);
  return val == null || val === "" || Number.isNaN(n) ? "0" : String(Math.trunc(n));
};

const fmtDelay = (item) => {
  const f = item.fuse_delay, l = item.lift_delay;
  const parts = [];
  if (f != null && f !== "" && Number(f) >= 0) parts.push(`F:${Number(f)}`);
  if (l != null && l !== "" && Number(l) >= 0) parts.push(`L:${Number(l)}`);
  return parts.length ? parts.join(" ") : "—";
};

export default function InventoryList({ inventory, setActiveItem, refreshInventory }) {
  const [sortKey, setSortKey] = useState("name");
  const [sortDirection, setSortDirection] = useState("asc");
  const [activeTab, setActiveTab] = useState("multishot");
  const [firingProfiles, setFiringProfiles] = useState({});
  const [profileItem, setProfileItem] = useState(null);
  const [shellPackItem, setShellPackItem] = useState(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isBatchOpen, setIsBatchOpen] = useState(false);

  // Batch reprocess state preserved -- the controls remain functionally
  // identical, just relocated to a single collapsible "Tools" panel.
  const [detectionMethod, setDetectionMethod] = useState("max_amplitude");
  const [thresholdRatio, setThresholdRatio] = useState(0.7);
  const [thresholdRatioInput, setThresholdRatioInput] = useState("0.70");
  const [floorPercent, setFloorPercent] = useState(10);
  const [floorPercentInput, setFloorPercentInput] = useState("10.0");
  const [mergeThresholdMs, setMergeThresholdMs] = useState(500);
  const [mergeThresholdMsInput, setMergeThresholdMsInput] = useState("500");
  const [reprocessAll, setReprocessAll] = useState(false);
  const [overrideDuration, setOverrideDuration] = useState(false);
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [batchStatus, setBatchStatus] = useState(null);

  const sorted = useMemo(() => {
    const arr = [...inventory].sort((a, b) => {
      if (sortKey === "unit_cost") {
        const av = a.unit_cost == null || a.unit_cost === "" ? null : Number(a.unit_cost);
        const bv = b.unit_cost == null || b.unit_cost === "" ? null : Number(b.unit_cost);
        if (av == null && bv == null) return 0;
        if (av == null) return sortDirection === "asc" ? 1 : -1;
        if (bv == null) return sortDirection === "asc" ? -1 : 1;
        return sortDirection === "asc" ? av - bv : bv - av;
      }
      if (sortKey === "available_ct") {
        const av = Number(a.available_ct) || 0;
        const bv = Number(b.available_ct) || 0;
        return sortDirection === "asc" ? av - bv : bv - av;
      }
      const av = a[sortKey], bv = b[sortKey];
      if (av < bv) return sortDirection === "asc" ? -1 : 1;
      if (av > bv) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [inventory, sortKey, sortDirection]);

  const tabCounts = useMemo(() => {
    const counts = Object.fromEntries(TAB_KEYS.map((k) => [k, 0]));
    for (const item of inventory) {
      for (const t of TAB_KEYS) {
        if (TAB_CONFIG[t].types.includes(item.type)) { counts[t]++; break; }
      }
    }
    return counts;
  }, [inventory]);

  const filtered = useMemo(() => {
    const allowed = new Set(TAB_CONFIG[activeTab].types);
    return sorted.filter((it) => allowed.has(it.type));
  }, [sorted, activeTab]);

  const totalValue = useMemo(() => {
    let sum = 0;
    for (const inv of filtered) {
      const qty = Math.max(0, Math.trunc(Number(inv.available_ct) || 0));
      const price = Number(inv.unit_cost);
      if (Number.isFinite(price) && price >= 0) sum += qty * price;
    }
    return sum;
  }, [filtered]);

  const handleSort = (key) => {
    if (sortKey === key) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDirection("asc"); }
  };

  // Fetch firing profiles -- preserved from previous implementation.
  useEffect(() => {
    if (inventory.length === 0) return;
    let cancelled = false;
    (async () => {
      const profiles = {};
      await Promise.all(inventory.map(async (item) => {
        try {
          const { data } = await axios.get(`/api/inventory/${item.id}/firing-profile`);
          if (data) profiles[item.id] = data;
        } catch (e) {
          if (e.response?.status !== 404) console.error("firing-profile fetch", e);
        }
      }));
      if (!cancelled) setFiringProfiles(profiles);
    })();
    return () => { cancelled = true; };
  }, [inventory]);

  const refreshProfiles = async () => {
    const profiles = {};
    await Promise.all(inventory.map(async (item) => {
      try {
        const { data } = await axios.get(`/api/inventory/${item.id}/firing-profile`);
        if (data) profiles[item.id] = data;
      } catch (e) {
        if (e.response?.status !== 404) console.error("firing-profile fetch", e);
      }
    }));
    setFiringProfiles(profiles);
  };

  const handleGenerateProfile = async (item) => {
    if (!item.id || !item.youtube_link) return;
    try {
      await axios.post(`/api/inventory/${item.id}/reprocess-profile`, {
        detectionMethod: "max_amplitude",
        thresholdRatio: 0.7,
        mergeThresholdMs: 500,
        overrideDuration: false,
      });
      setTimeout(refreshProfiles, 3000);
      await asyncAlert("Shot profile generation started. Reload soon to see it.");
    } catch (e) {
      await asyncAlert(e.response?.data?.error || "Failed to start profile generation.");
    }
  };

  const handleBatchReprocess = async () => {
    setIsBatchProcessing(true);
    setBatchStatus(null);
    try {
      const { data } = await axios.post("/api/inventory/reprocess-all-profiles", {
        detectionMethod,
        thresholdRatio: detectionMethod === "max_amplitude" ? thresholdRatio : undefined,
        floorPercent: detectionMethod === "noise_floor" ? floorPercent : undefined,
        mergeThresholdMs,
        reprocessAll,
        overrideDuration,
      });
      setBatchStatus({ ok: true, message: data?.message || "Batch started." });
      setTimeout(refreshProfiles, 5000);
    } catch (e) {
      setBatchStatus({ ok: false, message: e.response?.data?.error || "Batch failed." });
    } finally {
      setIsBatchProcessing(false);
    }
  };

  const attention = (item) => {
    if (!ATTENTION_TYPES.has(item.type)) return { show: false };
    const noDur = item.duration == null || (typeof item.duration === "string" && item.duration.trim() === "");
    const hasYt = item.youtube_link && String(item.youtube_link).trim() !== "";
    const start = item.youtube_link_start_sec;
    const ytMissing = hasYt && (start == null || (typeof start === "string" && start.trim() === ""));
    const reasons = [];
    if (noDur) reasons.push("Missing duration");
    if (ytMissing) reasons.push("YouTube link needs a start time");
    return { show: noDur || ytMissing, title: reasons.join(". ") };
  };

  const hasShellPackData = (item) => {
    if (!item || item.type !== "AERIAL_SHELL" || !item.metadata) return false;
    try {
      const m = typeof item.metadata === "string" ? JSON.parse(item.metadata) : item.metadata;
      return !!m?.pack_shell_data?.shells?.length;
    } catch { return false; }
  };

  // -------------------------------------------------------------------------
  // Column renderers (shared between all tabs).
  // -------------------------------------------------------------------------
  const cols = {
    name: {
      header: "Name", sortKey: "name",
      render: (it) => {
        const a = attention(it);
        return (
          <TD>
            <div className="flex items-center gap-2 min-w-0">
              {a.show && (
                <span className="text-warn shrink-0" title={a.title}>
                  <FaTriangleExclamation aria-hidden />
                </span>
              )}
              <span className="truncate font-medium text-fg-primary">{it.name}</span>
            </div>
          </TD>
        );
      },
    },
    type: {
      header: "Type", sortKey: "type",
      render: (it) => <TD className="text-fg-secondary">{getTypeLabel(it.type)}</TD>,
    },
    duration: {
      header: "Duration", align: "right",
      render: (it) => <TD numeric>{it.duration ?? "—"}</TD>,
    },
    delay: {
      header: "Delay", align: "right",
      render: (it) => (
        <TD numeric className="text-fg-secondary">{fmtDelay(it)}</TD>
      ),
    },
    fuseDelay: {
      header: "Fuse delay", align: "right",
      render: (it) => <TD numeric>{it.fuse_delay ?? "—"}</TD>,
    },
    liftDelay: {
      header: "Lift delay", align: "right",
      render: (it) => <TD numeric>{it.lift_delay ?? "—"}</TD>,
    },
    burnRate: {
      header: "Burn rate", align: "right",
      render: (it) => <TD numeric>{it.burn_rate ?? "—"}</TD>,
    },
    qty: {
      header: "Qty", sortKey: "available_ct", align: "right",
      render: (it) => <TD numeric>{fmtInt(it.available_ct)}</TD>,
    },
    unitCost: {
      header: "Unit cost", sortKey: "unit_cost", align: "right",
      render: (it) => (
        <TD numeric className="text-fg-secondary">{fmtCurrency(it.unit_cost)}</TD>
      ),
    },
    color: {
      header: "Color",
      render: (it) => (
        <TD>
          {it.color ? (
            <span
              className="inline-block w-6 h-4 rounded-sm border border-border-subtle"
              style={{ backgroundColor: it.color }}
              title={it.color}
              aria-label={it.color}
            />
          ) : "—"}
        </TD>
      ),
    },
    tags: {
      header: "Tags",
      render: (it) => (
        <TD>
          <div className="flex items-center gap-2 text-fg-muted">
            {it.image ? <FaImage title="Has image" aria-hidden /> : null}
            {it.youtube_link ? (
              <a
                href={it.youtube_link} target="_blank" rel="noreferrer"
                className="hover:text-accent" title="Open YouTube link"
                onClick={(e) => e.stopPropagation()}
              >
                <FaVideo aria-hidden />
              </a>
            ) : null}
            {it.youtube_link && it.youtube_link.trim() !== "" ? (
              firingProfiles[it.id] ? (
                <button
                  onClick={(e) => { e.stopPropagation(); setProfileItem(it); }}
                  className="text-accent hover:brightness-125" title="View shot profile"
                >
                  <FaChartLine aria-hidden />
                </button>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); handleGenerateProfile(it); }}
                  className="text-warn hover:brightness-125" title="Generate shot profile"
                >
                  <FaChartLine aria-hidden />
                </button>
              )
            ) : null}
          </div>
        </TD>
      ),
    },
    source: {
      header: "Source",
      render: (it) => (
        <TD>
          <Badge tone={it.source === "imported" ? "accent" : "neutral"}>
            {it.source === "imported" ? "Library" : "User"}
          </Badge>
        </TD>
      ),
    },
    shells: {
      header: "Shells",
      render: (it) => (
        <TD>
          <Button
            size="xs" variant="outline"
            leading={<FiPackage />}
            onClick={(e) => { e.stopPropagation(); setShellPackItem(it); }}
          >
            {hasShellPackData(it) ? (
              <span className="inline-flex items-center gap-1">
                <FaCheckCircle className="text-ok" aria-hidden /> Pack
              </span>
            ) : "Edit pack"}
          </Button>
        </TD>
      ),
    },
  };

  const activeColumns = TAB_CONFIG[activeTab].columns;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div role="tablist" className="flex items-center gap-0 border-b border-border-subtle pb-0">
          {TAB_KEYS.map((key) => {
            const active = activeTab === key;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(key)}
                className={cn(
                  "px-3 h-9 -mb-px border-b-2 inline-flex items-center gap-2 text-sm transition-colors",
                  active
                    ? "text-fg-primary border-accent font-semibold"
                    : "text-fg-muted border-transparent hover:text-fg-secondary"
                )}
              >
                {TAB_CONFIG[key].label}
                <span className={cn(
                  "rounded-sm px-1.5 text-2xs num",
                  active ? "bg-accent-muted text-accent-fg" : "bg-surface-3 text-fg-muted"
                )}>
                  {tabCounts[key] || 0}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" leading={<FaUpload />} onClick={() => setIsImportOpen(true)}>
            Import
          </Button>
        </div>
      </div>

      {/* Tools — collapsible. Subordinate to the main table; doesn't compete. */}
      <Card padding="none" tone="neutral">
        <button
          type="button"
          onClick={() => setIsBatchOpen((v) => !v)}
          className="w-full px-4 h-10 flex items-center justify-between text-left hover:bg-surface-2/60"
          aria-expanded={isBatchOpen}
        >
          <span className="text-sm font-medium text-fg-primary">Batch tools</span>
          <span className="text-fg-muted text-xs">{isBatchOpen ? "Hide" : "Show"}</span>
        </button>
        {isBatchOpen && (
          <div className="px-4 pb-4 pt-2 border-t border-border-subtle space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="eyebrow">Detection</span>
                <select
                  value={detectionMethod}
                  onChange={(e) => setDetectionMethod(e.target.value)}
                  className="h-9 rounded-sm bg-surface-1 border border-border px-2"
                >
                  <option value="max_amplitude">Max Amplitude</option>
                  <option value="noise_floor">Noise Floor</option>
                </select>
              </label>
              {detectionMethod === "max_amplitude" ? (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="eyebrow">Threshold (0–1)</span>
                  <input
                    type="number" min="0" max="1" step="0.01"
                    value={thresholdRatioInput}
                    onChange={(e) => {
                      const v = e.target.value; setThresholdRatioInput(v);
                      const n = parseFloat(v);
                      if (!Number.isNaN(n) && n >= 0 && n <= 1) setThresholdRatio(n);
                    }}
                    className="h-9 rounded-sm bg-surface-1 border border-border px-2 num"
                  />
                </label>
              ) : (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="eyebrow">Floor %</span>
                  <input
                    type="number" min="0" step="0.1"
                    value={floorPercentInput}
                    onChange={(e) => {
                      const v = e.target.value; setFloorPercentInput(v);
                      const n = parseFloat(v);
                      if (!Number.isNaN(n) && n >= 0) setFloorPercent(n);
                    }}
                    className="h-9 rounded-sm bg-surface-1 border border-border px-2 num"
                  />
                </label>
              )}
              <label className="flex flex-col gap-1 text-sm">
                <span className="eyebrow">Merge gap (ms)</span>
                <input
                  type="number" min="0" step="50"
                  value={mergeThresholdMsInput}
                  onChange={(e) => {
                    const v = e.target.value; setMergeThresholdMsInput(v);
                    const n = parseInt(v, 10);
                    if (!Number.isNaN(n) && n >= 0) setMergeThresholdMs(n);
                  }}
                  className="h-9 rounded-sm bg-surface-1 border border-border px-2 num"
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="text-sm flex items-center gap-2 text-fg-secondary">
                <input type="checkbox" checked={reprocessAll}
                  onChange={(e) => setReprocessAll(e.target.checked)} /> Overwrite existing
              </label>
              <label className="text-sm flex items-center gap-2 text-fg-secondary">
                <input type="checkbox" checked={overrideDuration}
                  onChange={(e) => setOverrideDuration(e.target.checked)} /> Override duration
              </label>
              <Button size="sm" variant="primary"
                onClick={handleBatchReprocess} disabled={isBatchProcessing}
                loading={isBatchProcessing}>
                {isBatchProcessing ? "Processing…" : "Start batch"}
              </Button>
              {batchStatus ? (
                <span className={cn("text-xs", batchStatus.ok ? "text-ok" : "text-danger")}>
                  {batchStatus.message}
                </span>
              ) : null}
            </div>
          </div>
        )}
      </Card>

      <Table>
        <THead>
          {activeColumns.map((colKey) => {
            const col = cols[colKey];
            return (
              <TH
                key={colKey}
                align={col.align || "left"}
                sortable={!!col.sortKey}
                active={col.sortKey && sortKey === col.sortKey}
                direction={sortDirection}
                onClick={() => col.sortKey && handleSort(col.sortKey)}
              >
                {col.header}
              </TH>
            );
          })}
          <TH align="right">{/* hover actions */}</TH>
        </THead>
        <TBody>
          {filtered.length === 0 ? (
            <TR>
              <TD className="py-8 text-center text-fg-muted italic"
                  colSpan={activeColumns.length + 1}>
                No {TAB_CONFIG[activeTab].label.toLowerCase()} items yet.
              </TD>
            </TR>
          ) : filtered.map((it) => (
            <TR
              key={it.id}
              onClick={() => setActiveItem(it)}
              attention={attention(it).show}
            >
              {activeColumns.map((colKey) => (
                <React.Fragment key={colKey}>
                  {cols[colKey].render(it)}
                </React.Fragment>
              ))}
              <TD align="right" className="opacity-0 group-hover:opacity-100">
                <div className="inline-flex items-center gap-1 invisible-on-row hover:visible">
                  <IconButton
                    label="Edit item"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); setActiveItem(it); }}
                  >
                    <MdEdit />
                  </IconButton>
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>

      <p className="text-sm text-fg-muted text-right num">
        Total value:{" "}
        <span className="text-fg-secondary">
          {totalValue.toLocaleString("en-US", { style: "currency", currency: "USD" })}
        </span>
      </p>

      <ShotProfileModal
        isVisible={!!profileItem}
        item={profileItem}
        firingProfile={profileItem ? firingProfiles[profileItem.id] : null}
        onClose={() => setProfileItem(null)}
        onReprocessComplete={refreshProfiles}
      />
      <ShellPackEditor
        isOpen={!!shellPackItem}
        onClose={() => setShellPackItem(null)}
        item={shellPackItem}
      />
      <ImportCatalogModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        onImportComplete={() => refreshInventory && refreshInventory()}
      />
    </div>
  );
}
