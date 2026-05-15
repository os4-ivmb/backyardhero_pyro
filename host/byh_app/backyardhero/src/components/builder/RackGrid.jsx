import React, { useState, useRef, useMemo } from "react";
import { Button } from "@/design";
import CellShellSelector from "./CellShellSelector";
import FuseModal from "./FuseModal";

// === Layout constants =====================================================
// The grid is rendered at a fixed cell size so the SVG fuse overlay can
// be positioned in pixel space. The two constants below must stay in
// sync with the `w-14` (= 56px) cell + `gap-1` (= 4px) Tailwind classes.
const CELL_SIZE_PX = 56;
const CELL_GAP_PX = 4;
const CELL_PITCH_PX = CELL_SIZE_PX + CELL_GAP_PX;

// === Helpers ==============================================================
const cellKey = (x, y) => `${x}_${y}`;
const parseCellKey = (key) => key.split("_").map(Number);
const cellCenter = (x, y) => ({
  x: x * CELL_PITCH_PX + CELL_SIZE_PX / 2,
  y: y * CELL_PITCH_PX + CELL_SIZE_PX / 2,
});

const areAdjacent = (x1, y1, x2, y2) =>
  (Math.abs(x1 - x2) === 1 && y1 === y2) ||
  (Math.abs(y1 - y2) === 1 && x1 === x2);

// === Component ============================================================
// RackGrid is the heart of the racks tab: it draws the rack as a 2D
// grid of "cells", with each cell optionally bound to a shell from
// inventory and/or to a "fuse" (a chain of cells linked by a length
// of pyrotechnic fuse, used to compute physical fire delays).
//
// The component supports two distinct interaction *modes*:
//
//   "shells" -- the default. Click a cell to assign a shell.
//               ⌘/Ctrl-click to multi-select adjacent cells, then
//               batch-assign them all to the same shell.
//
//   "fusing" -- a focused mode for drawing fuses. There's no
//               cmd-click here; instead the user explicitly hits
//               "New fuse", picks a fuse type, and chain-clicks
//               cells to extend the fuse. Clicking an existing
//               fuse opens an inline edit (change type / delete).
//
// Keeping the two flows mode-gated dramatically simplifies the
// per-click decision tree compared to the prior "modifier keys
// everywhere" approach, and gives us room to surface clear hints
// for what each click does.
export default function RackGrid({ rack, racks, inventory, onUpdate, showItems }) {
  const cells = rack.cells || {};
  const fuses = rack.fuses || {};

  const aerialShells = useMemo(
    () => (inventory || []).filter((item) => item.type === "AERIAL_SHELL"),
    [inventory]
  );
  const fuseInventory = useMemo(
    () => (inventory || []).filter((item) => item.type === "FUSE"),
    [inventory]
  );

  // -- Mode + per-mode state ------------------------------------------------
  // "shells" | "fusing"
  const [mode, setMode] = useState("shells");

  // Shells-mode: multi-select set (cell keys).
  const [selectedCells, setSelectedCells] = useState(() => new Set());
  // Shells-mode: which cell triggered the single-cell shell picker.
  const [clickedCell, setClickedCell] = useState(null);
  const [showShellSelector, setShowShellSelector] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);

  // Fusing-mode: substate machine.
  //   null              -- idle (click an existing fuse to edit)
  //   { ...pending }    -- chaining a new fuse
  // The "type picker" step is handled by `pickingType` (the create
  // FuseModal); confirming it transitions us into `pendingFuse`.
  const [pickingType, setPickingType] = useState(false);
  const [pendingFuse, setPendingFuse] = useState(null);
  // Fusing-mode: editing an existing fuse. Holds the fuse id.
  const [editingFuseId, setEditingFuseId] = useState(null);
  // Small ephemeral warning (e.g. "cell already in a fuse") shown
  // inline in the fusing toolbar. Auto-clears on next click.
  const [chainWarning, setChainWarning] = useState("");

  const gridRef = useRef(null);

  // -- Derived lookup helpers ----------------------------------------------
  const getCellData = (x, y) => cells[cellKey(x, y)] || null;
  const cellHasShell = (x, y) => {
    const c = cells[cellKey(x, y)];
    return c && c.shellId != null;
  };
  const cellHasFuse = (x, y) => {
    const c = cells[cellKey(x, y)];
    return !!(c && c.fuseId);
  };
  const isSelected = (x, y) => selectedCells.has(cellKey(x, y));
  const isInPendingFuse = (x, y) =>
    !!pendingFuse?.cells?.includes(cellKey(x, y));

  const getShellData = (shellId) =>
    aerialShells.find((item) => item.id === shellId) || null;

  const getShellColors = (shellId, shellNumber) => {
    const shell = getShellData(shellId);
    if (!shell || !shell.metadata) return [];
    try {
      const metadata =
        typeof shell.metadata === "string"
          ? JSON.parse(shell.metadata)
          : shell.metadata;
      const packData = metadata?.pack_shell_data;
      if (!packData || !packData.shells) return [];
      const sd = packData.shells.find((s) => s.number === shellNumber);
      return sd?.colors || [];
    } catch (e) {
      return [];
    }
  };

  const getFuseColor = (fuseTypeId) => {
    const fuseItem = fuseInventory.find(
      (item) => item.id === parseInt(fuseTypeId)
    );
    return fuseItem?.color || "#FFD700";
  };

  // -- Mode change cleanup -------------------------------------------------
  // Switching modes mid-action would leave dangling chain/selection state.
  // Reset everything when the user toggles the segmented control.
  const handleModeChange = (next) => {
    if (next === mode) return;
    setMode(next);
    setSelectedCells(new Set());
    setClickedCell(null);
    setShowShellSelector(false);
    setShowBatchModal(false);
    setPickingType(false);
    setPendingFuse(null);
    setEditingFuseId(null);
    setChainWarning("");
  };

  // -- Shells-mode handlers ------------------------------------------------
  const handleShellSelected = (shellId, shellNumber) => {
    if (!clickedCell) return;
    const key = cellKey(clickedCell.x, clickedCell.y);
    const updatedCells = { ...cells };
    if (shellId === null) {
      delete updatedCells[key];
    } else {
      updatedCells[key] = {
        shellId,
        shellNumber: shellNumber || null,
        fuseId: cells[key]?.fuseId || null,
      };
    }
    onUpdate({ ...rack, cells: updatedCells });
    setShowShellSelector(false);
    setClickedCell(null);
  };

  const handleBatchAssign = (shellId, shellNumber) => {
    const updatedCells = { ...cells };
    for (const key of selectedCells) {
      updatedCells[key] = {
        shellId,
        shellNumber: shellNumber || null,
        fuseId: cells[key]?.fuseId || null,
      };
    }
    onUpdate({ ...rack, cells: updatedCells });
    setShowBatchModal(false);
    setSelectedCells(new Set());
  };

  // -- Fusing-mode handlers ------------------------------------------------
  const handleStartNewFuse = () => {
    setChainWarning("");
    setPickingType(true);
  };

  const handleFuseTypePicked = ({ fuseType, leadIn }) => {
    setPickingType(false);
    setPendingFuse({
      type: fuseType,
      leadIn: leadIn,
      cells: [],
    });
  };

  const handleDiscardPendingFuse = () => {
    setPendingFuse(null);
    setChainWarning("");
  };

  const handleUndoLastChainCell = () => {
    setChainWarning("");
    setPendingFuse((prev) => {
      if (!prev || prev.cells.length === 0) return prev;
      return { ...prev, cells: prev.cells.slice(0, -1) };
    });
  };

  const handleSavePendingFuse = () => {
    if (!pendingFuse || pendingFuse.cells.length < 2) return;
    const fuseId = `fuse_${Date.now()}`;
    const updatedCells = { ...cells };
    for (const key of pendingFuse.cells) {
      const prevCell = updatedCells[key];
      updatedCells[key] = {
        shellId: prevCell?.shellId ?? null,
        shellNumber: prevCell?.shellNumber ?? null,
        fuseId,
      };
    }
    const updatedFuses = {
      ...fuses,
      [fuseId]: {
        type: pendingFuse.type,
        leadIn: pendingFuse.leadIn,
        // Preserve user-chosen click order: a fuse is a physical
        // chain, not a set, so the order matters for path drawing
        // and lead-in calculations downstream.
        cells: pendingFuse.cells.slice(),
      },
    };
    onUpdate({ ...rack, cells: updatedCells, fuses: updatedFuses });
    setPendingFuse(null);
    setChainWarning("");
  };

  // Updating an existing fuse's type/lead-in is non-destructive --
  // cells stay the same, only the metadata mutates.
  const handleSaveEditedFuse = ({ fuseType, leadIn }) => {
    if (!editingFuseId) return;
    const target = fuses[editingFuseId];
    if (!target) {
      setEditingFuseId(null);
      return;
    }
    const updatedFuses = {
      ...fuses,
      [editingFuseId]: {
        ...target,
        type: fuseType,
        leadIn: leadIn,
      },
    };
    onUpdate({ ...rack, fuses: updatedFuses });
    setEditingFuseId(null);
  };

  // Deletion only severs the fuse linkage -- the shell assignments on
  // the cells stick around. That matches the user's expectation: a
  // fuse is metadata draped over cells, deleting it shouldn't wipe
  // the shells underneath.
  const handleDeleteEditedFuse = () => {
    if (!editingFuseId) return;
    const targetCells =
      Array.isArray(fuses[editingFuseId]?.cells) && fuses[editingFuseId].cells;
    const updatedFuses = { ...fuses };
    delete updatedFuses[editingFuseId];
    const updatedCells = { ...cells };
    if (targetCells) {
      for (const key of targetCells) {
        if (updatedCells[key]?.fuseId === editingFuseId) {
          updatedCells[key] = { ...updatedCells[key], fuseId: null };
        }
      }
    }
    onUpdate({ ...rack, cells: updatedCells, fuses: updatedFuses });
    setEditingFuseId(null);
  };

  // -- Unified click dispatcher --------------------------------------------
  const handleCellClick = (e, x, y) => {
    const key = cellKey(x, y);

    if (mode === "shells") {
      if (e.ctrlKey || e.metaKey) {
        // Multi-select: toggle membership but require adjacency to an
        // already-selected cell so the selection stays a connected
        // region (mirrors the prior behaviour).
        setSelectedCells((prev) => {
          const next = new Set(prev);
          if (next.has(key)) {
            next.delete(key);
            return next;
          }
          if (next.size === 0) {
            next.add(key);
            return next;
          }
          for (const sk of next) {
            const [sx, sy] = parseCellKey(sk);
            if (areAdjacent(x, y, sx, sy)) {
              next.add(key);
              return next;
            }
          }
          return next;
        });
      } else {
        // A plain click opens the per-cell shell picker. We keep the
        // multi-select set untouched so users can stage a batch in the
        // background, fiddle with a single cell, and resume.
        setClickedCell({ x, y });
        setShowShellSelector(true);
      }
      return;
    }

    // === Fusing mode ===
    if (pendingFuse) {
      // Currently chaining a new fuse.
      if (pendingFuse.cells.includes(key)) {
        setChainWarning("Cell is already in this fuse.");
        return;
      }
      // Disallow stealing cells from existing fuses -- it's almost
      // always a mistake. The user should explicitly delete the old
      // fuse first.
      const otherFuseId = cells[key]?.fuseId;
      if (otherFuseId) {
        setChainWarning(
          "That cell is already part of another fuse. Save or discard this fuse, then edit the other one."
        );
        return;
      }
      setChainWarning("");
      setPendingFuse({
        ...pendingFuse,
        cells: [...pendingFuse.cells, key],
      });
      return;
    }

    // Idle fusing mode: clicking a fuse-bearing cell opens the editor.
    const cellFuseId = cells[key]?.fuseId;
    if (cellFuseId && fuses[cellFuseId]) {
      setEditingFuseId(cellFuseId);
      return;
    }
    // Click an empty cell: nudge the user toward "New fuse".
    setChainWarning(
      'Click "New fuse" to start. Click an existing fuse cell to edit it.'
    );
  };

  // -- SVG: rendered fuse paths --------------------------------------------
  const renderSavedFuseLines = () => {
    const lines = [];
    for (const [fuseId, fuse] of Object.entries(fuses)) {
      if (!fuse.cells || fuse.cells.length < 2) continue;
      const stroke = getFuseColor(fuse.type);
      const isEditing = editingFuseId === fuseId;
      for (let i = 0; i < fuse.cells.length - 1; i++) {
        const [x1, y1] = parseCellKey(fuse.cells[i]);
        const [x2, y2] = parseCellKey(fuse.cells[i + 1]);
        const a = cellCenter(x1, y1);
        const b = cellCenter(x2, y2);
        lines.push(
          <line
            key={`${fuseId}_${i}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={stroke}
            strokeWidth={isEditing ? 6 : 4}
            strokeLinecap="round"
            opacity={isEditing ? 1 : 0.95}
          />
        );
      }
    }
    return lines;
  };

  const renderPendingFuseLine = () => {
    if (!pendingFuse || pendingFuse.cells.length < 2) return null;
    const stroke = getFuseColor(pendingFuse.type);
    const segs = [];
    for (let i = 0; i < pendingFuse.cells.length - 1; i++) {
      const [x1, y1] = parseCellKey(pendingFuse.cells[i]);
      const [x2, y2] = parseCellKey(pendingFuse.cells[i + 1]);
      const a = cellCenter(x1, y1);
      const b = cellCenter(x2, y2);
      segs.push(
        <line
          key={`pending_${i}`}
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke={stroke}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray="6 4"
          opacity={0.95}
        />
      );
    }
    return segs;
  };

  // -- Toolbar pieces ------------------------------------------------------
  // Single-row segmented control so we can park it on the right edge
  // of whichever per-mode toolbar is active (saves a full row).
  const renderModeSwitch = () => {
    const tab = (id, label) => (
      <button
        key={id}
        type="button"
        onClick={() => handleModeChange(id)}
        className={
          "px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider transition-colors " +
          (mode === id
            ? "bg-accent text-accent-fg"
            : "bg-transparent text-fg-secondary hover:text-fg-primary hover:bg-surface-3")
        }
      >
        {label}
      </button>
    );
    return (
      <div className="inline-flex rounded-sm border border-border overflow-hidden shrink-0">
        {tab("shells", "Shells")}
        {tab("fusing", "Fusing")}
      </div>
    );
  };

  const renderShellsToolbar = () => {
    const count = selectedCells.size;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-fg-muted min-w-0 flex-1">
          {count > 1 ? (
            <>
              <span className="text-fg-primary font-semibold">
                {count} cell{count === 1 ? "" : "s"} selected.
              </span>{" "}
              Use the batch button to assign them all at once.
            </>
          ) : (
            <>
              Click a cell to assign a shell. Hold{" "}
              <kbd className="px-1 rounded bg-surface-3 text-fg-primary text-2xs border border-border">
                ⌘
              </kbd>{" "}
              /{" "}
              <kbd className="px-1 rounded bg-surface-3 text-fg-primary text-2xs border border-border">
                Ctrl
              </kbd>{" "}
              and click adjacent cells to batch-assign.
            </>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {count > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelectedCells(new Set())}
            >
              Clear
            </Button>
          ) : null}
          {count > 1 ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => setShowBatchModal(true)}
            >
              Batch ({count})
            </Button>
          ) : null}
          {renderModeSwitch()}
        </div>
      </div>
    );
  };

  const renderFusingToolbar = () => {
    if (!pendingFuse) {
      return (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-fg-muted min-w-0 flex-1">
            {chainWarning || (
              <>
                Click <span className="text-fg-primary">New fuse</span> to start
                a chain. Click an existing fuse cell to edit or delete it.
              </>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" variant="primary" onClick={handleStartNewFuse}>
              New fuse
            </Button>
            {renderModeSwitch()}
          </div>
        </div>
      );
    }
    const fuseItem = fuseInventory.find(
      (f) => f.id === parseInt(pendingFuse.type)
    );
    const count = pendingFuse.cells.length;
    return (
      <div className="rounded-md border border-accent/50 bg-accent/10 px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-fg-primary flex items-center gap-2 min-w-0">
            <span
              className="inline-block w-3 h-3 rounded-sm border border-border shrink-0"
              style={{ backgroundColor: getFuseColor(pendingFuse.type) }}
              aria-hidden
            />
            <span className="truncate">
              <span className="font-semibold">
                {fuseItem?.name || "Fuse"}
              </span>{" "}
              · {count} cell{count === 1 ? "" : "s"}
              {count < 2 ? (
                <span className="text-fg-muted"> (need at least 2)</span>
              ) : null}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleUndoLastChainCell}
              disabled={count === 0}
            >
              Undo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleDiscardPendingFuse}
            >
              Discard
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={handleSavePendingFuse}
              disabled={count < 2}
            >
              Save fuse
            </Button>
            {renderModeSwitch()}
          </div>
        </div>
        {chainWarning ? (
          <div className="text-2xs text-warn-fg mt-1">{chainWarning}</div>
        ) : null}
      </div>
    );
  };

  // -- Render --------------------------------------------------------------
  const editingFuse = editingFuseId ? fuses[editingFuseId] : null;

  return (
    <div className="space-y-2">
      {mode === "shells" ? renderShellsToolbar() : renderFusingToolbar()}

      <div className="flex justify-center py-2">
        <div
          ref={gridRef}
          className="grid gap-1 relative"
          style={{
            gridTemplateColumns: `repeat(${rack.x_rows}, minmax(0, 1fr))`,
            width: `${rack.x_rows * CELL_PITCH_PX}px`,
          }}
        >
          <svg
            className="absolute inset-0 pointer-events-none z-10"
            style={{
              width: `${rack.x_rows * CELL_PITCH_PX}px`,
              height: `${rack.y_rows * CELL_PITCH_PX}px`,
            }}
          >
            {renderSavedFuseLines()}
            {renderPendingFuseLine()}
          </svg>
          {Array.from({ length: rack.y_rows }).map((_, y) =>
            Array.from({ length: rack.x_rows }).map((_, x) => {
              const key = cellKey(x, y);
              const cellData = getCellData(x, y);
              const shell = cellData ? getShellData(cellData.shellId) : null;
              const colors = cellData
                ? getShellColors(cellData.shellId, cellData.shellNumber)
                : [];
              const selected = isSelected(x, y);
              const inPending = isInPendingFuse(x, y);
              const hasShell = cellHasShell(x, y);
              const inFuse = cellHasFuse(x, y);
              const isEditingThisFuse =
                inFuse && editingFuseId && cellData?.fuseId === editingFuseId;

              // Border + tint resolution. The grid is the rack's
              // visual anchor, so we keep cells uniform and only
              // tweak the border to communicate state.
              let cellClasses =
                "relative w-14 h-14 border-2 rounded-sm cursor-pointer transition-colors duration-100 ";
              if (mode === "shells" && selected) {
                cellClasses += "border-accent bg-accent/15 ";
              } else if (mode === "fusing" && inPending) {
                cellClasses +=
                  "border-accent bg-accent/15 ring-2 ring-accent/30 ";
              } else if (isEditingThisFuse) {
                cellClasses +=
                  "border-warn ring-2 ring-warn/40 bg-warn-bg/30 ";
              } else if (hasShell) {
                cellClasses += "border-border bg-surface-3 ";
              } else {
                cellClasses += "border-border-subtle bg-surface-inset ";
              }
              cellClasses += "hover:border-border-strong";

              return (
                <div
                  key={key}
                  onClick={(e) => handleCellClick(e, x, y)}
                  className={cellClasses}
                  title={
                    shell
                      ? `${shell.name}${
                          cellData.shellNumber
                            ? ` #${cellData.shellNumber}`
                            : ""
                        }`
                      : "Empty"
                  }
                >
                  {hasShell && (
                    <>
                      <div className="absolute inset-0 flex flex-col items-center justify-center text-xs text-fg-primary px-1">
                        <div className="text-[10px] leading-tight font-semibold">
                          {shell?.name?.substring(0, 7).toUpperCase()}
                        </div>
                        <div className="text-[10px] leading-tight text-fg-secondary">
                          {cellData.shellNumber
                            ? `#${cellData.shellNumber}`
                            : "ANY"}
                        </div>
                      </div>
                      {colors.length > 0 && (
                        <div className="absolute bottom-0 left-0 right-0 h-2 flex">
                          {colors.map((color, idx) => (
                            <div
                              key={idx}
                              className="flex-1"
                              style={{ backgroundColor: color }}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Shells-mode modals */}
      {showShellSelector && clickedCell && (
        <CellShellSelector
          isOpen={showShellSelector}
          onClose={() => {
            setShowShellSelector(false);
            setClickedCell(null);
          }}
          onSelect={handleShellSelected}
          cellData={getCellData(clickedCell.x, clickedCell.y)}
          inventory={inventory}
          showItems={showItems}
          racks={racks}
        />
      )}
      {showBatchModal && (
        <CellShellSelector
          isOpen={showBatchModal}
          onClose={() => setShowBatchModal(false)}
          onSelect={handleBatchAssign}
          cellData={null}
          inventory={inventory}
          isBatch={true}
          showItems={showItems}
          racks={racks}
        />
      )}

      {/* Fusing-mode modals */}
      {pickingType && (
        <FuseModal
          isOpen={pickingType}
          mode="create"
          inventory={inventory}
          onClose={() => setPickingType(false)}
          onConfirm={handleFuseTypePicked}
        />
      )}
      {editingFuseId && editingFuse && (
        <FuseModal
          isOpen={true}
          mode="edit"
          inventory={inventory}
          initialFuseType={editingFuse.type}
          initialLeadIn={editingFuse.leadIn ?? 1}
          onClose={() => setEditingFuseId(null)}
          onConfirm={handleSaveEditedFuse}
          onDelete={handleDeleteEditedFuse}
        />
      )}
    </div>
  );
}
