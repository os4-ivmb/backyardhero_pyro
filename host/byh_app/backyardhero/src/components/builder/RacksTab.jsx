import React, { useState, useEffect, useRef } from "react";
import axios from "axios";
import { asyncConfirm, asyncAlert } from "../common/AsyncPrompt";
import {
  MdEdit,
  MdAdd,
  MdContentCopy,
  MdDelete,
  MdAspectRatio,
} from "react-icons/md";

import {
  Section,
  Card,
  Button,
  IconButton,
  Modal,
  Field,
  inputClass,
} from "@/design";

import RackGrid from "./RackGrid";
import RackResizeModal from "./RackResizeModal";

// === RacksTab =============================================================
// Top-level rack manager for a show. Owns the list of racks and exposes
// each rack as its own tab inside a single, centered editor pane. A
// trailing "+" tab opens the add-rack modal.
//
// Item pruning: when the user resizes a rack in a way that destroys
// cells referenced by timeline items, we hand the parent
// `setShowItems` callback a filtered items[] so the timeline stays
// in sync with reality. If the parent doesn't pass `setShowItems` we
// silently no-op the pruning, which matches the old behaviour.
export default function RacksTab({
  inventory,
  showId,
  showItems,
  setShowItems,
}) {
  const [racks, setRacks] = useState([]);
  const [activeRackId, setActiveRackId] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingRackId, setEditingRackId] = useState(null);
  const [editingRackName, setEditingRackName] = useState("");
  const [resizingRack, setResizingRack] = useState(null);

  const [newRack, setNewRack] = useState({
    name: "",
    x_rows: 4,
    x_spacing: 2.75,
    y_rows: 4,
    y_spacing: 2.75,
  });

  // After a create/clone we want to *jump* to the new rack. The POST
  // returns an id but at that moment the rack list hasn't been
  // refetched yet, so we stash the target id here and an effect
  // promotes it to `activeRackId` once the rack actually appears.
  const pendingActiveRackRef = useRef(null);

  useEffect(() => {
    if (showId) {
      fetchRacks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showId]);

  // Keep `activeRackId` pointed at a real rack: if the current one
  // disappears (delete) we fall back to the first available; if we
  // just created/cloned one (`pendingActiveRackRef`) we promote it.
  useEffect(() => {
    if (racks.length === 0) {
      if (activeRackId !== null) setActiveRackId(null);
      return;
    }
    if (
      pendingActiveRackRef.current != null &&
      racks.some((r) => r.id === pendingActiveRackRef.current)
    ) {
      setActiveRackId(pendingActiveRackRef.current);
      pendingActiveRackRef.current = null;
      return;
    }
    if (activeRackId == null || !racks.some((r) => r.id === activeRackId)) {
      setActiveRackId(racks[0].id);
    }
  }, [racks, activeRackId]);

  const fetchRacks = async () => {
    if (!showId) return;
    try {
      const response = await axios.get("/api/racks", {
        params: { show_id: showId },
      });
      setRacks(response.data);
    } catch (error) {
      console.error("Failed to fetch racks:", error);
    }
  };

  const resetNewRack = () =>
    setNewRack({
      name: "",
      x_rows: 4,
      x_spacing: 2.75,
      y_rows: 4,
      y_spacing: 2.75,
    });

  const handleAddRack = async () => {
    if (!newRack.name.trim()) {
      await asyncAlert("Please enter a rack name");
      return;
    }
    if (!showId) {
      await asyncAlert("Please save the show first before adding racks");
      return;
    }

    try {
      const resp = await axios.post("/api/racks", {
        show_id: showId,
        ...newRack,
        name: newRack.name.trim(),
        cells: {},
        fuses: {},
      });
      if (resp?.data?.id != null) {
        pendingActiveRackRef.current = resp.data.id;
      }
      await fetchRacks();
      resetNewRack();
      setShowAddModal(false);
    } catch (error) {
      console.error("Failed to create rack:", error);
      await asyncAlert("Failed to create rack");
    }
  };

  const handleUpdateRack = async (rackId, updatedRack) => {
    // Optimistic local write so the grid feels snappy; the API mirror
    // refresh below corrects any drift.
    setRacks((prev) =>
      prev.map((r) => (r.id === rackId ? { ...updatedRack } : r))
    );
    try {
      await axios.patch(`/api/racks/${rackId}`, updatedRack);
      await fetchRacks();
    } catch (error) {
      console.error("Failed to update rack:", error);
      await fetchRacks();
      await asyncAlert("Failed to update rack");
    }
  };

  // Handles BOTH the rack PATCH and the timeline-item pruning that a
  // destructive resize implies. Kept in RacksTab (not RackResizeModal)
  // so the side-effect on `showItems` lives next to the API mutation.
  const handleConfirmResize = async ({ rack: nextRack, removedItemIds }) => {
    const rackId = nextRack.id;
    setRacks((prev) =>
      prev.map((r) => (r.id === rackId ? { ...nextRack } : r))
    );
    if (
      removedItemIds &&
      removedItemIds.length > 0 &&
      typeof setShowItems === "function"
    ) {
      const removeSet = new Set(removedItemIds);
      setShowItems((prev) =>
        Array.isArray(prev)
          ? prev.filter((it) => !removeSet.has(it.id))
          : prev
      );
    }
    try {
      await axios.patch(`/api/racks/${rackId}`, nextRack);
      await fetchRacks();
    } catch (error) {
      console.error("Failed to resize rack:", error);
      await fetchRacks();
      await asyncAlert("Failed to resize rack");
    }
    setResizingRack(null);
  };

  const handleDeleteRack = async (rackId) => {
    if (!(await asyncConfirm({ message: "Are you sure you want to delete this rack?", destructive: true }))) return;
    // Pre-pick a fallback active id so the tab doesn't blink to "none"
    // for a frame after delete.
    if (rackId === activeRackId) {
      const idx = racks.findIndex((r) => r.id === rackId);
      const fallback =
        racks[idx + 1] || racks[idx - 1] || racks.find((r) => r.id !== rackId);
      if (fallback) pendingActiveRackRef.current = fallback.id;
    }
    try {
      await axios.delete(`/api/racks/${rackId}`);
      await fetchRacks();
    } catch (error) {
      console.error("Failed to delete rack:", error);
      await asyncAlert("Failed to delete rack");
    }
  };

  const handleCloneRack = async (rackId) => {
    if (!showId) {
      await asyncAlert("Please save the show first before cloning racks");
      return;
    }
    const rackToClone = racks.find((r) => r.id === rackId);
    if (!rackToClone) {
      await asyncAlert("Rack not found");
      return;
    }
    try {
      const resp = await axios.post("/api/racks", {
        show_id: showId,
        name: `${rackToClone.name} (Copy)`,
        x_rows: rackToClone.x_rows,
        x_spacing: rackToClone.x_spacing,
        y_rows: rackToClone.y_rows,
        y_spacing: rackToClone.y_spacing,
        cells: rackToClone.cells,
        fuses: rackToClone.fuses,
      });
      if (resp?.data?.id != null) {
        pendingActiveRackRef.current = resp.data.id;
      }
      await fetchRacks();
    } catch (error) {
      console.error("Failed to clone rack:", error);
      await asyncAlert("Failed to clone rack");
    }
  };

  const handleStartEditName = (rack) => {
    setEditingRackId(rack.id);
    setEditingRackName(rack.name);
  };

  const handleSaveName = async (rackId) => {
    if (!editingRackName.trim()) {
      await asyncAlert("Rack name cannot be empty");
      return;
    }
    const rack = racks.find((r) => r.id === rackId);
    if (!rack) return;
    try {
      await axios.patch(`/api/racks/${rackId}`, {
        ...rack,
        name: editingRackName.trim(),
      });
      setEditingRackId(null);
      setEditingRackName("");
      await fetchRacks();
    } catch (error) {
      console.error("Failed to update rack name:", error);
      await asyncAlert("Failed to update rack name");
    }
  };

  const handleCancelEditName = () => {
    setEditingRackId(null);
    setEditingRackName("");
  };

  const activeRack =
    activeRackId != null ? racks.find((r) => r.id === activeRackId) : null;

  // -- Tabs ----------------------------------------------------------------
  const renderTabs = () => (
    <div className="flex items-end border-b border-border-subtle overflow-x-auto -mb-px">
      {racks.map((rack) => {
        const isActive = rack.id === activeRackId;
        return (
          <button
            key={rack.id}
            type="button"
            onClick={() => setActiveRackId(rack.id)}
            className={
              "shrink-0 px-4 py-2 font-medium text-sm transition-colors -mb-px border-b-2 " +
              (isActive
                ? "text-accent border-accent"
                : "text-fg-secondary border-transparent hover:text-fg-primary")
            }
            title={rack.name}
          >
            {rack.name}
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => setShowAddModal(true)}
        disabled={!showId}
        title="Add rack"
        aria-label="Add rack"
        className={
          "shrink-0 px-3 py-2 text-sm transition-colors -mb-px border-b-2 border-transparent " +
          "text-fg-secondary hover:text-fg-primary disabled:opacity-40 disabled:cursor-not-allowed " +
          "inline-flex items-center gap-1"
        }
      >
        <MdAdd className="w-4 h-4" />
        {racks.length === 0 ? <span>Add rack</span> : null}
      </button>
    </div>
  );

  // -- Active rack pane ----------------------------------------------------
  const renderActiveRack = () => {
    if (!activeRack) return null;
    const rack = activeRack;
    const isRenaming = editingRackId === rack.id;
    return (
      <Card tone="raised" padding="md" className="mt-4">
        <div className="flex items-center justify-between gap-3 mb-2 min-h-[28px]">
          <div className="min-w-0 flex-1 flex items-center gap-3">
            {isRenaming ? (
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <input
                  type="text"
                  value={editingRackName}
                  onChange={(e) => setEditingRackName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveName(rack.id);
                    else if (e.key === "Escape") handleCancelEditName();
                  }}
                  className={inputClass + " text-sm font-semibold max-w-sm"}
                  autoFocus
                />
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => handleSaveName(rack.id)}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleCancelEditName}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <>
                <h3
                  className="text-sm font-semibold text-fg-primary truncate inline-flex items-center gap-1 cursor-pointer hover:text-accent"
                  onClick={() => handleStartEditName(rack)}
                  title="Click to rename"
                >
                  {rack.name}
                  <MdEdit className="w-3.5 h-3.5 opacity-60" />
                </h3>
                <span className="text-2xs text-fg-muted whitespace-nowrap num">
                  {rack.x_rows} × {rack.y_rows} · {rack.x_spacing}" ×{" "}
                  {rack.y_spacing}"
                </span>
              </>
            )}
          </div>
          {isRenaming ? null : (
            <div className="flex items-center gap-1 shrink-0">
              <IconButton
                label="Resize rack"
                size="sm"
                variant="outline"
                onClick={() => setResizingRack(rack)}
              >
                <MdAspectRatio className="w-4 h-4" />
              </IconButton>
              <IconButton
                label="Clone rack"
                size="sm"
                variant="outline"
                onClick={() => handleCloneRack(rack.id)}
              >
                <MdContentCopy className="w-4 h-4" />
              </IconButton>
              <IconButton
                label="Delete rack"
                size="sm"
                variant="danger"
                onClick={() => handleDeleteRack(rack.id)}
              >
                <MdDelete className="w-4 h-4" />
              </IconButton>
            </div>
          )}
        </div>
        <RackGrid
          // Force a fresh component tree when switching tabs so mode /
          // pending-fuse / selection state doesn't bleed across racks.
          key={rack.id}
          rack={rack}
          racks={racks}
          inventory={inventory}
          onUpdate={(updatedRack) => handleUpdateRack(rack.id, updatedRack)}
          showItems={showItems}
        />
      </Card>
    );
  };

  return (
    <Section
      title="Racks"
      description="Physical fireworks racks that anchor the show layout. Each rack is a grid of cells; cells hold shells, and chains of cells can be linked together with a fuse."
    >
      {!showId ? (
        <Card tone="inset" className="text-center text-fg-muted py-8">
          Please save the show first before adding racks.
        </Card>
      ) : (
        <>
          {renderTabs()}
          {activeRack ? (
            renderActiveRack()
          ) : (
            <Card tone="inset" className="text-center text-fg-muted py-8 mt-4">
              No racks yet. Click the{" "}
              <span className="text-fg-primary inline-flex items-center gap-1">
                <MdAdd className="w-4 h-4" /> Add rack
              </span>{" "}
              tab to create one.
            </Card>
          )}
        </>
      )}

      <Modal
        isOpen={showAddModal}
        onClose={() => {
          setShowAddModal(false);
          resetNewRack();
        }}
        title="Add rack"
        size="lg"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setShowAddModal(false);
                resetNewRack();
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={handleAddRack}>
              Create rack
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Rack name" className="col-span-2">
            <input
              type="text"
              value={newRack.name}
              onChange={(e) =>
                setNewRack({ ...newRack, name: e.target.value })
              }
              className={inputClass}
              placeholder="e.g. Front row"
              autoFocus
            />
          </Field>
          <Field label="Columns (X)">
            <input
              type="number"
              min="1"
              value={newRack.x_rows}
              onChange={(e) =>
                setNewRack({
                  ...newRack,
                  x_rows: parseInt(e.target.value) || 1,
                })
              }
              className={inputClass}
            />
          </Field>
          <Field label="Rows (Y)">
            <input
              type="number"
              min="1"
              value={newRack.y_rows}
              onChange={(e) =>
                setNewRack({
                  ...newRack,
                  y_rows: parseInt(e.target.value) || 1,
                })
              }
              className={inputClass}
            />
          </Field>
          <Field label="X spacing (in)">
            <input
              type="number"
              min="0"
              step="0.1"
              value={newRack.x_spacing}
              onChange={(e) =>
                setNewRack({
                  ...newRack,
                  x_spacing: parseFloat(e.target.value) || 0,
                })
              }
              className={inputClass}
            />
          </Field>
          <Field label="Y spacing (in)">
            <input
              type="number"
              min="0"
              step="0.1"
              value={newRack.y_spacing}
              onChange={(e) =>
                setNewRack({
                  ...newRack,
                  y_spacing: parseFloat(e.target.value) || 0,
                })
              }
              className={inputClass}
            />
          </Field>
        </div>
      </Modal>

      <RackResizeModal
        isOpen={!!resizingRack}
        rack={resizingRack}
        showItems={showItems}
        onClose={() => setResizingRack(null)}
        onConfirm={handleConfirmResize}
      />
    </Section>
  );
}
