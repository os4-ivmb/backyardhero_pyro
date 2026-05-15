import React, { useMemo, useState, useEffect } from "react";
import { Modal, Button, Field, inputClass } from "@/design";

// Modal for editing an existing rack's grid dimensions (and spacing).
//
// Resizing a rack can be destructive: any cell whose (x,y) ends up
// outside the new bounds is removed. This deletes:
//   - The shell assignment on those cells.
//   - Any fuse that's left with <2 cells after the removals (the
//     remaining cells stay shelled, just no longer fused).
//   - Any timeline show item (RACK_SHELLS) whose `rackCells` references
//     a removed cell -- the item can't physically fire any more, so it
//     has to come off the timeline. The parent passes us `showItems` +
//     `onResize({ rack, removedItems })` so we can hand back the list
//     of items the parent should drop from `items[]`.
//
// We don't actually mutate anything in this component -- we ONLY
// compute a preview of the impact and surface it. The parent commits.
export default function RackResizeModal({
  isOpen,
  onClose,
  rack,
  showItems = [],
  onConfirm,
}) {
  const [xRows, setXRows] = useState(rack?.x_rows ?? 4);
  const [yRows, setYRows] = useState(rack?.y_rows ?? 4);
  const [xSpacing, setXSpacing] = useState(rack?.x_spacing ?? 2.75);
  const [ySpacing, setYSpacing] = useState(rack?.y_spacing ?? 2.75);

  // Re-seed the local form whenever the modal is (re)opened with a
  // different rack -- otherwise the inputs would stay stuck on the
  // previous rack's values.
  useEffect(() => {
    if (!isOpen || !rack) return;
    setXRows(rack.x_rows ?? 4);
    setYRows(rack.y_rows ?? 4);
    setXSpacing(rack.x_spacing ?? 2.75);
    setYSpacing(rack.y_spacing ?? 2.75);
  }, [isOpen, rack]);

  // What gets removed at the proposed dimensions. Pure derived value,
  // recomputes whenever the form or the underlying rack changes.
  const impact = useMemo(() => {
    if (!rack) {
      return {
        removedCellKeys: new Set(),
        removedShellCount: 0,
        removedFuseIds: [],
        affectedItemIds: [],
        affectedItems: [],
      };
    }
    const newX = Math.max(1, parseInt(xRows, 10) || 1);
    const newY = Math.max(1, parseInt(yRows, 10) || 1);
    const cells = rack.cells || {};
    const fuses = rack.fuses || {};

    // Cells that fall outside the new bounds. Cell keys are stored as
    // `${x}_${y}` -- we just walk every existing key, parse, and bin
    // it into removed/kept.
    const removedCellKeys = new Set();
    let removedShellCount = 0;
    for (const key of Object.keys(cells)) {
      const [xs, ys] = key.split("_").map(Number);
      if (!Number.isFinite(xs) || !Number.isFinite(ys)) continue;
      if (xs >= newX || ys >= newY) {
        removedCellKeys.add(key);
        if (cells[key]?.shellId != null) removedShellCount++;
      }
    }

    // Fuses that lose at least one cell, AND whose surviving cells fall
    // below the 2-cell minimum that makes a fuse meaningful. (A fuse
    // can lose one of N cells and keep working as N-1; we only delete
    // it if it'd be a degenerate "fuse" of 0 or 1 cells.)
    const removedFuseIds = [];
    for (const [fuseId, fuse] of Object.entries(fuses)) {
      const cellsArr = Array.isArray(fuse.cells) ? fuse.cells : [];
      const survivors = cellsArr.filter((k) => !removedCellKeys.has(k));
      if (survivors.length < 2 && cellsArr.length >= 2) {
        removedFuseIds.push(fuseId);
      }
    }

    // Show items pinned to a removed cell on THIS rack. We compare ids
    // string-normalised because the timeline keeps `rackId` as either
    // a number or a string depending on how the cue was created.
    const rackIdStr = String(rack.id);
    const affectedItems = [];
    for (const it of showItems || []) {
      if (!it || it.type !== "RACK_SHELLS") continue;
      if (String(it.rackId) !== rackIdStr) continue;
      const cellsArr = Array.isArray(it.rackCells) ? it.rackCells : [];
      if (cellsArr.some((k) => removedCellKeys.has(k))) {
        affectedItems.push(it);
      }
    }

    return {
      removedCellKeys,
      removedShellCount,
      removedFuseIds,
      affectedItemIds: affectedItems.map((i) => i.id),
      affectedItems,
    };
  }, [rack, xRows, yRows, showItems]);

  const dimensionsChanged =
    rack &&
    (parseInt(xRows, 10) !== rack.x_rows ||
      parseInt(yRows, 10) !== rack.y_rows ||
      parseFloat(xSpacing) !== rack.x_spacing ||
      parseFloat(ySpacing) !== rack.y_spacing);

  const destructive =
    impact.removedCellKeys.size > 0 ||
    impact.removedFuseIds.length > 0 ||
    impact.affectedItemIds.length > 0;

  const handleConfirm = () => {
    if (!rack) return;
    const newX = Math.max(1, parseInt(xRows, 10) || 1);
    const newY = Math.max(1, parseInt(yRows, 10) || 1);

    // Filter out the removed cells, then prune the now-degenerate
    // fuses, and finally scrub fuseId from any cell that pointed at a
    // deleted fuse.
    const nextCells = {};
    for (const [key, val] of Object.entries(rack.cells || {})) {
      if (impact.removedCellKeys.has(key)) continue;
      nextCells[key] = val;
    }
    const removedFuseSet = new Set(impact.removedFuseIds);
    const nextFuses = {};
    for (const [fuseId, fuse] of Object.entries(rack.fuses || {})) {
      if (removedFuseSet.has(fuseId)) continue;
      const cellsArr = Array.isArray(fuse.cells) ? fuse.cells : [];
      const survivors = cellsArr.filter(
        (k) => !impact.removedCellKeys.has(k)
      );
      nextFuses[fuseId] = { ...fuse, cells: survivors };
    }
    // Clear orphan fuseId references on surviving cells.
    for (const key of Object.keys(nextCells)) {
      const fid = nextCells[key]?.fuseId;
      if (fid && removedFuseSet.has(fid)) {
        nextCells[key] = { ...nextCells[key], fuseId: null };
      }
    }

    onConfirm?.({
      rack: {
        ...rack,
        x_rows: newX,
        y_rows: newY,
        x_spacing: parseFloat(xSpacing) || 0,
        y_spacing: parseFloat(ySpacing) || 0,
        cells: nextCells,
        fuses: nextFuses,
      },
      removedItemIds: impact.affectedItemIds,
    });
  };

  if (!rack) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Resize rack: ${rack.name}`}
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            disabled={!dimensionsChanged}
            onClick={handleConfirm}
          >
            {destructive
              ? `Resize and remove ${
                  impact.removedShellCount +
                  impact.removedFuseIds.length +
                  impact.affectedItemIds.length
                } item${
                  impact.removedShellCount +
                    impact.removedFuseIds.length +
                    impact.affectedItemIds.length ===
                  1
                    ? ""
                    : "s"
                }`
              : "Resize"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Columns (X)">
            <input
              type="number"
              min="1"
              value={xRows}
              onChange={(e) => setXRows(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Rows (Y)">
            <input
              type="number"
              min="1"
              value={yRows}
              onChange={(e) => setYRows(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="X spacing (in)">
            <input
              type="number"
              min="0"
              step="0.1"
              value={xSpacing}
              onChange={(e) => setXSpacing(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Y spacing (in)">
            <input
              type="number"
              min="0"
              step="0.1"
              value={ySpacing}
              onChange={(e) => setYSpacing(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <div className="text-xs text-fg-muted">
          Current: <span className="text-fg-secondary">{rack.x_rows} × {rack.y_rows}</span>
          {" · "}
          Spacing: <span className="text-fg-secondary">{rack.x_spacing}" × {rack.y_spacing}"</span>
        </div>

        {destructive ? (
          <div className="rounded-md border border-danger/50 bg-danger-bg/40 p-3 text-sm">
            <div className="font-semibold text-danger-fg mb-2">
              This resize will permanently remove:
            </div>
            <ul className="list-disc pl-5 space-y-0.5 text-fg-primary">
              {impact.removedCellKeys.size > 0 ? (
                <li>
                  {impact.removedCellKeys.size} cell
                  {impact.removedCellKeys.size === 1 ? "" : "s"} (
                  {impact.removedShellCount} with shells assigned)
                </li>
              ) : null}
              {impact.removedFuseIds.length > 0 ? (
                <li>
                  {impact.removedFuseIds.length} fuse
                  {impact.removedFuseIds.length === 1 ? "" : "s"} (left
                  with too few cells to remain a fuse)
                </li>
              ) : null}
              {impact.affectedItemIds.length > 0 ? (
                <li>
                  {impact.affectedItemIds.length} timeline cue
                  {impact.affectedItemIds.length === 1 ? "" : "s"} that
                  reference{impact.affectedItemIds.length === 1 ? "s" : ""}{" "}
                  the deleted cells
                  {impact.affectedItems.length > 0 ? (
                    <ul className="list-[circle] pl-5 mt-1 text-xs text-fg-secondary">
                      {impact.affectedItems.slice(0, 6).map((it) => (
                        <li key={it.id}>
                          {it.name || `Item #${it.id}`} (
                          {it.zone}:{it.target})
                        </li>
                      ))}
                      {impact.affectedItems.length > 6 ? (
                        <li>… and {impact.affectedItems.length - 6} more</li>
                      ) : null}
                    </ul>
                  ) : null}
                </li>
              ) : null}
            </ul>
            <p className="text-xs text-fg-muted mt-2">
              Shells and timeline cues outside the affected range are
              kept as-is.
            </p>
          </div>
        ) : dimensionsChanged ? (
          <div className="rounded-md border border-border bg-surface-2 p-3 text-sm text-fg-secondary">
            Non-destructive: no cells, fuses, or cues are affected.
          </div>
        ) : (
          <div className="text-xs text-fg-muted">
            Adjust the values above to resize.
          </div>
        )}
      </div>
    </Modal>
  );
}
