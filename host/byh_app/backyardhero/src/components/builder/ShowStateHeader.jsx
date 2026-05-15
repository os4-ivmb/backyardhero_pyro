import React, { useEffect, useMemo, useState } from "react";
import useAppStore from '@/store/useAppStore';

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

// Compact "Saved · 3s ago" / "Saving..." / "Unsaved changes" pill that
// keeps the operator confident the auto-save is doing its job. The
// "ago" string updates once a second while the badge is mounted; we
// re-derive on the same interval rather than recomputing per render so
// children that are mid-drag don't re-render at the wrong moment.
function SaveStatusBadge({ status, lastSavedAt, hasShowId }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "saved") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status]);

  if (!hasShowId && status === "idle") {
    // Brand-new draft. Nothing to communicate yet -- the Add Show
    // button itself is the affordance.
    return null;
  }

  let label;
  let toneClass;
  if (status === "saving") {
    label = "Saving…";
    toneClass = "bg-blue-900/40 text-blue-200 border-blue-700/60";
  } else if (status === "dirty") {
    label = "Unsaved changes";
    toneClass = "bg-amber-900/40 text-amber-200 border-amber-700/60";
  } else if (status === "error") {
    label = "Save failed";
    toneClass = "bg-red-900/40 text-red-200 border-red-700/60";
  } else if (lastSavedAt) {
    const ageS = Math.max(0, Math.floor((now - lastSavedAt) / 1000));
    let ago;
    if (ageS < 5) ago = "just now";
    else if (ageS < 60) ago = `${ageS}s ago`;
    else if (ageS < 3600) ago = `${Math.floor(ageS / 60)}m ago`;
    else ago = `${Math.floor(ageS / 3600)}h ago`;
    label = `Saved · ${ago}`;
    toneClass = "bg-emerald-900/40 text-emerald-200 border-emerald-700/60";
  } else {
    label = "Auto-save on";
    toneClass = "bg-gray-700 text-gray-300 border-gray-600";
  }

  return (
    <span
      className={`text-xs px-2 py-1 rounded border ${toneClass} whitespace-nowrap`}
      title="The editor auto-saves a second or so after each edit."
    >
      {label}
    </span>
  );
}

export default function ShowStateHeader({
  items,
  showMetadata,
  setShowMetadata,
  refreshInventoryFnc,
  clearEditor,
  receiverLabels,
  // Save plumbing: lifted into ShowBuilder so the same function powers
  // both the manual button and the debounced auto-save.
  onSaveShow,
  saveStatus = "idle",
  lastSavedAt = null,
}) {
  const { inventoryById } = useAppStore();

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
        <div className="text-white flex items-center gap-2 justify-end">
          <SaveStatusBadge
            status={saveStatus}
            lastSavedAt={lastSavedAt}
            hasShowId={!!showMetadata.id}
          />
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
            onClick={() => onSaveShow?.()}
            className={`p-2 mx-1 bg-blue-800 text-white rounded-md ${!showMetadata.name ? 'bg-gray-400' : 'hover:bg-blue-600'}`}
            disabled={!showMetadata.name || saveStatus === "saving"}
            title={
              showMetadata.id
                ? "Auto-save runs after edits; this button forces an immediate save."
                : "Save creates the show row; subsequent edits auto-save."
            }
          >
            {showMetadata.id ? "Save" : "Add Show"}
          </button>
        </div>
      </div>
    </div>
  );
}
