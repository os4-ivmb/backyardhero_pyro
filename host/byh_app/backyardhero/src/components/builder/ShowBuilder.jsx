import React, { useEffect, useState } from "react";
import Timeline from "../common/Timeline";
import useAppStore from '@/store/useAppStore';
import FusedLineBuilderModal from "./FusedLineBuilderModal";
import ShowTargetGrid from "./ShowTargetGrid";
import ShowStateHeader from "./ShowStateHeader";
import VideoPreviewPopup from "../common/VideoPreviewPopup";

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

const ShowBuilder = (props) => {
  const { inventory, inventoryById, stagedShow, setStagedShow, systemConfig } = useAppStore();
  const [items, setItems] = useState([]);
  const [isAddModalOpen, setAddModalOpen] = useState(false);
  const [addItemStartTime, setAddItemStartTime] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(50);
  const [selectedItem, setSelectedItem] = useState(false);
  const [isPopupVisible, setPopupVisible] = useState(false);
  const [showMetadata, setShowMetadata] = useState({});
  const [availableDevices, setAvailableDevices] = useState({});

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
          <Timeline 
            items={items} 
            setItems={setItems} 
            openAddModal={openAddModal} 
            setSelectedItem={setSelectedItem}
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
