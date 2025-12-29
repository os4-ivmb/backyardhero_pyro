import React, { useState, useMemo } from "react";
import useAppStore from '@/store/useAppStore';

export default function ShowStateHeader({ items, showMetadata, setShowMetadata, refreshInventoryFnc , protocols, clearEditor, receiverLabels }) {
  const { createShow, updateShow, setStagedShow} = useAppStore();

  const handleUpsertShow = async () => {
    let authorization_code = showMetadata.authorization_code
    // Only prompt for code if creating a new show
    if (!authorization_code) {
      authorization_code = prompt("Please enter an auth code for this show. It will be used to both edit and launch the show.")
    }

    const allowedAttributes = ["id", "startTime", "itemId", "zone", "target", "type", "name", "duration", "delay", "rackId", "rackCells", "rackName", "rackSpacing", "fireableItem", "fireableItemId", "fuse", "spacing", "leadInInches", "shells"];

    const compressedItems = items.map(obj =>
        allowedAttributes.reduce((acc, key) => {
            if (key in obj) acc[key] = obj[key];
            return acc;
        }, {})
    );

    const showData = {
        runtime_version: "0",
        runtime_payload: "{}",
        ...showMetadata,
        authorization_code,
        version: (parseInt(showMetadata.version) || 1) + 1,
        duration: Math.round(Math.max(
            ...items.map((item) => item.startTime + item.duration)
        )),
        display_payload: JSON.stringify(compressedItems),
        // Include audio file info if present
        audioFile: showMetadata.audioFile || null,
        // Include receiver locations as JSON if present
        receiver_locations: showMetadata.receiver_locations ? JSON.stringify(showMetadata.receiver_locations) : null,
        // Include receiver labels as JSON if present
        receiver_labels: receiverLabels && Object.keys(receiverLabels).length > 0 ? JSON.stringify(receiverLabels) : null
    }


    if(showMetadata.id){
        updateShow(showMetadata.id, showData)
        setShowMetadata((showmd) => ({ ...showmd, ...showData }))
        setStagedShow({...showData, id: showMetadata.id, items })
        alert("Updated Successfully!")
    }else{
        const id = await createShow(showData)
        setShowMetadata((showmd) => ({ ...showmd, ...showData, id: id }))
        setStagedShow({...showData, id: id, items })
    }
  }

  const handleUpdateShowProtocol = (e) => {
    setShowMetadata((showmd) => ({ ...showmd, protocol: e.target.value }))
  }

  // Calculate show statistics
  const stats = useMemo(() => {
    if (!items.length) {
      return {
        itemCount: 0,
        usedZones: 0,
        usedTargets: 0,
        totalDuration: "00:00",
        closestFire: "N/A",
        maxConcurrency: 0,
        showDensity: "N/A",
      };
    }

    // Total item count
    const itemCount = items.length;

    // Used zones and targets
    const usedZones = new Set(items.map((item) => item.zone)).size;
    const usedTargets = new Set(items.map((item) => item.target)).size;
    // Calculate total duration of the show
    const latestEndTime = Math.max(
      ...items.map((item) => item.startTime + item.duration)
    );
    const totalDurationSeconds = latestEndTime;
    const totalDuration = new Date(totalDurationSeconds * 1000)
      .toISOString()
      .substr(14, 5);

    // Calculate closest fire (minimum time between any two startTimes)
    const sortedStartTimes = items.map((item) => item.startTime).sort((a, b) => a - b);
    let closestFire = Infinity;
    for (let i = 1; i < sortedStartTimes.length; i++) {
      const diff = sortedStartTimes[i] - sortedStartTimes[i - 1];
      closestFire = Math.min(closestFire, diff);
    }
    closestFire = closestFire === Infinity ? "N/A" : `${closestFire.toFixed(3)} sec`;

    // Calculate max concurrency
    const timeline = [];
    items.forEach((item) => {
      timeline.push({ time: item.startTime, type: "start" });
      timeline.push({ time: item.startTime + item.duration, type: "end" });
    });
    timeline.sort((a, b) => a.time - b.time);

    let maxConcurrency = 0;
    let currentConcurrency = 0;
    timeline.forEach((point) => {
      if (point.type === "start") {
        currentConcurrency++;
        maxConcurrency = Math.max(maxConcurrency, currentConcurrency);
      } else {
        currentConcurrency--;
      }
    });

    // Calculate show density
    const totalItemDurations = items.reduce((sum, item) => sum + item.duration, 0);
    const showDensity =
      totalDurationSeconds > 0
        ? (totalItemDurations / totalDurationSeconds).toFixed(2)
        : "N/A";

    return {
      itemCount,
      usedZones,
      usedTargets,
      totalDuration,
      closestFire,
      maxConcurrency,
      showDensity,
    };
  }, [items]);

  return (
    <div className="border border-gray-700 rounded-md p-4 flex items-center justify-between bg-gray-800 mb-3">
      {/* Left Section: Show Name */}
      <div className="flex items-center space-x-2">
        <input
          type="text"
          placeholder="Show Name"
          value={showMetadata.name}
          onChange={(e) => setShowMetadata((showmd) => ({ ...showmd, name: e.target.value }))}
          className="p-2 border border-gray-300 rounded-md"
        />
        <select
            value={showMetadata.protocol}
            onChange={handleUpdateShowProtocol}
            name="type"
            className="block appearance-none w-full border border-gray-400 hover:border-gray-500 px-4 py-2 pr-8 rounded shadow leading-tight focus:outline-none focus:shadow-outline"
          >
            {Object.keys(protocols || {}).map((k, i) => (
              <option key={i} value={k}>
                {protocols[k].label}
              </option>
            ))}
          </select>
      </div>

      {/* Middle Section: Show Details */}
      <div className="text-center">
        <div className="text-sm text-gray-4s00">
          <p>Items: <b>{stats.itemCount}</b></p>
          <p>Total Duration: <b>{stats.totalDuration}</b></p>
        </div>
      </div>
      <div className="text-center">
        <div className="text-sm text-gray-4s00">
          <p>Used Zones: <b>{stats.usedZones}</b></p>
          <p>Used Cues: <b>{stats.usedTargets}</b></p>
        </div>
      </div>
      <div className="text-center">
        <div className="text-sm text-gray-400">
          <p>Closest Fire: <b>{stats.closestFire}</b></p>
          <p>Max Concurrency: <b>{stats.maxConcurrency}</b></p>
        </div>
      </div>
      <div className="text-center">
        <div className="text-sm text-gray-400">
          <p>Show Density: <b>{stats.showDensity}</b></p>
        </div>
      </div>
      <div className="text-center">
        <div className=" text-white">
  
        <button
          className="bg-blue-800 px-4 py-2 rounded mx-1"
          onClick={()=>clearEditor()}
        >
          Clear
        </button>
        <button
          className="bg-blue-800 px-4 py-2 rounded mx-1"
          onClick={()=>refreshInventoryFnc()}
        >
          Refresh Inventory
        </button>
        <button
          onClick={handleUpsertShow}
          className={`p-2 mx-1 bg-blue-800 text-white rounded-md ${!showMetadata.name ? 'bg-gray-400' : 'hover:bg-blue-600'}`}
          disabled={!showMetadata.name}
        >
          {showMetadata.id ? "Save" : "Add Show"}
        </button>
        
        </div>
      </div>
    </div>
  );
}
