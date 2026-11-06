import React, { useEffect, useState } from "react";
import { FiPlus, FiX, FiTrash2 } from "react-icons/fi";
import { MdDragIndicator } from "react-icons/md";

import { itemColorOf, getTypeLabel } from "@/constants";
import { cn } from "@/design";
import {
  STEP_FIRE_SIMULTANEOUS,
  STEP_FIRE_STAGGERED,
  MAX_STEP_INTERVAL_MS,
  clampStepInterval,
} from "@/util/showConfig";

// Manual-sequence replacement for the editor Timeline. Steps scroll
// horizontally in firing order with an always-present "new step" box at the
// end. Each step stacks the cues it fires, top to bottom in firing order for
// interval steps. Steps are dragged by their header to reorder; cues can be
// dragged within a step to reorder or onto another step; inventory rows
// dropped on a step (or the new-step box) open the normal add flow for that
// step.

const STEP_MIME = "application/x-byh-step";
const ITEM_MIME = "application/x-byh-item";
const INVENTORY_MIME = "newinventoryid";

const hasType = (e, type) => Array.from(e.dataTransfer?.types || []).includes(type);
const acceptsDrop = (e) =>
  hasType(e, STEP_MIME) || hasType(e, ITEM_MIME) || hasType(e, INVENTORY_MIME);

// Id of the cue a dragged cue would land in front of, from the pointer's
// height over the step's cue rows; null means after the last cue.
function insertBeforeId(stepEl, clientY) {
  for (const row of stepEl.querySelectorAll("[data-seq-item-id]")) {
    const r = row.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return Number(row.dataset.seqItemId);
  }
  return null;
}

function StepModeBar({ step, onUpdateStep }) {
  const staggered = step.fireMode === STEP_FIRE_STAGGERED;
  const [draft, setDraft] = useState(String(step.intervalMs));
  useEffect(() => setDraft(String(step.intervalMs)), [step.intervalMs]);

  const commit = () => {
    const ms = clampStepInterval(draft);
    setDraft(String(ms));
    if (ms !== step.intervalMs) onUpdateStep(step.id, { intervalMs: ms });
  };

  const modeButton = (mode, label) => {
    const active = step.fireMode === mode;
    return (
      <button
        type="button"
        onClick={() => !active && onUpdateStep(step.id, { fireMode: mode })}
        aria-pressed={active}
        className={cn(
          "rounded-sm px-1.5 py-0.5 text-2xs font-medium transition-colors",
          active ? "bg-accent text-accent-fg" : "text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
        )}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      onDoubleClick={(e) => e.stopPropagation()}
      className="flex items-center gap-1 px-2 py-1 border-b border-border-subtle bg-surface-inset"
    >
      <div className="flex items-center gap-0.5 rounded-sm border border-border-subtle bg-surface-2 p-0.5">
        {modeButton(STEP_FIRE_SIMULTANEOUS, "Fire All")}
        {modeButton(STEP_FIRE_STAGGERED, "Interval")}
      </div>
      {staggered ? (
        <label className="ml-auto flex items-center gap-1 text-2xs text-fg-muted">
          <input
            type="number"
            min={1}
            max={MAX_STEP_INTERVAL_MS}
            step={10}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            aria-label={`Interval between cues in step ${step.number}, in milliseconds`}
            className="w-14 rounded-sm border border-border bg-surface-1 px-1 py-0.5 text-right text-2xs tabular-nums text-fg-primary focus:border-accent focus:outline-none"
          />
          ms
        </label>
      ) : null}
    </div>
  );
}

function StepItem({ item, receiverLabels, offsetMs, dropBefore, dragging, onDragState, onEdit, onRemove }) {
  const zoneLabel = receiverLabels?.[item.zone] || item.zone;
  return (
    <div
      draggable
      data-seq-item-id={item.id}
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.setData(ITEM_MIME, String(item.id));
        e.dataTransfer.effectAllowed = "move";
        onDragState(item.id);
      }}
      onDragEnd={() => onDragState(null)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onEdit(item);
      }}
      title="Double-click to edit · drag to reorder or move to another step"
      className={cn(
        "group relative flex items-stretch gap-2 rounded-sm border border-border-subtle bg-surface-2 pr-1 cursor-grab active:cursor-grabbing",
        dragging && "opacity-40"
      )}
    >
      {dropBefore ? (
        <span className="pointer-events-none absolute -top-1 left-0 right-0 h-0.5 rounded-full bg-accent" aria-hidden />
      ) : null}
      <span
        className="w-1.5 shrink-0 rounded-l-sm"
        style={{ backgroundColor: itemColorOf(item) }}
        aria-hidden
      />
      <div className="min-w-0 flex-1 py-1.5">
        <div className="truncate text-sm font-medium text-fg-primary">
          {item.name || getTypeLabel(item.type) || "Cue"}
        </div>
        <div className="truncate text-2xs text-fg-muted">
          {getTypeLabel(item.type)} · {zoneLabel}:{item.target}
        </div>
      </div>
      {offsetMs != null ? (
        <span className="self-center num text-2xs tabular-nums text-fg-muted group-hover:hidden">
          +{offsetMs}ms
        </span>
      ) : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(item);
        }}
        aria-label={`Remove ${item.name || "cue"} from step`}
        className="self-center rounded-sm p-1 text-fg-muted opacity-0 hover:bg-surface-3 hover:text-danger-fg group-hover:opacity-100 focus:opacity-100"
      >
        <FiX aria-hidden />
      </button>
    </div>
  );
}

export default function SequenceEditor({
  steps,
  receiverLabels,
  onAddToStep,
  onDropInventory,
  onEditItem,
  onRemoveItem,
  onRemoveStep,
  onMoveStep,
  onMoveItem,
  onUpdateStep,
}) {
  // Step id (or "new") currently under a drag, for the drop highlight.
  const [dragOver, setDragOver] = useState(null);
  // Where a dragged cue would be inserted: { stepId, beforeId }.
  const [cueDrop, setCueDrop] = useState(null);
  const [draggingItemId, setDraggingItemId] = useState(null);

  const handleDragState = (itemId) => {
    setDraggingItemId(itemId);
    if (itemId == null) {
      setCueDrop(null);
      setDragOver(null);
    }
  };

  const handleDrop = (e, stepId, stepIndex) => {
    e.preventDefault();
    setDragOver(null);
    setCueDrop(null);
    const draggedStep = e.dataTransfer.getData(STEP_MIME);
    if (draggedStep) {
      const toIndex = stepIndex == null ? steps.length - 1 : stepIndex;
      onMoveStep(draggedStep, toIndex);
      return;
    }
    const draggedItem = e.dataTransfer.getData(ITEM_MIME);
    if (draggedItem) {
      const beforeId = stepId == null ? null : insertBeforeId(e.currentTarget, e.clientY);
      onMoveItem(Number(draggedItem), stepId, beforeId);
      return;
    }
    const invId = e.dataTransfer.getData("newInventoryId");
    if (invId) onDropInventory(parseInt(invId, 10), stepId);
  };

  const dropProps = (key, stepId, stepIndex) => ({
    onDragOver: (e) => {
      if (!acceptsDrop(e)) return;
      e.preventDefault();
      if (dragOver !== key) setDragOver(key);
      if (stepId != null && hasType(e, ITEM_MIME)) {
        const beforeId = insertBeforeId(e.currentTarget, e.clientY);
        if (cueDrop?.stepId !== stepId || cueDrop?.beforeId !== beforeId) {
          setCueDrop({ stepId, beforeId });
        }
      } else if (cueDrop) {
        setCueDrop(null);
      }
    },
    onDragLeave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      setDragOver((cur) => (cur === key ? null : cur));
      setCueDrop((cur) => (cur?.stepId === stepId ? null : cur));
    },
    onDrop: (e) => handleDrop(e, stepId, stepIndex),
  });

  return (
    <div className="flex-1 min-h-0 flex flex-col rounded-md border border-border-subtle bg-surface-inset">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border-subtle shrink-0">
        <div className="text-sm text-fg-secondary">
          <span className="font-semibold text-fg-primary">Manual sequence</span>
          <span className="text-fg-muted">
            {" "}· {steps.length} step{steps.length === 1 ? "" : "s"} · each fire-key press fires the next step
          </span>
        </div>
        <div className="text-2xs text-fg-muted hidden md:block">
          Double-click a step to add a cue · drag headers to reorder steps · drag cues to reorder or move
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full items-stretch gap-3 p-3 w-max">
          {steps.map((step, index) => (
            <div
              key={step.id}
              {...dropProps(step.id, step.id, index)}
              onDoubleClick={() => onAddToStep(step.id)}
              className={cn(
                "w-64 shrink-0 flex flex-col min-h-0 rounded-md border bg-surface-1 transition-colors",
                dragOver === step.id ? "border-accent ring-2 ring-accent/40" : "border-border"
              )}
            >
              <div
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(STEP_MIME, step.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                className="flex items-start gap-1.5 px-2 pt-2 pb-1.5 border-b border-border-subtle cursor-grab active:cursor-grabbing"
                title="Drag to reorder"
              >
                <MdDragIndicator className="mt-1 shrink-0 text-fg-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="eyebrow">Step</div>
                  <div className="text-2xs text-fg-muted">
                    {step.items.length} cue{step.items.length === 1 ? "" : "s"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveStep(step.id);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  aria-label={`Remove step ${step.number}`}
                  title="Remove step"
                  className="rounded-sm p-1 text-fg-muted hover:bg-surface-3 hover:text-danger-fg"
                >
                  <FiTrash2 aria-hidden />
                </button>
                <span className="num text-3xl font-bold leading-none text-fg-primary tabular-nums">
                  {step.number}
                </span>
              </div>

              <StepModeBar step={step} onUpdateStep={onUpdateStep} />

              <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1.5">
                {step.items.map((item, itemIndex) => (
                  <StepItem
                    key={item.id}
                    item={item}
                    receiverLabels={receiverLabels}
                    offsetMs={
                      step.fireMode === STEP_FIRE_STAGGERED && step.items.length > 1
                        ? itemIndex * step.intervalMs
                        : null
                    }
                    dropBefore={cueDrop?.stepId === step.id && cueDrop.beforeId === item.id}
                    dragging={draggingItemId === item.id}
                    onDragState={handleDragState}
                    onEdit={onEditItem}
                    onRemove={onRemoveItem}
                  />
                ))}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddToStep(step.id);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="relative inline-flex items-center justify-center gap-1.5 rounded-sm border border-dashed border-border px-2 py-1.5 text-xs text-fg-muted hover:border-accent hover:text-fg-primary"
                >
                  {cueDrop?.stepId === step.id && cueDrop.beforeId == null ? (
                    <span className="pointer-events-none absolute -top-1 left-0 right-0 h-0.5 rounded-full bg-accent" aria-hidden />
                  ) : null}
                  <FiPlus aria-hidden /> Add cue
                </button>
              </div>
            </div>
          ))}

          <div
            {...dropProps("new", null, null)}
            onDoubleClick={() => onAddToStep(null)}
            className={cn(
              "w-64 shrink-0 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 text-center transition-colors",
              dragOver === "new" ? "border-accent bg-accent-muted/30" : "border-border hover:border-border-strong"
            )}
          >
            <span className="num text-3xl font-bold leading-none text-fg-muted tabular-nums">
              {steps.length + 1}
            </span>
            <div className="text-sm font-medium text-fg-secondary">New step</div>
            <p className="text-2xs text-fg-muted">
              Double-click, or drop an inventory item here, to start step {steps.length + 1}.
            </p>
            <button
              type="button"
              onClick={() => onAddToStep(null)}
              onDoubleClick={(e) => e.stopPropagation()}
              className="mt-1 inline-flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1 text-xs text-fg-secondary hover:border-accent hover:text-fg-primary"
            >
              <FiPlus aria-hidden /> Add cue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
