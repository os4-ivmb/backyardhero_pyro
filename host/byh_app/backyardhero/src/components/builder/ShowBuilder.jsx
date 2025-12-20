import React, { useEffect, useState, useRef } from "react";
import Timeline from "../common/Timeline";
import useAppStore from '@/store/useAppStore';
import FusedLineBuilderModal from "./FusedLineBuilderModal";
import ShowTargetGrid from "./ShowTargetGrid";
import ShowStateHeader from "./ShowStateHeader";
import VideoPreviewPopup from "../common/VideoPreviewPopup";
import SpatialLayoutMap from "./SpatialLayoutMap";
import WaveSurfer from 'wavesurfer.js';

export const mergeCues = (receivers) => {
  const mergedCues = {};
  if (!receivers) {
    return {};
  }
  Object.values(receivers).forEach(receiver => {
    if (receiver.cues) {
      Object.entries(receiver.cues).forEach(([zone, values]) => {
        if (!mergedCues[zone]) {
          mergedCues[zone] = [];
        }
        mergedCues[zone].push(...values);
      });
    }
  });
  return mergedCues;
}

const AddItemModal = ({ isOpen, onClose, onAdd, startTime, items, inventory, availableDevices }) => {
  const [selectedType, setSelectedType] = useState("CAKE_FOUNTAIN");
  const [selectedItem, setSelectedItem] = useState(null);
  const [fusedLine, setFusedLine] = useState(null); // Store the completed fused line
  const [isFusedBuilderOpen, setFusedBuilderOpen] = useState(false);
  const [zone, setZone] = useState(null);
  const [target, setTarget] = useState(null);
  const [metaLabel, setMetaLabel] = useState("");
  const [metaDelaySec, setMetaDelaySec] = useState(0);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (availableDevices) {
      if (!zone) {
        const zones = Object.keys(availableDevices);
        setZone(zones[0]);
        if (zones[0]) {
          setTarget(availableDevices[zones[0]][0]);
        }
      }
    }
  }, [availableDevices, zone]);

  const filteredInventory = inventory.filter((item) => item.type === selectedType).sort((a, b) => a.name.localeCompare(b.name));

  const handleItemSelected = (item) => {
    console.log("HAS")
    if(metaLabel === ""){
      setMetaLabel(item.name)
    }

    setSelectedItem(item)
  }

  const handleAdd = () => {
    const occupied = items.find(
      (item) => item.zone === zone && item.target === target
    );

    if (occupied) {
      setError(`Zone ${zone} Target ${target} is currently used by ${occupied.name}`);
      return;
    }
    setError('');


    if (selectedItem) {
      onAdd({ 
        ...selectedItem, 
        startTime, 
        zone, 
        target, 
        name: metaLabel, 
        metaDelaySec, 
        delay: (metaDelaySec || 0) + (selectedItem.fuseDelay || 0),
        itemId: selectedItem.id 
      });
      onClose();
    } else if (fusedLine) {
      onAdd({ 
        ...fusedLine, 
        startTime, 
        zone, 
        target, 
        name: metaLabel,  
        metaDelaySec,
        delay: (metaDelaySec || 0) + (fusedLine.shells[0]?.lift_delay || 0) + (fusedLine.shells[0]?.fuse_delay || 0),
      });
      onClose();
    } else if (selectedType === "GENERIC") {
      console.log("GENERIC ADD")
      onAdd({ 
        name: "GENERIC",
        type: "GENERIC", 
        duration: 5,
        startTime, 
        zone, 
        target, 
        name: metaLabel, 
        delay: metaDelaySec || 0
      });
      onClose();
    }

    // Reset fields
    setSelectedType("CAKE_FOUNTAIN");
    setSelectedItem(null);
    setFusedLine(null);
    setFusedBuilderOpen(false);
    setMetaLabel("");
    setMetaDelaySec(0);
  };

  const handleFusedLineAdd = (fusedLine) => {
    setFusedLine(fusedLine);
    setFusedBuilderOpen(false);
    setMetaLabel(fusedLine.name)
  };

  const handleFusedLineCancel = (forced) => {
    if (forced) {
      setSelectedType("CAKE_FOUNTAIN");
    }
    setFusedBuilderOpen(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-gray-800 text-white p-6 rounded shadow-lg w-96 relative z-50">
        <h2 className="text-xl mb-4">Add Item to Timeline</h2>
        
        {/* Type Selector */}
        <div className="mb-4">
          <label className="block mb-2">Select Type:</label>
          <select
            className="w-full p-2 bg-gray-700 rounded"
            value={selectedType}
            onChange={(e) => {
              const newType = e.target.value;
              setSelectedType(newType);
              setSelectedItem(null)
              if (newType === "FUSED_SHELL_LINE") {
                setFusedBuilderOpen(true);
              } else {
                setFusedLine(null);
              }
            }}
          >
            <option value="CAKE_FOUNTAIN">Cake Fountain</option>
            <option value="CAKE_200G">Cake 200g</option>
            <option value="CAKE_500G">Cake 500g</option>
            <option value="AERIAL_SHELL">Aerial Shell</option>
            <option value="GENERIC">Generic</option>
            <option value="FUSE">Fuse</option>
            <option value="FUSED_SHELL_LINE">Fused Shell Line</option>
          </select>
        </div>

        {/* FusedLine Preview */}
        {fusedLine && (
          <div className="mb-4 p-4 bg-gray-700 rounded">
            <h3 className="text-lg mb-2">Fused Line Preview:</h3>
            <p>
              <strong>Fuse Type:</strong>{" "}
              <b style={{ color: `${fusedLine.fuse.color}` }}>{fusedLine.fuse.name}</b>
            </p>
            <p><strong>Spacing:</strong> {fusedLine.spacing}"</p>
            <p><strong>Duration:</strong> {fusedLine.duration}s</p>
            <p>
              <strong>Shells:</strong>
              <ul className="list-decimal list-inside" style={{ borderLeft: `3px solid ${fusedLine.fuse.color}` }}>
                {fusedLine.shells.map((shell, index) => (
                  <li key={index}>{shell.name}</li>
                ))}
              </ul>
            </p>
          </div>
        )}

        {/* Select Item for non-fused types */}
        {!fusedLine && selectedType !== "FUSED_SHELL_LINE" && selectedType !== "GENERIC" && (
          <div className="mb-4">
            <label className="block mb-2">Select Item:</label>
            <ul className="h-32 overflow-y-auto bg-gray-700 p-2 rounded">
              {filteredInventory.map((item) => (
                <li
                  key={item.id}
                  className={`p-2 rounded cursor-pointer ${selectedItem?.id === item.id ? "bg-blue-500" : "hover:bg-gray-600"}`}
                  onClick={() => handleItemSelected(item)}
                >
                  {item.name} ({item.duration} sec)
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Meta Label Field */}
        <div className="mb-4">
          <label className="block mb-2">Label:</label>
          <input
            type="text"
            className="w-full p-2 bg-gray-700 rounded text-white"
            value={metaLabel}
            onChange={(e) => setMetaLabel(e.target.value)}
            placeholder="Enter meta label"
          />
        </div>

        {/* Zone, Target, and Meta Delay (in line) */}
        <div className="mb-4 flex space-x-4 items-end">
          <div>
            <label className="block mb-2">Zone:</label>
            <select
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              className="block appearance-none w-full border border-gray-400 hover:border-gray-500 px-4 py-2 rounded shadow leading-tight focus:outline-none focus:shadow-outline"
            >
              {Object.keys(availableDevices).map((k, i) => (
                <option key={i} value={k}>{k}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block mb-2">Target:</label>
            <select
              value={target}
              onChange={(e) => setTarget(parseInt(e.target.value))}
              className="block appearance-none w-full border border-gray-400 hover:border-gray-500 px-4 py-2 rounded shadow leading-tight focus:outline-none focus:shadow-outline"
            >
              {zone && availableDevices[zone].map((k, i) => (
                <option key={i} value={k}>{k}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block mb-2">Additional Delay (sec):</label>
            <input
              type="number"
              className="w-full p-2 bg-gray-700 rounded text-white"
              value={metaDelaySec}
              onChange={(e) => setMetaDelaySec(parseFloat(e.target.value))}
              placeholder="Delay in sec"
            />
          </div>
        </div>

        {/* Error display */}
        <div className="text-xs text-red-500 mb-2">{error}</div>

        {/* Modal Buttons */}
        <div className="flex justify-end space-x-2">
          <button className="bg-gray-600 px-4 py-2 rounded" onClick={onClose}>
            Cancel
          </button>
          <button
            className="bg-blue-600 px-4 py-2 rounded"
            onClick={handleAdd}
            disabled={!selectedItem && !fusedLine && !(selectedType === "GENERIC")}
          >
            Add
          </button>
        </div>
      </div>

      {/* FusedLineBuilderModal */}
      {isFusedBuilderOpen && (
        <FusedLineBuilderModal
          isOpen={isFusedBuilderOpen}
          onClose={handleFusedLineCancel}
          onAdd={handleFusedLineAdd}
          inventory={inventory}
        />
      )}
    </div>
  );
};

const ChainTimingModal = ({ isOpen, onClose, onApply, selectedItems }) => {
  const [intervalSeconds, setIntervalSeconds] = useState(1);
  const [startTime, setStartTime] = useState(0);

  useEffect(() => {
    if (selectedItems.length > 0) {
      // Set default start time to the earliest selected item's start time
      const earliestTime = Math.min(...selectedItems.map(item => item.startTime));
      setStartTime(earliestTime);
    }
  }, [selectedItems]);

  const handleApply = () => {
    if (selectedItems.length < 2) return;
    
    // Sort items by their current start time to maintain order
    const sortedItems = [...selectedItems].sort((a, b) => a.startTime - b.startTime);
    
    // Calculate new start times
    const newItems = sortedItems.map((item, index) => ({
      ...item,
      startTime: startTime + (index * intervalSeconds)
    }));
    
    onApply(newItems);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-gray-800 text-white p-6 rounded shadow-lg w-96 relative z-50">
        <h2 className="text-xl mb-4">Chain Timing</h2>
        <p className="text-sm text-gray-300 mb-4">
          Set timing interval between {selectedItems.length} selected items
        </p>
        
        <div className="mb-4">
          <label className="block mb-2">Start Time (seconds):</label>
          <input
            type="number"
            className="w-full p-2 bg-gray-700 rounded text-white"
            value={startTime}
            onChange={(e) => setStartTime(parseFloat(e.target.value) || 0)}
            step="0.1"
          />
        </div>

        <div className="mb-4">
          <label className="block mb-2">Interval Between Items (seconds):</label>
          <input
            type="number"
            className="w-full p-2 bg-gray-700 rounded text-white"
            value={intervalSeconds}
            onChange={(e) => setIntervalSeconds(parseFloat(e.target.value) || 0)}
            step="0.1"
            min="0"
          />
        </div>

        <div className="mb-4 p-3 bg-gray-700 rounded">
          <h3 className="text-sm font-bold mb-2">Preview:</h3>
          {selectedItems.slice(0, 3).map((item, index) => (
            <div key={item.id} className="text-xs">
              {item.name}: {startTime + (index * intervalSeconds)}s
            </div>
          ))}
          {selectedItems.length > 3 && (
            <div className="text-xs text-gray-400">... and {selectedItems.length - 3} more</div>
          )}
        </div>

        <div className="flex justify-end space-x-2">
          <button className="bg-gray-600 px-4 py-2 rounded" onClick={onClose}>
            Cancel
          </button>
          <button
            className="bg-blue-600 px-4 py-2 rounded"
            onClick={handleApply}
            disabled={selectedItems.length < 2}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};

const TestShowBuilder = ({ receivers, onGenerate, currentIndex, setCurrentIndex }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedReceivers, setSelectedReceivers] = useState([]);
  const [startTime, setStartTime] = useState(5);
  const [cadence, setCadence] = useState(1);
  const [pattern, setPattern] = useState("row"); // "row" or "sequential"

  // Get all available receivers from the receivers object
  const availableReceivers = Object.keys(receivers || {});

  const handleToggleReceiver = (receiverKey) => {
    setSelectedReceivers(prev => {
      if (prev.includes(receiverKey)) {
        return prev.filter(key => key !== receiverKey);
      } else {
        return [...prev, receiverKey];
      }
    });
  };

  const handleSelectAll = () => {
    setSelectedReceivers(availableReceivers);
  };

  const handleDeselectAll = () => {
    setSelectedReceivers([]);
  };

  const handleGenerate = () => {
    if (selectedReceivers.length === 0) {
      alert("Please select at least one receiver");
      return;
    }

    // Get all cues for selected receivers
    const receiverCues = {};
    selectedReceivers.forEach(receiverKey => {
      const receiver = receivers[receiverKey];
      if (receiver && receiver.cues) {
        // Collect all cues from all zones
        const allCues = [];
        Object.values(receiver.cues).forEach(targets => {
          allCues.push(...targets);
        });
        receiverCues[receiverKey] = allCues.sort((a, b) => a - b);
      }
    });

    // Find max number of cues across all receivers
    const cueLengths = Object.values(receiverCues).map(cues => cues.length);
    const maxCues = cueLengths.length > 0 ? Math.max(...cueLengths) : 0;

    if (maxCues === 0) {
      alert("Selected receivers have no cues available");
      return;
    }

    // Generate items based on pattern
    const newItems = [];
    let itemId = currentIndex;

    if (pattern === "row") {
      // Row pattern: All receivers fire cue 0 at startTime, then all fire cue 1 at startTime + cadence, etc.
      for (let cueIndex = 0; cueIndex < maxCues; cueIndex++) {
        selectedReceivers.forEach(receiverKey => {
          const cues = receiverCues[receiverKey];
          if (cueIndex < cues.length) {
            const cue = cues[cueIndex];
            // Find the zone for this receiver (usually the receiver key itself)
            const receiver = receivers[receiverKey];
            let zone = receiverKey;
            if (receiver && receiver.cues) {
              // Find which zone contains this target
              for (const [z, targets] of Object.entries(receiver.cues)) {
                if (targets.includes(cue)) {
                  zone = z;
                  break;
                }
              }
            }
            
            newItems.push({
              id: itemId++,
              type: "GENERIC",
              name: `Test ${receiverKey} Cue ${cue}`,
              startTime: startTime + (cueIndex * cadence),
              zone: zone,
              target: cue,
              duration: 1,
              delay: 0
            });
          }
        });
      }
    } else {
      // Sequential pattern: Receiver 1 fires cue 0, wait cadence, Receiver 2 fires cue 0, etc., then move to cue 1
      let timeOffset = 0;
      for (let cueIndex = 0; cueIndex < maxCues; cueIndex++) {
        selectedReceivers.forEach(receiverKey => {
          const cues = receiverCues[receiverKey];
          if (cueIndex < cues.length) {
            const cue = cues[cueIndex];
            // Find the zone for this receiver
            const receiver = receivers[receiverKey];
            let zone = receiverKey;
            if (receiver && receiver.cues) {
              for (const [z, targets] of Object.entries(receiver.cues)) {
                if (targets.includes(cue)) {
                  zone = z;
                  break;
                }
              }
            }
            
            newItems.push({
              id: itemId++,
              type: "GENERIC",
              name: `Test ${receiverKey} Cue ${cue}`,
              startTime: startTime + timeOffset,
              zone: zone,
              target: cue,
              duration: 1,
              delay: 0
            });
            timeOffset += cadence;
          }
        });
      }
    }

    setCurrentIndex(itemId);
    onGenerate(newItems);
  };

  return (
    <div className="mb-4 p-3 bg-gray-800 rounded-lg border border-gray-700">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-white font-semibold hover:text-gray-300 flex items-center"
        >
          <span className="mr-2">{isExpanded ? '▼' : '▶'}</span>
          Test Show Builder
        </button>
        {isExpanded && (
          <button
            onClick={handleGenerate}
            className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded text-sm"
            disabled={selectedReceivers.length === 0}
          >
            Generate
          </button>
        )}
      </div>
      
      {isExpanded && (
        <div className="mt-4 space-y-4">
          {/* Receiver Selection */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-white text-sm font-semibold">Select Receivers:</label>
              <div className="space-x-2">
                <button
                  onClick={handleSelectAll}
                  className="text-xs bg-gray-600 hover:bg-gray-700 text-white px-2 py-1 rounded"
                >
                  Select All
                </button>
                <button
                  onClick={handleDeselectAll}
                  className="text-xs bg-gray-600 hover:bg-gray-700 text-white px-2 py-1 rounded"
                >
                  Deselect All
                </button>
              </div>
            </div>
            <div className="max-h-32 overflow-y-auto bg-gray-900 p-2 rounded border border-gray-600">
              {availableReceivers.length === 0 ? (
                <div className="text-gray-400 text-sm">No receivers available</div>
              ) : (
                <div className="space-y-1">
                  {availableReceivers.map(receiverKey => {
                    const receiver = receivers[receiverKey];
                    const cueCount = receiver?.cues ? 
                      Object.values(receiver.cues).flat().length : 0;
                    return (
                      <label key={receiverKey} className="flex items-center text-sm text-white cursor-pointer hover:bg-gray-700 p-1 rounded">
                        <input
                          type="checkbox"
                          checked={selectedReceivers.includes(receiverKey)}
                          onChange={() => handleToggleReceiver(receiverKey)}
                          className="mr-2"
                        />
                        <span>{receiverKey} ({cueCount} cues)</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Configuration */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-white text-sm font-semibold mb-1">Start Time (sec):</label>
              <input
                type="number"
                className="w-full p-2 bg-gray-700 rounded text-white"
                value={startTime}
                onChange={(e) => setStartTime(parseFloat(e.target.value) || 0)}
                step="0.1"
                min="0"
              />
            </div>
            <div>
              <label className="block text-white text-sm font-semibold mb-1">Cadence (sec):</label>
              <select
                className="w-full p-2 bg-gray-700 rounded text-white"
                value={cadence}
                onChange={(e) => setCadence(parseFloat(e.target.value))}
              >
                <option value={0.05}>0.05</option>
                <option value={0.1}>0.1</option>
                <option value={0.15}>0.15</option>
                <option value={0.25}>0.25</option>
                <option value={0.5}>0.5</option>
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </div>
            <div>
              <label className="block text-white text-sm font-semibold mb-1">Pattern:</label>
              <select
                className="w-full p-2 bg-gray-700 rounded text-white"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
              >
                <option value="row">Row (All at once)</option>
                <option value="sequential">Sequential</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const AudioWaveform = ({ onTimeUpdate, currentTime, duration, isPlaying, onPlayPause, onAudioFileChange }) => {
  const waveformRef = useRef(null);
  const wavesurferRef = useRef(null);
  const [audioFile, setAudioFile] = useState(null);
  const [isReady, setIsReady] = useState(false);
  const [localDuration, setLocalDuration] = useState(0);
  const lastUpdateRef = useRef(0);
  const throttleInterval = 100; // Update every 100ms instead of every frame

  useEffect(() => {
    if (waveformRef.current && !wavesurferRef.current) {
      wavesurferRef.current = WaveSurfer.create({
        container: waveformRef.current,
        waveColor: '#4F46E5',
        progressColor: '#7C3AED',
        cursorColor: '#EF4444',
        barWidth: 2,
        barRadius: 3,
        cursorWidth: 1,
        height: 80,
        barGap: 3,
        responsive: true,
        normalize: true,
      });

      // Set up event listeners
      wavesurferRef.current.on('ready', () => {
        console.log('WaveSurfer ready');
        setIsReady(true);
        setLocalDuration(wavesurferRef.current.getDuration());
      });

      wavesurferRef.current.on('audioprocess', (currentTime) => {
        // Throttle updates to improve performance
        const now = Date.now();
        if (now - lastUpdateRef.current >= throttleInterval) {
          console.log('Audio process:', currentTime);
          if (onTimeUpdate) {
            onTimeUpdate(currentTime);
          }
          lastUpdateRef.current = now;
        }
      });

      wavesurferRef.current.on('seek', (progress) => {
        // Throttle seek updates
        const now = Date.now();
        if (now - lastUpdateRef.current >= throttleInterval) {
          console.log('Seek:', progress);
          const time = progress * wavesurferRef.current.getDuration();
          if (onTimeUpdate) {
            onTimeUpdate(time);
          }
          lastUpdateRef.current = now;
        }
      });

      wavesurferRef.current.on('play', () => {
        console.log('Play event');
        if (onPlayPause) {
          onPlayPause(true);
        }
      });

      wavesurferRef.current.on('pause', () => {
        console.log('Pause event');
        if (onPlayPause) {
          onPlayPause(false);
        }
      });

      wavesurferRef.current.on('finish', () => {
        console.log('Finish event');
        if (onPlayPause) {
          onPlayPause(false);
        }
      });

      wavesurferRef.current.on('error', (error) => {
        console.error('WaveSurfer error:', error);
      });
    }

    return () => {
      if (wavesurferRef.current) {
        wavesurferRef.current.destroy();
        wavesurferRef.current = null;
      }
    };
  }, []); // Remove dependencies to prevent re-creation

  useEffect(() => {
    if (wavesurferRef.current && isReady) {
      console.log('Attempting to play/pause:', isPlaying);
      if (isPlaying) {
        wavesurferRef.current.play();
      } else {
        wavesurferRef.current.pause();
      }
    }
  }, [isPlaying, isReady]);

  useEffect(() => {
    if (wavesurferRef.current && isReady && currentTime !== undefined) {
      const duration = wavesurferRef.current.getDuration();
      if (duration && duration > 0 && isFinite(currentTime) && currentTime >= 0) {
        // Only seek if audio is not playing to avoid stuttering
        if (!isPlaying) {
          const progress = Math.min(1, Math.max(0, currentTime / duration));
          console.log('Seeking to:', progress, 'at time:', currentTime);
          wavesurferRef.current.seekTo(progress);
        }
      }
    }
  }, [currentTime, isReady, isPlaying]);

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (file && file.type.startsWith('audio/')) {
      console.log('Loading file:', file.name);
      setAudioFile(file);
      const url = URL.createObjectURL(file);
      if (wavesurferRef.current) {
        wavesurferRef.current.load(url);
      }
      
      // Notify parent component about the audio file
      if (onAudioFileChange) {
        onAudioFileChange({
          name: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified,
          file: file // Pass the actual file object for upload
        });
      }
    }
  };

  const handlePlayPause = () => {
    console.log('Play/Pause button clicked');
    if (wavesurferRef.current && isReady) {
      wavesurferRef.current.playPause();
    }
  };

  const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="mb-4 p-4 bg-gray-800 rounded-lg border border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-white">Audio Timeline</h3>
        <div className="flex items-center gap-2">
          <input
            type="file"
            accept="audio/*"
            onChange={handleFileUpload}
            className="text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700"
          />
          {isReady && (
            <>
              <button
                onClick={handlePlayPause}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
              >
                {isPlaying ? 'Pause' : 'Play'}
              </button>
              <span className="text-sm text-gray-300">
                {formatTime(currentTime || 0)} / {formatTime(localDuration || 0)}
              </span>
            </>
          )}
        </div>
      </div>
      
      <div 
        ref={waveformRef} 
        className="w-full bg-gray-900 rounded"
      />
      
      {!audioFile && (
        <div className="text-center text-gray-400 text-sm mt-2">
          Upload an MP3 file to sync with your timeline
        </div>
      )}
      
      {/* Debug info */}
      <div className="text-xs text-gray-500 mt-2">
        Ready: {isReady.toString()}, Playing: {isPlaying.toString()}, Duration: {localDuration.toFixed(2)}s
      </div>
    </div>
  );
};

const ShowBuilder = (props) => {
  const { systemConfig, inventory, inventoryById, stagedShow, setStagedShow, updateShow } = useAppStore();
  const [items, setItems] = useState([]);
  const [showMetadata, setShowMetadata] = useState({});
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [addItemStartTime, setAddItemStartTime] = useState(0);
  const [selectedItem, setSelectedItem] = useState(false);
  const [selectedItems, setSelectedItems] = useState([]);
  const [isChainTimingModalOpen, setIsChainTimingModalOpen] = useState(false);
  const [isPopupVisible, setPopupVisible] = useState(false);
  const [audioFile, setAudioFile] = useState(null);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [availableDevices, setAvailableDevices] = useState({});
  const [receiverLocations, setReceiverLocations] = useState({});
  const [currentIndex, setCurrentIndex] = useState(50);
  const [itemsFixed, setItemsFixed] = useState(false);
  const [filteredReceivers, setFilteredReceivers] = useState({});

  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {

    
    let tprotocol = showMetadata.protocol;
    
    // If no protocol is set, set the first available one
    if(!tprotocol && systemConfig.protocols && Object.keys(systemConfig.protocols).length > 0){
      tprotocol = Object.keys(systemConfig.protocols)[0];
      console.log('Setting default protocol:', tprotocol);
      setShowMetadata((showmd) => ({ ...showmd, protocol: tprotocol }));
      return; // Exit early, let the next render handle it
    }

    console.log('Using protocol:', tprotocol);

    if (tprotocol && systemConfig.receivers && systemConfig.protocols) {
      const protocol = systemConfig.protocols[tprotocol];
      console.log('Found protocol object:', protocol);
      
      if (protocol && protocol.receivers) {
        console.log('Protocol receivers:', protocol.receivers);
        console.log('Available system receivers:', Object.keys(systemConfig.receivers));
        
        const filteredReceivers = Object.fromEntries(
          Object.entries(systemConfig.receivers).filter(([key, receiver]) => {
            const isIncluded = protocol.receivers.includes(key);
            console.log(`Receiver ${key}: ${isIncluded ? 'included' : 'excluded'}`);
            return isIncluded;
          })
        );
        
        setFilteredReceivers(filteredReceivers);
        console.log('Filtered receivers:', filteredReceivers);
        
        const availableDevicesData = mergeCues(filteredReceivers);
        console.log('Final availableDevices:', availableDevicesData);
        
        // If mergeCues returns empty, try using the receivers directly
        if (Object.keys(availableDevicesData).length === 0 && Object.keys(filteredReceivers).length > 0) {
          console.log('mergeCues returned empty, using receivers directly');
          // Create a simple mapping from receiver keys to their cues
          const directMapping = {};
          Object.entries(filteredReceivers).forEach(([receiverKey, receiver]) => {
            if (receiver.cues) {
              Object.entries(receiver.cues).forEach(([zone, targets]) => {
                if (!directMapping[zone]) {
                  directMapping[zone] = [];
                }
                directMapping[zone].push(...targets);
              });
            }
          });
          console.log('Direct mapping:', directMapping);
          setAvailableDevices(directMapping);
        } else {
          setAvailableDevices(availableDevicesData);
        }
      } else {
        console.log('Protocol or protocol.receivers is missing, using all receivers');
        // If protocol.receivers doesn't exist, use all available receivers
        setFilteredReceivers(systemConfig.receivers);
        const availableDevicesData = mergeCues(systemConfig.receivers);
        console.log('Using all receivers, availableDevices:', availableDevicesData);
        
        // If mergeCues returns empty, try using the receivers directly
        if (Object.keys(availableDevicesData).length === 0 && Object.keys(systemConfig.receivers).length > 0) {
          console.log('mergeCues returned empty, using all receivers directly');
          const directMapping = {};
          Object.entries(systemConfig.receivers).forEach(([receiverKey, receiver]) => {
            if (receiver.cues) {
              Object.entries(receiver.cues).forEach(([zone, targets]) => {
                if (!directMapping[zone]) {
                  directMapping[zone] = [];
                }
                directMapping[zone].push(...targets);
              });
            }
          });
          console.log('Direct mapping from all receivers:', directMapping);
          setAvailableDevices(directMapping);
        } else {
          setAvailableDevices(availableDevicesData);
        }
      }
    } else {
      console.log('Missing required data:', { tprotocol, hasReceivers: !!systemConfig.receivers, hasProtocols: !!systemConfig.protocols });
      setAvailableDevices({});
      setFilteredReceivers({});
    }
  }, [showMetadata.protocol, systemConfig.receivers, systemConfig.protocols]);

  // Debug useEffect to monitor availableDevices changes
  useEffect(() => {
    console.log('availableDevices changed:', availableDevices);
    console.log('availableDevices keys:', Object.keys(availableDevices));
  }, [availableDevices]);

  useEffect(() => {
    if (items.length && !itemsFixed) {
      // Reassign IDs sequentially starting from 1
      const updatedItems = items.map((item, index) => ({
        ...item,
        id: index + 1
      }));
      setItems(updatedItems);
      setItemsFixed(true);
    }
  }, [items, itemsFixed]);

  useEffect(() => {
    console.log('items changed:', items);
    if(items.length > 0){
      setCurrentIndex(items.reduce((max, obj) => (obj.id > max.id ? obj : max), items[0]).id + 1);
    }
  }, [items]);

  useEffect(() => {
    if (stagedShow.id) {
      setShowMetadata(stagedShow);
      const newItems = JSON.parse(stagedShow.display_payload);
      const maxId = newItems.reduce((max, obj) => (obj.id > max.id ? obj : max), newItems[0]).id;
      refreshInventory(newItems);
      console.log(`CURRENT INDEX IS ${maxId}`);
      // If editing a show with audio, set the audio file for the player
      if (stagedShow.audioFile) {
        setAudioFile(stagedShow.audioFile);
      } else {
        setAudioFile(null);
      }
      
      // Load existing receiver locations from show data
      if (stagedShow.receiver_locations) {
        try {
          const parsedLocations = JSON.parse(stagedShow.receiver_locations);
          setReceiverLocations(parsedLocations);
        } catch (e) {
          console.error('Failed to parse receiver_locations for show:', stagedShow.id, e);
          initializeDefaultLocations();
        }
      } else {
        initializeDefaultLocations();
      }
    }
  }, [stagedShow]);

  const initializeDefaultLocations = () => {
    if (systemConfig.receivers && systemConfig.protocols) {
      const protocol = systemConfig.protocols[showMetadata.protocol];
      if (protocol && protocol.receivers) {
        const receivers = Object.keys(systemConfig.receivers).filter(key => 
          protocol.receivers.includes(key)
        );
        const defaultLocations = {};
        receivers.forEach((receiverKey, index) => {
          const row = Math.floor(index / 3);
          const col = index % 3;
          defaultLocations[receiverKey] = {
            x: 100 + col * 150,
            y: 100 + row * 150
          };
        });
        setReceiverLocations(defaultLocations);
      } else {
        // If protocol.receivers doesn't exist, use all receivers
        console.log('Initializing default locations for all receivers');
        const receivers = Object.keys(systemConfig.receivers);
        const defaultLocations = {};
        receivers.forEach((receiverKey, index) => {
          const row = Math.floor(index / 3);
          const col = index % 3;
          defaultLocations[receiverKey] = {
            x: 100 + col * 150,
            y: 100 + row * 150
          };
        });
        setReceiverLocations(defaultLocations);
      }
    }
  };

  const refreshInventory = (items_in) => {
    setItems((items) => (items_in || items).map((item) => {
      const inv_item = inventoryById[item.itemId];
      if (inv_item) {
        const { id, ...InvItemWithoutId } = inv_item;
        return { ...InvItemWithoutId, ...item };
      }else{
        return item
      }
    }));
  };

  useEffect(() => {
    if (props.showId && !isInitialized) {
      // any additional initialization code
    }
  }, [props.showId]);

  const clearEditorFnc = () => {
    setItems([]);
    setShowMetadata({name:""});
  };

  const openAddModal = (time) => {
    setAddItemStartTime(time);
    setIsAddModalOpen(true);
  };

  const closeModal = () => {
    setIsAddModalOpen(false);
  };

  const addItemToTimeline = (item) => {
    item.id = currentIndex;
    setCurrentIndex((currentIndex) => currentIndex + 1);
    setItems((prevItems) => [...prevItems, item]);
  };

  useEffect(() => {
    if (selectedItem) {
      if (selectedItem.youtube_link) {
        setPopupVisible(true);
      }
    }
  }, [selectedItem]);

  const handleItemSelect = (item, isMultiSelect) => {
    if (isMultiSelect) {
      setSelectedItems(prev => {
        const isSelected = prev.some(selected => selected.id === item.id);
        if (isSelected) {
          return prev.filter(selected => selected.id !== item.id);
        } else {
          return [...prev, item];
        }
      });
    } else {
      setSelectedItem(item);
      setSelectedItems([]); // Clear multi-select when single selecting
    }
  };

  const handleChainTiming = () => {
    if (selectedItems.length >= 2) {
      setIsChainTimingModalOpen(true);
    }
  };

  const handleChainTimingApply = (updatedItems) => {
    setItems(prevItems => 
      prevItems.map(item => {
        const updatedItem = updatedItems.find(updated => updated.id === item.id);
        return updatedItem || item;
      })
    );
  };

  const clearSelection = () => {
    setSelectedItem(false);
    setSelectedItems([]);
  };

  const handleAudioTimeUpdate = (time) => {
    if (isFinite(time) && time >= 0) {
      setAudioCurrentTime(time);
    }
  };

  const handleAudioPlayPause = (playing) => {
    setIsAudioPlaying(playing);
  };

  const handleAudioFileChange = async (fileInfo) => {
    setAudioFile(fileInfo);
    
    // Upload the actual file to get a persistent URL
    try {
      const formData = new FormData();
      formData.append('audio', fileInfo.file);
      
      const response = await fetch('/api/shows/upload-audio', {
        method: 'POST',
        body: formData
      });
      
      if (response.ok) {
        const result = await response.json();
        const audioUrl = result.url;
        
        // Update show metadata with audio info and URL
        console.log("SSM", showMetadata)
        setShowMetadata(prev => ({
          ...prev,
          audioFile: {
            ...fileInfo,
            url: audioUrl
          }
        }));
      } else {
        console.error('Failed to upload audio file');
      }
    } catch (error) {
      console.error('Error uploading audio file:', error);
      // Fallback: just save the file info without URL
      setShowMetadata(prev => ({
        ...prev,
        audioFile: fileInfo
      }));
    }
  };

  // Remove audio from show handler
  const handleRemoveAudio = () => {
    setShowMetadata(prev => ({ ...prev, audioFile: null }));
    setAudioFile(null);
  };

  // Save receiver locations to show data
  const saveReceiverLocations = async () => {
    if (!stagedShow.id) {
      alert("Please save the show first before saving receiver locations.");
      return;
    }

    try {
      const updatedShowData = {
        ...stagedShow,
        receiver_locations: JSON.stringify(receiverLocations)
      };
      
      await updateShow(stagedShow.id, updatedShowData);
      alert("Receiver locations saved successfully!");
    } catch (error) {
      console.error('Failed to save receiver locations:', error);
      alert("Failed to save receiver locations. Please try again.");
    }
  };

  // Handle test show generation
  const handleTestShowGenerate = (newItems) => {
    // Clear existing items and set new ones
    setItems(newItems);
    setItemsFixed(false); // Allow ID reassignment
  };

  return (
    <div className="p-4">
      <h1 className="text-xl mb-4">Show Editor</h1>
      <ShowStateHeader 
        items={items} 
        setItems={setItems} 
        refreshInventoryFnc={refreshInventory} 
        inventoryById={inventoryById} 
        showMetadata={showMetadata} 
        setShowMetadata={setShowMetadata}
        clearEditor={clearEditorFnc}
        protocols={systemConfig.protocols}
      />
      {availableDevices && Object.keys(availableDevices).length > 0 ? (
        <div>
          {/* Audio Waveform */}
          <AudioWaveform
            onTimeUpdate={handleAudioTimeUpdate}
            currentTime={audioCurrentTime}
            duration={audioDuration}
            isPlaying={isAudioPlaying}
            onPlayPause={handleAudioPlayPause}
            onAudioFileChange={handleAudioFileChange}
          />
          {/* Remove Audio Button */}
          {audioFile && (
            <div className="mb-2 flex justify-end">
              <button
                className="bg-red-700 hover:bg-red-800 text-white px-3 py-1 rounded text-sm"
                onClick={handleRemoveAudio}
              >
                Remove Audio
              </button>
            </div>
          )}
          
          {/* Test Show Builder */}
          <TestShowBuilder
            receivers={filteredReceivers}
            onGenerate={handleTestShowGenerate}
            currentIndex={currentIndex}
            setCurrentIndex={setCurrentIndex}
          />
          
          {/* Chain Timing Button */}
          {selectedItems.length >= 2 && (
            <div className="mb-4 p-3 bg-blue-900 rounded-lg border border-blue-700">
              <div className="flex items-center justify-between">
                <span className="text-white">
                  {selectedItems.length} items selected - Command+Click to select multiple
                </span>
                <button
                  onClick={handleChainTiming}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
                >
                  Chain Timing
                </button>
              </div>
            </div>
          )}
          
          <Timeline 
            items={items} 
            setItems={setItems} 
            openAddModal={openAddModal} 
            setSelectedItem={(item) => handleItemSelect(item, false)}
            selectedItems={selectedItems}
            onItemSelect={handleItemSelect}
            clearSelection={clearSelection}
            timeCursor={audioCurrentTime}
            setTimeCursor={setAudioCurrentTime}
          />
          <AddItemModal
            isOpen={isAddModalOpen}
            onClose={closeModal}
            onAdd={addItemToTimeline}
            startTime={addItemStartTime}
            items={items}
            inventory={inventory}
            availableDevices={availableDevices}
          />
          <ChainTimingModal
            isOpen={isChainTimingModalOpen}
            onClose={() => setIsChainTimingModalOpen(false)}
            onApply={handleChainTimingApply}
            selectedItems={selectedItems}
          />
          {selectedItem ? (
            <VideoPreviewPopup 
              items={[selectedItem]} 
              isVisible={isPopupVisible} 
              onClose={() => setPopupVisible(false)} 
            />
          ) : (
            ""
          )}
          <ShowTargetGrid  
            items={items} 
            setItems={setItems} 
            availableDevices={availableDevices} 
          />
          
          {/* Spatial Layout Section */}
          <SpatialLayoutMap
            receivers={systemConfig.receivers}
            items={items}
            receiverLocations={receiverLocations}
            setReceiverLocations={setReceiverLocations}
            onSaveLocations={saveReceiverLocations}
          />
        </div>
      ) : (
        <div className="text-center p-8">
          <h2 className="text-xl font-bold text-gray-700 mb-4">Show Editor</h2>
          <p className="text-gray-500 mb-4">
            {!showMetadata.protocol 
              ? "Please select a protocol in the show header above to get started." 
              : "No receivers available for the selected protocol. Please check your system configuration."}
          </p>
          <p className="text-sm text-gray-400">
            Available protocols: {systemConfig.protocols ? Object.keys(systemConfig.protocols).join(', ') : 'None configured'}
          </p>
        </div>
      )}
    </div>
  );
};

export default ShowBuilder;
