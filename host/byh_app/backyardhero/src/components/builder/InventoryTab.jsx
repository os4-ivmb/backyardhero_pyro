import { useEffect, useMemo, useState } from "react";
import { MdAdd, MdEdit, MdRefresh } from "react-icons/md";
import { itemColorOf, getTypeLabel } from "@/constants";
import { cn } from "@/design";

// Inventory types that can be placed directly onto the timeline as a cue.
// Composite types (fused lines, rack shells) and raw fuses are built through
// their dedicated flows, not dragged from this list.
const PLACEABLE_TYPES = new Set([
  "CAKE_FOUNTAIN",
  "CAKE_200G",
  "CAKE_350G",
  "CAKE_500G",
  "COMPOUND_CAKE",
  "AERIAL_SHELL",
]);

// A draggable palette of inventory items. Dragging a row onto the Timeline
// drops a `newInventoryId` payload that ShowBuilder turns into a new cue (see
// Timeline.handleDrop / ShowBuilder.handleDropInventory).
export default function InventoryTab({ inventory, onAddInventory, onEditInventory, onRefreshInventory }) {
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!onRefreshInventory || refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshInventory();
    } finally {
      setRefreshing(false);
    }
  };
  // Right-click context menu: { x, y, item } | null.
  const [ctxMenu, setCtxMenu] = useState(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e) => e.key === "Escape" && setCtxMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (inventory || [])
      .filter((it) => PLACEABLE_TYPES.has(it.type))
      .filter((it) => !q || (it.name || "").toLowerCase().includes(q) || getTypeLabel(it.type).toLowerCase().includes(q))
      .sort((a, b) =>
        a.type === b.type
          ? (a.name || "").localeCompare(b.name || "")
          : getTypeLabel(a.type).localeCompare(getTypeLabel(b.type))
      );
  }, [inventory, query]);

  const handleDragStart = (e, item) => {
    e.dataTransfer.setData("newInventoryId", String(item.id));
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm text-fg-secondary">
          Drag an item onto the timeline to place it as a cue.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search inventory…"
            className="h-8 w-56 rounded-sm bg-surface-2 border border-border-subtle px-2 text-sm text-fg-primary placeholder:text-fg-muted"
          />
          {onRefreshInventory && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Reload inventory"
              className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-sm border border-border-subtle text-fg-secondary hover:text-fg-primary hover:bg-surface-3 disabled:opacity-50"
            >
              <MdRefresh className={cn("text-base", refreshing && "animate-spin")} />
            </button>
          )}
          {onAddInventory && (
            <button
              type="button"
              onClick={onAddInventory}
              className="h-8 shrink-0 inline-flex items-center gap-1.5 rounded-sm bg-emerald-600 hover:bg-emerald-700 px-3 text-sm text-white"
              title="Open the Inventory page to add a new item"
            >
              <MdAdd className="text-base" />
              Add new item to inventory
            </button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border-subtle px-4 py-8 text-center text-sm text-fg-muted">
          {inventory?.length ? (
            "No placeable inventory matches your search."
          ) : (
            <div className="flex flex-col items-center gap-3">
              <span>No inventory yet. Add items to your inventory to place them on the timeline.</span>
              {onAddInventory && (
                <button
                  type="button"
                  onClick={onAddInventory}
                  className="inline-flex items-center gap-1.5 rounded-sm bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 text-sm text-white"
                >
                  <MdAdd className="text-base" />
                  Add new item to inventory
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {rows.map((item) => (
            <div
              key={item.id}
              draggable
              onDragStart={(e) => handleDragStart(e, item)}
              onContextMenu={
                onEditInventory
                  ? (e) => {
                      e.preventDefault();
                      setCtxMenu({ x: e.clientX, y: e.clientY, item });
                    }
                  : undefined
              }
              title={`${item.name} — ${getTypeLabel(item.type)} (drag onto the timeline · right-click for options)`}
              className={cn(
                "flex items-center gap-2 rounded-md border border-border-subtle bg-surface-2 px-2.5 py-2",
                "cursor-grab active:cursor-grabbing hover:border-accent hover:bg-surface-3 select-none"
              )}
            >
              <span
                className="h-3 w-3 shrink-0 rounded-sm"
                style={{ backgroundColor: itemColorOf(item) }}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg-primary">{item.name}</span>
                <span className="block truncate text-[11px] text-fg-muted">
                  {getTypeLabel(item.type)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[140px] rounded-md border border-border-subtle bg-surface-2 py-1 shadow-e3 text-sm text-fg-primary"
          style={{
            left: Math.min(ctxMenu.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 160),
            top: Math.min(ctxMenu.y, (typeof window !== "undefined" ? window.innerHeight : 9999) - 100),
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="px-3 py-1.5 text-xs text-fg-muted truncate border-b border-border-subtle mb-1">
            {ctxMenu.item.name}
          </div>
          <button
            type="button"
            onClick={() => {
              const it = ctxMenu.item;
              setCtxMenu(null);
              onEditInventory?.(it);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-3"
          >
            <span className="w-3.5 inline-flex justify-center text-[12px] opacity-80">
              <MdEdit aria-hidden />
            </span>
            Edit…
          </button>
        </div>
      )}
    </div>
  );
}
