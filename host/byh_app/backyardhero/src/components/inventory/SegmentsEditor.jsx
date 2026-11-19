import React, { useState } from "react";
import { MdDelete, MdDragIndicator, MdArrowUpward, MdArrowDownward } from "react-icons/md";
import { LuBlocks } from "react-icons/lu";

import { cn } from "@/design";
import { newSegmentId, parseMetadata, segmentLabel } from "@/util/segments";

const labelClass = "block text-fg-secondary text-2xs uppercase tracking-wider font-semibold mb-1";
const inputClass = "h-8 w-full rounded-sm bg-surface-1 border border-border px-2 text-sm text-fg-primary placeholder:text-fg-muted focus:border-accent transition-colors";

const EMPTY_DRAFT = { name: "", duration: "", color: "" };

// Breaks a piece into ordered sections stored at metadata.segments. `metadata`
// may be a JSON string or object; onChange receives the next metadata object.
// `touch` swaps drag-to-reorder (HTML5 DnD doesn't fire on touch screens) for
// up/down buttons, for the mobile editor.
export default function SegmentsEditor({ metadata, onChange, touch = false }) {
  const meta = parseMetadata(metadata);
  const segments = Array.isArray(meta.segments) ? meta.segments : [];
  const [enabled, setEnabled] = useState(segments.length > 0);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [draftError, setDraftError] = useState(null);
  const [dragIdx, setDragIdx] = useState(-1);
  const [overIdx, setOverIdx] = useState(-1);

  const commit = (nextSegments) => {
    const next = { ...meta };
    if (nextSegments && nextSegments.length) next.segments = nextSegments;
    else delete next.segments;
    onChange(next);
  };

  const toggle = (on) => {
    setEnabled(on);
    // Unchecking discards the breakdown (nothing is saved until "Save changes").
    if (!on) commit([]);
  };

  const addSegment = () => {
    const d = Number(draft.duration);
    if (draft.duration === "" || !Number.isFinite(d) || d <= 0) {
      setDraftError("Duration must be a positive number of seconds.");
      return;
    }
    setDraftError(null);
    commit([
      ...segments,
      { id: newSegmentId(), name: draft.name.trim(), duration: d, color: draft.color || "" },
    ]);
    setDraft(EMPTY_DRAFT);
  };

  const updateSegment = (idx, patch) =>
    commit(segments.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  const removeSegment = (idx) => commit(segments.filter((_, i) => i !== idx));

  const moveSegment = (idx, delta) => {
    const to = idx + delta;
    if (to < 0 || to >= segments.length) return;
    const next = [...segments];
    [next[idx], next[to]] = [next[to], next[idx]];
    commit(next);
  };

  const handleDrop = (toIdx) => {
    if (dragIdx < 0 || dragIdx === toIdx) return;
    const next = [...segments];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(toIdx, 0, moved);
    commit(next);
  };

  const total = segments.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-fg-primary cursor-pointer select-none">
        <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} />
        <LuBlocks className="text-fg-secondary" aria-hidden />
        <span className="font-medium">Break down into sections</span>
      </label>

      {enabled && (
        <div className="space-y-3 rounded-sm border border-border-subtle bg-surface-2 p-3">
          <p className="text-fg-muted text-xs">
            Each section can be placed on the timeline on its own. {touch ? "Use the arrows" : "Drag rows"} to set the firing order.
          </p>

          <div className={cn("grid items-end gap-2", touch ? "grid-cols-[1fr_4.5rem_2.25rem_auto]" : "grid-cols-[1fr_5.5rem_2.5rem_auto]")}>
            <div>
              <label className={labelClass}>Label (optional)</label>
              <input
                className={inputClass} type="text" placeholder={`Section ${segments.length + 1}`}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSegment(); } }}
              />
            </div>
            <div>
              <label className={labelClass}>Duration (s)</label>
              <input
                className={inputClass} type="number" min="0" step="0.1"
                value={draft.duration}
                onChange={(e) => setDraft({ ...draft, duration: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSegment(); } }}
              />
            </div>
            <div>
              <label className={labelClass}>Color</label>
              <ColorInput value={draft.color} onChange={(c) => setDraft({ ...draft, color: c })} />
            </div>
            <button
              type="button" onClick={addSegment}
              className="h-8 px-3 rounded-sm bg-accent text-accent-fg text-sm font-medium hover:opacity-90"
            >
              Add
            </button>
          </div>
          {draftError && <p className="text-xs text-danger">{draftError}</p>}

          {segments.length === 0 ? (
            <p className="text-sm text-fg-muted italic">No sections yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-fg-muted text-2xs uppercase tracking-wider">
                  <th className={touch ? "w-14" : "w-6"} />
                  <th className="text-left font-semibold py-1 w-8">#</th>
                  <th className="text-left font-semibold py-1">Label</th>
                  <th className={cn("text-right font-semibold py-1", touch ? "w-16" : "w-20")}>Dur (s)</th>
                  <th className="font-semibold py-1 w-10">Color</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {segments.map((s, i) => (
                  <tr
                    key={s.id}
                    draggable={!touch}
                    onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
                    onDragOver={(e) => { e.preventDefault(); setOverIdx(i); }}
                    onDragLeave={() => setOverIdx((o) => (o === i ? -1 : o))}
                    onDrop={(e) => { e.preventDefault(); handleDrop(i); setDragIdx(-1); setOverIdx(-1); }}
                    onDragEnd={() => { setDragIdx(-1); setOverIdx(-1); }}
                    className={cn(
                      "border-t border-border-subtle",
                      dragIdx === i && "opacity-40",
                      overIdx === i && dragIdx !== i && "bg-accent-muted"
                    )}
                  >
                    {touch ? (
                      <td className="py-1">
                        <div className="flex items-center">
                          <button
                            type="button" onClick={() => moveSegment(i, -1)} disabled={i === 0}
                            className="p-1.5 text-fg-secondary disabled:opacity-25" aria-label={`Move section ${i + 1} up`}
                          >
                            <MdArrowUpward />
                          </button>
                          <button
                            type="button" onClick={() => moveSegment(i, 1)} disabled={i === segments.length - 1}
                            className="p-1.5 text-fg-secondary disabled:opacity-25" aria-label={`Move section ${i + 1} down`}
                          >
                            <MdArrowDownward />
                          </button>
                        </div>
                      </td>
                    ) : (
                      <td className="text-fg-muted cursor-grab"><MdDragIndicator aria-label="Drag to reorder" /></td>
                    )}
                    <td className="num text-fg-secondary">{i + 1}</td>
                    <td className="py-1 pr-2">
                      <input
                        className={inputClass} type="text" value={s.name || ""}
                        placeholder={segmentLabel(null, i)}
                        onChange={(e) => updateSegment(i, { name: e.target.value })}
                      />
                    </td>
                    <td className="py-1">
                      <input
                        className={inputClass + " text-right"} type="number" min="0" step="0.1"
                        value={s.duration ?? ""}
                        onChange={(e) => updateSegment(i, { duration: e.target.value === "" ? "" : Number(e.target.value) })}
                      />
                    </td>
                    <td className="py-1 text-center">
                      <ColorInput value={s.color} onChange={(c) => updateSegment(i, { color: c })} />
                    </td>
                    <td className="text-right">
                      <button
                        type="button" onClick={() => removeSegment(i)}
                        className="p-1 text-fg-muted hover:text-danger" aria-label={`Remove section ${i + 1}`}
                      >
                        <MdDelete />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border-subtle text-fg-muted text-xs">
                  <td colSpan={3} className="py-1">{segments.length} section{segments.length === 1 ? "" : "s"}</td>
                  <td className="num text-right py-1">{total.toFixed(1)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// Optional colour: an empty value shows a dashed swatch; right-click / the ×
// clears it.
function ColorInput({ value, onChange }) {
  return (
    <div className="relative inline-flex h-8 w-8">
      <input
        type="color" value={value || "#888888"}
        onChange={(e) => onChange(e.target.value)}
        title={value ? `${value} (right-click to clear)` : "No colour (inherits item colour)"}
        onContextMenu={(e) => { if (value) { e.preventDefault(); onChange(""); } }}
        className={cn(
          "h-8 w-8 rounded-sm border bg-surface-1 cursor-pointer",
          value ? "border-border" : "border-dashed border-fg-muted opacity-40"
        )}
      />
      {value ? (
        <button
          type="button" onClick={() => onChange("")} aria-label="Clear colour"
          className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-surface-3 border border-border text-[10px] leading-none text-fg-secondary hover:text-danger"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
