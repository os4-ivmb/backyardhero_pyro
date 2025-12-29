import React, { useState } from "react";
import {
  DndContext,
  useDraggable,
  useDroppable,
  closestCenter,
  DragOverlay,
} from "@dnd-kit/core";
import { MdEdit, MdSwapHoriz } from "react-icons/md";
import { FaX } from "react-icons/fa6";
import { INV_COLOR_CODE } from "@/constants";

export default function ShowTargetGrid(props) {
    const { items, setItems, receiverLabels, setReceiverLabels } = props;
    const [activeItem, setActiveItem] = useState(null);
    const [editingZone, setEditingZone] = useState(null);
    const [editValue, setEditValue] = useState("");
    const [migrateSourceZone, setMigrateSourceZone] = useState(null);
    const [showMigrateModal, setShowMigrateModal] = useState(false);

    const availableDevices = props.availableDevices
    
    const handleLabelEdit = (zoneName) => {
      setEditingZone(zoneName);
      setEditValue(receiverLabels[zoneName] || zoneName);
    };
    
    const handleLabelSave = (zoneName) => {
      setReceiverLabels(prev => ({
        ...prev,
        [zoneName]: editValue || zoneName
      }));
      setEditingZone(null);
      setEditValue("");
    };
    
    const handleLabelCancel = () => {
      setEditingZone(null);
      setEditValue("");
    };
    
    const handleLabelKeyDown = (e, zoneName) => {
      if (e.key === 'Enter') {
        handleLabelSave(zoneName);
      } else if (e.key === 'Escape') {
        handleLabelCancel();
      }
    };

    // Get receivers (zones) that don't have any cues assigned
    const getAvailableTargetReceivers = (sourceZone) => {
      return Object.keys(availableDevices).filter((zoneName) => {
        // Skip the source zone
        if (zoneName === sourceZone) return false;
        
        // Check if this zone has any items assigned
        const hasItems = items.some((item) => item.zone === zoneName);
        return !hasItems;
      });
    };

    const handleMigrateClick = (sourceZone) => {
      setMigrateSourceZone(sourceZone);
      setShowMigrateModal(true);
    };

    const handleMigrateConfirm = (targetZone) => {
      if (!migrateSourceZone || !targetZone) return;

      // Get all items from the source zone
      const sourceItems = items.filter((item) => item.zone === migrateSourceZone);

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
  
    return (
      <>
      <DndContext
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        collisionDetection={closestCenter}
      >
        <div className="flex flex-col gap-4 mb-12">
          {Object.keys(availableDevices).map((zoneName, zoneIndex) => (
            <div key={zoneIndex} className="flex flex-col">
              <div className="flex items-center gap-2 mb-2">
                {editingZone === zoneName ? (
                  <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => handleLabelSave(zoneName)}
                    onKeyDown={(e) => handleLabelKeyDown(e, zoneName)}
                    className="text-lg font-semibold bg-gray-700 text-white px-2 py-1 rounded border border-gray-600 focus:outline-none focus:border-blue-500"
                    autoFocus
                  />
                ) : (
                  <>
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                      {receiverLabels[zoneName] ? (
                        <>
                          <span>{receiverLabels[zoneName]}</span>
                          <span className="text-gray-500 text-sm font-normal">({zoneName})</span>
                        </>
                      ) : (
                        <span>{zoneName}</span>
                      )}
                    </h3>
                    <button
                      onClick={() => handleLabelEdit(zoneName)}
                      className="text-gray-400 hover:text-white transition-colors"
                      title="Edit receiver label"
                    >
                      <MdEdit size={18} />
                    </button>
                    {/* Only show migrate button if this receiver has items assigned */}
                    {items.some((item) => item.zone === zoneName) && (
                      <button
                        onClick={() => handleMigrateClick(zoneName)}
                        className="text-blue-400 hover:text-blue-300 transition-colors"
                        title="Migrate all cues to another receiver"
                      >
                        <MdSwapHoriz size={18} />
                      </button>
                    )}
                  </>
                )}
              </div>
              <div className={`grid grid-cols-12 gap-4`} style={{gridTemplateColumns: 'repeat(6, minmax(0, 1fr))'}}>
                {availableDevices[zoneName].map((target, targetIndex) => {
                  const item = items.find(
                    (item) =>
                      item.zone === zoneName && item.target === target
                  );
  
                  return (
                    <DroppableCell
                      key={`droppable-${zoneName}-${target}`}
                      id={`${zoneName}-${target}`}
                    >
                      {item && (
                        <DraggableItem id={item.id} color={INV_COLOR_CODE[item.type]}>
                          {item.image && (
                                <div
                                className="absolute top-0 right-0 h-full w-1/3 bg-cover bg-center opacity-100"
                                style={{
                                    backgroundImage: `url(${item.image})`,
                                    mixBlendMode: "multiply",
                                }}
                                ></div>
                            )}

                            {/* Show the name of the item */}
                            <div className="relative z-10">{item.name}</div>
                        </DraggableItem>
                      )}
                    </DroppableCell>
                  );
                })}
              </div>
            </div>
          ))}
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
                    ></div>
                )}

                {/* Show the name of the item */}
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
                Migrate Cues from {receiverLabels[migrateSourceZone] || migrateSourceZone}
              </h3>
              <button
                onClick={handleMigrateCancel}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <FaX size={20} />
              </button>
            </div>
            
            <p className="text-gray-300 mb-4 text-sm">
              Select a target receiver to move all cues to. Only receivers without assigned cues are shown.
            </p>

            <div className="space-y-2 max-h-64 overflow-y-auto">
              {getAvailableTargetReceivers(migrateSourceZone).length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-4">
                  No available receivers. All receivers have cues assigned.
                </p>
              ) : (
                getAvailableTargetReceivers(migrateSourceZone).map((targetZone) => (
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
                ))
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
  
  function DraggableItem({ id, children, color }) {
    const { attributes, listeners, setNodeRef, transform } = useDraggable({
      id,
    });
  
    const style = {
      transform: transform
        ? `translate(${transform.x}px, ${transform.y}px)`
        : undefined,
      backgroundColor: '#FFF6',
      color: '#FFF',
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