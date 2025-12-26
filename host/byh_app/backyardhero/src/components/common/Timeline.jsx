import { INV_COLOR_CODE } from "@/constants";
import React, { useState, useRef, memo, useEffect } from "react";
import { FaTrash } from "react-icons/fa6";
import axios from "axios";

const Timeline = memo((props) => {
  const [zoom, setZoom] = useState(40); // Zoom level
  const {items, setItems} = props; // Track item positions
  const timelineRef = useRef(null); // Reference to the timeline container
  const ticksRef = useRef(null); // Reference to the ticks container
  const isReadOnly = props.readOnly
  const MAX_SHOW_TIME_SEC=props.timeCapSeconds || 1800
  const [firingProfiles, setFiringProfiles] = useState({}); // Map of itemId -> firing profile

  const handleWheel = (e) => {
    //e.preventDefault();
    e.stopPropagation();
    setZoom((prevZoom) => Math.max(0.1, prevZoom - e.deltaY * (prevZoom*0.001))); // Zoom with mouse wheel
  };

  const handleZoomIn = () => {
    setZoom((prevZoom) => Math.min(200, prevZoom * 1.2));
  };

  const handleZoomOut = () => {
    setZoom((prevZoom) => Math.max(0.1, prevZoom / 1.2));
  };

  const handleTouchStart = (e) => {
    // Prevent default touch behavior to avoid window scrolling
    e.preventDefault();
  };

  const handleTouchMove = (e) => {
    // Prevent default touch behavior to avoid window scrolling
    e.preventDefault();
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
    if (props.setTimeCursor && isFinite(cursorTime) && cursorTime >= 0) {
      props.setTimeCursor(cursorTime);
    }
  }

  const handleTimelineClick = (e) => {
    // If clicking on the timeline background (not on an item), clear selection
    if (e.target === e.currentTarget || e.target.className.includes('border-l')) {
      if (props.clearSelection) {
        props.clearSelection();
      }
    }
    
    // Handle time cursor if enabled
    if (props.setTimeCursor) {
      handleTimeCursorClick(e);
    }
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

      // Check if the dragged item is part of a multi-selection
      const selectedItems = props.selectedItems || [];
      console.log('selectedItems', selectedItems);
      console.log('id', id);
      const isMultiSelectDrag = selectedItems.some(item => item.id === parseInt(id));
      
      if (isMultiSelectDrag && selectedItems.length > 1) {
        // Handle multi-item drag - maintain relative timing
        const draggedItem = selectedItems.find(item => item.id === parseInt(id));
        const timeOffset = xform * 2; // Same calculation as single item
        
        setItems((prevItems) =>
          prevItems.map((item) => {
            if (selectedItems.some(selected => selected.id === item.id)) {
              return { ...item, startTime: item.startTime + timeOffset };
            }
            return item;
          })
        );
      } else {
        // Single item drag (existing behavior)
        console.log(items)
        setItems((prevItems) =>
          prevItems.map((item) =>
            item.id === parseInt(id)
              ? { ...item, startTime: item.startTime + (xform*2) }
              : item
          )
        );
      }
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

  // Fetch firing profiles for CAKE_200G and CAKE_500G items
  useEffect(() => {
    const fetchFiringProfiles = async () => {
      const profiles = {};
      const cakeItems = items.filter(item => 
        (item.type === 'CAKE_200G' || item.type === 'CAKE_500G') && item.itemId
      );
      
      const promises = cakeItems.map(async (item) => {
        try {
          const response = await axios.get(`/api/inventory/${item.itemId}/firing-profile`);
          if (response.data) {
            profiles[item.itemId] = response.data;
          }
        } catch (error) {
          // Profile doesn't exist for this item, which is fine
          if (error.response?.status !== 404) {
            console.error(`Error fetching firing profile for item ${item.itemId}:`, error);
          }
        }
      });
      
      await Promise.all(promises);
      setFiringProfiles(profiles);
    };

    if (items.length > 0) {
      fetchFiringProfiles();
    }
  }, [items]);

  const tickInterval = zoom >= 3 ? (zoom >= 40 ? (zoom >= 200 ? 0.5 : 1) : 10) : 60; // Use 10-second ticks at high zoom, 1-minute ticks at low zoom

  const handleItemClick = (e, item) => {
    if (isReadOnly) return;
    
    const isCommandClick = e.metaKey || e.ctrlKey; // Command on Mac, Ctrl on Windows/Linux
    
    if (isCommandClick) {
      // Multi-select mode
      e.preventDefault();
      e.stopPropagation();
      props.onItemSelect?.(item, true);
    } else {
      // Single select mode
      props.setSelectedItem?.(item);
      // Clear multi-selection when single clicking
      if (props.clearSelection) {
        props.clearSelection();
      }
    }
  };

  return (
    <div className="w-full container">
      {/* Zoom Controls */}
      <div className="flex items-center mb-2 gap-2">
        <button
          className="bg-gray-700 text-white px-2 py-1 rounded hover:bg-gray-600"
          onClick={handleZoomOut}
          title="Zoom Out"
        >
          -
        </button>
        <span className="text-xs text-gray-300">Zoom: {zoom.toFixed(1)}x</span>
        <button
          className="bg-gray-700 text-white px-2 py-1 rounded hover:bg-gray-600"
          onClick={handleZoomIn}
          title="Zoom In"
        >
          +
        </button>
      </div>
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
        onClick={handleTimelineClick}
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

            // Check if item is selected
            const selectedItems = props.selectedItems || [];
            const isSelected = selectedItems.some(selected => selected.id === item.id);

            // Get firing profile for this item if it's a cake
            const firingProfile = (item.type === 'CAKE_200G' || item.type === 'CAKE_500G') && item.itemId
              ? firingProfiles[item.itemId]
              : null;
            const shots = firingProfile?.shot_timestamps || [];

            return (
              <React.Fragment key={item.id}>
                {/* Main bar */}
                <div
                  className={`absolute text-white text-xs rounded px-2 py-1 cursor-move drop-shadow-xs ${
                    isSelected ? 'ring-2 ring-blue-400 ring-opacity-75' : ''
                  }`}
                  style={{
                    left: `${start}%`,
                    width: `${width}%`,
                    top: `${top * 40 + 20}px`, // Add padding above items
                    transform: `scaleX(1)`, // Adjust width scaling with zoom
                    transformOrigin: "left center",
                    backgroundColor: INV_COLOR_CODE[item.type]+"CC",
                    textShadow: "0px 0px 3px black",
                    border: isSelected ? '2px solid #60A5FA' : 'none'
                  }}
                  draggable
                  onDragStart={(e) => (isReadOnly ? (()=>{}) : handleDragStart(e, item.id))}
                  onClick={(e) => handleItemClick(e, item)}
                >
                  {item.name} @ {item.zone}:{item.target}
                </div>
                
                {/* Shot profile overlays - positioned as siblings to avoid affecting bar layout */}
                {shots.length > 0 && shots.map((shot, shotIndex) => {
                  const [shotStartMs, shotEndMs] = shot;
                  // Convert milliseconds to seconds, then to percentage of item duration
                  const shotStartSec = shotStartMs / 1000;
                  const shotEndSec = shotEndMs / 1000;
                  const shotDuration = shotEndSec - shotStartSec;
                  
                  // Position relative to the item's start time and duration
                  const shotLeftPercent = (shotStartSec / item.duration) * 100;
                  const shotWidthPercent = (shotDuration / item.duration) * 100;
                  
                  // Calculate absolute position on timeline
                  const shotStartTime = item.startTime + shotStartSec;
                  const shotLeft = calculatePosition(shotStartTime);
                  const shotWidth = (shotDuration / maxTime) * 100;
                  
                  return (
                    <div
                      key={`${item.id}-shot-${shotIndex}`}
                      className="absolute pointer-events-none"
                      style={{
                        left: `${shotLeft}%`,
                        width: `${shotWidth}%`,
                        top: `${top * 40 + 20}px`,
                        height: '24px', // Match the bar height
                        backgroundColor: 'rgba(255, 255, 255, 0.4)', // More opaque overlay
                        borderRadius: '2px',
                        zIndex: 1
                      }}
                    />
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
});

export default Timeline;
