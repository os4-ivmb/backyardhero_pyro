import React, { useMemo, useState } from "react";
import { Card, Badge, Button, cn } from "@/design";
import { FiChevronDown, FiAlertTriangle, FiArchive, FiRotateCcw } from "react-icons/fi";
import { protoStatusLabel } from "@/util/protoStatus";
import useAppStore from "@/store/useAppStore";
import { inventoryUsageRows } from "@/util/showInventoryUsage";
import { formatShowCreatedAt } from "@/util/showStats";
import { asyncAlert, asyncConfirm } from "@/components/common/AsyncPrompt";

// Collapsible details drawer. Replaces the always-visible MultiShowSection
// tab strip. Holds:
//   - Status explainer (proto handler stage in human language).
//   - Pre-check / proto handler errors, if any.
//   - Show actions (archive / un-archive).
//
// Default: collapsed. Auto-opens if there are errors so the operator
// doesn't miss them.

export default function ShowDetails({ errors = [], protoHandlerStatus, show }) {
  const hasErrors = errors.length > 0;
  const [open, setOpen] = useState(hasErrors);
  const explainer = protoStatusLabel(protoHandlerStatus);

  // Tabs: "Status" / "Errors" / "Actions". If errors present, default to errors tab.
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
          {show?.archived_at ? <Badge tone="neutral">Archived</Badge> : null}
        </div>
        <FiChevronDown className={cn("text-lg transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="border-t border-border-subtle">
          <div className="flex border-b border-border-subtle px-2">
            {[
              { id: "status", label: "Status" },
              { id: "errors", label: `Pre-check errors${hasErrors ? ` (${errors.length})` : ""}` },
              { id: "actions", label: "Actions" },
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
            ) : tab === "actions" ? (
              <ShowActions show={show} />
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

function ShowActions({ show }) {
  const { inventoryById, archiveShow, unarchiveShow } = useAppStore();
  const [updateInventory, setUpdateInventory] = useState(true);
  const [busy, setBusy] = useState(false);

  const usage = useMemo(
    () => inventoryUsageRows(show?.display_payload, inventoryById),
    [show?.display_payload, inventoryById]
  );

  if (!show?.id) return <p className="text-fg-muted">No show staged.</p>;

  const handleArchive = async () => {
    const deducting = updateInventory && usage.length > 0;
    const ok = await asyncConfirm({
      title: "Archive show",
      message: deducting
        ? `Archive "${show.name}" and deduct ${usage.length} inventory item${usage.length === 1 ? "" : "s"} used in this show?`
        : `Archive "${show.name}"?`,
      okLabel: "Archive",
    });
    if (!ok) return;
    setBusy(true);
    const r = await archiveShow(show.id, { updateInventory });
    setBusy(false);
    if (!r.ok) await asyncAlert({ title: "Archive failed", message: r.error });
  };

  const handleUnarchive = async () => {
    setBusy(true);
    const r = await unarchiveShow(show.id);
    setBusy(false);
    if (!r.ok) await asyncAlert({ title: "Un-archive failed", message: r.error });
  };

  if (show.archived_at) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          leading={<FiRotateCcw />}
          loading={busy}
          onClick={handleUnarchive}
        >
          Un-archive show
        </Button>
        <span className="text-fg-muted">
          Archived {formatShowCreatedAt(show.archived_at)}. Un-archiving does not restore inventory.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        <Button
          size="sm"
          variant="outline"
          leading={<FiArchive />}
          loading={busy}
          onClick={handleArchive}
        >
          Archive show
        </Button>
        <label className="inline-flex items-center gap-1.5 text-sm text-fg-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={updateInventory}
            onChange={(e) => setUpdateInventory(e.target.checked)}
          />
          Update inventory
        </label>
      </div>
      {updateInventory ? (
        usage.length === 0 ? (
          <p className="text-fg-muted">No non-shell inventory items to deduct.</p>
        ) : (
          <div className="flex flex-col gap-1 max-w-md">
            <span className="text-2xs text-fg-muted">
              Non-shell items deducted from inventory (shells are not changed):
            </span>
            <ul className="space-y-0.5">
              {usage.map((u) => (
                <li key={u.id} className="flex items-center gap-2 text-fg-secondary">
                  <span className="truncate">{u.name}</span>
                  <span className="num text-fg-muted tabular-nums ml-auto">
                    −{u.used} · {u.before} → {u.after}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}
    </div>
  );
}
