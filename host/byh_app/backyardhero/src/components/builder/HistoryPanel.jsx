import React, { useState } from "react";
import { FiRotateCcw, FiRotateCw, FiClock, FiTrash2, FiPlus, FiMinus, FiMove, FiEdit2, FiLock } from "react-icons/fi";
import { cn } from "@/design";

const cueName = (it) => (it && it.name) || "cue";

// Structured diff between two cue lists: what was added, removed, moved
// (start-time change) and otherwise edited (field changes). An item can appear
// in both `moved` and `edited` (moved + retimed duration, say).
const computeChanges = (prev, next) => {
  prev = prev || [];
  next = next || [];
  const prevById = new Map(prev.map((i) => [i.id, i]));
  const nextById = new Map(next.map((i) => [i.id, i]));
  const added = next.filter((i) => !prevById.has(i.id));
  const removed = prev.filter((i) => !nextById.has(i.id));
  const moved = [];
  const edited = [];
  const lockedChanged = [];
  const FIELDS = [
    ["duration", "Duration", true],
    ["zone", "Zone", false],
    ["target", "Target", false],
    ["delay", "Delay", true],
    ["metaDelaySec", "Meta delay", true],
    ["name", "Name", false],
    ["type", "Type", false],
  ];
  for (const n of next) {
    const p = prevById.get(n.id);
    if (!p || p === n) continue;
    if (Number(p.startTime) !== Number(n.startTime)) {
      moved.push({ item: n, from: Number(p.startTime), to: Number(n.startTime) });
    }
    if (!!p.locked !== !!n.locked) lockedChanged.push({ item: n, locked: !!n.locked });
    const fields = [];
    for (const [key, label, isTime] of FIELDS) {
      if (String(p[key] ?? "") !== String(n[key] ?? "")) {
        fields.push({ label, from: p[key], to: n[key], isTime });
      }
    }
    if (fields.length) edited.push({ item: n, fields });
  }
  return { added, removed, moved, edited, lockedChanged };
};

const Row = ({ icon, tone, children }) => (
  <li className="flex items-start gap-2 py-1 text-sm">
    <span className={cn("mt-0.5 shrink-0", tone)}>{icon}</span>
    <span className="min-w-0 text-fg-secondary">{children}</span>
  </li>
);

// Diff inspector: shows what a given history entry changed, comparing it to the
// snapshot it was derived from (its parent).
function DiffView({ entry, entries, formatTime, receiverLabels }) {
  const fmt = (v) => (formatTime ? formatTime(Number(v)) : String(v));
  const zoneLabel = (z) => (receiverLabels && receiverLabels[z]) || z;

  if (!entry) {
    return <p className="text-sm text-fg-muted italic">Select a step to inspect what it changed.</p>;
  }
  // A "revert" marker records that the operator jumped back through history
  // before their next edit; it carries no changes of its own, so skip the diff.
  if (entry.kind === "revert") {
    return (
      <div>
        <h4 className="text-sm font-medium text-fg-primary mb-1 truncate">{entry.label}</h4>
        <p className="text-sm text-fg-muted italic">
          Jumped back to an earlier state before continuing to edit.
        </p>
      </div>
    );
  }
  const parent = entry.parentId != null ? entries.find((e) => e.id === entry.parentId) : null;
  if (!parent) {
    return (
      <div>
        <h4 className="text-sm font-medium text-fg-primary mb-1">{entry.label}</h4>
        <p className="text-sm text-fg-muted italic">
          Baseline state — nothing to diff (this is where the log starts).
        </p>
      </div>
    );
  }

  const { added, removed, moved, edited, lockedChanged } = computeChanges(parent.items, entry.items);
  const nothing =
    !added.length && !removed.length && !moved.length && !edited.length && !lockedChanged.length;

  return (
    <div>
      <h4 className="text-sm font-medium text-fg-primary mb-2 truncate">{entry.label}</h4>
      {nothing ? (
        <p className="text-sm text-fg-muted italic">No field-level changes detected.</p>
      ) : (
        <ul className="divide-y divide-border-subtle/50">
          {added.map((it) => (
            <Row key={`a-${it.id}`} icon={<FiPlus aria-hidden />} tone="text-emerald-500">
              Added <span className="text-fg-primary font-medium">{cueName(it)}</span>{" "}
              <span className="text-fg-muted">at {fmt(it.startTime)}</span>
            </Row>
          ))}
          {removed.map((it) => (
            <Row key={`r-${it.id}`} icon={<FiMinus aria-hidden />} tone="text-danger">
              Removed <span className="text-fg-primary font-medium">{cueName(it)}</span>
            </Row>
          ))}
          {moved.map(({ item, from, to }) => (
            <Row key={`m-${item.id}`} icon={<FiMove aria-hidden />} tone="text-accent">
              Moved <span className="text-fg-primary font-medium">{cueName(item)}</span>{" "}
              <span className="num font-mono text-fg-muted">{fmt(from)}</span>
              <span className="text-fg-muted"> → </span>
              <span className="num font-mono text-fg-primary">{fmt(to)}</span>
            </Row>
          ))}
          {lockedChanged.map(({ item, locked }) => (
            <Row key={`l-${item.id}`} icon={<FiLock aria-hidden />} tone="text-fg-muted">
              {locked ? "Locked" : "Unlocked"}{" "}
              <span className="text-fg-primary font-medium">{cueName(item)}</span>
            </Row>
          ))}
          {edited.map(({ item, fields }) => (
            <Row key={`e-${item.id}`} icon={<FiEdit2 aria-hidden />} tone="text-amber-500">
              <span className="text-fg-primary font-medium">{cueName(item)}</span>
              <ul className="mt-0.5 ml-1 text-xs text-fg-muted">
                {fields.map((f) => {
                  const from = f.label === "Zone" ? zoneLabel(f.from) : f.isTime ? fmt(f.from) : String(f.from ?? "—");
                  const to = f.label === "Zone" ? zoneLabel(f.to) : f.isTime ? fmt(f.to) : String(f.to ?? "—");
                  return (
                    <li key={f.label}>
                      {f.label}: <span className="num font-mono">{from}</span>
                      <span> → </span>
                      <span className="num font-mono text-fg-secondary">{to}</span>
                    </li>
                  );
                })}
              </ul>
            </Row>
          ))}
        </ul>
      )}
    </div>
  );
}

// Visual undo/redo history for the timeline. `entries` is the ordered log of
// snapshots (index 0 = oldest / the loaded show), `index` points at the current
// state. The log is non-destructive: editing after an undo appends rather than
// discarding, so every state you've visited stays jumpable via `onGoTo`. The
// side panel diffs the selected step against the state it was derived from.
export default function HistoryPanel({ entries = [], index = -1, onGoTo, onClear, formatTime, receiverLabels }) {
  const [inspectedId, setInspectedId] = useState(null);
  const canUndo = index > 0;
  const canRedo = index >= 0 && index < entries.length - 1;
  const canClear = entries.length > 1;

  // Inspect the current step by default; fall back if the id no longer exists.
  const inspected =
    entries.find((e) => e.id === inspectedId) || entries[index] || null;

  const selectRow = (i) => {
    onGoTo?.(i);
    setInspectedId(entries[i]?.id ?? null);
  };

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <p className="text-sm text-fg-secondary max-w-md">
          Jump to any point in your edit history — even states you left behind
          after new edits. Select a step to inspect its changes. Saved per show
          for this session.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => selectRow(index - 1)}
            disabled={!canUndo}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-sm border transition-colors",
              canUndo
                ? "border-border text-fg-secondary hover:text-fg-primary hover:bg-surface-3"
                : "border-border-subtle text-fg-muted opacity-50 cursor-not-allowed"
            )}
          >
            <FiRotateCcw aria-hidden /> Undo
          </button>
          <button
            type="button"
            onClick={() => selectRow(index + 1)}
            disabled={!canRedo}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-sm border transition-colors",
              canRedo
                ? "border-border text-fg-secondary hover:text-fg-primary hover:bg-surface-3"
                : "border-border-subtle text-fg-muted opacity-50 cursor-not-allowed"
            )}
          >
            <FiRotateCw aria-hidden /> Redo
          </button>
          <button
            type="button"
            onClick={() => onClear?.()}
            disabled={!canClear}
            title="Clear the history log, keeping the current timeline as the new baseline"
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-sm border transition-colors",
              canClear
                ? "border-border text-fg-secondary hover:text-danger hover:border-danger/50 hover:bg-surface-3"
                : "border-border-subtle text-fg-muted opacity-50 cursor-not-allowed"
            )}
          >
            <FiTrash2 aria-hidden /> Clear
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-fg-muted italic">
          No history yet — load a show and start editing.
        </p>
      ) : (
        <div className="flex gap-4 items-start flex-col sm:flex-row">
          {/* Step list */}
          <ol className="w-full sm:w-64 shrink-0 rounded-md border border-border-subtle bg-surface-1/60 divide-y divide-border-subtle/60 overflow-y-auto max-h-[420px]">
            {entries.map((entry, i) => {
              const isCurrent = i === index;
              const isInspected = inspected && entry.id === inspected.id;
              const isFuture = i > index;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => selectRow(i)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors",
                      isInspected && "ring-1 ring-inset ring-accent/50",
                      isCurrent
                        ? "bg-accent/15 text-fg-primary"
                        : isFuture
                        ? "text-fg-muted hover:bg-surface-3/60 hover:text-fg-secondary"
                        : "text-fg-secondary hover:bg-surface-3/60 hover:text-fg-primary"
                    )}
                  >
                    {entry.kind === "revert" ? (
                      <FiRotateCcw
                        className={cn("shrink-0 text-[11px]", isCurrent ? "text-accent" : "text-fg-muted")}
                        aria-hidden
                      />
                    ) : (
                      <span
                        className={cn(
                          "shrink-0 w-1.5 h-1.5 rounded-full",
                          isCurrent ? "bg-accent" : isFuture ? "bg-border" : "bg-fg-muted"
                        )}
                        aria-hidden
                      />
                    )}
                    <span className="num text-[11px] text-fg-muted w-6 shrink-0">{i + 1}</span>
                    <span className={cn("flex-1 truncate", entry.kind === "revert" && "italic text-fg-muted")}>{entry.label}</span>
                    {isCurrent && (
                      <span className="eyebrow text-accent shrink-0 inline-flex items-center gap-1">
                        <FiClock aria-hidden /> now
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>

          {/* Diff inspector */}
          <div className="flex-1 min-w-0 rounded-md border border-border-subtle bg-surface-1/60 p-3 self-stretch">
            <DiffView
              entry={inspected}
              entries={entries}
              formatTime={formatTime}
              receiverLabels={receiverLabels}
            />
          </div>
        </div>
      )}
    </div>
  );
}
