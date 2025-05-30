import { INV_COLOR_CODE } from "@/constants";
import React, { useState, useRef, memo } from "react";
import { FaTrash } from "react-icons/fa6";

const Timeline = memo((props) => {
  const [zoom, setZoom] = useState(40); // Zoom level
  const {items, setItems} = props; // Track item positions
  const timelineRef = useRef(null); // Reference to the timeline container
  const ticksRef = useRef(null); // Reference to the ticks container
  const isReadOnly = props.readOnly
  const MAX_SHOW_TIME_SEC=props.timeCapSeconds || 1800

  const handleWheel = (e) => {
    e.preventDefault();
    setZoom((prevZoom) => Math.max(0.1, prevZoom - e.deltaY * (prevZoom*0.001))); // Zoom with mouse wheel
  };

  const handleDragStart = (e, id) => {

    e.dataTransfer.setData("id", id);
    e.dataTransfer.setData("clx", e.clientX);
    e.dataTransfer.setData("xEvtOffset", (e.clientX - e.target.getBoundingClientRect().left));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleTimeCursorClick = (e) => {
    const timelineOffset = timelineRef.current.scrollLeft;
    const clickX =
      e.clientX - timelineRef.current.getBoundingClientRect().left + timelineOffset;
    const timelineWidth = timelineRef.current.scrollWidth;
    const cursorTime = (clickX / timelineWidth) * 3600;
    props.setTimeCursor(cursorTime)
  }

  const handleDoubleClick = (e) => {
    const timelineOffset = timelineRef.current.scrollLeft;
    const clickX =
      e.clientX - timelineRef.current.getBoundingClientRect().left + timelineOffset;
    const timelineWidth = timelineRef.current.scrollWidth;
    const startTime = (clickX / timelineWidth) * 3600; // Convert position to time in seconds
    props.openAddModal(startTime); // Call parent function to open the modal
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("id");
    const evtXoffset = e.dataTransfer.getData("xEvtOffset")
    const timelineOffset = timelineRef.current.scrollLeft;
    const delta = e.clientX - e.dataTransfer.getData("clx")

    const dropX =
      e.clientX - timelineRef.current.getBoundingClientRect().left + timelineOffset - evtXoffset;

    if (timelineRef.current) {

      const timelineWidth = timelineRef.current.scrollWidth;
      const xform = (delta / timelineWidth) * MAX_SHOW_TIME_SEC
      const dropTime = (dropX / timelineWidth) * MAX_SHOW_TIME_SEC; // Drop time in seconds

      // Update item's start time based on drop position
      setItems((prevItems) =>
        prevItems.map((item) =>
          item.id === parseInt(id)
            ? { ...item, startTime: item.startTime + (xform*2) }
            : item
        )
      );
    }
  };

  const handleScroll = (e) => {
    // Sync the scroll position of the ticks container with the timeline
    if (ticksRef.current) {
      ticksRef.current.scrollLeft = e.target.scrollLeft;
    }
  };

  const handleRemoveEl = (e) => {
    const id = e.dataTransfer.getData("id");
    if(confirm(`Remove this item from the show?`)){
      setItems((prevItems) =>
        prevItems.filter((item) =>
          item.id != parseInt(id)
        )
      );
    }
  }

  const maxTime = 60 * 60; // Maximum time (1 hour in seconds)

  const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return minutes > 0
      ? `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`
      : `${seconds}`;
  };

  const calculatePosition = (startTime) => {
    return (startTime / maxTime) * 100; // Scaled as a percentage of the timeline width
  };

  const calculateStack = () => {
    const stacks = [];
    items.forEach((item) => {
      let overlapIndex = 0;
      for (let i = 0; i < stacks.length; i++) {
        if (
          !stacks[i].some(
            (other) =>
              item.startTime < other.startTime + other.duration &&
              item.startTime + item.duration > other.startTime
          )
        ) {
          overlapIndex = i;
          break;
        }
        overlapIndex = stacks.length; // New stack
      }
      if (!stacks[overlapIndex]) stacks[overlapIndex] = [];
      stacks[overlapIndex].push(item);
    });
    return stacks;
  };
  const stackedItems = calculateStack();

  const tickInterval = zoom >= 3 ? (zoom >= 40 ? (zoom >= 200 ? 0.5 : 1) : 10) : 60; // Use 10-second ticks at high zoom, 1-minute ticks at low zoom

  return (
    <div className="w-full container">
      {/* Ticks container */}
      { isReadOnly ? '' : (
        <div 
          className="m-1 p-2 flex" 
          onDragEnter={(e)=>{e.preventDefault()}} 
          onDragOver={(e)=>{e.preventDefault()}} 
          onDrop={handleRemoveEl}
          >
            <FaTrash/>
            <p className="text-sm ml-2">Drag items here to remove</p>

        </div>
      )}
      <div
        ref={ticksRef}
        className="relative w-full h-8 overflow-hidden bg-gray-900"
      >
        <div
          className="relative h-full"
          style={{
            width: `${100 * zoom}%`, // Dynamically adjust width based on zoom
          }}
        >
          {Array.from(
            { length: Math.ceil(maxTime / tickInterval) + 1 },
            (_, i) => (
              <div
                key={i}
                className="absolute h-full border-l border-gray-600"
                style={{
                  left: `${(i * tickInterval) / maxTime * 100}%`,
                }}
              >
                <span className="text-xs text-gray-400 absolute top-1 left-0">
                  {formatTime(i * tickInterval)}
                </span>
              </div>
            )
          )}
        </div>
      </div>

      {/* Timeline container */}
      <div
        ref={timelineRef}
        className="relative w-full h-64 overflow-x-scroll border border-gray-700 bg-gray-900"
        onWheel={handleWheel}
        onDragOver={isReadOnly ? (()=>{}) : handleDragOver}
        onDrop={isReadOnly ? (()=>{}) : handleDrop}
        onScroll={handleScroll}
        onDoubleClick={isReadOnly ? (()=>{}) : handleDoubleClick}
        onClick={props.setTimeCursor ? handleTimeCursorClick : ()=>{}}
      >
        {/* Timeline background */}
        <div
          className="relative h-full"
          style={{
            width: `${100 * zoom}%`, // Dynamically adjust width based on zoom
          }}
        >
          {/* Time markers (extend lines into the timeline) */}
          {Array.from(
            { length: Math.ceil(maxTime / tickInterval) + 1 },
            (_, i) => (
              <div
                key={i}
                className="absolute top-0 h-full border-l border-gray-600"
                style={{
                  left: `${(i * tickInterval) / maxTime * 100}%`,
                }}
              ></div>
            )
          )}

          {props.timeCursor ? (
            <div
              className="absolute top-0 h-full border-l border-green-300"
              style={{
                left: `${props.timeCursor / maxTime * 100}%`,
              }}
            ></div>
          ) : ''}

          {/* Items */}
          {stackedItems.flat().map((item) => {
            const start = calculatePosition(item.startTime);
            const width = (item.duration / maxTime) * 100;
            const top = stackedItems.findIndex((stack) =>
              stack.includes(item)
            );


            return (
              <div
                key={item.id}
                className={`absolute text-white text-xs rounded px-2 py-1 cursor-move drop-shadow-xs`}
                style={{
                  left: `${start}%`,
                  width: `${width}%`,
                  top: `${top * 40 + 20}px`, // Add padding above items
                  transform: `scaleX(1)`, // Adjust width scaling with zoom
                  transformOrigin: "left center",
                  backgroundColor: INV_COLOR_CODE[item.type]+"CC",
                  textShadow: "0px 0px 3px black"
                }}
                draggable
                onDragStart={(e) => (isReadOnly ? (()=>{}) : handleDragStart(e, item.id))}
                onClick={(e) => {
                    if(isReadOnly) return;
                    if(e.shiftKey){
                        props.setSelectedItem(item)
                    }
                }}
              >
                {item.name} @ {item.zone}:{item.target}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

export default Timeline;
