import React, { useState, useEffect, useMemo, useRef } from "react";
import axios from "axios";
import { MdRefresh, MdAdd, MdDelete, MdSave } from "react-icons/md";
import useAppStore from '@/store/useAppStore';
import { extractYouTubeVideoId } from "@/util/youtube";

// ---------------------------------------------------------------------------
// YouTube IFrame Player API loader.
//
// The IFrame Player API is loaded once per page lifetime. It's a third-party
// script that exposes `window.YT.Player` and calls `window.onYouTubeIframeAPIReady`
// when ready. We wrap that handshake in a singleton promise so multiple modal
// opens share the same load and we never inject the <script> tag twice.
// ---------------------------------------------------------------------------
let ytApiPromise = null;
function loadYouTubeIframeApi() {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.YT && typeof window.YT.Player === "function") {
    return Promise.resolve(window.YT);
  }
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    // Preserve any pre-existing handler -- another consumer could in
    // theory be using the same API. The YouTube API calls this exactly
    // once, so we chain rather than clobber.
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      if (typeof prev === "function") {
        try { prev(); } catch (_) { /* ignore prior-handler errors */ }
      }
      resolve(window.YT);
    };
    if (!document.querySelector('script[data-yt-iframe-api]')) {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      s.dataset.ytIframeApi = "1";
      document.head.appendChild(s);
    }
  });
  return ytApiPromise;
}

export default function ShotProfileModal({ isVisible, item, firingProfile, onClose, onReprocessComplete }) {
  const { updateInventoryItem } = useAppStore();
  const [isReprocessing, setIsReprocessing] = useState(false);
  const [reprocessStatus, setReprocessStatus] = useState(null);
  const [detectionMethod, setDetectionMethod] = useState('max_amplitude');
  const [thresholdRatio, setThresholdRatio] = useState(0.70);
  const [thresholdRatioInput, setThresholdRatioInput] = useState('0.70');
  const [floorPercent, setFloorPercent] = useState(10.0);
  const [floorPercentInput, setFloorPercentInput] = useState('10.0');
  const [mergeThresholdMs, setMergeThresholdMs] = useState(500);
  const [mergeThresholdMsInput, setMergeThresholdMsInput] = useState('500');
  const [overrideDuration, setOverrideDuration] = useState(false);
  const [showReprocessOptions, setShowReprocessOptions] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  // Editor state
  const [editableShots, setEditableShots] = useState([]);
  const [selectedShotIndex, setSelectedShotIndex] = useState(null);
  const [offsetSeconds, setOffsetSeconds] = useState(0);
  const [offsetSecondsInput, setOffsetSecondsInput] = useState('0');
  const [durationInput, setDurationInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  // Per-cell draft buffer for the start/end ms text inputs. Keyed by
  // `${index}-${field}`. Lets the operator freely type/clear/retype
  // values without the controlled-input + handleUpdateShot clamp firing
  // on every keystroke (e.g. trying to lower an `end` from 5000 to 200
  // when `start` is 1000 -- without this, the mid-keystroke "2" gets
  // clamped right back up to the min and the typing flow collapses).
  // Drafts are committed on blur / Enter, dropped on Escape.
  const [shotDrafts, setShotDrafts] = useState({});

  // ---- YouTube reference-video state ---------------------------------------
  //
  // When the inventory item has a YouTube link, we embed the IFrame Player
  // above the timeline so the operator can scrub against the source video
  // and verify shot timings are aligned. The playhead is driven directly
  // off `player.getCurrentTime()` on every animation frame -- we never run
  // our own clock, so buffering/seek/state-changes inside the iframe stay
  // automatically in sync with our visible playhead.
  //
  // The playhead element is updated via a ref (direct DOM writes) rather
  // than React state to avoid 60fps re-renders of the editor table.
  const ytWrapperRef = useRef(null);   // host <div> React owns; YT iframe lives inside
  const ytPlayerRef = useRef(null);    // YT.Player instance (kept in a ref so the seek helper can read it)
  const ytRafRef = useRef(null);       // active requestAnimationFrame handle
  const playheadElRef = useRef(null);  // playhead DOM node we slide via .style.left
  const totalDurationRef = useRef(0);  // mirrors totalDuration so the rAF loop sees fresh values
  const ytStartSecRef = useRef(0);     // mirrors ytStartSec so the rAF loop sees fresh starts WITHOUT re-mounting
  const playheadOffsetMsRef = useRef(0); // ephemeral preview offset for the playhead (ms; can be negative)
  const playheadReadoutRef = useRef(null); // <span> whose textContent we rewrite each rAF tick (no react re-render)
  const [ytError, setYtError] = useState(null); // 101/150 etc. -> embedding disabled by uploader
  const [ytPlayerReady, setYtPlayerReady] = useState(false);
  const [isUpdatingStart, setIsUpdatingStart] = useState(false);

  // Temporary "shift the playhead by N seconds" calibration knob. Modifies
  // ONLY the rendered playhead position -- never the saved shot timestamps
  // or `youtube_link_start_sec`. Use it to dial in the visual alignment
  // delta first, then bake the result into "Offset All Shots" / "Set start
  // to cursor" once you know the right magnitude. Resets to 0 on modal
  // close (it lives in component state).
  const [playheadOffsetSec, setPlayheadOffsetSec] = useState(0);
  const [playheadOffsetInput, setPlayheadOffsetInput] = useState("0");

  const videoId = useMemo(
    () => extractYouTubeVideoId(item?.youtube_link || ""),
    [item?.youtube_link]
  );
  const ytStartSec = useMemo(() => {
    const v = parseFloat(item?.youtube_link_start_sec);
    return Number.isFinite(v) ? v : 0;
  }, [item?.youtube_link_start_sec]);
  // Mirror the (possibly updated) start time into a ref so the long-lived
  // rAF loop can read the latest value without forcing the player to
  // remount when the operator recalibrates via "Set start to cursor".
  ytStartSecRef.current = ytStartSec;
  // Same trick for the preview playhead offset: it changes as the operator
  // edits the input, and we want the playhead to update live without
  // restarting the iframe or rebinding the rAF callback.
  playheadOffsetMsRef.current = (Number.isFinite(playheadOffsetSec) ? playheadOffsetSec : 0) * 1000;
  // Derived boolean (primitive) so the player effect only re-runs on real
  // mount/unmount transitions -- a `firingProfile` reference change from a
  // refresh won't churn the iframe.
  const hasProfile = !!firingProfile?.shot_timestamps;

  const seekVideoToShotMs = (startMs) => {
    const player = ytPlayerRef.current;
    if (!player || typeof player.seekTo !== "function") return;
    try {
      player.seekTo(ytStartSec + (startMs || 0) / 1000, true);
    } catch (_) { /* player not yet ready, ignore */ }
  };

  // Unified click handler for shot blocks (timeline) and shot rows
  // (editor table). Always selects + seeks so the operator can scrub the
  // video to any shot. To EDIT a shot's color without disturbing the
  // video cursor, click the color square cell specifically -- that path
  // stops propagation and only selects (see the color <td> below).
  const handleShotClick = (index, startMs) => {
    setSelectedShotIndex(index);
    seekVideoToShotMs(startMs);
  };

  // "Set start time to current video cursor". Reads the live playback
  // position and persists it as the item's `youtube_link_start_sec`.
  // This effectively aligns shot 0 ms with whatever frame the operator
  // has the video paused/playing on. Pre-existing shot offsets are NOT
  // shifted -- the operator can use the "Offset All Shots" control to
  // re-center the rest of the sequence if needed.
  const handleSetStartToCursor = async () => {
    const player = ytPlayerRef.current;
    if (!player || typeof player.getCurrentTime !== "function") return;
    let cursorSec = 0;
    try { cursorSec = player.getCurrentTime(); } catch (_) { return; }
    if (!Number.isFinite(cursorSec) || cursorSec < 0) return;
    if (!item?.id) return;

    setIsUpdatingStart(true);
    try {
      // The inventory PATCH endpoint is a full-record update, so we spread
      // the existing item to keep name/type/etc. intact.
      await updateInventoryItem(item.id, {
        ...item,
        youtube_link_start_sec: cursorSec,
      });
      // No need to seek -- the player is already at `cursorSec`, and once
      // ytStartSec updates from the refreshed item the playhead naturally
      // snaps to 0 ms (= start of shot sequence).
    } catch (err) {
      console.error("Failed to update start time:", err);
      alert("Failed to update start time. Please try again.");
    } finally {
      setIsUpdatingStart(false);
    }
  };

  // Normalize shots to [start, end, color] format
  const normalizeShots = (shots) => {
    if (!shots) return [];
    return shots.map(shot => {
      if (Array.isArray(shot)) {
        if (shot.length === 2) {
          return [shot[0], shot[1], null];
        } else if (shot.length >= 3) {
          return [shot[0], shot[1], shot[2] || null];
        }
      }
      return shot;
    });
  };

  // Initialize editor state when profile changes
  useEffect(() => {
    if (firingProfile && firingProfile.shot_timestamps) {
      const normalized = normalizeShots(firingProfile.shot_timestamps);
      setEditableShots(normalized);
      setHasChanges(false);
      // A freshly hydrated profile invalidates any pending draft edits.
      setShotDrafts({});

      // Initialize duration input
      const totalDuration = normalized.length > 0 
        ? Math.max(...normalized.map(shot => shot[1])) 
        : 0;
      setDurationInput((totalDuration / 1000).toFixed(2));
    }
  }, [firingProfile]);

  // Initialize duration from item
  useEffect(() => {
    if (item?.duration) {
      setDurationInput(item.duration.toString());
    }
  }, [item]);

  // Keep the rAF loop's view of totalDuration current without forcing the
  // playhead callback into the render closure (which would re-create the
  // effect / loop on every shot edit).
  totalDurationRef.current = useMemo(() => {
    if (!editableShots || editableShots.length === 0) return 0;
    return Math.max(...editableShots.map((shot) => shot[1]));
  }, [editableShots]);

  // YouTube IFrame Player lifecycle. Mounts when the modal is open, the
  // item has a usable YouTube link, and there's a profile to validate
  // against. Tears the player down (and detaches the iframe) on close.
  //
  // NOTE: `ytStartSec` is INTENTIONALLY not in the dep array. The start
  // time is captured at mount for `playerVars.start` / initial seek, but
  // subsequent changes (e.g. operator clicks "Set start to cursor") flow
  // through `ytStartSecRef.current` into the rAF loop without remounting
  // the iframe -- which would otherwise produce an ugly reload flicker
  // on every recalibration.
  useEffect(() => {
    const wrapper = ytWrapperRef.current;
    if (!isVisible || !videoId || !hasProfile || !wrapper) return undefined;

    let cancelled = false;
    setYtError(null);
    setYtPlayerReady(false);
    // Snapshot the start at mount time. Live updates flow via the ref.
    const initialStartSec = ytStartSecRef.current;

    // YT.Player REPLACES the element you pass it with its iframe. To keep
    // React's reconciliation unconfused we have React own a stable
    // `wrapper` div, and inside the effect we create a transient child
    // for YT to consume. On cleanup we destroy the player and wipe any
    // residual nodes out of the wrapper.
    const playerHost = document.createElement("div");
    playerHost.style.width = "100%";
    playerHost.style.height = "100%";
    wrapper.appendChild(playerHost);

    loadYouTubeIframeApi().then((YT) => {
      if (cancelled || !YT) return;
      try {
        ytPlayerRef.current = new YT.Player(playerHost, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: {
            start: Math.floor(initialStartSec),
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
          },
          events: {
            onReady: (e) => {
              // `playerVars.start` only takes integer seconds; this nudge
              // lands us on the exact (possibly fractional) start frame
              // so the playhead lines up with shot 0 from the get-go.
              try { e.target.seekTo(initialStartSec, true); } catch (_) {}
              // YT applies width/height as pixel attributes on the iframe.
              // Force it to fill our 16:9 wrapper so the player is responsive.
              try {
                const iframe = e.target.getIframe?.();
                if (iframe) {
                  iframe.style.width = "100%";
                  iframe.style.height = "100%";
                  iframe.removeAttribute("width");
                  iframe.removeAttribute("height");
                }
              } catch (_) {}
              if (!cancelled) setYtPlayerReady(true);
            },
            onError: (e) => {
              // Common codes: 101 / 150 = embedding disabled by uploader,
              // 100 = video not found, 2 = malformed param. All we can do
              // is surface a hint to the operator.
              setYtError(e?.data ?? "unknown");
            },
          },
        });
      } catch (err) {
        console.error("YT.Player init failed:", err);
        setYtError("init_failed");
      }
    });

    const tick = () => {
      const player = ytPlayerRef.current;
      const el = playheadElRef.current;
      const readout = playheadReadoutRef.current;
      const total = totalDurationRef.current;
      const startSec = ytStartSecRef.current;
      const offsetMs = playheadOffsetMsRef.current;
      if (
        player &&
        total > 0 &&
        typeof player.getCurrentTime === "function"
      ) {
        try {
          const sec = player.getCurrentTime();
          // `offsetMs` is a non-destructive preview shift -- it ONLY moves
          // where the playhead is drawn relative to the video cursor, it
          // does NOT touch `youtube_link_start_sec` or shot timestamps.
          const seqMs = (sec - startSec) * 1000 + offsetMs;
          if (el) {
            if (seqMs >= 0 && seqMs <= total) {
              el.style.display = "block";
              el.style.left = `${(seqMs / total) * 100}%`;
            } else {
              // Before the shot sequence starts or after it ends: hide
              // the marker rather than pinning it at the edge, since
              // "off the map" is the honest state.
              el.style.display = "none";
            }
          }
          // Live ms readout. Direct DOM write avoids triggering a React
          // re-render at 60fps; the span content is independent of any
          // reconciliation so it's safe.
          if (readout) {
            readout.textContent = `${Math.round(seqMs)} ms`;
          }
        } catch (_) { /* getCurrentTime can throw mid-teardown; ignore */ }
      }
      ytRafRef.current = requestAnimationFrame(tick);
    };
    ytRafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (ytRafRef.current) cancelAnimationFrame(ytRafRef.current);
      ytRafRef.current = null;
      const p = ytPlayerRef.current;
      if (p && typeof p.destroy === "function") {
        try { p.destroy(); } catch (_) {}
      }
      ytPlayerRef.current = null;
      setYtPlayerReady(false);
      while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
    };
  }, [isVisible, videoId, hasProfile]);

  if (!isVisible || !item) return null;

  const hasYouTubeLink = item.youtube_link && item.youtube_link.trim() !== '' && item.youtube_link_start_sec !== null;

  const handleReprocess = async () => {
    if (!item?.id || !hasYouTubeLink) return;

    setIsReprocessing(true);
    setReprocessStatus(null);

    try {
      const response = await axios.post(`/api/inventory/${item.id}/reprocess-profile`, {
        detectionMethod: detectionMethod,
        thresholdRatio: detectionMethod === 'max_amplitude' ? thresholdRatio : undefined,
        floorPercent: detectionMethod === 'noise_floor' ? floorPercent : undefined,
        mergeThresholdMs: mergeThresholdMs,
        overrideDuration: overrideDuration
      });
      
      setReprocessStatus({
        success: true,
        message: response.data.message || 'Reprocessing started. This may take a few minutes. Please refresh to see the updated profile.'
      });

      if (onReprocessComplete) {
        setTimeout(() => {
          onReprocessComplete();
        }, 2000);
      }
    } catch (error) {
      console.error('Error reprocessing profile:', error);
      setReprocessStatus({
        success: false,
        message: error.response?.data?.error || 'Failed to start reprocessing. Please try again.'
      });
    } finally {
      setIsReprocessing(false);
    }
  };

  const handleRefresh = async () => {
    if (!item?.id || !onReprocessComplete) return;
    setIsRefreshing(true);
    try {
      await onReprocessComplete();
    } catch (error) {
      console.error('Error refreshing profile:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleOffsetShots = () => {
    const offsetSec = parseFloat(offsetSecondsInput);
    if (isNaN(offsetSec)) return;
    const offsetMs = offsetSec * 1000;

    const updatedShots = editableShots.map(shot => [
      Math.max(0, shot[0] + offsetMs),
      Math.max(0, shot[1] + offsetMs),
      shot[2]
    ]);
    
    setEditableShots(updatedShots);
    setHasChanges(true);
    setOffsetSecondsInput('0');
    // Any in-flight cell drafts now refer to stale values -- drop them so
    // the inputs re-display the freshly offset committed values.
    setShotDrafts({});
    // Sync the preview playhead offset to the applied shot offset so the
    // playhead visually shifts in lockstep with the shots (the operator
    // can then iterate further or hit Reset on the playhead offset to
    // see the un-shifted alignment).
    setPlayheadOffsetSec(offsetSec);
    setPlayheadOffsetInput(String(offsetSec));
  };

  const handleAddShot = () => {
    const totalDuration = editableShots.length > 0 
      ? Math.max(...editableShots.map(shot => shot[1])) 
      : 0;
    
    const newShot = [totalDuration, totalDuration + 1000, null]; // 1 second default
    setEditableShots([...editableShots, newShot]);
    setHasChanges(true);
    setSelectedShotIndex(editableShots.length);
  };

  const handleRemoveShot = (index) => {
    const updated = editableShots.filter((_, i) => i !== index);
    setEditableShots(updated);
    setHasChanges(true);
    if (selectedShotIndex === index) {
      setSelectedShotIndex(null);
    } else if (selectedShotIndex > index) {
      setSelectedShotIndex(selectedShotIndex - 1);
    }
    // Removing a row shifts every higher-index row down by one. Rather
    // than try to remap, just drop all drafts -- they're transient.
    setShotDrafts({});
  };

  const handleUpdateShot = (index, field, value) => {
    const updated = [...editableShots];
    if (field === 'start') {
      updated[index][0] = Math.max(0, parseInt(value) || 0);
    } else if (field === 'end') {
      updated[index][1] = Math.max(updated[index][0], parseInt(value) || updated[index][0]);
    }
    setEditableShots(updated);
    setHasChanges(true);
  };

  const handleShotColorChange = (index, color) => {
    const updated = [...editableShots];
    updated[index][2] = color || null;
    setEditableShots(updated);
    setHasChanges(true);
  };

  const handleSave = async () => {
    if (!item?.id) return;

    setIsSaving(true);
    try {
      // Save firing profile
      await axios.patch(`/api/inventory/${item.id}/firing-profile`, {
        shot_timestamps: editableShots
      });

      // Save duration if changed. The inventory PATCH endpoint is a
      // full-record update (it requires name/type and overwrites every
      // column from the body), so we have to send the entire existing
      // item with the new duration overlaid, not just `{ duration }`.
      const durationValue = parseFloat(durationInput);
      if (!isNaN(durationValue) && durationValue !== item.duration) {
        await updateInventoryItem(item.id, {
          ...item,
          duration: durationValue,
        });
      }

      setHasChanges(false);
      
      // Refresh profile
      if (onReprocessComplete) {
        await onReprocessComplete();
      }
    } catch (error) {
      console.error('Error saving profile:', error);
      alert('Failed to save profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  // If no profile exists, show generation UI
  if (!firingProfile || !firingProfile.shot_timestamps) {
    return (
      <div 
        className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
        onClick={onClose}
      >
        <div 
          className="bg-gray-800 rounded-lg p-6 max-w-2xl w-full mx-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold text-white">
              Shot Profile: {item?.name || 'Unknown'}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white text-3xl leading-none"
            >
              &times;
            </button>
          </div>

          <div className="mb-4 text-gray-300">
            {hasYouTubeLink ? (
              <>
                <p className="mb-4">No firing profile found for this item.</p>
                <p className="mb-4 text-sm text-gray-400">
                  This item has a YouTube link configured. You can generate a firing profile by processing the video.
                </p>
                
                <div className="flex justify-end">
                  <div className="flex flex-col items-end gap-2">
                    <button
                      onClick={() => setShowReprocessOptions(!showReprocessOptions)}
                      className="text-blue-400 hover:text-blue-300 text-sm underline"
                    >
                      {showReprocessOptions ? 'Hide' : 'Show'} Advanced Options
                    </button>
                    
                    {showReprocessOptions && (
                      <div className="bg-gray-700 rounded p-3 w-80">
                        <div className="mb-3">
                          <label className="block text-gray-200 text-sm font-bold mb-2">
                            Detection Method
                          </label>
                          <select
                            value={detectionMethod}
                            onChange={(e) => setDetectionMethod(e.target.value)}
                            className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                          >
                            <option value="max_amplitude">Max Amplitude</option>
                            <option value="noise_floor">Noise Floor</option>
                          </select>
                        </div>
                        <div className="flex gap-4">
                          {detectionMethod === 'max_amplitude' ? (
                            <div className="flex-1">
                              <label className="block text-gray-200 text-sm font-bold mb-2">
                                Threshold Ratio (0.0 - 1.0)
                              </label>
                              <input
                                type="number"
                                min="0"
                                max="1"
                                step="0.01"
                                value={thresholdRatioInput}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setThresholdRatioInput(val);
                                  const num = parseFloat(val);
                                  if (!isNaN(num) && num >= 0 && num <= 1) {
                                    setThresholdRatio(num);
                                  }
                                }}
                                onBlur={(e) => {
                                  const val = e.target.value;
                                  const num = parseFloat(val);
                                  if (val === '' || isNaN(num) || num < 0 || num > 1) {
                                    setThresholdRatioInput(thresholdRatio.toString());
                                  }
                                }}
                                className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                              />
                              <p className="text-gray-400 text-xs italic mt-1">
                                Lower = more sensitive
                              </p>
                            </div>
                          ) : (
                            <div className="flex-1">
                              <label className="block text-gray-200 text-sm font-bold mb-2">
                                Floor Percent (%)
                              </label>
                              <input
                                type="number"
                                min="0"
                                step="0.1"
                                value={floorPercentInput}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setFloorPercentInput(val);
                                  const num = parseFloat(val);
                                  if (!isNaN(num) && num >= 0) {
                                    setFloorPercent(num);
                                  }
                                }}
                                onBlur={(e) => {
                                  const val = e.target.value;
                                  const num = parseFloat(val);
                                  if (val === '' || isNaN(num) || num < 0) {
                                    setFloorPercentInput(floorPercent.toString());
                                  }
                                }}
                                className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                              />
                              <p className="text-gray-400 text-xs italic mt-1">
                                % above noise floor
                              </p>
                            </div>
                          )}
                          <div className="flex-1">
                            <label className="block text-gray-200 text-sm font-bold mb-2">
                              Merge (ms)
                            </label>
                            <input
                              type="number"
                              min="0"
                              step="50"
                              value={mergeThresholdMsInput}
                              onChange={(e) => {
                                const val = e.target.value;
                                setMergeThresholdMsInput(val);
                                const num = parseInt(val);
                                if (!isNaN(num) && num >= 0) {
                                  setMergeThresholdMs(num);
                                }
                              }}
                              onBlur={(e) => {
                                const val = e.target.value;
                                const num = parseInt(val);
                                if (val === '' || isNaN(num) || num < 0) {
                                  setMergeThresholdMsInput(mergeThresholdMs.toString());
                                }
                              }}
                              className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                            />
                            <p className="text-gray-400 text-xs italic mt-1">
                              Gap to merge shots
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    <button
                      onClick={handleReprocess}
                      disabled={isReprocessing}
                      className="bg-blue-900 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline"
                    >
                      {isReprocessing ? 'Processing...' : 'Generate Firing Profile'}
                    </button>
                  </div>
                </div>
                
                {reprocessStatus && (
                  <p className={`mt-2 text-sm ${reprocessStatus.success ? 'text-green-400' : 'text-red-400'}`}>
                    {reprocessStatus.message}
                  </p>
                )}
              </>
            ) : (
              <p>No firing profile available. This item needs a YouTube link and start time to generate a profile.</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const totalDuration = editableShots.length > 0 
    ? Math.max(...editableShots.map(shot => shot[1])) 
    : 0;

  return (
    <div 
      className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-50 overflow-y-auto py-8"
      onClick={onClose}
    >
      <div 
        className="bg-gray-800 rounded-lg p-6 max-w-6xl w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold text-white">
            Shot Profile Editor: {item?.name || 'Unknown'}
          </h2>
          <div className="flex items-center gap-2">
            {hasChanges && (
              <span className="text-yellow-400 text-sm">Unsaved changes</span>
            )}
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed p-1"
              title="Refresh Profile"
            >
              <MdRefresh className={`text-2xl ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white text-3xl leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Editor Controls */}
        <div className="mb-4 bg-gray-700 rounded p-4 space-y-3">
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <label className="block text-gray-200 text-sm font-bold mb-2">
                Duration (seconds)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={durationInput}
                onChange={(e) => setDurationInput(e.target.value)}
                onBlur={(e) => {
                  const val = parseFloat(e.target.value);
                  if (isNaN(val) || val < 0) {
                    setDurationInput(item.duration?.toString() || '0');
                  }
                }}
                className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
              />
            </div>
            
            <div className="flex-1">
              <label className="block text-gray-200 text-sm font-bold mb-2">
                Offset All Shots (seconds)
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  step="0.01"
                  value={offsetSecondsInput}
                  onChange={(e) => {
                    const val = e.target.value;
                    setOffsetSecondsInput(val);
                    const num = parseFloat(val);
                    if (!isNaN(num)) {
                      setOffsetSeconds(num);
                    }
                  }}
                  onBlur={(e) => {
                    const val = e.target.value;
                    const num = parseFloat(val);
                    if (val === '' || isNaN(num)) {
                      setOffsetSecondsInput('0');
                    }
                  }}
                  className="shadow appearance-none border rounded flex-1 py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                  placeholder="±0.00"
                />
                <button
                  onClick={handleOffsetShots}
                  className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline"
                >
                  Apply
                </button>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleAddShot}
                className="bg-green-900 hover:bg-green-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline flex items-center gap-2"
              >
                <MdAdd /> Add Shot
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || !hasChanges}
                className="bg-blue-900 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline flex items-center gap-2"
              >
                <MdSave /> {isSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>

          {/* Color Picker for Selected Shot */}
          {selectedShotIndex !== null && editableShots[selectedShotIndex] && (
            <div className="flex items-center gap-4 pt-2 border-t border-gray-600">
              <label className="text-gray-200 text-sm font-bold">
                Shot {selectedShotIndex + 1} Color:
              </label>
              <input
                type="color"
                value={editableShots[selectedShotIndex][2] || '#3B82F6'}
                onChange={(e) => handleShotColorChange(selectedShotIndex, e.target.value)}
                className="h-10 w-20 cursor-pointer"
              />
              <button
                onClick={() => handleShotColorChange(selectedShotIndex, null)}
                className="text-gray-400 hover:text-white text-sm underline"
              >
                Clear Color
              </button>
            </div>
          )}
        </div>

        {/* YouTube reference video. Shown only when the item has a
            parseable link; the playhead in the timeline below tracks
            getCurrentTime() of this player so the operator can verify
            shot timestamps against the source footage. */}
        {hasYouTubeLink && videoId && (
          <div className="bg-gray-900 rounded p-4 mb-4">
            <div className="mx-auto" style={{ width: 480, maxWidth: '100%' }}>
              <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
                <div
                  ref={ytWrapperRef}
                  className="absolute inset-0 bg-black rounded overflow-hidden"
                />
              </div>
              {ytError ? (
                <p className="text-xs text-red-400 italic mt-2 text-center">
                  Couldn&apos;t load reference video
                  {ytError === 101 || ytError === 150
                    ? ' (embedding disabled by uploader).'
                    : '.'}
                </p>
              ) : (
                <p className="text-xs text-gray-500 italic mt-2 text-center">
                  Reference video. Press play to drive the playhead below;
                  click a shot to jump the video to that timestamp. Click
                  the color swatch on a row to edit color without seeking.
                </p>
              )}

              {/* Calibration controls. Two complementary tools:
                  1. "Set start to current cursor" -- persistent: writes
                     `youtube_link_start_sec` so shot 0 ms aligns with the
                     current video frame.
                  2. "Playhead offset" -- ephemeral preview: shifts only
                     where the playhead is rendered relative to the video.
                     Use to dial in the alignment delta before deciding
                     how to bake it in (via Set start + Offset All Shots).
              */}
              {!ytError && (
                <div className="mt-3 flex items-center justify-center gap-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleSetStartToCursor}
                      disabled={!ytPlayerReady || isUpdatingStart}
                      className="bg-purple-900 hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm font-bold py-1.5 px-3 rounded focus:outline-none focus:shadow-outline"
                      title="Save the current video cursor position as this item's shot-sequence start time"
                    >
                      {isUpdatingStart ? 'Saving…' : 'Set start to current cursor'}
                    </button>
                    <span className="text-xs text-gray-500">
                      Current start: {ytStartSec.toFixed(2)}s
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <label
                      className="text-xs text-gray-300"
                      title="Visually shift the playhead by N seconds against the video cursor. Preview-only -- does not modify saved data. Negative = playhead earlier than video; positive = later."
                    >
                      Playhead offset (sec):
                    </label>
                    <input
                      type="number"
                      step="0.05"
                      value={playheadOffsetInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPlayheadOffsetInput(val);
                        const num = parseFloat(val);
                        // Tolerate partial input ("-", "", "0.") -- only
                        // commit a finite numeric value to the live offset;
                        // anything else leaves the previous offset in place
                        // until the operator finishes typing.
                        if (Number.isFinite(num)) {
                          setPlayheadOffsetSec(num);
                        }
                      }}
                      onBlur={(e) => {
                        const val = e.target.value;
                        const num = parseFloat(val);
                        if (val === '' || !Number.isFinite(num)) {
                          setPlayheadOffsetSec(0);
                          setPlayheadOffsetInput('0');
                        } else {
                          // Normalise the display (e.g. "0." -> "0").
                          setPlayheadOffsetInput(String(num));
                        }
                      }}
                      className="w-20 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white text-sm"
                      placeholder="0.00"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setPlayheadOffsetSec(0);
                        setPlayheadOffsetInput('0');
                      }}
                      disabled={playheadOffsetSec === 0}
                      className="text-xs text-gray-400 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed underline"
                      title="Reset playhead offset to 0"
                    >
                      Reset
                    </button>
                  </div>

                  {/* Live ms readout of where the playhead currently sits
                      on the shot-sequence timeline (post-offset). Wrote
                      directly via ref in the rAF tick so it never causes
                      a React re-render. */}
                  <div className="flex items-center gap-1 text-xs text-gray-300">
                    <span>Playhead:</span>
                    <span
                      ref={playheadReadoutRef}
                      className="font-mono text-yellow-300 min-w-[5ch] text-right"
                    >
                      — ms
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Timeline Container */}
        <div className="bg-gray-900 rounded p-4 mb-4">
          <div className="relative" style={{ height: '60px', width: '100%', minHeight: '60px' }}>
            <div className="absolute inset-0 border border-gray-600 rounded"></div>
            
            {editableShots.map((shot, index) => {
              const [start, end, color] = shot;
              const left = totalDuration > 0 ? (start / totalDuration) * 100 : 0;
              const width = totalDuration > 0 ? ((end - start) / totalDuration) * 100 : 0;
              const bgColor = color || '#3B82F6';
              const isSelected = selectedShotIndex === index;
              
              return (
                <div
                  key={index}
                  onClick={() => handleShotClick(index, start)}
                  className={`absolute rounded cursor-pointer border-2 transition-all ${
                    isSelected ? 'ring-2 ring-yellow-400 ring-offset-2' : ''
                  }`}
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    height: '40px',
                    top: '10px',
                    minWidth: '2px',
                    backgroundColor: bgColor,
                    borderColor: isSelected ? '#FBBF24' : bgColor,
                  }}
                  title={`Shot ${index + 1}: ${(start / 1000).toFixed(2)}s - ${(end / 1000).toFixed(2)}s (${((end - start) / 1000).toFixed(2)}s)`}
                />
              );
            })}

            {/* Playhead. Slid by direct DOM writes inside the rAF loop so
                we don't trigger React re-renders at 60fps. Hidden until
                the player is ready and inside the shot-sequence window. */}
            <div
              ref={playheadElRef}
              className="absolute pointer-events-none"
              style={{
                top: 0,
                bottom: 0,
                width: 2,
                marginLeft: -1,
                backgroundColor: '#FBBF24',
                boxShadow: '0 0 4px rgba(251, 191, 36, 0.85)',
                display: 'none',
                zIndex: 10,
              }}
            />
          </div>
          
          <div className="flex justify-between text-xs text-gray-500 mt-2">
            <span>0s</span>
            <span>{(totalDuration / 2000).toFixed(2)}s</span>
            <span>{(totalDuration / 1000).toFixed(2)}s</span>
          </div>
        </div>

        {/* Editable Shot List */}
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm text-gray-300">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-left p-2">Shot</th>
                <th className="text-left p-2">Start (ms)</th>
                <th className="text-left p-2">End (ms)</th>
                <th className="text-left p-2">Duration (ms)</th>
                <th className="text-left p-2">Color</th>
                <th className="text-left p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {editableShots.map((shot, index) => {
                const [start, end, color] = shot;
                const duration = end - start;
                const isSelected = selectedShotIndex === index;
                
                return (
                  <tr 
                    key={index} 
                    className={`border-b border-gray-700 hover:bg-gray-700 cursor-pointer ${
                      isSelected ? 'bg-gray-700' : ''
                    }`}
                    onClick={() => handleShotClick(index, start)}
                  >
                    <td className="p-2">{index + 1}</td>
                    {(['start', 'end']).map((field) => {
                      const committed = field === 'start' ? start : end;
                      const draftKey = `${index}-${field}`;
                      const draft = shotDrafts[draftKey];
                      const display = draft !== undefined ? draft : String(committed);
                      const setDraft = (val) =>
                        setShotDrafts((prev) => ({ ...prev, [draftKey]: val }));
                      const clearDraft = () =>
                        setShotDrafts((prev) => {
                          if (!(draftKey in prev)) return prev;
                          const next = { ...prev };
                          delete next[draftKey];
                          return next;
                        });
                      const commitDraft = () => {
                        if (draft === undefined) return;
                        // handleUpdateShot owns parse/clamp/coerce. Empty
                        // or non-numeric drafts fall through to its
                        // `parseInt(value) || 0` fallback, which is the
                        // existing committed-value semantics.
                        handleUpdateShot(index, field, draft);
                        clearDraft();
                      };
                      return (
                        <td className="p-2" key={field}>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={display}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={commitDraft}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                e.currentTarget.blur();
                              } else if (e.key === 'Escape') {
                                clearDraft();
                                e.currentTarget.blur();
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-20 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
                          />
                        </td>
                      );
                    })}
                    <td className="p-2">{duration}</td>
                    <td className="p-2">
                      {/* The color swatch is the dedicated "edit color
                          without seeking the video" affordance: clicking
                          here selects the shot (which surfaces the color
                          picker above) but stops propagation so the row's
                          seek-to-shot handler doesn't fire. */}
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedShotIndex(index);
                        }}
                        className="w-8 h-8 rounded border border-gray-600 inline-block cursor-pointer hover:border-yellow-400"
                        style={{ backgroundColor: color || '#3B82F6' }}
                        title="Edit color (does not move video cursor)"
                      />
                    </td>
                    <td className="p-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveShot(index);
                        }}
                        className="text-red-400 hover:text-red-300"
                        title="Remove Shot"
                      >
                        <MdDelete />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Reprocess Options (collapsed) */}
        {hasYouTubeLink && (
          <div className="mt-4 pt-4 border-t border-gray-700">
            <button
              onClick={() => setShowReprocessOptions(!showReprocessOptions)}
              className="text-blue-400 hover:text-blue-300 text-sm underline mb-2"
            >
              {showReprocessOptions ? 'Hide' : 'Show'} Reprocess Options
            </button>
            
            {showReprocessOptions && (
              <div className="bg-gray-700 rounded p-3 mt-2">
                <div className="mb-3">
                  <label className="block text-gray-200 text-sm font-bold mb-2">
                    Detection Method
                  </label>
                  <select
                    value={detectionMethod}
                    onChange={(e) => setDetectionMethod(e.target.value)}
                    className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                  >
                    <option value="max_amplitude">Max Amplitude</option>
                    <option value="noise_floor">Noise Floor</option>
                  </select>
                </div>
                <div className="flex gap-4 mb-3">
                  {detectionMethod === 'max_amplitude' ? (
                    <div className="flex-1">
                      <label className="block text-gray-200 text-sm font-bold mb-2">
                        Threshold Ratio (0.0 - 1.0)
                      </label>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        value={thresholdRatioInput}
                        onChange={(e) => {
                          const val = e.target.value;
                          setThresholdRatioInput(val);
                          const num = parseFloat(val);
                          if (!isNaN(num) && num >= 0 && num <= 1) {
                            setThresholdRatio(num);
                          }
                        }}
                        onBlur={(e) => {
                          const val = e.target.value;
                          const num = parseFloat(val);
                          if (val === '' || isNaN(num) || num < 0 || num > 1) {
                            setThresholdRatioInput(thresholdRatio.toString());
                          }
                        }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                      />
                      <p className="text-gray-400 text-xs italic mt-1">
                        Lower = more sensitive
                      </p>
                    </div>
                  ) : (
                    <div className="flex-1">
                      <label className="block text-gray-200 text-sm font-bold mb-2">
                        Floor Percent (%)
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={floorPercentInput}
                        onChange={(e) => {
                          const val = e.target.value;
                          setFloorPercentInput(val);
                          const num = parseFloat(val);
                          if (!isNaN(num) && num >= 0) {
                            setFloorPercent(num);
                          }
                        }}
                        onBlur={(e) => {
                          const val = e.target.value;
                          const num = parseFloat(val);
                          if (val === '' || isNaN(num) || num < 0) {
                            setFloorPercentInput(floorPercent.toString());
                          }
                        }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                      />
                      <p className="text-gray-400 text-xs italic mt-1">
                        % above noise floor
                      </p>
                    </div>
                  )}
                  <div className="flex-1">
                    <label className="block text-gray-200 text-sm font-bold mb-2">
                      Merge (ms)
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="50"
                      value={mergeThresholdMsInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setMergeThresholdMsInput(val);
                        const num = parseInt(val);
                        if (!isNaN(num) && num >= 0) {
                          setMergeThresholdMs(num);
                        }
                      }}
                      onBlur={(e) => {
                        const val = e.target.value;
                        const num = parseInt(val);
                        if (val === '' || isNaN(num) || num < 0) {
                          setMergeThresholdMsInput(mergeThresholdMs.toString());
                        }
                      }}
                      className="shadow appearance-none border rounded w-full py-2 px-3 text-white bg-gray-800 border-gray-600 leading-tight focus:outline-none focus:shadow-outline"
                    />
                    <p className="text-gray-400 text-xs italic mt-1">
                      Gap to merge shots
                    </p>
                  </div>
                </div>
                <div className="mb-3">
                  <label className="flex items-center gap-2 text-gray-200 text-sm">
                    <input
                      type="checkbox"
                      checked={overrideDuration}
                      onChange={(e) => setOverrideDuration(e.target.checked)}
                      className="w-4 h-4 text-blue-600 bg-gray-800 border-gray-600 rounded focus:ring-blue-500"
                    />
                    <span className="font-bold">Override Duration</span>
                  </label>
                  <p className="text-gray-400 text-xs italic mt-1 ml-6">
                    Set item duration from first shot start to last shot end
                  </p>
                </div>
                <button
                  onClick={handleReprocess}
                  disabled={isReprocessing}
                  className="bg-blue-900 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline"
                >
                  {isReprocessing ? 'Reprocessing...' : 'Reprocess Profile'}
                </button>
                {reprocessStatus && (
                  <p className={`mt-2 text-sm ${reprocessStatus.success ? 'text-green-400' : 'text-red-400'}`}>
                    {reprocessStatus.message}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
