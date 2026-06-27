import React, { useMemo, useState } from "react";
import { FaCheck, FaPen, FaArrowRight, FaExclamationTriangle } from "react-icons/fa";
import { Button, Badge, selectClass, cn } from "@/design";

// Step 2: map each imported receiver to a real receiver in the system.
//
// Auto-matched receivers come in green; unmatched ones are yellow with a
// dropdown to resolve. A resolved tile can be edited to re-assign.
export default function Step2ResolveReceivers({
  conversion,
  resolutions,
  dbReceivers,
  onChangeResolution,
  onOpenCueList,
}) {
  const receivers = conversion?.receivers || [];
  const [editingKeys, setEditingKeys] = useState(() => new Set());
  const [draft, setDraft] = useState({});

  const resolvedCount = receivers.filter((r) => resolutions[r.key]).length;
  const allResolved = receivers.length > 0 && resolvedCount === receivers.length;

  const startEdit = (key) => {
    setDraft((d) => ({ ...d, [key]: resolutions[key] || "" }));
    setEditingKeys((s) => new Set(s).add(key));
  };
  const stopEdit = (key) => {
    setEditingKeys((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });
  };
  const confirm = (key) => {
    const choice = draft[key];
    if (!choice) return;
    onChangeResolution(key, choice);
    stopEdit(key);
  };

  return (
    <div className="flex flex-col gap-4">
      {allResolved ? (
        <div className="flex items-center gap-2 rounded-sm border border-ok/40 bg-ok-bg/60 px-3 py-2 text-sm text-ok-fg">
          <FaCheck className="w-3.5 h-3.5 shrink-0" />
          This show imports cleanly — every receiver is mapped.
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-sm border border-warn/40 bg-warn-bg/60 px-3 py-2 text-sm text-warn-fg">
          <FaExclamationTriangle className="w-3.5 h-3.5 shrink-0" />
          {receivers.length - resolvedCount} of {receivers.length} receivers
          need to be mapped to a receiver in your system.
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {receivers.map((rec) => {
          const resolvedId = resolutions[rec.key];
          const isEditing = editingKeys.has(rec.key) || !resolvedId;
          return (
            <ReceiverTile
              key={rec.key}
              rec={rec}
              resolvedId={resolvedId}
              dbReceivers={dbReceivers}
              resolutions={resolutions}
              isEditing={isEditing}
              draftValue={draft[rec.key]}
              onDraftChange={(v) => setDraft((d) => ({ ...d, [rec.key]: v }))}
              onConfirm={() => confirm(rec.key)}
              onEdit={() => startEdit(rec.key)}
              onOpenCueList={() => onOpenCueList(rec.key)}
            />
          );
        })}
      </div>
    </div>
  );
}

function ReceiverTile({
  rec,
  resolvedId,
  dbReceivers,
  resolutions,
  isEditing,
  draftValue,
  onDraftChange,
  onConfirm,
  onEdit,
  onOpenCueList,
}) {
  const resolved = !!resolvedId;
  const modules = Math.max(1, Math.round(rec.neededCues / 8));

  // Receivers selectable for THIS tile: enabled, and not already claimed by
  // another imported receiver (its own current resolution stays allowed).
  const options = useMemo(() => {
    const claimed = new Set(
      Object.entries(resolutions)
        .filter(([k]) => k !== rec.key)
        .map(([, id]) => id)
        .filter(Boolean),
    );
    return Object.entries(dbReceivers || {})
      .filter(([id, def]) => {
        if (!def || def.enabled === false) return false;
        if (claimed.has(id)) return false;
        return true;
      })
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  }, [dbReceivers, resolutions, rec.key]);

  const resolvedLabel = resolvedId
    ? dbReceivers?.[resolvedId]?.label &&
      dbReceivers[resolvedId].label !== resolvedId
      ? `${dbReceivers[resolvedId].label} (${resolvedId})`
      : resolvedId
    : null;

  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-md border p-3 transition-colors",
        resolved
          ? "border-ok/50 bg-ok-bg/30"
          : "border-warn/50 bg-warn-bg/30",
      )}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-sm font-semibold text-fg-primary shrink-0">
            {rec.key}
          </span>
          {resolved ? (
            <>
              <FaArrowRight className="w-3 h-3 text-fg-muted shrink-0" />
              <span className="text-sm text-fg-secondary truncate">
                {resolvedLabel}
              </span>
            </>
          ) : null}
        </div>
        <Badge tone={resolved ? "ok" : "warn"} size="sm">
          {resolved ? "Mapped" : "Unmapped"}
        </Badge>
      </div>

      <div className="flex items-center gap-2 text-2xs text-fg-muted">
        <button
          type="button"
          onClick={onOpenCueList}
          className="inline-flex items-center gap-1 rounded-sm border border-border-subtle bg-surface-1 px-2 py-0.5 text-xs text-fg-secondary hover:border-border-strong hover:text-fg-primary"
          title="View cue names on this receiver"
        >
          <span className="num tabular-nums">{rec.items.length}</span> cues
        </button>
        <span>·</span>
        <span>
          provisioning <span className="num">{rec.neededCues}</span> cues (
          {modules} module{modules === 1 ? "" : "s"})
        </span>
      </div>

      {isEditing ? (
        <div className="flex items-center gap-2">
          <select
            value={draftValue ?? resolvedId ?? ""}
            onChange={(e) => onDraftChange(e.target.value)}
            className={cn(selectClass, "flex-1")}
            disabled={options.length === 0}
          >
            <option value="">
              {options.length === 0 ? "(no receivers available)" : "Select a receiver…"}
            </option>
            {options.map(([id, def]) => (
              <option key={id} value={id}>
                {def.label && def.label !== id ? `${def.label} (${id})` : id}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="primary"
            onClick={onConfirm}
            disabled={!(draftValue ?? resolvedId)}
          >
            Confirm
          </Button>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button size="xs" variant="ghost" leading={<FaPen />} onClick={onEdit}>
            Edit
          </Button>
        </div>
      )}
    </div>
  );
}
