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
  const [inventory, setInventory] = useState([]); // Inventory for RACK_SHELLS calculations
  // Tracks the timestamp (ms) of the last copy-place click so a trailing
  // dblclick from the same gesture doesn't also pop the AddItemModal.
  const recentCopyPlaceRef = useRef(0);

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
    // Copy Item flow: in 'select-position' mode a click anywhere on the
    // timeline (background or items) drops the duplicate at that time. Skip
    // the normal "clear selection / move time cursor" behavior.
    if (props.copyMode === "select-position") {
      const timelineOffset = timelineRef.current.scrollLeft;
      const clickX =
        e.clientX - timelineRef.current.getBoundingClientRect().left + timelineOffset;
      const timelineWidth = timelineRef.current.scrollWidth;
      const dropTime = (clickX / timelineWidth) * 3600;
      recentCopyPlaceRef.current = Date.now();
      props.onCopyPlaceClick?.(dropTime);
      return;
    }

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
    // Suppress the AddItemModal if this dblclick is the trailing pair of a
    // copy-place click that just landed.
    if (Date.now() - recentCopyPlaceRef.current < 500) return;

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

  const cakeTypesWithFiringProfiles = (type) =>
    type === "CAKE_200G" ||
    type === "CAKE_350G" ||
    type === "CAKE_500G" ||
    type === "COMPOUND_CAKE";

  // Fetch firing profiles for cakes that use shot profiles. Also walks
  // FUSED_LINE steps so cake steps inside a fused line render shot overlays.
  useEffect(() => {
    const fetchFiringProfiles = async () => {
      const profiles = {};
      const itemIds = new Set();
      items.forEach((item) => {
        if (cakeTypesWithFiringProfiles(item.type) && item.itemId) {
          itemIds.add(item.itemId);
        }
        if (item.type === "FUSED_LINE" && Array.isArray(item.steps)) {
          item.steps.forEach((step) => {
            if (cakeTypesWithFiringProfiles(step.type) && step.itemId) {
              itemIds.add(step.itemId);
            }
          });
        }
      });

      const promises = Array.from(itemIds).map(async (itemId) => {
        try {
          const response = await axios.get(`/api/inventory/${itemId}/firing-profile`);
          if (response.data) {
            profiles[itemId] = response.data;
          }
        } catch (error) {
          // Profile doesn't exist for this item, which is fine
          if (error.response?.status !== 404) {
            console.error(`Error fetching firing profile for item ${itemId}:`, error);
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

  // Fetch inventory if we have RACK_SHELLS items
  useEffect(() => {
    const hasRackShells = items.some(item => item.type === 'RACK_SHELLS');
    if (hasRackShells && inventory.length === 0) {
      const fetchInventory = async () => {
        try {
          const response = await axios.get('/api/inventory');
          setInventory(response.data || []);
        } catch (error) {
          console.error('Failed to fetch inventory for RACK_SHELLS:', error);
        }
      };
      fetchInventory();
    }
  }, [items, inventory.length]);

  const tickInterval = zoom >= 3 ? (zoom >= 40 ? (zoom >= 200 ? 0.5 : 1) : 10) : 60; // Use 10-second ticks at high zoom, 1-minute ticks at low zoom

  const handleItemClick = (e, item) => {
    if (isReadOnly) return;

    // Copy Item flow: in 'select-source' mode an item click picks the source
    // to duplicate. Swallow the event so we don't also single-select / clear.
    if (props.copyMode === "select-source") {
      e.preventDefault();
      e.stopPropagation();
      props.onCopySourceClick?.(item);
      return;
    }

    // In 'select-position' mode, defer entirely to the timeline-level handler
    // so we don't also single-select the item the user clicked through.
    if (props.copyMode === "select-position") {
      return;
    }

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
        className={`relative w-full h-64 overflow-x-scroll border bg-gray-900 ${
          props.copyMode
            ? "border-emerald-500"
            : "border-gray-700"
        }`}
        style={{
          cursor:
            props.copyMode === "select-position"
              ? "crosshair"
              : props.copyMode === "select-source"
                ? "copy"
                : undefined,
        }}
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
            const firingProfile =
              cakeTypesWithFiringProfiles(item.type) && item.itemId
                ? firingProfiles[item.itemId]
                : null;
            let shots = firingProfile?.shot_timestamps || [];

            // Calculate shot timings for fused lines
            // Note: item.startTime represents when the first shot fires (the click point)
            // The delay (lead-in + first shell delays) is only used by the firing system
            // to know when to light the fuse, not for the visual timeline
            if ((item.type === 'FUSED_AERIAL_LINE' || item.type === 'FUSED_SHELL_LINE') && item.shells && item.fuse && item.spacing) {
              const burn_rate = item.fuse.burn_rate || 0;
              const spacing_inches = parseFloat(item.spacing) || 0;
              const fuse_burn_time_per_shell = (spacing_inches / 12) * burn_rate;
              
              shots = item.shells.map((shell, index) => {
                if (!shell) return null;
                
                // Calculate time from item start to when this shell's effect appears
                // First shell fires at startTime (0 relative to item start)
                let shotStartSec = 0;
                
                if (index > 0) {
                  // Subsequent shells: add fuse burn time for spacing between each shell
                  for (let i = 1; i <= index; i++) {
                    shotStartSec += fuse_burn_time_per_shell;
                  }
                }
                
                // Shot duration is 1 second
                const shotEndSec = shotStartSec + 1.0;
                
                // Return in milliseconds format like cake shots: [start_ms, end_ms]
                return [shotStartSec * 1000, shotEndSec * 1000];
              }).filter(shot => shot !== null);
            }

            // Calculate shot timings for FUSED_LINE (fused item line). Each
            // step's bar starts at an offset within the parent (computed from
            // prior steps' durations + intervening fuse delays). Shots inside
            // a step are positioned relative to the step's start.
            // We also build per-step boundaries so the renderer can drop a
            // visual divider between adjacent steps.
            let fusedLineStepBoundariesSec = [];
            if (item.type === 'FUSED_LINE' && Array.isArray(item.steps) && item.steps.length > 0) {
              const stepShots = [];
              const offsets = [];
              let acc = 0;
              item.steps.forEach((step, idx) => {
                if (idx > 0) acc += Math.max(0, Number(step.fuseDelay) || 0);
                offsets.push(acc);
                acc += Math.max(0, Number(step.duration) || 0);
              });

              // A boundary is the start of every step beyond the first; this is
              // where we draw a vertical black line separator.
              fusedLineStepBoundariesSec = offsets.slice(1);

              item.steps.forEach((step, idx) => {
                const offsetSec = offsets[idx];
                const stepDur = Math.max(0, Number(step.duration) || 0);

                if (step.type === 'FUSED_SHELL_LINE' && step.fusedShellLine) {
                  const fl = step.fusedShellLine;
                  const burn_rate = fl.fuse?.burn_rate || 0;
                  const spacing_inches = parseFloat(fl.spacing) || 0;
                  const fuse_burn_time_per_shell = (spacing_inches / 12) * burn_rate;
                  (fl.shells || []).forEach((shell, sIdx) => {
                    if (!shell) return;
                    const inStepSec = sIdx * fuse_burn_time_per_shell;
                    const startSec = offsetSec + inStepSec;
                    const endSec = startSec + 1.0;
                    stepShots.push([startSec * 1000, endSec * 1000]);
                  });
                } else if (cakeTypesWithFiringProfiles(step.type) && step.itemId && firingProfiles[step.itemId]) {
                  const ts = firingProfiles[step.itemId].shot_timestamps || [];
                  ts.forEach((shot) => {
                    const shotStartMs = shot[0];
                    const shotEndMs = shot[1];
                    const color = shot.length >= 3 ? shot[2] : null;
                    const startMs = (offsetSec * 1000) + shotStartMs;
                    const endMs = (offsetSec * 1000) + shotEndMs;
                    if (color) {
                      stepShots.push([startMs, endMs, color]);
                    } else {
                      stepShots.push([startMs, endMs]);
                    }
                  });
                } else {
                  // Generic fallback: fill the step's full duration with one shot.
                  const startSec = offsetSec;
                  const endSec = offsetSec + Math.max(0.2, stepDur);
                  stepShots.push([startSec * 1000, endSec * 1000]);
                }
              });
              shots = stepShots;
            }

            // Calculate shot timings for rack shells
            // Note: item.startTime represents when the first shot fires (the click point)
            // The delay (lead-in + first shell delays) is only used by the firing system
            // to know when to light the fuse, not for the visual timeline
            if (item.type === 'RACK_SHELLS' && item.fireableItem && item.rackSpacing && inventory.length > 0) {
              const fireableItem = item.fireableItem;
              const rackSpacing = item.rackSpacing;
              
              if (fireableItem.type === 'fused' && fireableItem.fuse && fireableItem.cellData && fireableItem.cells) {
                // For fused rack items, calculate when each shell effect appears
                const fuse = fireableItem.fuse;
                const fuseItem = inventory.find(inv => inv.type === 'FUSE' && inv.id === parseInt(fuse.type));
                const burn_rate = fuseItem?.burn_rate || 0;
                
                shots = fireableItem.cellData.map((cellData, index) => {
                  if (!cellData || !cellData.shellId) return null;
                  
                  // First shell fires at startTime (0 relative to item start)
                  let shotStartSec = 0;
                  
                  if (index > 0) {
                    // Subsequent shells: add fuse burn time for spacing between each shell
                    for (let i = 1; i <= index; i++) {
                      // Calculate distance between previous cell and current cell
                      const prevCellKey = fireableItem.cells[i - 1];
                      const currentCellKey = fireableItem.cells[i];
                      const [x1, y1] = prevCellKey.split('_').map(Number);
                      const [x2, y2] = currentCellKey.split('_').map(Number);
                      
                      // Calculate distance using rack spacing (in inches)
                      const xDiff = Math.abs(x2 - x1);
                      const yDiff = Math.abs(y2 - y1);
                      const distance_inches = (xDiff * rackSpacing.x) + (yDiff * rackSpacing.y);
                      
                      // Time for fuse to burn this distance: (distance in feet) * burn_rate
                      const fuse_burn_time = (distance_inches / 12) * burn_rate;
                      shotStartSec += fuse_burn_time;
                    }
                  }
                  
                  // Shot duration is 0.5 seconds
                  const shotEndSec = shotStartSec + 0.5;
                  
                  // Return in milliseconds format like cake shots: [start_ms, end_ms]
                  return [shotStartSec * 1000, shotEndSec * 1000];
                }).filter(shot => shot !== null);
              } else if (fireableItem.type === 'single' && fireableItem.cellData && fireableItem.cellData[0]) {
                // For single shell rack items
                const cellData = fireableItem.cellData[0];
                const shell = inventory.find(inv => inv.id === cellData.shellId);
                if (shell) {
                  // Single shell fires at startTime (0 relative to item start)
                  const shotStartSec = 0;
                  const shotEndSec = shotStartSec + 0.5;
                  shots = [[shotStartSec * 1000, shotEndSec * 1000]];
                }
              }
            }

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
                    backgroundColor: (INV_COLOR_CODE[item.type] || '#888888')+"CC",
                    textShadow: "0px 0px 3px black",
                    border: isSelected ? '2px solid #60A5FA' : 'none'
                  }}
                  draggable
                  onDragStart={(e) => (isReadOnly ? (()=>{}) : handleDragStart(e, item.id))}
                  onClick={(e) => handleItemClick(e, item)}
                >
                  {item.name} @ {props.receiverLabels?.[item.zone] || item.zone}:{item.target}
                  {Number.isFinite(item.multiple) && item.multiple > 1 && (
                    <span
                      className="absolute top-0 right-0 px-1 text-[10px] font-bold leading-none bg-black/40 rounded-bl"
                      style={{ textShadow: "0px 0px 2px black" }}
                    >
                      x{item.multiple}
                    </span>
                  )}
                </div>
                
                {/* Vertical black separators for FUSED_LINE step boundaries */}
                {fusedLineStepBoundariesSec.map((boundarySec, bIdx) => {
                  const boundaryAbsTime = item.startTime + boundarySec;
                  const boundaryLeftPct = calculatePosition(boundaryAbsTime);
                  return (
                    <div
                      key={`${item.id}-boundary-${bIdx}`}
                      className="absolute pointer-events-none"
                      style={{
                        left: `${boundaryLeftPct}%`,
                        top: `${top * 40 + 20}px`,
                        width: '0px',
                        height: '24px',
                        borderLeft: '2px solid #000',
                        zIndex: 2,
                      }}
                    />
                  );
                })}

                {/* Shot profile overlays - positioned as siblings to avoid affecting bar layout */}
                {shots.length > 0 && shots.map((shot, shotIndex) => {
                  // Handle both [start, end] and [start, end, color] formats
                  const shotStartMs = shot[0];
                  const shotEndMs = shot[1];
                  const shotColor = shot.length >= 3 ? shot[2] : null;
                  
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
                  
                  // Base overlay with default semi-transparent white
                  const baseBackgroundColor = 'rgba(255, 255, 255, 0.4)';
                  
                  return (
                    <div
                      key={`${item.id}-shot-${shotIndex}`}
                      className="absolute pointer-events-none"
                      style={{
                        left: `${shotLeft}%`,
                        width: `${shotWidth}%`,
                        top: `${top * 40 + 20}px`,
                        height: '24px', // Match the bar height
                        backgroundColor: baseBackgroundColor,
                        borderRadius: '2px',
                        zIndex: 1
                      }}
                    >
                      {/* Color stripe at top if shot has a color */}
                      {shotColor && (
                        <div
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            height: '3px',
                            backgroundColor: shotColor,
                            borderRadius: '2px 2px 0 0'
                          }}
                        />
                      )}
                    </div>
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
