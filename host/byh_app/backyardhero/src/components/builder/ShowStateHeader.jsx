import React, { useEffect, useMemo, useState } from "react";
import { FiEye, FiEyeOff, FiEdit2, FiCheck } from "react-icons/fi";
import useAppStore from '@/store/useAppStore';
import { Button, IconButton, Card, CardHeader, Stat, cn, inputClass, fieldLabelClass } from "@/design";

// Arm code field for the Show Details tab. Hidden (masked) by default with a
// click-to-reveal toggle and an edit button; editing writes straight to
// showMetadata so the builder's normal save path persists it. The arm code is
// what gates editing and launching the show, so it's kept out of sight until
// the operator deliberately reveals it.
function ArmCodeField({ value, onChange }) {
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const code = value || "";
  const masked = code ? "•".repeat(Math.max(6, Math.min(code.length, 12))) : "";

  return (
    <div className="min-w-0">
      <label htmlFor="arm-code" className={fieldLabelClass}>
        Arm code
      </label>
      {editing ? (
        <div className="mt-1 flex items-center gap-2">
          <input
            id="arm-code"
            type="text"
            autoFocus
            placeholder="e.g. 1234"
            value={code}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setEditing(false);
            }}
            className={cn(inputClass, "w-40")}
          />
          <Button
            size="sm"
            variant="primary"
            leading={<FiCheck />}
            onClick={() => setEditing(false)}
          >
            Done
          </Button>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-2">
          <span
            className={cn(
              "font-mono text-sm px-3 h-9 inline-flex items-center rounded border border-border bg-surface-1 min-w-[8rem]",
              !code && "text-fg-muted",
            )}
          >
            {code ? (revealed ? code : masked) : "Not set"}
          </span>
          <IconButton
            size="sm"
            variant="ghost"
            label={revealed ? "Hide arm code" : "Reveal arm code"}
            onClick={() => setRevealed((v) => !v)}
            disabled={!code}
          >
            {revealed ? <FiEyeOff /> : <FiEye />}
          </IconButton>
          <Button
            size="sm"
            variant="outline"
            leading={<FiEdit2 />}
            onClick={() => setEditing(true)}
          >
            {code ? "Edit" : "Set"}
          </Button>
        </div>
      )}
    </div>
  );
}

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

// Coerce a timeline numeric (startTime / duration) to a real number.
// Show payloads coming from different DBs / host versions sometimes carry
// these as strings; without this the stats below silently break -- the
// worst offender being `sum + item.duration`, which CONCATENATES strings
// ("0" + "5" + "5" ...) and then divides, blowing Show Density up to a
// >1e10 garbage value. Mirrors the same guard in Timeline.jsx.
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

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
      ...items.map((item) => num(item.startTime) + num(item.duration))
    );
    const totalDurationSeconds = latestEndTime;
    const totalDuration = new Date(totalDurationSeconds * 1000)
      .toISOString()
      .substr(14, 5);

    // Calculate closest fire (minimum time between any two startTimes)
    const sortedStartTimes = items.map((item) => num(item.startTime)).sort((a, b) => a - b);
    let closestFire = Infinity;
    for (let i = 1; i < sortedStartTimes.length; i++) {
      const diff = sortedStartTimes[i] - sortedStartTimes[i - 1];
      closestFire = Math.min(closestFire, diff);
    }
    closestFire = closestFire === Infinity ? "N/A" : `${closestFire.toFixed(3)} sec`;

    // Calculate max concurrency
    const timeline = [];
    items.forEach((item) => {
      timeline.push({ time: num(item.startTime), type: "start" });
      timeline.push({ time: num(item.startTime) + num(item.duration), type: "end" });
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
    const totalItemDurations = items.reduce((sum, item) => sum + num(item.duration), 0);
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
    <div className="space-y-4 w-full">
      {/* Show name + primary actions */}
      <Card tone="raised" padding="md">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-4 min-w-0">
            <div className="min-w-0">
              <label htmlFor="show-name" className={fieldLabelClass}>
                Show name
              </label>
              <input
                id="show-name"
                type="text"
                placeholder="Untitled show"
                value={showMetadata.name || ""}
                onChange={(e) =>
                  setShowMetadata((showmd) => ({ ...showmd, name: e.target.value }))
                }
                className={cn(inputClass, "mt-1 w-72")}
              />
            </div>
            <ArmCodeField
              value={showMetadata.authorization_code}
              onChange={(v) =>
                setShowMetadata((showmd) => ({ ...showmd, authorization_code: v }))
              }
            />
          </div>
          <div className="flex items-center gap-2">
            <SaveStatusBadge
              status={saveStatus}
              lastSavedAt={lastSavedAt}
              hasShowId={!!showMetadata.id}
            />
            <Button size="sm" variant="ghost" onClick={() => refreshInventoryFnc()}>
              Refresh inventory
            </Button>
            <Button size="sm" variant="outline" onClick={() => clearEditor()}>
              Clear
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => onSaveShow?.()}
              disabled={!showMetadata.name || saveStatus === "saving"}
              title={
                showMetadata.id
                  ? "Auto-save runs after edits; this button forces an immediate save."
                  : "Save creates the show row; subsequent edits auto-save."
              }
            >
              {showMetadata.id ? "Save" : "Add show"}
            </Button>
          </div>
        </div>
      </Card>

      {/* Show statistics */}
      <Card tone="raised" padding="md">
        <CardHeader eyebrow="Summary" title="Show statistics" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9 gap-x-6 gap-y-4">
          <Stat label="Items" value={stats.itemCount} numeric />
          <Stat label="Total duration" value={stats.totalDuration} numeric />
          <Stat label="Used zones" value={stats.usedZones} numeric />
          <Stat label="Used cues" value={stats.usedTargets} numeric />
          <Stat label="Closest fire" value={stats.closestFire} numeric />
          <Stat label="Max concurrency" value={stats.maxConcurrency} numeric />
          <Stat label="Show density" value={stats.showDensity} numeric />
          <Stat label="Total cost" value={formatMoney(stats.totalCost)} numeric />
          <Stat label="Cost / min" value={formatMoney(stats.costPerMin)} numeric />
        </div>
      </Card>
    </div>
  );
}
