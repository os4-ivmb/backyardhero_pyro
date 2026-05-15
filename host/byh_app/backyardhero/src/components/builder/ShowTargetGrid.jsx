import React, { useMemo, useState } from "react";
import {
  DndContext,
  useDraggable,
  useDroppable,
  closestCenter,
  DragOverlay,
} from "@dnd-kit/core";
import { MdEdit, MdSwapHoriz, MdAdd, MdDeleteOutline } from "react-icons/md";
import { FaX, FaTriangleExclamation, FaCircleQuestion } from "react-icons/fa6";
import { INV_COLOR_CODE } from "@/constants";
import { SHOW_RECEIVER_STATUS } from "@/util/showReceivers";

// Target Grid surface.
//
// Each show owns its receivers list. The grid renders one row per
// receiver/zone in `showReceivers`, in the order they were added. The
// header strip carries an "Add Receiver/Zone" button (top of the
// surface, always visible) and per-row edit/migrate/remove affordances.
//
// Verification is consumed for the *staged* show, but only HARD errors
// (missing/disabled receiver) get the red error treatment here -- those
// genuinely block authoring (you can't drop items onto a non-existent
// receiver in any meaningful way). "Insufficient cue count" is treated
// as a soft warning and surfaced only on the Receivers page card --
// operators routinely build shows ahead of hardware install or against
// a soft-capped (force_cues_available) receiver, and the editor
// shouldn't get in their way.
export default function ShowTargetGrid({
  items,
  setItems,
  availableDevices,
  showReceivers = [],
  receiverLabels = {},
  verification, // { results: [...], hasError } or undefined
  onAddReceiver,
  onEditReceiver,
  onRemoveReceiver,
}) {
  const [activeItem, setActiveItem] = useState(null);
  const [migrateSourceZone, setMigrateSourceZone] = useState(null);
  const [showMigrateModal, setShowMigrateModal] = useState(false);

  // Quick lookup: receiverId -> verification result. Lets us tag rows
  // with their status without re-walking the array per render.
  const statusByReceiver = useMemo(() => {
    const out = {};
    if (verification && Array.isArray(verification.results)) {
      for (const r of verification.results) {
        if (r && r.entry && r.entry.id) out[r.entry.id] = r;
      }
    }
    return out;
  }, [verification]);

  // Receivers that can accept migration: zones in the show that have no
  // items today, excluding the source. We deliberately don't migrate to
  // an empty *DB* receiver that isn't in the show — under per-show
  // receivers a target must already be wired into the show.
  const getAvailableTargetReceivers = (sourceZone) => {
    return showReceivers
      .map((e) => e?.id)
      .filter((id) => {
        if (!id || id === sourceZone) return false;
        return !items.some((item) => item.zone === id);
      });
  };

  const handleMigrateClick = (sourceZone) => {
    setMigrateSourceZone(sourceZone);
    setShowMigrateModal(true);
  };

  const handleMigrateConfirm = (targetZone) => {
    if (!migrateSourceZone || !targetZone) return;

    // Update items: change zone from source to target, keep same target numbers
    const updatedItems = items.map((item) => {
      if (item.zone === migrateSourceZone) {
        return { ...item, zone: targetZone };
      }
      return item;
    });

    setItems(updatedItems);
    setShowMigrateModal(false);
    setMigrateSourceZone(null);
  };

  const handleMigrateCancel = () => {
    setShowMigrateModal(false);
    setMigrateSourceZone(null);
  };

  const handleDragStart = (event) => {
    const item = items.find((i) => i.id === event.active.id);
    setActiveItem(item);
  };

  const handleDragEnd = (event) => {
    const { over } = event;
    if (!over) return;

    const [newZone, newTarget] = over.id.split("-");

    const isOccupato = items.some(
      (item) => item.zone === newZone && item.target === newTarget
    );

    if (isOccupato) {
      alert("Seat's Taken!");
      setActiveItem(null);
      return;
    }

    const updatedItems = items.map((item) =>
      item.id === activeItem.id
        ? { ...item, zone: newZone, target: parseInt(newTarget) }
        : item
    );

    setItems(updatedItems);
    setActiveItem(null);
  };

  const hasAnyReceivers = showReceivers && showReceivers.length > 0;

  return (
    <>
      {/* Top strip: the single "+ Add Receiver/Zone" entry point. Always
          visible so an empty show has an obvious next step. */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-gray-400">
          {hasAnyReceivers ? (
            <>
              <span className="text-gray-200 font-medium">
                {showReceivers.length}
              </span>{" "}
              receiver{showReceivers.length === 1 ? "" : "s"} in this show
            </>
          ) : (
            <span>No receivers in this show yet.</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onAddReceiver?.()}
          className="flex items-center gap-2 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-sm"
          title="Add a receiver / zone to this show"
        >
          <MdAdd className="text-base" />
          <span>Add Receiver / Zone</span>
        </button>
      </div>

      <DndContext
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        collisionDetection={closestCenter}
      >
        <div className="flex flex-col gap-4 mb-12">
          {showReceivers.map((entry, zoneIndex) => {
            if (!entry || !entry.id) return null;
            const zoneName = entry.id;
            const targets = availableDevices[zoneName] || [];
            const status = statusByReceiver[zoneName];
            // Insufficient cue count is intentionally NOT surfaced as an
            // editor error -- operators routinely build shows ahead of
            // hardware install, or against a receiver that's been
            // soft-capped via the Force zones override on the Receivers
            // page. The under-cued state is shown on the Receivers
            // page card instead, where the operator can resolve it.
            const isMissing = status?.status === SHOW_RECEIVER_STATUS.MISSING;
            const isDisabled = status?.status === SHOW_RECEIVER_STATUS.DISABLED;
            const hasError = isMissing || isDisabled;
            const displayLabel = receiverLabels[zoneName] || entry.label;

            return (
              <div
                key={`${zoneName}-${zoneIndex}`}
                className={`flex flex-col rounded-md ${
                  hasError ? "border border-red-500/70 p-2 bg-red-950/20" : ""
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    {displayLabel ? (
                      <>
                        <span>{displayLabel}</span>
                        <span className="text-gray-500 text-sm font-normal">
                          ({zoneName})
                        </span>
                      </>
                    ) : (
                      <span>{zoneName}</span>
                    )}
                    <span className="text-xs text-gray-500 font-normal">
                      · {entry.cues} cues
                    </span>
                  </h3>
                  <button
                    onClick={() => onEditReceiver?.(zoneName)}
                    className="text-gray-400 hover:text-white transition-colors"
                    title="Edit receiver / zone"
                  >
                    <MdEdit size={18} />
                  </button>
                  {items.some((item) => item.zone === zoneName) && (
                    <button
                      onClick={() => handleMigrateClick(zoneName)}
                      className="text-blue-400 hover:text-blue-300 transition-colors"
                      title="Migrate all cues to another receiver"
                    >
                      <MdSwapHoriz size={18} />
                    </button>
                  )}
                  <button
                    onClick={() => onRemoveReceiver?.(zoneName)}
                    className="text-gray-400 hover:text-red-400 transition-colors ml-auto"
                    title={
                      items.some((it) => it.zone === zoneName)
                        ? "Remove receiver (blocked while items use it)"
                        : "Remove receiver from this show"
                    }
                  >
                    <MdDeleteOutline size={18} />
                  </button>
                </div>

                {hasError ? (
                  <div className="flex items-start gap-2 text-sm text-red-300 mb-2">
                    {isMissing && (
                      <>
                        <FaCircleQuestion className="mt-0.5 shrink-0" />
                        <span>
                          Receiver <b>{zoneName}</b> does not exist on this
                          system. Add it on the Receivers page or remove it
                          from the show.
                        </span>
                      </>
                    )}
                    {isDisabled && (
                      <>
                        <FaTriangleExclamation className="mt-0.5 shrink-0" />
                        <span>
                          Receiver <b>{zoneName}</b> is disabled. Enable it on
                          the Receivers page before loading this show.
                        </span>
                      </>
                    )}
                  </div>
                ) : null}

                <div
                  className="grid grid-cols-12 gap-4"
                  style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}
                >
                  {targets.map((target) => {
                    const item = items.find(
                      (it) => it.zone === zoneName && it.target === target
                    );
                    return (
                      <DroppableCell
                        key={`droppable-${zoneName}-${target}`}
                        id={`${zoneName}-${target}`}
                      >
                        {item && (
                          <DraggableItem
                            id={item.id}
                            color={INV_COLOR_CODE[item.type]}
                          >
                            {item.image && (
                              <div
                                className="absolute top-0 right-0 h-full w-1/3 bg-cover bg-center opacity-100"
                                style={{
                                  backgroundImage: `url(${item.image})`,
                                  mixBlendMode: "multiply",
                                }}
                              />
                            )}
                            <div className="relative z-10">{item.name}</div>
                          </DraggableItem>
                        )}
                      </DroppableCell>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {!hasAnyReceivers && (
            <div className="text-center py-10 px-4 border border-dashed border-gray-700 rounded-md text-gray-400 text-sm">
              Click <span className="text-gray-200 font-semibold">Add Receiver / Zone</span>{" "}
              above to wire a receiver into this show. You'll pick how many
              cues you want (in multiples of 8) and an optional label.
            </div>
          )}
        </div>

        <DragOverlay>
          {activeItem ? (
            <div
              className="p-2 text-white font-bold rounded-md"
              style={{
                backgroundColor: INV_COLOR_CODE[activeItem.type],
              }}
            >
              {activeItem.image && (
                <div
                  className="absolute top-0 right-0 h-full w-1/3 bg-cover bg-center opacity-40"
                  style={{
                    backgroundImage: `url(${activeItem.image})`,
                  }}
                />
              )}
              <div className="relative z-10">{activeItem.name}</div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Migrate Modal */}
      {showMigrateModal && migrateSourceZone && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 border border-gray-700">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold text-white">
                Migrate Cues from{" "}
                {receiverLabels[migrateSourceZone] || migrateSourceZone}
              </h3>
              <button
                onClick={handleMigrateCancel}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <FaX size={20} />
              </button>
            </div>

            <p className="text-gray-300 mb-4 text-sm">
              Select a target receiver to move all cues to. Only receivers in
              this show without assigned cues are shown.
            </p>

            <div className="space-y-2 max-h-64 overflow-y-auto">
              {getAvailableTargetReceivers(migrateSourceZone).length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-4">
                  No available receivers. Add an empty receiver to the show
                  first.
                </p>
              ) : (
                getAvailableTargetReceivers(migrateSourceZone).map(
                  (targetZone) => (
                    <button
                      key={targetZone}
                      onClick={() => handleMigrateConfirm(targetZone)}
                      className="w-full text-left px-4 py-3 bg-gray-700 hover:bg-gray-600 rounded border border-gray-600 hover:border-blue-500 transition-colors"
                    >
                      <div className="font-medium text-white">
                        {receiverLabels[targetZone] || targetZone}
                      </div>
                      {receiverLabels[targetZone] && (
                        <div className="text-sm text-gray-400">{targetZone}</div>
                      )}
                    </button>
                  )
                )
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={handleMigrateCancel}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function DraggableItem({ id, children }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id });

  const style = {
    transform: transform
      ? `translate(${transform.x}px, ${transform.y}px)`
      : undefined,
    backgroundColor: "#FFF6",
    color: "#FFF",
  };

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="p-4 text-white text-xs font-bold rounded-md cursor-grab overflow-hidden"
      style={style}
    >
      {children}
    </div>
  );
}

function DroppableCell({ id, children }) {
  const { isOver, setNodeRef } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`relative p-2 border border-gray-800 rounded-md col-span-1 ${
        isOver ? "bg-blue-100" : "bg-gray-900"
      }`}
      style={{ minHeight: "30px" }}
    >
      {children}
    </div>
  );
}
