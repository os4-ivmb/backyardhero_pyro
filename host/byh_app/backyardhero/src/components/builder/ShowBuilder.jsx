import React, { useEffect, useState, useRef } from "react";
import Timeline from "../common/Timeline";
import useAppStore from '@/store/useAppStore';
import FusedLineBuilderModal from "./FusedLineBuilderModal";
import ShowTargetGrid from "./ShowTargetGrid";
import ShowStateHeader from "./ShowStateHeader";
import VideoPreviewPopup from "../common/VideoPreviewPopup";
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
          lastModified: file.lastModified
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
  const { inventory, inventoryById, stagedShow, setStagedShow, systemConfig } = useAppStore();
  const [items, setItems] = useState([]);
  const [isAddModalOpen, setAddModalOpen] = useState(false);
  const [addItemStartTime, setAddItemStartTime] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(50);
  const [selectedItem, setSelectedItem] = useState(false);
  const [selectedItems, setSelectedItems] = useState([]); // Multi-select state
  const [isPopupVisible, setPopupVisible] = useState(false);
  const [showMetadata, setShowMetadata] = useState({});
  const [availableDevices, setAvailableDevices] = useState({});
  const [isChainTimingModalOpen, setIsChainTimingModalOpen] = useState(false);
  
  // Audio state
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);

  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    let tprotocol = showMetadata.protocol
    if(!tprotocol && systemConfig.receivers){
      tprotocol = Object.keys(systemConfig.protocols)[0];
      setShowMetadata((showmd) => ({ ...showmd, protocol: tprotocol }));
    }

    if (tprotocol && systemConfig.receivers) {

      const allowedTypes = Object.keys(systemConfig.types).filter((typekey) => {
        return systemConfig.types[typekey].supported_protocols.includes(tprotocol)
      })


      setAvailableDevices(
        mergeCues(
          Object.fromEntries(
            Object.entries(systemConfig.receivers).filter(
              ([key, val]) =>{
                return allowedTypes.includes(val.type)
              }
            )
          )
        )
      );
    }
  }, [showMetadata.protocol, systemConfig.receivers]);

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
    if (stagedShow.id) {
      setShowMetadata(stagedShow);
      const newItems = JSON.parse(stagedShow.display_payload);
      const maxId = newItems.reduce((max, obj) => (obj.id > max.id ? obj : max), newItems[0]).id;
      refreshInventory(newItems);
      setCurrentIndex(maxId + 5 || 50);
      console.log(`CURRENT INDEX IS ${maxId}`);
    }
  }, [stagedShow]);

  useEffect(() => {
    if (props.showId && !isInitialized) {
      // any additional initialization code
    }
  }, [props.showId]);

  const clearEditorFnc = () => {
    setItems([]);
    setStagedShow({});
    setShowMetadata({name:""});
  };

  const openAddModal = (time) => {
    setAddItemStartTime(time);
    setAddModalOpen(true);
  };

  const closeModal = () => {
    setAddModalOpen(false);
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
      {availableDevices ? (
        <div>
          {/* Audio Waveform */}
          <AudioWaveform
            onTimeUpdate={handleAudioTimeUpdate}
            currentTime={audioCurrentTime}
            duration={audioDuration}
            isPlaying={isAudioPlaying}
            onPlayPause={handleAudioPlayPause}
            onAudioFileChange={(fileInfo) => {
              // Handle audio file change
            }}
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
        </div>
      ) : (
        "Need to select a protocol"
      )}
    </div>
  );
};

export default ShowBuilder;
