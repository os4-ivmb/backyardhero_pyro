import React, { useState } from "react";
import {
  DndContext,
  useDraggable,
  useDroppable,
  closestCenter,
  DragOverlay,
} from "@dnd-kit/core";
import { INV_COLOR_CODE } from "@/constants";

export default function ShowTargetGrid(props) {
    const { items, setItems } = props;
    const [activeItem, setActiveItem] = useState(null);

    const availableDevices = props.availableDevices
  
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
      <DndContext
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        collisionDetection={closestCenter}
      >
        <div className="flex flex-col gap-4 mb-12">
          {Object.keys(availableDevices).map((zoneName, zoneIndex) => (
            <div key={zoneIndex} className="flex flex-col">
              <h3 className="text-lg font-semibold mb-2">{zoneName}</h3>
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