import React, { useState, useMemo } from "react";
import useAppStore from '@/store/useAppStore';
import { audioFieldFromShow } from "@/utils/audioTracks";

// Resolve a non-negative number from a unit_cost-like value; returns 0 otherwise.
const toCost = (val) => {
  if (val === null || val === undefined || val === "") return 0;
  const n = typeof val === "number" ? val : parseFloat(val);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

// Compute the total cost contribution of a single timeline item.
const computeItemCost = (item, inventoryById) => {
  if (!item) return 0;
  const lookupCost = (shellId) => {
    if (shellId == null) return 0;
    const inv = inventoryById?.[shellId];
    return toCost(inv?.unit_cost);
  };

  if (item.type === "GENERIC") return 0;

  // Fused item line: a chain of inventory-backed steps fired off one cue.
  // Walk each step and sum its contribution, honoring per-step `multiple`
  // for items that fire several physical units per cue (cakes, etc.).
  if (item.type === "FUSED_LINE" && Array.isArray(item.steps)) {
    return item.steps.reduce((sum, step) => {
      if (!step) return sum;
      if (step.type === "FUSED_SHELL_LINE" && step.fusedShellLine) {
        const shells = step.fusedShellLine.shells || [];
        return (
          sum +
          shells.reduce(
            (s, shell) => s + (toCost(shell?.unit_cost) || lookupCost(shell?.id)),
            0
          )
        );
      }
      const qty = Number.isFinite(step.multiple) && step.multiple >= 1 ? step.multiple : 1;
      const stepCost = toCost(step.unit_cost) || lookupCost(step.itemId);
      return sum + stepCost * qty;
    }, 0);
  }

  // Fused shell line: sum each shell's unit_cost.
  if (Array.isArray(item.shells) && item.shells.length > 0) {
    return item.shells.reduce(
      (sum, shell) => sum + (toCost(shell?.unit_cost) || lookupCost(shell?.id)),
      0
    );
  }

  // Rack shells: walk the fireableItem cells and sum each shell's unit_cost.
  if (item.type === "RACK_SHELLS" && item.fireableItem) {
    const fi = item.fireableItem;
    if (fi.type === "single") {
      const shellId = fi.cellData?.shellId;
      return lookupCost(shellId);
    }
    if (fi.type === "fused" && Array.isArray(fi.cellData)) {
      return fi.cellData.reduce((sum, cd) => sum + lookupCost(cd?.shellId), 0);
    }
    return 0;
  }

  // Default: a single inventory-backed item (cake, aerial shell, etc).
  // `multiple` lets one cue fire several physical units; the cost scales 1:1.
  const qty = Number.isFinite(item.multiple) && item.multiple >= 1 ? item.multiple : 1;
  if (item.unit_cost != null && item.unit_cost !== "") {
    return toCost(item.unit_cost) * qty;
  }
  return lookupCost(item.itemId) * qty;
};

export default function ShowStateHeader({ items, showMetadata, setShowMetadata, refreshInventoryFnc , clearEditor, receiverLabels }) {
  const { createShow, updateShow, setStagedShow, inventoryById } = useAppStore();

  const handleUpsertShow = async () => {
    let authorization_code = showMetadata.authorization_code
    // Only prompt for code if creating a new show
    if (!authorization_code) {
      authorization_code = prompt("Please enter an auth code for this show. It will be used to both edit and launch the show.")
    }

    const allowedAttributes = ["id", "startTime", "itemId", "zone", "target", "type", "name", "duration", "delay", "rackId", "rackCells", "rackName", "rackSpacing", "fireableItem", "fireableItemId", "fuse", "spacing", "leadInInches", "shells", "multiple", "steps", "firstStepFuseDelay"];

    const compressedItems = items.map(obj =>
        allowedAttributes.reduce((acc, key) => {
            if (key in obj) acc[key] = obj[key];
            return acc;
        }, {})
    );

    // Multi-track audio. The API expects `audioFile` to be the JSON blob
    // that gets written to the `audio_file` column verbatim, so we send
    // the {tracks:[...], audioOffsetMs} wrapper there. The in-memory
    // state shape is different: it keeps `audioTracks` (canonical
    // array) plus `audioFile` aliased to the first track for legacy
    // consumers, and `audioOffsetMs` as a top-level field.
    //
    // The editor doesn't expose UI for `audioOffsetMs` -- that's tuned
    // from the operator console -- but we read it off `showMetadata`
    // and re-include it on save so editor saves don't clobber a
    // previously-tuned offset.
    const tracksForState = Array.isArray(showMetadata.audioTracks)
      ? showMetadata.audioTracks
      : [];
    const audioOffsetMsForState = Number.isFinite(showMetadata.audioOffsetMs)
      ? showMetadata.audioOffsetMs
      : 0;
    const apiAudioBlob = tracksForState.length
      ? audioFieldFromShow({
          tracks: tracksForState,
          audioOffsetMs: audioOffsetMsForState,
        })
      : showMetadata.audioFile || null;

    const apiShowData = {
        runtime_version: "0",
        runtime_payload: "{}",
        ...showMetadata,
        authorization_code,
        version: (parseInt(showMetadata.version) || 1) + 1,
        duration: items.length > 0
            ? Math.round(Math.max(
                ...items.map((item) => item.startTime + item.duration)
            ))
            : 0,
        display_payload: JSON.stringify(compressedItems),
        audioFile: apiAudioBlob,
        // Include receiver locations as JSON if present
        receiver_locations: showMetadata.receiver_locations ? JSON.stringify(showMetadata.receiver_locations) : null,
        // Include receiver labels as JSON if present
        receiver_labels: receiverLabels && Object.keys(receiverLabels).length > 0 ? JSON.stringify(receiverLabels) : null
    }

    const stateShape = {
        ...apiShowData,
        audioFile: tracksForState[0] || null,
        audioTracks: tracksForState,
        audioOffsetMs: audioOffsetMsForState,
    };

    if(showMetadata.id){
        updateShow(showMetadata.id, apiShowData)
        setShowMetadata((showmd) => ({ ...showmd, ...stateShape }))
        setStagedShow({...stateShape, id: showMetadata.id, items })
        alert("Updated Successfully!")
    }else{
        const id = await createShow(apiShowData)
        setShowMetadata((showmd) => ({ ...showmd, ...stateShape, id: id }))
        setStagedShow({...stateShape, id: id, items })
    }
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
        totalCost: 0,
        costPerMin: 0,
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

    // Calculate total cost and cost-per-minute
    const totalCost = items.reduce(
      (sum, item) => sum + computeItemCost(item, inventoryById),
      0
    );
    const costPerMin =
      totalDurationSeconds > 0 ? totalCost / (totalDurationSeconds / 60) : 0;

    return {
      itemCount,
      usedZones,
      usedTargets,
      totalDuration,
      closestFire,
      maxConcurrency,
      showDensity,
      totalCost,
      costPerMin,
    };
  }, [items, inventoryById]);

  const formatMoney = (n) => {
    if (!Number.isFinite(n)) return "$0.00";
    return `$${n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

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
        <div className="text-sm text-gray-400">
          <p>Total Cost: <b>{formatMoney(stats.totalCost)}</b></p>
          <p>$/min: <b>{formatMoney(stats.costPerMin)}</b></p>
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
