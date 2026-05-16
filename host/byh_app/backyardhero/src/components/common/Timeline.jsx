import { INV_COLOR_CODE } from "@/constants";
import React, { useState, useRef, memo, useEffect, useMemo } from "react";
import { FaTrash } from "react-icons/fa6";
import { FiZoomIn, FiZoomOut } from "react-icons/fi";
import axios from "axios";
import { cn } from "@/design";
import {
  anyTrackHasBpm,
  generateMultiTrackBeatGrid,
  snapShowTimeToBeat,
  totalShowAudioDuration,
} from "@/utils/audioTracks";

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
      // Hold Alt while dropping to bypass snap (DAW-style override).
      const snapActive = useBeatsGrid && snapToBeat && !e.altKey;

      if (isMultiSelectDrag && selectedItems.length > 1) {
        // Handle multi-item drag - maintain relative timing.
        const draggedItem = selectedItems.find(item => item.id === parseInt(id));
        let timeOffset = xform * 2; // Same calculation as single item
        // When snap is on, derive the offset from the dragged item's
        // snapped landing position so all peers shift by the same amount
        // and keep their relative timing.
        if (snapActive && draggedItem) {
          const targetStart = draggedItem.startTime + timeOffset;
          const snappedStart = snapTimeToBeat(targetStart);
          timeOffset = snappedStart - draggedItem.startTime;
        }

        setItems((prevItems) =>
          prevItems.map((item) => {
            if (selectedItems.some(selected => selected.id === item.id)) {
              return { ...item, startTime: item.startTime + timeOffset };
            }
            return item;
          })
        );
      } else {
        // Single item drag.
        console.log(items)
        setItems((prevItems) =>
          prevItems.map((item) => {
            if (item.id !== parseInt(id)) return item;
            const targetStart = item.startTime + (xform * 2);
            const newStart = snapActive ? snapTimeToBeat(targetStart) : targetStart;
            return { ...item, startTime: newStart };
          })
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

  // Auto-frame the playhead while time advances. We DON'T smooth-scroll
  // every frame -- that fights manual scroll and burns layout work at
  // 10Hz. Instead we only re-frame when the cursor leaves the viewport,
  // jumping the scroll so the cursor lands ~10% from the left edge.
  // This costs one scrollLeft assignment per "page-flip" of playback.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const t = props.timeCursor;
    if (!Number.isFinite(t) || t < 0) return;
    const w = el.scrollWidth;
    if (w <= 0) return;
    const cursorPx = (t / maxTime) * w;
    const view = el.clientWidth;
    if (view <= 0) return;
    const left = el.scrollLeft;
    const right = left + view;
    if (cursorPx < left || cursorPx > right) {
      el.scrollLeft = Math.max(0, cursorPx - view * 0.1);
    }
  }, [props.timeCursor, zoom]);

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

  // Major/minor tick hierarchy. The previous implementation drew a single
  // dense grid which created the "visual vibration" called out in the brief.
  // Now we render minor ticks faintly (or not at all at low zooms) and
  // major ticks slightly stronger with labels.
  const tickConfig = (() => {
    if (zoom >= 200) return { minor: 0.5, major: 5  };
    if (zoom >= 40)  return { minor: 1,   major: 10 };
    if (zoom >= 3)   return { minor: 10,  major: 60 };
    return                  { minor: 60,  major: 300 };
  })();
  const tickInterval = tickConfig.minor;

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

  // Minor ticks are drawn very faintly; major ticks are slightly stronger
  // with labels. The first major label always renders, subsequent labels
  // only render at multiples of `tickConfig.major` so we don't have label
  // pile-ups at low zoom.
  const tickCount = Math.ceil(maxTime / tickInterval) + 1;

  // Beat grid derived from each track's per-song BPM. Tracks play
  // sequentially with no gap, so each track's beats are anchored at its
  // cumulative start time within the show. We accept either the new
  // `audioTracks` array prop or the legacy single-bpm props (synthesising
  // a one-element tracks array) so older Timeline consumers keep working
  // until they're migrated.
  const audioTracks = useMemo(() => {
    if (Array.isArray(props.audioTracks)) return props.audioTracks;
    if (props.bpm && props.bpm > 0) {
      return [
        {
          id: "_legacy",
          url: null,
          name: "audio",
          bpm: props.bpm,
          firstBeatOffsetSec: props.firstBeatOffsetSec || 0,
          beatsPerMeasure: props.beatsPerMeasure || 4,
          durationSec: Number.isFinite(props.audioDurationSec)
            ? props.audioDurationSec
            : null,
        },
      ];
    }
    return [];
  }, [
    props.audioTracks,
    props.bpm,
    props.firstBeatOffsetSec,
    props.beatsPerMeasure,
    props.audioDurationSec,
  ]);

  const hasBeats = anyTrackHasBpm(audioTracks);
  const totalAudioDur = useMemo(
    () => totalShowAudioDuration(audioTracks),
    [audioTracks]
  );
  const beatGridMaxSec = useMemo(() => {
    const cap = Number.isFinite(props.audioDurationSec) && props.audioDurationSec > 0
      ? props.audioDurationSec
      : totalAudioDur;
    return cap > 0 ? Math.min(cap, maxTime) : maxTime;
  }, [props.audioDurationSec, totalAudioDur]);

  const beatGrid = useMemo(() => {
    if (!hasBeats) return [];
    return generateMultiTrackBeatGrid({
      tracks: audioTracks,
      maxTimeSec: beatGridMaxSec,
    });
  }, [hasBeats, audioTracks, beatGridMaxSec]);

  // Grid mode toggle in the toolbar: "seconds" keeps the existing
  // mm:ss grid; "beats" replaces the second-grid with measure/beat
  // gridlines aligned to the song. Default to seconds, but flip to
  // beats automatically the first time bpm becomes available so a
  // freshly-detected song "lights up" the grid without an extra click.
  const [gridMode, setGridMode] = useState("seconds");
  const initialBeatsAdoptedRef = useRef(false);
  useEffect(() => {
    if (hasBeats && !initialBeatsAdoptedRef.current) {
      setGridMode("beats");
      initialBeatsAdoptedRef.current = true;
    }
    if (!hasBeats) {
      // BPM cleared -- fall back to seconds and re-arm the auto-adopt.
      setGridMode("seconds");
      initialBeatsAdoptedRef.current = false;
    }
  }, [hasBeats]);

  const useBeatsGrid = gridMode === "beats" && hasBeats;

  // Density culling for the beat grid. Driven by the *loosest* track --
  // the one with the slowest tempo (largest beat period, most px per
  // beat). Picking the loosest gives every track the same visual
  // treatment: as long as any track is wide enough to show off-beats /
  // measure labels at this zoom, all tracks do. (If we used a per-track
  // threshold a faster auto-detected track would silently lose its
  // off-beats and measure numbers, which made non-first songs look
  // visually different from the first.)
  const loosestBeatPeriodSec = useMemo(() => {
    let max = 0;
    for (const t of audioTracks) {
      if (t?.bpm && t.bpm > 0) max = Math.max(max, 60 / t.bpm);
    }
    return max;
  }, [audioTracks]);
  const beatsPerMeasureRef = useMemo(() => {
    // Use the largest beatsPerMeasure across tracks so the densest-
    // measure case drives the label stride; anything smaller will then
    // certainly fit too.
    let max = 4;
    for (const t of audioTracks) {
      if (t?.beatsPerMeasure && t.beatsPerMeasure > max) max = t.beatsPerMeasure;
    }
    return max;
  }, [audioTracks]);
  const approxPxPerBeat = useMemo(() => {
    if (!useBeatsGrid || !loosestBeatPeriodSec) return 0;
    const refPx = 1000 * zoom;
    return (loosestBeatPeriodSec / maxTime) * refPx;
  }, [useBeatsGrid, loosestBeatPeriodSec, zoom]);
  const showOffBeats = useBeatsGrid && approxPxPerBeat >= 6;
  const showMeasureLabels =
    useBeatsGrid && approxPxPerBeat * beatsPerMeasureRef >= 28;
  const measureLabelStride = useMemo(() => {
    if (!showMeasureLabels) return 1;
    const measurePx = approxPxPerBeat * beatsPerMeasureRef;
    if (measurePx >= 80) return 1;
    if (measurePx >= 40) return 2;
    if (measurePx >= 28) return 4;
    return 8;
  }, [showMeasureLabels, approxPxPerBeat, beatsPerMeasureRef]);
  const isOffBeatVisible = () => showOffBeats;
  const isMeasureLabelVisible = (b) => {
    if (!b.downbeat || b.measure == null) return false;
    if (!showMeasureLabels) return false;
    return (b.measure - 1) % measureLabelStride === 0;
  };

  // Snap-to-beat for drag/drop. Only meaningful in beats mode; held in
  // local state so it persists across drag operations within a session.
  const [snapToBeat, setSnapToBeat] = useState(false);

  // Toolbar toggle: when on, each item's label includes the zone:cue
  // badge (e.g. "RX142:1"). Defaults off so the timeline reads cleaner;
  // operators flip it on when they need the routing at a glance.
  const [showZoneCue, setShowZoneCue] = useState(false);

  // Quantise an absolute timeline time (seconds) to the nearest beat in
  // whichever track contains that time. Returns the input unchanged
  // when the grid isn't on or no track at that position has BPM set.
  const snapTimeToBeat = (sec) => {
    if (!useBeatsGrid || !snapToBeat) return sec;
    return snapShowTimeToBeat(audioTracks, sec);
  };
  return (
    <div className="w-full">
      {/* Zoom controls -- compact, consistent with the rest of the chrome. */}
      <div className="flex items-center justify-between gap-3 px-3 h-9 bg-surface-1 border-b border-border-subtle">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleZoomOut}
            title="Zoom out"
            className="h-7 w-7 inline-flex items-center justify-center rounded-sm text-fg-secondary hover:text-fg-primary hover:bg-surface-3"
          >
            <FiZoomOut aria-hidden />
          </button>
          <span className="eyebrow w-12 text-center num">
            {zoom.toFixed(1)}×
          </span>
          <button
            type="button"
            onClick={handleZoomIn}
            title="Zoom in"
            className="h-7 w-7 inline-flex items-center justify-center rounded-sm text-fg-secondary hover:text-fg-primary hover:bg-surface-3"
          >
            <FiZoomIn aria-hidden />
          </button>
          {/* Grid mode toggle: only relevant once BPM is known. We still
              render it when not available so the affordance is visible,
              just disabled with a tooltip explaining why. */}
          <span className="ml-2 inline-flex items-center gap-1.5">
            <span className="eyebrow">Grid</span>
            <select
              value={gridMode}
              onChange={(e) => setGridMode(e.target.value)}
              disabled={!hasBeats}
              title={
                hasBeats
                  ? "Switch the grid lines between seconds and song beats"
                  : "Detect a BPM on the audio to enable beat gridlines"
              }
              className={cn(
                "h-7 rounded-sm bg-surface-2 border border-border-subtle text-xs text-fg-primary",
                "px-1.5 pr-5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              <option value="seconds">Seconds</option>
              <option value="beats" disabled={!hasBeats}>
                Beats
              </option>
            </select>
          </span>
          {/* Snap-to-beat toggle. Only meaningful in beats mode and only
              shown to non-readonly users. Hold Alt during a drop to
              bypass the snap for fine adjustments. */}
          {useBeatsGrid && !isReadOnly && (
            <label
              className="ml-1 inline-flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer select-none"
              title="When on, dragged items snap their start time to the nearest beat. Hold Alt while dropping to bypass."
            >
              <input
                type="checkbox"
                checked={snapToBeat}
                onChange={(e) => setSnapToBeat(e.target.checked)}
              />
              Snap to beat
            </label>
          )}
          <label
            className="ml-1 inline-flex items-center gap-1.5 text-xs text-fg-secondary cursor-pointer select-none"
            title="Show the zone:cue badge (e.g. RX142:1) on each timeline item."
          >
            <input
              type="checkbox"
              checked={showZoneCue}
              onChange={(e) => setShowZoneCue(e.target.checked)}
            />
            Show zone:cue
          </label>
        </div>
        {!isReadOnly && (
          <div
            onDragEnter={(e) => e.preventDefault()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleRemoveEl}
            className="flex items-center gap-2 text-xs text-fg-muted hover:text-danger hover:bg-danger/10 px-2 h-7 rounded-sm border border-dashed border-border-subtle"
          >
            <FaTrash aria-hidden />
            <span>Drag items here to remove</span>
          </div>
        )}
      </div>

      {/* Ruler -- thin, single-line. Switches between seconds and beats. */}
      <div
        ref={ticksRef}
        className="relative w-full h-7 overflow-hidden bg-surface-inset border-b border-border-subtle"
      >
        <div className="relative h-full" style={{ width: `${100 * zoom}%` }}>
          {!useBeatsGrid && Array.from({ length: tickCount }, (_, i) => {
            const t = i * tickInterval;
            const isMajor = (t % tickConfig.major) === 0;
            return (
              <div
                key={i}
                className="absolute top-0 bottom-0"
                style={{ left: `${(t / maxTime) * 100}%` }}
              >
                <div
                  className={cn(
                    "w-px h-full",
                    isMajor ? "bg-border" : "bg-border-subtle/60"
                  )}
                />
                {isMajor ? (
                  <span className="absolute top-1 left-1 text-[10px] text-fg-muted num font-mono whitespace-nowrap">
                    {formatTime(t)}
                  </span>
                ) : null}
              </div>
            );
          })}

          {/* Beat grid on the ruler. Strong cap on each downbeat with a
              measure number; lighter half-height ticks on intermediate
              beats. The first beat of each track (measure === 1) gets a
              brighter cap to mark the song boundary. Density culling is
              per-track so a fast song's beats can't suppress a slow
              song's beats. */}
          {useBeatsGrid && beatGrid.map((b) => {
            if (!b.downbeat && !isOffBeatVisible(b.trackIndex)) return null;
            const left = `${(b.t / maxTime) * 100}%`;
            const labelVisible = isMeasureLabelVisible(b);
            const isTrackStart = b.downbeat && b.measure === 1;
            return (
              <div
                key={`r-beat-${b.trackIndex}-${b.n}`}
                className="absolute top-0 pointer-events-none"
                style={{ left, height: "100%" }}
              >
                <div
                  className="absolute top-0"
                  style={{
                    width: isTrackStart ? "2px" : "1px",
                    height: b.downbeat ? "100%" : "40%",
                    background: b.downbeat
                      ? "rgb(var(--accent) / 0.85)"
                      : "rgb(var(--accent) / 0.30)",
                  }}
                />
                {labelVisible && (
                  <span
                    className="absolute top-1 left-1 text-[10px] font-mono num leading-none whitespace-nowrap"
                    style={{ color: "rgb(var(--accent))" }}
                  >
                    {b.measure}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Timeline body -- low-contrast grid; cursor is a thin accent line. */}
      <div
        ref={timelineRef}
        className={cn(
          "relative w-full h-64 overflow-x-scroll bg-surface-inset",
          props.copyMode && "ring-1 ring-inset ring-accent"
        )}
        style={{
          cursor:
            props.copyMode === "select-position"
              ? "crosshair"
              : props.copyMode === "select-source"
              ? "copy"
              : undefined,
        }}
        onWheel={handleWheel}
        onDragOver={isReadOnly ? () => {} : handleDragOver}
        onDrop={isReadOnly ? () => {} : handleDrop}
        onScroll={handleScroll}
        onDoubleClick={isReadOnly ? () => {} : handleDoubleClick}
        onClick={handleTimelineClick}
      >
        <div className="relative h-full" style={{ width: `${100 * zoom}%` }}>
          {/* Major/minor seconds grid behind items. Drawn as 1-px columns
              so they don't overlap into a "wall" the way border-left did. */}
          {!useBeatsGrid && Array.from({ length: tickCount }, (_, i) => {
            const t = i * tickInterval;
            const isMajor = (t % tickConfig.major) === 0;
            // At very low zoom we'd otherwise get hundreds of minor ticks
            // packed into 1px each which produces moire. Skip non-majors
            // when zoom is < 1.5.
            if (!isMajor && zoom < 1.5) return null;
            return (
              <div
                key={i}
                className={cn(
                  "absolute top-0 bottom-0 w-px pointer-events-none",
                  isMajor ? "bg-border-subtle/80" : "bg-border-subtle/30"
                )}
                style={{ left: `${(t / maxTime) * 100}%` }}
              />
            );
          })}

          {/* Beat grid in the body. Strong on the downbeat, light on
              the intermediate beats. The first beat of each track gets
              a thicker bar so song transitions are visible at a glance.
              Sits above the surface but below items (zIndex 0) so cue
              bars stay readable. Density culling is per-track. */}
          {useBeatsGrid && beatGrid.map((b) => {
            if (!b.downbeat && !isOffBeatVisible(b.trackIndex)) return null;
            const isTrackStart = b.downbeat && b.measure === 1;
            return (
              <div
                key={`b-beat-${b.trackIndex}-${b.n}`}
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{
                  left: `${(b.t / maxTime) * 100}%`,
                  width: isTrackStart ? "2px" : "1px",
                  background: b.downbeat
                    ? isTrackStart
                      ? "rgb(var(--accent) / 0.85)"
                      : "rgb(var(--accent) / 0.55)"
                    : "rgb(var(--accent) / 0.18)",
                  zIndex: 0,
                }}
              />
            );
          })}

          {props.timeCursor ? (
            <div
              className="absolute top-0 h-full pointer-events-none"
              style={{
                left: `${(props.timeCursor / maxTime) * 100}%`,
                width: "0px",
                borderLeft: "1px solid rgb(var(--accent))",
                boxShadow: "0 0 6px rgb(var(--accent) / 0.5)",
                zIndex: 5,
              }}
            >
              <span
                className="absolute top-0 -translate-x-1/2 w-2 h-2 rotate-45 bg-accent"
                aria-hidden
              />
            </div>
          ) : null}

          {/* Items */}
          {stackedItems.flat().map((item) => {
            const start = calculatePosition(item.startTime);
            const width = (item.duration / maxTime) * 100;
            const top = stackedItems.findIndex((stack) =>
              stack.includes(item)
            );
            // If the bar is too narrow to hold text, float the label just
            // outside the bar so short shell/rack cues remain identifiable.
            const isShortDurationItem = item.duration * zoom < 80;

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
                {/* Main bar -- calmer; lower-contrast colour fill, label
                    only when the bar is wide enough to fit it. */}
                <div
                  className={cn(
                    "absolute h-6 cursor-move overflow-hidden rounded-sm transition-shadow",
                    isSelected
                      ? "ring-2 ring-accent ring-offset-1 ring-offset-surface-inset"
                      : "shadow-e2"
                  )}
                  style={{
                    left: `${start}%`,
                    width: `${width}%`,
                    top: `${top * 40 + 20}px`,
                    backgroundColor: (INV_COLOR_CODE[item.type] || "#5a6470") + "B3",
                    borderLeft: `2px solid ${INV_COLOR_CODE[item.type] || "#5a6470"}`,
                  }}
                  draggable
                  onDragStart={(e) => (isReadOnly ? (() => {}) : handleDragStart(e, item.id))}
                  onClick={(e) => handleItemClick(e, item)}
                  title={`${item.name} @ ${props.receiverLabels?.[item.zone] || item.zone}:${item.target}`}
                />

                {/* Label layer sits above shot overlays so cue metadata stays readable. */}
                <div
                  className={cn(
                    "absolute pointer-events-none flex items-center gap-1.5 text-xs",
                    isShortDurationItem
                      ? "px-2 rounded-sm bg-surface-base/90 border border-border-subtle shadow-e2"
                      : "px-2 overflow-hidden"
                  )}
                  style={{
                    left: isShortDurationItem
                      ? `calc(${start + width}% + 4px)`
                      : `${start}%`,
                    width: isShortDurationItem ? "max-content" : `${width}%`,
                    maxWidth: isShortDurationItem ? "220px" : undefined,
                    top: `${top * 40 + 20}px`,
                    height: "24px",
                    zIndex: 4,
                  }}
                >
                  <span
                    className="truncate text-white"
                    style={{ textShadow: "0 1px 1px rgb(0 0 0 / 0.65)" }}
                  >
                    {item.name}
                  </span>
                  {showZoneCue && (
                    <span className="shrink-0 rounded-xs bg-white/80 border border-white/40 px-1 py-px text-[10px] font-semibold leading-none text-black shadow-e2">
                      {props.receiverLabels?.[item.zone] || item.zone}:{item.target}
                    </span>
                  )}
                  {Number.isFinite(item.multiple) && item.multiple > 1 && (
                    <span className="ml-auto shrink-0 px-1 text-[10px] font-mono leading-tight bg-surface-base/85 text-fg-primary rounded-sm">
                      ×{item.multiple}
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
