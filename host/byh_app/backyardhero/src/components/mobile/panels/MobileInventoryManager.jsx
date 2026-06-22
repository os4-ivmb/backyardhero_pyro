import React, { useCallback, useMemo, useState } from "react";
import { MdClose, MdEdit } from "react-icons/md";
import { FaImage, FaVideo, FaTriangleExclamation } from "react-icons/fa6";

import useAppStore from "@/store/useAppStore";
import { Section, Button, IconButton, Card, Badge, cn } from "@/design";
import { INV_TYPES, getTypeLabel } from "@/constants";
import { normalizeYouTubeUrl } from "@/util/youtube";
import { parseOptionalUnitCost } from "@/util/inventoryUnitCost";
import { asyncConfirm, asyncAlert } from "@/components/common/AsyncPrompt";

import {
  CakeFields,
  ShellFields,
  FuseFields,
} from "@/components/inventory/InventoryManager";

// Card-based inventory listing for mobile. The desktop version uses a
// dense table that doesn't fit a phone width (8 columns, sortable
// headers, hover-only edit affordance); this strips it back to a tap-
// anywhere-to-edit list so an operator can spot-check / amend an item
// while assembling racks in the yard.
//
// Tabs (Multishot / Artillery / Fuse) match the desktop ones so the
// mental model stays consistent. The "Tools" / batch reprocess panel
// is intentionally dropped here -- it's a desk-only workflow.
const TAB_CONFIG = {
  multishot: {
    label: "Multishot",
    types: ["CAKE_FOUNTAIN", "CAKE_200G", "CAKE_350G", "CAKE_500G", "COMPOUND_CAKE", "GENERIC"],
  },
  artillery: { label: "Artillery", types: ["AERIAL_SHELL"] },
  fuse:      { label: "Fuse",      types: ["FUSE"] },
};
const TAB_KEYS = Object.keys(TAB_CONFIG);
const ATTENTION_TYPES = new Set(
  Object.keys(INV_TYPES).filter((k) => k.startsWith("CAKE_") || k === "COMPOUND_CAKE")
);

const fmtInt = (val) => {
  const n = Number(val);
  return val == null || val === "" || Number.isNaN(n) ? "0" : String(Math.trunc(n));
};

const fmtCurrency = (val) =>
  val == null || val === "" || Number.isNaN(Number(val))
    ? "—"
    : `$${Number(val).toFixed(2)}`;

function attentionFlag(item) {
  if (!ATTENTION_TYPES.has(item.type)) return null;
  const noDur = item.duration == null
    || (typeof item.duration === "string" && item.duration.trim() === "");
  const hasYt = item.youtube_link && String(item.youtube_link).trim() !== "";
  const start = item.youtube_link_start_sec;
  const ytMissing = hasYt && (start == null
    || (typeof start === "string" && start.trim() === ""));
  const reasons = [];
  if (noDur) reasons.push("Missing duration");
  if (ytMissing) reasons.push("YouTube needs start time");
  return reasons.length ? reasons.join(". ") : null;
}

// Bottom-sheet editor. Same fields as the desktop modal but laid out
// vertically with full-width inputs for thumb tapping.
const DEFAULT_FORM = {
  id: "", name: "", type: "FUSE",
  duration: "", fuse_delay: "", lift_delay: "", burn_rate: "", color: "",
  available_ct: "", unit_cost: "",
  youtube_link: "", youtube_link_start_sec: "",
  image: "",
};

const inputClass =
  "h-10 w-full rounded-sm bg-surface-1 border border-border px-3 text-base text-fg-primary placeholder:text-fg-muted focus:border-accent transition-colors";
const labelClass =
  "block text-fg-secondary text-xs uppercase tracking-wider font-semibold mb-1";

function MobileInventoryEditor({
  activeItem, showNewItem, onSubmit, onDismiss, onDelete,
}) {
  const [formObject, setFormObject] = useState(activeItem || DEFAULT_FORM);
  const visible = !!showNewItem || !!(activeItem && activeItem.id);

  React.useEffect(() => {
    if (showNewItem) setFormObject(DEFAULT_FORM);
    else if (activeItem?.id) {
      setFormObject({ ...activeItem, metadata: activeItem.metadata || null });
    }
  }, [showNewItem, activeItem]);

  React.useEffect(() => {
    if (!visible) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onDismiss?.(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [visible, onDismiss]);

  if (!visible) return null;

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    if (name === "type") setFormObject({ ...DEFAULT_FORM, [name]: value, id: formObject.id });
    else setFormObject({ ...formObject, [name]: value });
  };

  const handleYouTubeLinkBlur = (e) => {
    const v = e.target.value;
    if (v && v.trim() !== "") {
      const norm = normalizeYouTubeUrl(v);
      if (norm && norm !== v) setFormObject({ ...formObject, youtube_link: norm });
    }
  };

  const Fields =
    formObject.type === "FUSE" ? FuseFields :
    formObject.type === "AERIAL_SHELL" ? ShellFields :
    CakeFields;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center"
      role="dialog"
      aria-modal
    >
      <div
        className="absolute inset-0 bg-surface-base/80 backdrop-blur-sm"
        onClick={onDismiss}
        role="presentation"
      />
      <div
        className={cn(
          "relative z-[101] w-full",
          "max-h-[92dvh] overflow-y-auto overscroll-contain",
          "rounded-t-xl border-t border-x border-border bg-surface-1 shadow-e3",
          "pb-safe"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle hint -- visual only; the modal is dismissed via
            tap-outside or the close button. */}
        <div className="h-1.5 w-10 rounded-full bg-border-default mx-auto mt-2" aria-hidden />
        <div className="flex items-center justify-between gap-2 px-4 h-12">
          <h3 className="text-base font-semibold text-fg-primary">
            {activeItem?.id ? "Edit item" : "Add item"}
          </h3>
          <IconButton label="Close editor" onClick={onDismiss}>
            <MdClose className="w-5 h-5" />
          </IconButton>
        </div>

        <form
          className="p-4 space-y-4"
          onSubmit={(e) => e.preventDefault()}
        >
          <div>
            <label className={labelClass}>Type</label>
            <select
              value={formObject.type}
              onChange={handleInputChange}
              name="type"
              className={inputClass}
            >
              {Object.keys(INV_TYPES).map((k) => (
                <option key={k} value={k}>{INV_TYPES[k]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Name</label>
            <input
              value={formObject.name} onChange={handleInputChange}
              name="name" type="text" className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Quantity available</label>
            <input
              value={formObject.available_ct} onChange={handleInputChange}
              name="available_ct" type="number"
              inputMode="numeric"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Unit cost (optional)</label>
            <input
              value={formObject.unit_cost ?? ""}
              onChange={handleInputChange}
              name="unit_cost" type="number" min="0" step="0.01"
              inputMode="decimal"
              placeholder="0.00" className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Image URL</label>
            <input
              value={formObject.image || ""} onChange={handleInputChange}
              name="image" type="text" className={inputClass}
            />
          </div>

          <div className="border-t border-border-subtle pt-4">
            <Fields
              formObject={formObject}
              handleInputChange={handleInputChange}
              handleYouTubeLinkBlur={handleYouTubeLinkBlur}
            />
          </div>

          <div className="flex flex-col gap-2 pt-2">
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              onClick={() => onSubmit(formObject)}
            >
              {activeItem?.id ? "Save changes" : "Add item"}
            </Button>
            {activeItem?.id && onDelete ? (
              <Button
                variant="ghost"
                size="md"
                className="w-full text-fg-muted hover:text-danger"
                onClick={() => onDelete(formObject)}
              >
                Delete
              </Button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}

function ItemCard({ item, onTap }) {
  const reason = attentionFlag(item);
  return (
    <button
      type="button"
      onClick={() => onTap(item)}
      className={cn(
        "w-full text-left rounded-md border bg-surface-1 px-3 py-3",
        "border-border-subtle hover:border-border-strong active:bg-surface-2",
        "flex items-start gap-3 transition-colors"
      )}
    >
      <div className="w-12 h-12 rounded-sm bg-surface-2 border border-border-subtle shrink-0 overflow-hidden flex items-center justify-center text-fg-muted">
        {item.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.image}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <FaImage aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          {reason ? (
            <FaTriangleExclamation className="text-warn mt-0.5 shrink-0" title={reason} aria-label={reason} />
          ) : null}
          <div className="font-medium text-fg-primary truncate">{item.name}</div>
        </div>
        <div className="mt-0.5 text-xs text-fg-muted truncate">
          {getTypeLabel(item.type)}
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-fg-secondary">
          <span className="num">Qty {fmtInt(item.available_ct)}</span>
          <span className="text-fg-muted">·</span>
          <span className="num">{fmtCurrency(item.unit_cost)}</span>
          {item.youtube_link ? (
            <>
              <span className="text-fg-muted">·</span>
              <FaVideo className="text-fg-muted" aria-label="Has video" />
            </>
          ) : null}
        </div>
      </div>
      <div className="text-fg-muted shrink-0 self-center">
        <MdEdit aria-hidden />
      </div>
    </button>
  );
}

export default function MobileInventoryManager() {
  const {
    inventory, createInventoryItem, updateInventoryItem, deleteInventoryItem,
  } = useAppStore();
  const [activeItem, setActiveItem] = useState(false);
  const [newItem, setNewItem] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState("multishot");

  const dismissEditor = useCallback(() => {
    setActiveItem(false);
    setNewItem(false);
  }, []);

  const tabCounts = useMemo(() => {
    const counts = Object.fromEntries(TAB_KEYS.map((k) => [k, 0]));
    for (const item of inventory || []) {
      for (const t of TAB_KEYS) {
        if (TAB_CONFIG[t].types.includes(item.type)) { counts[t]++; break; }
      }
    }
    return counts;
  }, [inventory]);

  const filtered = useMemo(() => {
    const allowed = new Set(TAB_CONFIG[activeTab].types);
    const q = filter.trim().toLowerCase();
    return (inventory || [])
      .filter((it) => allowed.has(it.type))
      .filter((it) => !q || (it.name || "").toLowerCase().includes(q))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [inventory, activeTab, filter]);

  const handleSubmit = async (item) => {
    let normalized = { ...item, unit_cost: parseOptionalUnitCost(item.unit_cost) };
    if (item.youtube_link && item.youtube_link.trim() !== "") {
      const norm = normalizeYouTubeUrl(item.youtube_link);
      normalized.youtube_link = norm || "";
    }
    try {
      if (normalized.id) {
        const existing = inventory.find((i) => i.id === normalized.id);
        let metadata =
          normalized.metadata !== undefined ? normalized.metadata : existing?.metadata;
        if (metadata && typeof metadata === "object") metadata = JSON.stringify(metadata);
        await updateInventoryItem(normalized.id, { ...normalized, metadata });
      } else {
        await createInventoryItem(normalized);
      }
      dismissEditor();
    } catch (err) {
      await asyncAlert(err?.response?.data?.error || err?.message || "Failed to save item.");
    }
  };

  const handleDelete = async (item) => {
    if (!item.id) return;
    if (!(await asyncConfirm({ message: `Delete "${item.name}"? This cannot be undone.`, destructive: true }))) return;
    try {
      await deleteInventoryItem(item.id);
      dismissEditor();
    } catch (e) {
      await asyncAlert(e?.response?.data?.error || "Failed to delete item.");
    }
  };

  return (
    <div className="w-full px-3 py-4 space-y-4">
      <Section title="Inventory">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search inventory…"
          className={inputClass}
        />
        <div role="tablist" className="mt-2 flex items-center gap-0 border-b border-border-subtle overflow-x-auto -mx-3 px-3 no-scrollbar">
          {TAB_KEYS.map((key) => {
            const active = activeTab === key;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(key)}
                className={cn(
                  "px-3 h-10 -mb-px border-b-2 inline-flex items-center gap-1.5 text-sm transition-colors whitespace-nowrap",
                  active
                    ? "text-fg-primary border-accent font-semibold"
                    : "text-fg-muted border-transparent"
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

        <div className="mt-3 flex flex-col gap-2">
          {filtered.length === 0 ? (
            <Card padding="lg" tone="neutral" className="text-center">
              <p className="text-fg-muted text-sm">
                {(inventory || []).length === 0
                  ? "No inventory yet -- add your first item below."
                  : "No items match this filter."}
              </p>
            </Card>
          ) : (
            filtered.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                onTap={(it) => { setActiveItem(it); setNewItem(false); }}
              />
            ))
          )}
        </div>

        <div className="pt-2">
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={() => { setActiveItem(false); setNewItem(true); }}
          >
            Add item
          </Button>
        </div>
      </Section>

      <MobileInventoryEditor
        activeItem={activeItem}
        showNewItem={newItem}
        onSubmit={handleSubmit}
        onDismiss={dismissEditor}
        onDelete={handleDelete}
      />
    </div>
  );
}
