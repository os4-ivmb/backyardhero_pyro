import React, { useEffect, useState, useRef, useMemo } from "react";
import Timeline from "../common/Timeline";
import useAppStore from '@/store/useAppStore';
import FusedLineBuilderModal from "./FusedLineBuilderModal";
import FusedItemLineBuilderModal from "./FusedItemLineBuilderModal";
import ShowTargetGrid from "./ShowTargetGrid";
import ShowStateHeader from "./ShowStateHeader";
import VideoPreviewPopup from "../common/VideoPreviewPopup";
import SpatialLayoutMap from "./SpatialLayoutMap";
import RacksTab from "./RacksTab";
import RackShellsSelector from "./RackShellsSelector";
import WaveSurfer from 'wavesurfer.js';
import { analyzeAudioFile, bpmFromTapTimes } from "@/utils/bpmAnalyzer";
import {
  newTrackId,
  totalShowAudioDuration,
  trackAtShowTime,
  trackOffsets,
} from "@/utils/audioTracks";
import {
  Modal,
  Button,
  Field,
  inputClass,
  selectClass,
  Card,
  Badge,
  cn,
} from "@/design";

// Item type catalogue surfaced in the Add Item modal. Centralised so the
// dropdown order stays predictable and labels stay in one place.
const ADD_ITEM_TYPES = [
  { value: "CAKE_FOUNTAIN", label: "Cake fountain" },
  { value: "CAKE_200G", label: "Cake 200g" },
  { value: "CAKE_350G", label: "Cake 350g" },
  { value: "CAKE_500G", label: "Cake 500g" },
  { value: "COMPOUND_CAKE", label: "Compound cake" },
  { value: "AERIAL_SHELL", label: "Aerial shell" },
  { value: "GENERIC", label: "Generic / placeholder" },
  { value: "FUSE", label: "Fuse" },
  { value: "FUSED_SHELL_LINE", label: "Fused shell line" },
  { value: "FUSED_LINE", label: "Fused line" },
  { value: "RACK_SHELLS", label: "Rack shells" },
];

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

// Item types that support firing multiples of the same physical item per cue.
const MULTIPLE_FIRE_TYPES = new Set([
  "CAKE_FOUNTAIN",
  "CAKE_200G",
  "CAKE_350G",
  "CAKE_500G",
  "COMPOUND_CAKE",
  "AERIAL_SHELL",
]);

const AddItemModal = ({ isOpen, onClose, onAdd, startTime, items, inventory, availableDevices, receiverLabels, showMetadata }) => {
  const [selectedType, setSelectedType] = useState("CAKE_FOUNTAIN");
  const [selectedItem, setSelectedItem] = useState(null);
  const [fusedLine, setFusedLine] = useState(null); // Store the completed fused line
  const [fusedItemLine, setFusedItemLine] = useState(null); // Store the completed fused item line (FUSED_LINE)
  const [rackShells, setRackShells] = useState(null); // Store the selected rack shells
  const [isFusedBuilderOpen, setFusedBuilderOpen] = useState(false);
  const [isFusedItemBuilderOpen, setFusedItemBuilderOpen] = useState(false);
  const [isRackShellsOpen, setIsRackShellsOpen] = useState(false);
  const [zone, setZone] = useState(null);
  const [target, setTarget] = useState(null);
  const [metaLabel, setMetaLabel] = useState("");
  const [metaDelaySec, setMetaDelaySec] = useState(0);
  const [fireMultiple, setFireMultiple] = useState(false);
  const [multipleCount, setMultipleCount] = useState(2);
  const [error, setError] = useState(null);

  const supportsMultiple = MULTIPLE_FIRE_TYPES.has(selectedType) && !!selectedItem;

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

  // Helper function to check if a zone+target combination is occupied
  const isOccupied = (zoneName, targetValue) => {
    return items.some(item => item.zone === zoneName && item.target === targetValue);
  };

  // Check if all targets in a zone are occupied
  const isZoneFullyOccupied = (zoneName) => {
    if (!availableDevices[zoneName]) return false;
    const targets = availableDevices[zoneName];
    return targets.every(target => isOccupied(zoneName, target));
  };

  // Update target if current selection becomes occupied
  useEffect(() => {
    if (zone && target !== null && availableDevices[zone]) {
      const isCurrentlyOccupied = items.some(item => item.zone === zone && item.target === target);
      if (isCurrentlyOccupied) {
        // Current target is occupied, find first available target in this zone
        const availableTarget = availableDevices[zone].find(
          t => !items.some(item => item.zone === zone && item.target === t)
        );
        if (availableTarget !== undefined) {
          setTarget(availableTarget);
        }
      }
    }
  }, [items, zone, target, availableDevices]);

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
      // For aerial shells, include both fuse_delay and lift_delay in the delay calculation
      // This matches the behavior for fused lines
      const itemDelay = (selectedItem.fuse_delay || selectedItem.fuseDelay || 0) 
        + (selectedItem.type === "AERIAL_SHELL" ? (selectedItem.lift_delay || 0) : 0);

      // Number of physical items fired together on this cue. Stored only when >1
      // so legacy items continue to behave as singles. Used by loadout/cost.
      const multiple = supportsMultiple && fireMultiple
        ? Math.max(2, Math.floor(multipleCount) || 2)
        : 1;

      onAdd({ 
        ...selectedItem, 
        startTime, 
        zone, 
        target, 
        name: metaLabel, 
        metaDelaySec, 
        delay: (metaDelaySec || 0) + itemDelay,
        itemId: selectedItem.id,
        ...(multiple > 1 ? { multiple } : {}),
      });
      onClose();
    } else if (fusedLine) {
      // Calculate lead-in fuse burn time
      // leadInInches is user-provided (from FusedLineBuilderModal)
      // burn_rate is in seconds per foot (s/f)
      const lead_in_inches = fusedLine.leadInInches || 0;
      const lead_in_time_seconds = fusedLine.fuse?.burn_rate 
        ? (lead_in_inches / 12) * fusedLine.fuse.burn_rate 
        : 0;
      
      // Total delay = metaDelay + lead-in fuse burn + first shell's fuse delay + first shell's lift delay
      // This is the delay from firing command until first shell effect appears
      const firstShell = fusedLine.shells?.[0];
      const delay = (metaDelaySec || 0) 
        + lead_in_time_seconds  // Time for lead-in fuse to burn to first shell
        + (firstShell?.fuse_delay || 0)  // Time for first shell's fuse to burn
        + (firstShell?.lift_delay || 0);  // Time for first shell to lift
      
      onAdd({ 
        ...fusedLine, 
        startTime, 
        zone, 
        target, 
        name: metaLabel,  
        metaDelaySec,
        delay,
      });
      onClose();
    } else if (fusedItemLine) {
      // FUSED_LINE: a chain of items fired in sequence off a single cue.
      // The first step's `fuseDelay` is the wire-fuse burn from the cue to
      // the first item's ignition (parallel to FUSED_AERIAL_LINE's lead-in).
      const firstStepFuseDelay = fusedItemLine.firstStepFuseDelay || 0;
      const delay = (metaDelaySec || 0) + firstStepFuseDelay;

      onAdd({
        ...fusedItemLine,
        startTime,
        zone,
        target,
        name: metaLabel,
        metaDelaySec,
        delay,
      });
      onClose();
    } else if (rackShells) {
      // Calculate timing for rack shells
      let delay = metaDelaySec || 0;
      let duration = 2; // Default duration
      
      const fireableItem = rackShells.fireableItem;
      const rackSpacing = rackShells.rackSpacing || { x: 2.75, y: 2.75 };
      
      if (fireableItem?.type === 'fused' && fireableItem.fuse) {
        // For fused links, calculate timing similar to fused shell lines
        const fuse = fireableItem.fuse;
        const fuseItem = inventory.find(item => item.type === 'FUSE' && item.id === parseInt(fuse.type));
        const burn_rate = fuseItem?.burn_rate || 0;
        const leadInInches = fuse.leadIn || 0;
        
        // Calculate total fuse length between cells
        // Sum up the distances between consecutive cells
        let total_fuse_length_inches = 0;
        for (let i = 0; i < fireableItem.cells.length - 1; i++) {
          const cell1 = fireableItem.cells[i];
          const cell2 = fireableItem.cells[i + 1];
          const [x1, y1] = cell1.split('_').map(Number);
          const [x2, y2] = cell2.split('_').map(Number);
          
          // Calculate distance using rack spacing
          const xDiff = Math.abs(x2 - x1);
          const yDiff = Math.abs(y2 - y1);
          const distance = (xDiff * rackSpacing.x) + (yDiff * rackSpacing.y);
          total_fuse_length_inches += distance;
        }
        
        // Lead-in fuse burn time
        const lead_in_time = (leadInInches / 12) * burn_rate;
        
        // Fuse burn time between cells
        const fuse_burn_time = (total_fuse_length_inches / 12) * burn_rate;
        
        // Get the last shell's delays
        const lastCellData = fireableItem.cellData?.[fireableItem.cellData.length - 1];
        const lastShellId = lastCellData?.shellId;
        const lastShell = inventory.find(item => item.id === lastShellId);
        //const last_shell_delays = (lastShell?.lift_delay || 0) + (lastShell?.fuse_delay || 0);
        
        // Duration = fuse burn time between shells + last shell delays
        // Note: lead-in time is NOT included because startTime represents when the first shot fires,
        // and the lead-in happens before that (accounted for in delay, used by firing system)
        // + 0.5 seconds for the shell to "go off"
        duration = fuse_burn_time + 0.5;
        
        // Delay = metaDelay + lead-in fuse burn + first shell's fuse delay + first shell's lift delay
        const firstCellData = fireableItem.cellData?.[0];
        const firstShellId = firstCellData?.shellId;
        const firstShell = inventory.find(item => item.id === firstShellId);
        delay = (metaDelaySec || 0)
          + lead_in_time  // Time for lead-in fuse to burn to first shell
          + (firstShell?.fuse_delay || 0)  // Time for first shell's fuse to burn
          + (firstShell?.lift_delay || 0);  // Time for first shell to lift
      } else if (fireableItem?.type === 'single' && fireableItem.cellData) {
        // For single shells, use the shell's delays
        const cellData = fireableItem.cellData;
        const shell = inventory.find(item => item.id === cellData.shellId);
        if (shell) {
          delay = (metaDelaySec || 0) + (shell.fuse_delay || 0) + (shell.lift_delay || 0);
          duration = (shell.duration || 2);
        }
      }
      
      onAdd({
        ...rackShells,
        startTime,
        zone,
        target,
        name: metaLabel || rackShells.rackName,
        metaDelaySec,
        delay,
        duration
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
    setFusedItemLine(null);
    setRackShells(null);
    setFusedBuilderOpen(false);
    setFusedItemBuilderOpen(false);
    setIsRackShellsOpen(false);
    setMetaLabel("");
    setMetaDelaySec(0);
    setFireMultiple(false);
    setMultipleCount(2);
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

  const handleFusedItemLineAdd = (line) => {
    setFusedItemLine(line);
    setFusedItemBuilderOpen(false);
    if (!metaLabel) setMetaLabel(line.name || "Fused Line");
  };

  const handleFusedItemLineCancel = (forced) => {
    if (forced) {
      setSelectedType("CAKE_FOUNTAIN");
    }
    setFusedItemBuilderOpen(false);
  };

  if (!isOpen) return null;

  // Whether the user has selected/built something we can actually add.
  const canAdd =
    !!selectedItem ||
    !!fusedLine ||
    !!fusedItemLine ||
    !!rackShells ||
    selectedType === "GENERIC";

  // Item type categories that surface an inventory list inline.
  const showsInventoryList =
    !fusedLine &&
    !fusedItemLine &&
    !rackShells &&
    selectedType !== "FUSED_SHELL_LINE" &&
    selectedType !== "FUSED_LINE" &&
    selectedType !== "RACK_SHELLS" &&
    selectedType !== "GENERIC";

  const onTypeChange = (newType) => {
    setSelectedType(newType);
    setSelectedItem(null);
    setFireMultiple(false);
    setMultipleCount(2);
    if (newType === "FUSED_SHELL_LINE") {
      setFusedBuilderOpen(true);
    } else if (newType === "FUSED_LINE") {
      setFusedItemBuilderOpen(true);
    } else if (newType === "RACK_SHELLS") {
      setIsRackShellsOpen(true);
    } else {
      setFusedLine(null);
      setFusedItemLine(null);
      setRackShells(null);
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Add item to timeline"
        eyebrow={`Cue · t = ${Number(startTime || 0).toFixed(2)}s`}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleAdd}
              disabled={!canAdd}
            >
              Add to timeline
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Item type">
            <select
              className={selectClass}
              value={selectedType}
              onChange={(e) => onTypeChange(e.target.value)}
            >
              {ADD_ITEM_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>

          {/* Inline preview cards for composite items */}
          {fusedLine && (
            <Card tone="raised" padding="md">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="eyebrow mb-1">Fused shell line</div>
                  <div className="text-sm font-medium text-fg-primary truncate">
                    {fusedLine.fuse?.name}{" "}
                    <span className="text-fg-muted">·</span>{" "}
                    {fusedLine.shells?.length || 0} shells
                  </div>
                  <div className="num text-2xs text-fg-muted mt-0.5">
                    spacing {fusedLine.spacing}″ ·{" "}
                    {Number(fusedLine.duration || 0).toFixed(2)}s
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setFusedBuilderOpen(true)}
                >
                  Edit
                </Button>
              </div>
              <ol className="list-decimal list-inside text-2xs text-fg-secondary mt-3 space-y-0.5 pl-1">
                {fusedLine.shells?.map((shell, index) => (
                  <li key={index} className="truncate">
                    {shell?.name}
                  </li>
                ))}
              </ol>
            </Card>
          )}

          {rackShells && (
            <Card tone="raised" padding="md">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="eyebrow mb-1">Rack shells</div>
                  <div className="text-sm font-medium text-fg-primary truncate">
                    {rackShells.rackName}
                  </div>
                  <div className="text-2xs text-fg-muted mt-0.5">
                    {rackShells.fireableItem?.type === "single"
                      ? `Single shell · cell ${rackShells.fireableItem.cells[0]}`
                      : `Fused link · ${rackShells.fireableItem?.cells.length || 0} shells`}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setIsRackShellsOpen(true)}
                >
                  Change
                </Button>
              </div>
              <div className="text-2xs text-fg-muted mt-2 num">
                Cells: {rackShells.rackCells?.join(", ") || "—"}
              </div>
              {rackShells.fireableItem?.type === "fused" &&
                rackShells.fireableItem.fuse &&
                (() => {
                  const fuseItem = inventory.find(
                    (item) =>
                      item.type === "FUSE" &&
                      item.id === parseInt(rackShells.fireableItem.fuse.type)
                  );
                  return (
                    <div className="text-2xs text-fg-muted mt-1">
                      Fuse:{" "}
                      <span className="text-fg-secondary">
                        {fuseItem?.name || "Unknown"}
                      </span>{" "}
                      · lead-in{" "}
                      <span className="num">
                        {rackShells.fireableItem.fuse.leadIn || 0}″
                      </span>
                    </div>
                  );
                })()}
            </Card>
          )}

          {fusedItemLine && (
            <Card tone="raised" padding="md">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="eyebrow mb-1">Fused line</div>
                  <div className="text-sm font-medium text-fg-primary">
                    {fusedItemLine.steps?.length || 0} step
                    {fusedItemLine.steps?.length === 1 ? "" : "s"} ·{" "}
                    <span className="num">
                      {fusedItemLine.duration?.toFixed(2)}s
                    </span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setFusedItemBuilderOpen(true)}
                >
                  Edit
                </Button>
              </div>
              <ol className="text-2xs text-fg-secondary mt-3 space-y-0.5">
                {fusedItemLine.steps?.map((s, i) => (
                  <li key={i} className="flex items-baseline gap-2 min-w-0">
                    <span className="text-fg-muted shrink-0 num">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="truncate">
                      {s.name}
                      {s.multiple > 1 ? ` ×${s.multiple}` : ""}
                    </span>
                    <span className="num text-fg-muted shrink-0 ml-auto">
                      +{(s.fuseDelay || 0).toFixed(2)}s ·{" "}
                      {s.duration.toFixed(2)}s
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          {showsInventoryList && (
            <Field
              label="Item"
              hint={
                filteredInventory.length === 0
                  ? "No inventory of this type yet."
                  : `${filteredInventory.length} matching item${filteredInventory.length === 1 ? "" : "s"}`
              }
            >
              <Card tone="inset" padding="none">
                <ul className="max-h-44 overflow-y-auto py-1">
                  {filteredInventory.length === 0 && (
                    <li className="px-3 py-2 text-sm text-fg-muted">
                      Add some in the Inventory page first.
                    </li>
                  )}
                  {filteredInventory.map((item) => {
                    const selected = selectedItem?.id === item.id;
                    return (
                      <li
                        key={item.id}
                        className={cn(
                          "px-3 py-1.5 cursor-pointer text-sm flex items-center justify-between gap-3 transition-colors",
                          selected
                            ? "bg-accent-muted text-accent-fg"
                            : "hover:bg-surface-3 text-fg-primary"
                        )}
                        onClick={() => handleItemSelected(item)}
                      >
                        <span className="truncate">{item.name}</span>
                        <span className="num text-2xs text-fg-muted shrink-0">
                          {Number(item.duration || 0).toFixed(1)}s
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </Field>
          )}

          {supportsMultiple && (
            <Field
              label="Fire multiple"
              hint="Fire several physical units of this item from one cue. Used for loadout totals and cost."
            >
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-fg-secondary cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={fireMultiple}
                    onChange={(e) => setFireMultiple(e.target.checked)}
                  />
                  <span>Fire multiple</span>
                </label>
                {fireMultiple && (
                  <input
                    type="number"
                    min={2}
                    step={1}
                    className={inputClass + " w-24"}
                    value={multipleCount}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setMultipleCount(
                        Number.isFinite(v) && v >= 2 ? v : 2
                      );
                    }}
                  />
                )}
              </div>
            </Field>
          )}

          <Field label="Label">
            <input
              type="text"
              className={inputClass}
              value={metaLabel}
              onChange={(e) => setMetaLabel(e.target.value)}
              placeholder="Auto-fills from item name"
            />
          </Field>

          <Field
            label="Additional delay (sec)"
            hint="Padding added on top of the item's intrinsic fuse / lift delay."
          >
            <input
              type="number"
              step="0.01"
              min="0"
              className={inputClass}
              value={metaDelaySec}
              onChange={(e) =>
                setMetaDelaySec(parseFloat(e.target.value) || 0)
              }
              placeholder="0"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Zone">
              <select
                value={zone || ""}
                onChange={(e) => {
                  const newZone = e.target.value;
                  setZone(newZone);
                  if (newZone && availableDevices[newZone]) {
                    const firstAvailableTarget =
                      availableDevices[newZone].find(
                        (t) => !isOccupied(newZone, t)
                      ) || availableDevices[newZone][0];
                    setTarget(firstAvailableTarget);
                  }
                }}
                className={selectClass}
              >
                {Object.keys(availableDevices).map((k, i) => {
                  const label = receiverLabels?.[k];
                  const displayText = label ? `${label} (${k})` : k;
                  const fullyOccupied = isZoneFullyOccupied(k);
                  return (
                    <option key={i} value={k} disabled={fullyOccupied}>
                      {displayText}
                      {fullyOccupied ? " · full" : ""}
                    </option>
                  );
                })}
              </select>
            </Field>
            <Field label="Target">
              <select
                value={target ?? ""}
                onChange={(e) => setTarget(parseInt(e.target.value))}
                className={selectClass}
              >
                {zone &&
                  availableDevices[zone]?.map((k, i) => {
                    const occupied = isOccupied(zone, k);
                    return (
                      <option key={i} value={k} disabled={occupied}>
                        {k}
                        {occupied ? " · used" : ""}
                      </option>
                    );
                  })}
              </select>
            </Field>
          </div>

          {error ? (
            <div className="rounded-sm border border-danger/40 bg-danger-bg/60 px-3 py-2 text-xs text-danger-fg">
              {error}
            </div>
          ) : null}
        </div>
      </Modal>

      {/* FusedLineBuilderModal */}
      {isFusedBuilderOpen && (
        <FusedLineBuilderModal
          isOpen={isFusedBuilderOpen}
          onClose={handleFusedLineCancel}
          onAdd={handleFusedLineAdd}
          inventory={inventory}
        />
      )}

      {/* FusedItemLineBuilderModal (FUSED_LINE) */}
      {isFusedItemBuilderOpen && (
        <FusedItemLineBuilderModal
          isOpen={isFusedItemBuilderOpen}
          onClose={handleFusedItemLineCancel}
          onAdd={handleFusedItemLineAdd}
          inventory={inventory}
          initialLine={fusedItemLine}
        />
      )}

      {/* RackShellsSelector */}
      {isRackShellsOpen && (
        <Modal
          isOpen={isRackShellsOpen}
          onClose={() => {
            setIsRackShellsOpen(false);
            if (!rackShells) setSelectedType("CAKE_FOUNTAIN");
          }}
          title="Select rack shells"
          size="2xl"
          layer={1}
        >
          <RackShellsSelector
            onSelect={(picked) => {
              setRackShells(picked);
              setIsRackShellsOpen(false);
              if (!metaLabel) {
                setMetaLabel(picked.rackName);
              }
            }}
            onClose={() => {
              setIsRackShellsOpen(false);
              if (!rackShells) setSelectedType("CAKE_FOUNTAIN");
            }}
            items={items}
            inventory={inventory}
            showId={showMetadata?.id}
          />
        </Modal>
      )}
    </>
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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Chain timing"
      eyebrow={`${selectedItems.length} items selected`}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleApply}
            disabled={selectedItems.length < 2}
          >
            Apply spacing
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-secondary leading-snug">
          Re-time the selected items in their current order, starting at{" "}
          <span className="num text-fg-primary">{startTime.toFixed(2)}s</span>{" "}
          and stepping every{" "}
          <span className="num text-fg-primary">
            {intervalSeconds.toFixed(2)}s
          </span>
          .
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Start time (sec)">
            <input
              type="number"
              step="0.1"
              className={inputClass}
              value={startTime}
              onChange={(e) => setStartTime(parseFloat(e.target.value) || 0)}
            />
          </Field>
          <Field label="Interval (sec)">
            <input
              type="number"
              step="0.1"
              min="0"
              className={inputClass}
              value={intervalSeconds}
              onChange={(e) =>
                setIntervalSeconds(parseFloat(e.target.value) || 0)
              }
            />
          </Field>
        </div>

        <Card tone="inset" padding="sm">
          <div className="eyebrow mb-2">Preview</div>
          <ul className="flex flex-col gap-1 text-sm">
            {selectedItems.slice(0, 5).map((item, index) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 min-w-0"
              >
                <span className="truncate text-fg-secondary">{item.name}</span>
                <span className="num text-fg-muted">
                  {(startTime + index * intervalSeconds).toFixed(2)}s
                </span>
              </li>
            ))}
            {selectedItems.length > 5 && (
              <li className="text-2xs text-fg-muted italic">
                +{selectedItems.length - 5} more…
              </li>
            )}
          </ul>
        </Card>
      </div>
    </Modal>
  );
};

const TestShowBuilder = ({ receivers, onGenerate, currentIndex, setCurrentIndex, inventory, inventoryById, availableDevices }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedReceivers, setSelectedReceivers] = useState([]);
  const [startTime, setStartTime] = useState(5);
  const [cadence, setCadence] = useState(1);
  const [pattern, setPattern] = useState("row"); // "row" or "sequential"

  // Only show receivers the user actually wants to fire on. The DB's
  // Receivers.enabled flag is mirrored into the receiver record (see
  // useAppStore.fetchReceivers). Disabled receivers are kept around for
  // historical / inspection purposes but should never seed test cues --
  // the daemon won't poll them and the dongle would refuse to address
  // them, so generating items for them just produces dead cues that
  // confuse the operator at run time.
  const availableReceivers = Object.entries(receivers || {})
    .filter(([_, rcv]) => rcv?.enabled !== false)
    .map(([key]) => key);

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

  const handleTestAllCakes = () => {
    if (!inventory || !availableDevices || Object.keys(availableDevices).length === 0) {
      alert("No inventory or available devices found");
      return;
    }

    // Filter for cakes used in quick test layout
    const cakeItems = inventory.filter(item =>
      item.type === "CAKE_200G" ||
      item.type === "CAKE_350G" ||
      item.type === "CAKE_500G" ||
      item.type === "COMPOUND_CAKE"
    );

    if (cakeItems.length === 0) {
      alert("No 200g, 350g, 500g, or compound cakes found in inventory");
      return;
    }

    // Create a flat list of all available zone/target combinations
    const availableSlots = [];
    Object.entries(availableDevices).forEach(([zone, targets]) => {
      targets.forEach(target => {
        availableSlots.push({ zone, target });
      });
    });

    if (availableSlots.length === 0) {
      alert("No available device slots found");
      return;
    }

    // Generate items, assigning each cake to an available slot and chaining them back-to-back
    const newItems = [];
    let itemId = currentIndex;
    let currentTime = startTime;
    let slotIndex = 0;

    cakeItems.forEach((cakeItem) => {
      // Get the next available slot (wrap around if needed)
      const slot = availableSlots[slotIndex % availableSlots.length];
      slotIndex++;

      // Use the cake's actual duration, default to 5 seconds if not set
      const duration = cakeItem.duration || 5;

      newItems.push({
        id: itemId++,
        itemId: cakeItem.id,
        type: cakeItem.type,
        name: cakeItem.name,
        startTime: currentTime,
        zone: slot.zone,
        target: slot.target,
        duration: duration,
        delay: 0
      });

      // Next cake starts when this one ends
      currentTime += duration;
    });

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
          <div className="flex gap-2">
            <button
              onClick={handleTestAllCakes}
              className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded text-sm"
            >
              Test All Cakes
            </button>
            <button
              onClick={handleGenerate}
              className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded text-sm"
              disabled={selectedReceivers.length === 0}
            >
              Generate
            </button>
          </div>
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

// Tab strip for the multi-track audio editor. One tab per track, plus
// a trailing "+ Add track" button. Tabs are draggable horizontally to
// reorder song playback, and double-click a tab to delete it (deletion
// is also exposed via the editor card's Delete button).
const AudioTrackTabs = ({
  tracks,
  activeTrackId,
  audioOffsets,
  onSelect,
  onAdd,
  onRemove,
  onReorder,
}) => {
  const [dragSrc, setDragSrc] = useState(-1);
  const [dragOverIdx, setDragOverIdx] = useState(-1);

  const handleDragStart = (e, idx) => {
    setDragSrc(idx);
    e.dataTransfer.effectAllowed = "move";
    // Required for Firefox to actually start the drag.
    try { e.dataTransfer.setData("text/plain", String(idx)); } catch (_) { /* */ }
  };
  const handleDragOver = (e, idx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverIdx !== idx) setDragOverIdx(idx);
  };
  const handleDrop = (e, idx) => {
    e.preventDefault();
    if (dragSrc >= 0 && dragSrc !== idx) onReorder?.(dragSrc, idx);
    setDragSrc(-1);
    setDragOverIdx(-1);
  };
  const handleDragEnd = () => {
    setDragSrc(-1);
    setDragOverIdx(-1);
  };

  const fmtOffset = (sec) => {
    if (!Number.isFinite(sec)) return "—";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  return (
    <div className="flex items-end gap-1 -mb-px">
      {tracks.map((t, idx) => {
        const isActive = t.id === activeTrackId;
        const isDropTarget = dragOverIdx === idx && dragSrc !== idx;
        return (
          <div
            key={t.id}
            draggable
            onDragStart={(e) => handleDragStart(e, idx)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDrop={(e) => handleDrop(e, idx)}
            onDragEnd={handleDragEnd}
            onClick={() => onSelect?.(t.id)}
            className={cn(
              "group relative inline-flex items-center gap-2 px-3 h-9 text-sm cursor-pointer select-none",
              "border border-b-0 rounded-t-md",
              isActive
                ? "bg-gray-800 border-gray-700 text-white"
                : "bg-gray-900 border-gray-800 text-gray-400 hover:text-gray-200",
              isDropTarget && "ring-2 ring-blue-500"
            )}
            title={`${t.name || "Untitled"}${
              Number.isFinite(t.durationSec)
                ? ` · ${fmtOffset(t.durationSec)}`
                : ""
            } · drag to reorder`}
          >
            <span className="text-gray-500 text-xs num">
              {String(idx + 1).padStart(2, "0")}
            </span>
            <span className="max-w-[12rem] truncate">
              {t.name || "Untitled"}
            </span>
            <span className="num text-xs text-gray-500">
              {fmtOffset(audioOffsets?.[idx] || 0)}
            </span>
            {tracks.length > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove?.(t.id);
                }}
                className={cn(
                  "ml-1 rounded-sm w-5 h-5 inline-flex items-center justify-center text-xs",
                  "text-gray-500 hover:text-red-400 hover:bg-gray-700/60"
                )}
                title="Delete this track"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        className={cn(
          "inline-flex items-center gap-1.5 px-3 h-9 text-sm rounded-t-md",
          "bg-gray-900 border border-b-0 border-gray-800 text-gray-300",
          "hover:bg-gray-800 hover:text-white"
        )}
        title="Add another song to the show"
      >
        + Add track
      </button>
    </div>
  );
};

// One wavesurfer instance bound to one track. All TrackPlayers in a show
// stay mounted in the DOM at once -- the inactive ones are hidden but
// keep their decoded audio + waveform peaks resident, which is the whole
// point: when playback hands off to the next song there is no fetch /
// decode / "ready" wait, just a CSS visibility flip plus a play() call
// on an already-warm wavesurfer.
//
// Only the active player forwards audio events (audioprocess, finish,
// play/pause) up to the parent so we don't double-up on time updates or
// trigger spurious global play/pause toggles when the *previous* track
// emits a 'pause' as part of its end-of-stream cleanup.
const TrackPlayer = ({
  track,                    // owning track object
  isActive,                 // is this the currently selected/playing track?
  isPlayingShow,            // global play state (whole-show)
  localTime,                // controlled local-time within this track (only meaningful when active)
  onLocalTimeUpdate,        // (localSec) => void  (active only)
  onPlayChange,             // (playing) => void   (active only)
  onTrackEnded,             // () => void          (active only)
  onTrackReady,             // (trackId, durationSec) => void  (always; signals duration + warm)
  onTrackUnready,           // (trackId) => void   (e.g. URL change tearing down ws)
}) => {
  const containerRef = useRef(null);
  const wsRef = useRef(null);

  // Sync isActive into a ref BEFORE the active-gate effect runs, so any
  // ws events fired synchronously by our own pause()/play() calls see the
  // up-to-date active state and don't bubble back as global toggles.
  const isActiveRef = useRef(isActive);
  const isPlayingShowRef = useRef(isPlayingShow);
  const localTimeRef = useRef(0);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  useEffect(() => { isPlayingShowRef.current = isPlayingShow; }, [isPlayingShow]);
  useEffect(() => {
    if (isActive) localTimeRef.current = Number.isFinite(localTime) ? localTime : 0;
  }, [localTime, isActive]);

  // Callback refs prevent stale closures inside the wavesurfer event
  // listeners (which are wired once at ws creation).
  const onLocalTimeUpdateRef = useRef(null);
  const onPlayChangeRef = useRef(null);
  const onTrackEndedRef = useRef(null);
  const onTrackReadyRef = useRef(null);
  const onTrackUnreadyRef = useRef(null);
  useEffect(() => { onLocalTimeUpdateRef.current = onLocalTimeUpdate; }, [onLocalTimeUpdate]);
  useEffect(() => { onPlayChangeRef.current = onPlayChange; }, [onPlayChange]);
  useEffect(() => { onTrackEndedRef.current = onTrackEnded; }, [onTrackEnded]);
  useEffect(() => { onTrackReadyRef.current = onTrackReady; }, [onTrackReady]);
  useEffect(() => { onTrackUnreadyRef.current = onTrackUnready; }, [onTrackUnready]);

  const lastUpdateRef = useRef(0);
  const throttleInterval = 100;

  const trackUrl = track?.url || null;
  const trackId = track?.id || null;

  // Build the wavesurfer instance keyed on track URL. We deliberately
  // don't tear down on isActive flips -- only when the audio source
  // changes (file replaced) or the track is unmounted (deleted).
  useEffect(() => {
    if (!containerRef.current) return;
    const ws = WaveSurfer.create({
      container: containerRef.current,
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
    wsRef.current = ws;

    ws.on('ready', () => {
      const dur = ws.getDuration();
      // Always report ready+duration so the parent can populate
      // durationSec for off-screen tracks (used by show offsets).
      onTrackReadyRef.current?.(trackId, dur);
      if (!isActiveRef.current) return;
      // Active-track promotion at ready time: align playhead and
      // resume playback if the show is currently rolling.
      if (dur > 0) {
        const t = Math.min(dur, Math.max(0, localTimeRef.current || 0));
        try { ws.seekTo(t / dur); } catch (_) { /* ignore */ }
      }
      if (isPlayingShowRef.current) {
        try { ws.play(); } catch (_) { /* ignore */ }
      }
    });

    ws.on('audioprocess', (t) => {
      if (!isActiveRef.current) return;
      const now = Date.now();
      if (now - lastUpdateRef.current >= throttleInterval) {
        onLocalTimeUpdateRef.current?.(t);
        lastUpdateRef.current = now;
      }
    });

    ws.on('seek', (progress) => {
      if (!isActiveRef.current) return;
      const now = Date.now();
      if (now - lastUpdateRef.current >= throttleInterval) {
        const t = progress * ws.getDuration();
        onLocalTimeUpdateRef.current?.(t);
        lastUpdateRef.current = now;
      }
    });

    ws.on('play', () => {
      if (!isActiveRef.current) return;
      onPlayChangeRef.current?.(true);
    });
    ws.on('pause', () => {
      if (!isActiveRef.current) return;
      // Don't bubble a "pause" that's actually the natural end of the
      // track -- the 'finish' handler owns that transition and a stray
      // setIsAudioPlaying(false) here would tear playback down right as
      // we're about to swap to the next track.
      const dur = ws.getDuration?.() || 0;
      const t = ws.getCurrentTime?.() ?? 0;
      if (dur > 0 && dur - t < 0.1) return;
      onPlayChangeRef.current?.(false);
    });
    ws.on('finish', () => {
      if (!isActiveRef.current) return;
      onTrackEndedRef.current?.();
    });
    ws.on('error', (err) => console.error('WaveSurfer error:', err));

    if (trackUrl) {
      // ws.load() returns a Promise that aborts (rejects with
      // AbortError) when the instance is destroyed mid-load. That
      // happens routinely under React StrictMode's mount/unmount
      // double-invoke and whenever the user swaps the audio file or
      // deletes the track. Swallow that specific case so it doesn't
      // surface as an unhandled rejection; report anything else.
      Promise.resolve()
        .then(() => ws.load(trackUrl))
        .catch((err) => {
          if (err?.name === 'AbortError') return;
          console.error('WaveSurfer load failed:', err);
        });
    }

    return () => {
      try { onTrackUnreadyRef.current?.(trackId); } catch (_) { /* ignore */ }
      try { ws.destroy(); } catch (_) { /* ignore */ }
      wsRef.current = null;
    };
    // Re-create when the audio source changes; also re-key on trackId so
    // a removed track's ws is torn down with the component.
  }, [trackId, trackUrl]);

  // Active gate. When this player becomes inactive, pause it. When it
  // becomes active, snap to the requested local time and (un)play to
  // match the global show state. The 'ready' handler covers the case
  // where this player is still loading at the moment it becomes active.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    if (!isActive) {
      try { ws.pause(); } catch (_) { /* ignore */ }
      return;
    }
    const dur = ws.getDuration?.() || 0;
    if (dur <= 0) return; // 'ready' will sync once decoded
    const t = Math.min(dur, Math.max(0, localTimeRef.current || 0));
    try { ws.seekTo(t / dur); } catch (_) { /* ignore */ }
    if (isPlayingShowRef.current) {
      try { ws.play(); } catch (_) { /* ignore */ }
    } else {
      try { ws.pause(); } catch (_) { /* ignore */ }
    }
  }, [isActive]);

  // External play/pause from the show-level button -> ws (active only).
  useEffect(() => {
    if (!isActive) return;
    const ws = wsRef.current;
    if (!ws) return;
    if ((ws.getDuration?.() || 0) <= 0) return; // ready handler will sync
    if (isPlayingShow) {
      try { ws.play(); } catch (_) { /* ignore */ }
    } else {
      try { ws.pause(); } catch (_) { /* ignore */ }
    }
  }, [isActive, isPlayingShow]);

  // External seek (timeline click) -> ws (active only). The tolerance
  // avoids a feedback loop with throttled audioprocess updates.
  useEffect(() => {
    if (!isActive) return;
    const ws = wsRef.current;
    if (!ws) return;
    const dur = ws.getDuration?.() || 0;
    if (dur <= 0) return;
    if (!isFinite(localTime) || localTime < 0) return;
    const cur = ws.getCurrentTime?.() ?? 0;
    if (Math.abs(cur - localTime) < 0.15) return;
    try { ws.seekTo(Math.min(1, localTime / dur)); } catch (_) { /* ignore */ }
  }, [isActive, localTime]);

  return (
    <div
      ref={containerRef}
      className="w-full bg-gray-900 rounded min-h-[80px]"
      style={{ display: isActive ? 'block' : 'none' }}
    />
  );
};

// Multi-track audio editor. Owns the BPM/upload/tap UI bound to the
// currently active track, and renders one TrackPlayer per track in the
// show. Only the active player's container is visible; all others stay
// mounted (and their wavesurfers stay loaded) so transitioning between
// songs is instant -- no fetch / decode / 'ready' wait.
const AudioWaveform = ({
  tracks,                   // full list of tracks in the show
  activeTrackId,            // id of the active track
  localTime,                // controlled local-time within the active track
  isPlaying,                // controlled play/pause state (whole-show level)
  onLocalTimeUpdate,        // (localSec) => void
  onPlayChange,             // (playing: boolean) => void
  onTrackEnded,             // () => void  (active wavesurfer 'finish')
  onTrackDurationKnown,     // (trackId, durationSec) => void  (per-track 'ready')
  onAudioFileUploaded,      // (file: File) => void  (parent uploads + updates active track)
  onBpmInfoChange,          // (patch) => void  (per-track BPM edit)
  onTrackRemove,            // optional: () => void  (delete the active track)
  trackLabel,               // string shown in the editor header
  isUploading,              // whether the parent is currently uploading audio
  isAutoDetecting,          // whether the parent is auto-detecting BPM in the background
}) => {
  const track = tracks?.find((t) => t.id === activeTrackId) || null;
  // Cache the most recently uploaded File handle so "Detect BPM" can run
  // without an extra fetch. After a page reload the cache is gone and we
  // fall back to fetching the persisted URL.
  const lastFileRef = useRef(null);
  // Tracks which TrackPlayers have hit 'ready' so we can derive the
  // active player's readiness for the play button. When a track URL
  // changes its TrackPlayer rebuilds and emits onTrackUnready first.
  const [readyTrackIds, setReadyTrackIds] = useState(() => new Set());
  const [trackDurations, setTrackDurations] = useState(() => ({}));
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);
  const tapTimesRef = useRef([]);
  const tapTimeoutRef = useRef(null);
  const [tapCount, setTapCount] = useState(0);

  const trackUrl = track?.url || null;
  const isReady = activeTrackId ? readyTrackIds.has(activeTrackId) : false;
  const localDuration = activeTrackId ? trackDurations[activeTrackId] || 0 : 0;

  const handleTrackReady = (trackId, dur) => {
    setReadyTrackIds((prev) => {
      if (prev.has(trackId)) return prev;
      const next = new Set(prev);
      next.add(trackId);
      return next;
    });
    if (Number.isFinite(dur) && dur > 0) {
      setTrackDurations((prev) =>
        Math.abs((prev[trackId] || 0) - dur) < 0.01 ? prev : { ...prev, [trackId]: dur }
      );
      onTrackDurationKnown?.(trackId, dur);
    }
  };

  const handleTrackUnready = (trackId) => {
    setReadyTrackIds((prev) => {
      if (!prev.has(trackId)) return prev;
      const next = new Set(prev);
      next.delete(trackId);
      return next;
    });
  };

  // Per-track BPM info derived from the active track. Falls back to
  // defaults when the track has no BPM yet.
  const info = {
    bpm: Number.isFinite(track?.bpm) ? track.bpm : null,
    firstBeatOffsetSec: Number.isFinite(track?.firstBeatOffsetSec)
      ? track.firstBeatOffsetSec
      : 0,
    beatsPerMeasure: Number.isFinite(track?.beatsPerMeasure)
      ? track.beatsPerMeasure
      : 4,
    confidence: Number.isFinite(track?.bpmConfidence) ? track.bpmConfidence : null,
    source: track?.bpmSource || null,
  };
  const patchBpmInfo = (patch) => {
    if (typeof onBpmInfoChange === "function") {
      onBpmInfoChange({ ...info, ...patch });
    }
  };

  // Reset per-track scratch state (cached File for re-detect, tap-tempo
  // buffer, analysis error) when the active track switches so a "Detect
  // BPM" / "Tap" press on the new tab can't be applied to the previous
  // tab's audio by accident.
  useEffect(() => {
    setAnalysisError(null);
    lastFileRef.current = null;
    tapTimesRef.current = [];
    setTapCount(0);
    if (tapTimeoutRef.current) {
      clearTimeout(tapTimeoutRef.current);
      tapTimeoutRef.current = null;
    }
  }, [activeTrackId]);

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file || !file.type.startsWith('audio/')) return;
    lastFileRef.current = file;
    setAnalysisError(null);
    if (typeof onAudioFileUploaded === "function") {
      onAudioFileUploaded(file);
    }
    // Reset the file input so re-picking the same file fires onChange.
    try { event.target.value = ""; } catch (_) { /* ignore */ }
  };

  const handleDetectBpm = async () => {
    const source = lastFileRef.current || trackUrl;
    if (!source) {
      setAnalysisError("Pick an audio file first.");
      return;
    }
    setIsAnalyzing(true);
    setAnalysisError(null);
    try {
      const result = await analyzeAudioFile(source);
      patchBpmInfo({
        bpm: result.bpm,
        firstBeatOffsetSec: result.firstBeatOffsetSec,
        confidence: result.confidence,
        source: "auto",
      });
    } catch (err) {
      console.error("BPM analysis failed:", err);
      setAnalysisError(err?.message || "BPM analysis failed");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleTap = () => {
    const now = performance.now();
    if (tapTimeoutRef.current) clearTimeout(tapTimeoutRef.current);
    tapTimeoutRef.current = setTimeout(() => {
      tapTimesRef.current = [];
      setTapCount(0);
    }, 2500);

    tapTimesRef.current = [...tapTimesRef.current, now].slice(-8);
    setTapCount(tapTimesRef.current.length);
    const bpm = bpmFromTapTimes(tapTimesRef.current);
    if (bpm && bpm >= 30 && bpm <= 300) {
      patchBpmInfo({ bpm, source: "tap" });
    }
  };

  const handleSetFirstBeatHere = () => {
    if (!isFinite(localTime) || localTime < 0) return;
    patchBpmInfo({ firstBeatOffsetSec: Number(localTime.toFixed(3)), source: "manual" });
  };

  const halveBpm = () => {
    if (!info.bpm) return;
    patchBpmInfo({ bpm: Number((info.bpm / 2).toFixed(2)), source: "manual" });
  };
  const doubleBpm = () => {
    if (!info.bpm) return;
    patchBpmInfo({ bpm: Number((info.bpm * 2).toFixed(2)), source: "manual" });
  };

  // Nudge the first-beat phase by ±50ms. Used by the fine-sync buttons
  // next to the "First beat (s)" input so the user can shift the grid
  // by ear while the song is playing.
  const FIRST_BEAT_NUDGE_SEC = 0.05;
  const nudgeFirstBeat = (deltaSec) => {
    const cur = Number.isFinite(info.firstBeatOffsetSec)
      ? info.firstBeatOffsetSec
      : 0;
    patchBpmInfo({
      firstBeatOffsetSec: Number((cur + deltaSec).toFixed(3)),
      source: "manual",
    });
  };

  // Derive whether the playhead is currently sitting on a downbeat.
  // Drives the blinking indicator next to the First-Beat controls; the
  // indicator pulses bright for ~150ms after each measure boundary
  // (assuming localTime updates ~10x/sec via the audioprocess throttle).
  // When paused this just reflects whether the static playhead lies on
  // a downbeat, which is also useful for verifying the offset by eye.
  const onBeat = (() => {
    if (!info.bpm || info.bpm <= 0) return false;
    if (!Number.isFinite(localTime)) return false;
    const period = 60 / info.bpm;
    const measureLen = period * (info.beatsPerMeasure || 4);
    const offset = info.firstBeatOffsetSec || 0;
    if (localTime < offset - 0.05) return false;
    const phase = ((localTime - offset) % measureLen + measureLen) % measureLen;
    return phase < 0.15;
  })();

  const handlePlayClick = () => {
    if (typeof onPlayChange === "function") onPlayChange(!isPlaying);
  };

  const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const hasAudio = !!trackUrl;

  return (
    <div className="p-4 bg-gray-800 rounded-b-lg border border-t-0 border-gray-700">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-gray-400">
            Track
          </div>
          <h3 className="text-base font-semibold text-white truncate">
            {trackLabel || track?.name || "Untitled track"}
          </h3>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <label
            className="text-sm text-gray-300 inline-flex items-center"
            title={hasAudio ? "Replace this track's audio" : "Upload audio for this track"}
          >
            <input
              type="file"
              accept="audio/*"
              onChange={handleFileUpload}
              className="text-sm text-gray-300 file:mr-3 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700"
            />
          </label>
          {isUploading && (
            <span className="text-xs text-gray-400">Uploading…</span>
          )}
          {!isUploading && isAutoDetecting && (
            <span className="text-xs text-gray-400">Detecting BPM…</span>
          )}
          {hasAudio && (
            <>
              <button
                type="button"
                onClick={handlePlayClick}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
                title="Play / pause the show preview"
                disabled={!isReady}
              >
                {isPlaying ? 'Pause' : 'Play'}
              </button>
              <span className="text-sm text-gray-300 num">
                {formatTime(localTime || 0)} / {formatTime(localDuration || 0)}
              </span>
            </>
          )}
          {typeof onTrackRemove === "function" && (
            <button
              type="button"
              onClick={onTrackRemove}
              className="text-gray-400 hover:text-red-400 text-sm px-2 h-9"
              title="Delete this track"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {/* All TrackPlayers stay mounted; only the active one is visible.
          Keeping the others warm is the entire reason transitions
          between songs are gap-free. */}
      <div>
        {tracks?.map((t) => (
          <TrackPlayer
            key={t.id}
            track={t}
            isActive={t.id === activeTrackId}
            isPlayingShow={!!isPlaying}
            localTime={t.id === activeTrackId ? localTime : 0}
            onLocalTimeUpdate={onLocalTimeUpdate}
            onPlayChange={onPlayChange}
            onTrackEnded={onTrackEnded}
            onTrackReady={handleTrackReady}
            onTrackUnready={handleTrackUnready}
          />
        ))}
      </div>

      {!hasAudio && (
        <div className="text-center text-gray-400 text-sm mt-2">
          Pick an audio file to populate this track.
        </div>
      )}

      {hasAudio && (
        <div className="mt-3 rounded border border-gray-700 bg-gray-900/40 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-gray-400 mb-1">
                BPM
              </label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={halveBpm}
                  disabled={!info.bpm}
                  className="px-2 h-8 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white rounded"
                  title="Halve BPM"
                >
                  ÷2
                </button>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="w-24 h-8 px-2 text-sm bg-gray-700 text-white rounded"
                  value={info.bpm ?? ""}
                  placeholder="—"
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    patchBpmInfo({
                      bpm: Number.isFinite(v) && v > 0 ? v : null,
                      source: "manual",
                    });
                  }}
                />
                <button
                  type="button"
                  onClick={doubleBpm}
                  disabled={!info.bpm}
                  className="px-2 h-8 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white rounded"
                  title="Double BPM"
                >
                  ×2
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-wide text-gray-400 mb-1 flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    "inline-block w-2.5 h-2.5 rounded-full transition-opacity duration-100",
                    "bg-yellow-400",
                    onBeat
                      ? "opacity-100 shadow-[0_0_8px_2px_rgb(250_204_21_/_0.8)]"
                      : "opacity-25"
                  )}
                  title={
                    info.bpm
                      ? "Pulses on each downbeat -- play the song and nudge ±50ms until it lines up with what you hear"
                      : "Detect a BPM to enable downbeat tracking"
                  }
                />
                First beat (s)
              </label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => nudgeFirstBeat(-FIRST_BEAT_NUDGE_SEC)}
                  disabled={!info.bpm}
                  className="h-8 w-8 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white rounded"
                  title="Shift the first-beat phase 50ms earlier (useful for fine-syncing while the song is playing)"
                >
                  −50
                </button>
                <input
                  type="number"
                  step="0.01"
                  className="w-24 h-8 px-2 text-sm bg-gray-700 text-white rounded"
                  value={info.firstBeatOffsetSec ?? 0}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    patchBpmInfo({
                      firstBeatOffsetSec: Number.isFinite(v) ? v : 0,
                      source: "manual",
                    });
                  }}
                />
                <button
                  type="button"
                  onClick={() => nudgeFirstBeat(FIRST_BEAT_NUDGE_SEC)}
                  disabled={!info.bpm}
                  className="h-8 w-8 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white rounded"
                  title="Shift the first-beat phase 50ms later"
                >
                  +50
                </button>
                <button
                  type="button"
                  onClick={handleSetFirstBeatHere}
                  className="h-8 px-2 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded whitespace-nowrap"
                  title="Use the playhead position as the first downbeat"
                >
                  Use playhead
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-wide text-gray-400 mb-1">
                Beats / measure
              </label>
              <select
                className="h-8 px-2 text-sm bg-gray-700 text-white rounded"
                value={info.beatsPerMeasure}
                onChange={(e) =>
                  patchBpmInfo({
                    beatsPerMeasure: parseInt(e.target.value, 10) || 4,
                  })
                }
              >
                {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={handleTap}
                className="h-8 px-3 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded"
                title="Tap in time with the music to set BPM (resets after 2.5s of inactivity)"
              >
                Tap{tapCount > 1 ? ` (${tapCount})` : ""}
              </button>
              <button
                type="button"
                onClick={handleDetectBpm}
                disabled={isAnalyzing || (!lastFileRef.current && !trackUrl)}
                className="h-8 px-3 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded"
              >
                {isAnalyzing ? "Detecting…" : "Detect BPM"}
              </button>
            </div>
          </div>

          <div className="mt-2 flex items-center gap-3 text-[11px] text-gray-400">
            {info.source && (
              <span>
                source: <span className="text-gray-300">{info.source}</span>
              </span>
            )}
            {info.confidence != null && info.source === "auto" && (
              <span>
                confidence:{" "}
                <span className="text-gray-300">
                  {(info.confidence * 100).toFixed(0)}%
                </span>
              </span>
            )}
            {analysisError && (
              <span className="text-red-400">{analysisError}</span>
            )}
            <span className="text-gray-500 ml-auto">
              Tip: if Detect comes back at half/double the right tempo, hit ×2 or ÷2.
            </span>
          </div>
        </div>
      )}

    </div>
  );
};

// Modal shown during the Copy Item flow. After the user clicks the source
// item in the timeline, this prompts for which receiver/cue (zone+target) the
// duplicate should land on. After confirming, the parent puts the builder in
// "place" mode so the next timeline click drops the copy.
const CopyItemTargetModal = ({ isOpen, onClose, onConfirm, sourceItem, items, availableDevices, receiverLabels }) => {
  const [zone, setZone] = useState(null);
  const [target, setTarget] = useState(null);
  const [error, setError] = useState("");

  const isOccupied = (zoneName, targetValue) =>
    items.some((it) => it.zone === zoneName && it.target === targetValue);

  const isZoneFullyOccupied = (zoneName) => {
    if (!availableDevices?.[zoneName]) return false;
    return availableDevices[zoneName].every((t) => isOccupied(zoneName, t));
  };

  // Default selection: prefer the source item's zone+target if free, else the
  // first unoccupied slot we can find.
  useEffect(() => {
    if (!isOpen || !availableDevices) return;
    const zones = Object.keys(availableDevices);
    if (zones.length === 0) return;

    const preferZone = sourceItem?.zone && availableDevices[sourceItem.zone] ? sourceItem.zone : null;
    const findFirstFreeIn = (z) => availableDevices[z]?.find((t) => !isOccupied(z, t));

    if (preferZone) {
      const free = findFirstFreeIn(preferZone);
      if (free !== undefined) {
        setZone(preferZone);
        setTarget(free);
        setError("");
        return;
      }
    }
    for (const z of zones) {
      const free = findFirstFreeIn(z);
      if (free !== undefined) {
        setZone(z);
        setTarget(free);
        setError("");
        return;
      }
    }
    setZone(zones[0]);
    setTarget(availableDevices[zones[0]]?.[0] ?? null);
    setError("");
  }, [isOpen, sourceItem, availableDevices]);

  if (!isOpen) return null;

  const handleConfirm = () => {
    if (zone == null || target == null) {
      setError("Pick a zone and target.");
      return;
    }
    if (isOccupied(zone, target)) {
      setError(`Zone ${zone} Target ${target} is already in use.`);
      return;
    }
    onConfirm(zone, target);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Copy "${sourceItem?.name || "item"}"`}
      eyebrow="Step 1 of 2 · pick destination"
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleConfirm}>
            Continue
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-secondary leading-snug">
          Pick a receiver and cue for the copy. After confirming, click a spot
          on the timeline to drop it.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Zone">
            <select
              value={zone ?? ""}
              onChange={(e) => {
                const newZone = e.target.value;
                setZone(newZone);
                if (newZone && availableDevices[newZone]) {
                  const firstFree =
                    availableDevices[newZone].find(
                      (t) => !isOccupied(newZone, t)
                    ) ?? availableDevices[newZone][0];
                  setTarget(firstFree);
                }
              }}
              className={selectClass}
            >
              {Object.keys(availableDevices || {}).map((k, i) => {
                const label = receiverLabels?.[k];
                const displayText = label ? `${label} (${k})` : k;
                const fullyOccupied = isZoneFullyOccupied(k);
                return (
                  <option key={i} value={k} disabled={fullyOccupied}>
                    {displayText}
                    {fullyOccupied ? " · full" : ""}
                  </option>
                );
              })}
            </select>
          </Field>
          <Field label="Target">
            <select
              value={target ?? ""}
              onChange={(e) => setTarget(parseInt(e.target.value))}
              className={selectClass}
            >
              {zone &&
                availableDevices?.[zone]?.map((k, i) => {
                  const occupied = isOccupied(zone, k);
                  return (
                    <option key={i} value={k} disabled={occupied}>
                      {k}
                      {occupied ? " · used" : ""}
                    </option>
                  );
                })}
            </select>
          </Field>
        </div>

        {error ? (
          <div className="rounded-sm border border-danger/40 bg-danger-bg/60 px-3 py-2 text-xs text-danger-fg">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
};

const ShowBuilder = (props) => {
  const {
    systemConfig,
    receivers,
    inventory,
    inventoryById,
    stagedShow,
    setStagedShow,
    updateShow,
  } = useAppStore();
  const [items, setItems] = useState([]);
  const [showMetadata, setShowMetadata] = useState({});
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [addItemStartTime, setAddItemStartTime] = useState(0);
  const [selectedItem, setSelectedItem] = useState(false);
  const [selectedItems, setSelectedItems] = useState([]);
  const [isChainTimingModalOpen, setIsChainTimingModalOpen] = useState(false);
  const [isPopupVisible, setPopupVisible] = useState(false);
  // Multi-track audio. The canonical list of tracks for the show; each
  // entry has its own URL, BPM, duration, etc. Tracks play sequentially
  // back-to-back with no gap. The "active" track is the one shown in
  // the per-track editor below the tab strip.
  const [audioTracks, setAudioTracks] = useState([]);
  const [activeTrackId, setActiveTrackId] = useState(null);
  // Show-time cursor across the whole audio: cumulative position
  // covering all tracks, in seconds. The Timeline + Console mirrors use
  // this directly. Local time within the active track is derived.
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [uploadingForTrackId, setUploadingForTrackId] = useState(null);
  const [autoDetectingTrackIds, setAutoDetectingTrackIds] = useState(() => new Set());

  const audioOffsets = useMemo(() => trackOffsets(audioTracks), [audioTracks]);
  const totalAudioDuration = useMemo(
    () => totalShowAudioDuration(audioTracks),
    [audioTracks]
  );
  const activeTrackIndex = useMemo(() => {
    if (!activeTrackId) return -1;
    return audioTracks.findIndex((t) => t.id === activeTrackId);
  }, [audioTracks, activeTrackId]);
  const activeTrack = activeTrackIndex >= 0 ? audioTracks[activeTrackIndex] : null;
  const activeTrackOffset =
    activeTrackIndex >= 0 ? audioOffsets[activeTrackIndex] : 0;
  const activeLocalTime = Math.max(0, audioCurrentTime - activeTrackOffset);
  const [availableDevices, setAvailableDevices] = useState({});
  const [receiverLocations, setReceiverLocations] = useState({});
  const [receiverLabels, setReceiverLabels] = useState({});
  const [currentIndex, setCurrentIndex] = useState(50);
  const [itemsFixed, setItemsFixed] = useState(false);
  const [filteredReceivers, setFilteredReceivers] = useState({});
  const [activeTab, setActiveTab] = useState("target"); // "target", "racks", "test", "layout"

  // Copy Item flow:
  //   null              → idle
  //   'select-source'   → user must click an existing timeline item to copy
  //   'select-position' → target picked; user clicks the timeline to drop the copy
  // The intermediate "pick zone/target" step is the CopyItemTargetModal, gated
  // by `isCopyTargetModalOpen`.
  const [copyMode, setCopyMode] = useState(null);
  const [copySourceItem, setCopySourceItem] = useState(null);
  const [copyTargetZone, setCopyTargetZone] = useState(null);
  const [copyTargetCue, setCopyTargetCue] = useState(null);
  const [isCopyTargetModalOpen, setIsCopyTargetModalOpen] = useState(false);

  const [isInitialized, setIsInitialized] = useState(false);

  // Receiver edits on the Receivers page update the DB-backed `receivers`
  // slice immediately. `systemConfig.receivers` is still present for legacy
  // consumers and initial config load, but it can be stale until
  // fetchSystemConfig runs again. Prefer the live slice so the builder sees
  // cue-count changes (e.g. RX143 16 -> 32 cues) without a full page refresh.
  const activeReceivers =
    receivers && Object.keys(receivers).length > 0
      ? receivers
      : systemConfig.receivers;

  const handleTabChange = (tabName) => {
    // Save current scroll position
    const scrollY = window.scrollY;
    setActiveTab(tabName);
    // Restore scroll position using requestAnimationFrame for better timing
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollY);
      // Also restore on next frame in case DOM updates cause reflow
      requestAnimationFrame(() => {
        window.scrollTo(0, scrollY);
      });
    });
  };

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

    if (tprotocol && activeReceivers && systemConfig.protocols) {
      const protocol = systemConfig.protocols[tprotocol];
      console.log('Found protocol object:', protocol);
      
      if (protocol && protocol.receivers) {
        console.log('Protocol receivers:', protocol.receivers);
        console.log('Available system receivers:', Object.keys(activeReceivers));
        
        const filteredReceivers = Object.fromEntries(
          Object.entries(activeReceivers).filter(([key, receiver]) => {
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
        setFilteredReceivers(activeReceivers);
        const availableDevicesData = mergeCues(activeReceivers);
        console.log('Using all receivers, availableDevices:', availableDevicesData);
        
        // If mergeCues returns empty, try using the receivers directly
        if (Object.keys(availableDevicesData).length === 0 && Object.keys(activeReceivers).length > 0) {
          console.log('mergeCues returned empty, using all receivers directly');
          const directMapping = {};
          Object.entries(activeReceivers).forEach(([receiverKey, receiver]) => {
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
      console.log('Missing required data:', { tprotocol, hasReceivers: !!activeReceivers, hasProtocols: !!systemConfig.protocols });
      setAvailableDevices({});
      setFilteredReceivers({});
    }
  }, [showMetadata.protocol, activeReceivers, systemConfig.protocols]);

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
      // Multi-track hydration. The store normalises legacy single-track
      // audioFile payloads into a one-element array, so we just trust
      // audioTracks here. Each track already carries its own bpm fields.
      const tracks = Array.isArray(stagedShow.audioTracks)
        ? stagedShow.audioTracks
        : [];
      setAudioTracks(tracks);
      setActiveTrackId(tracks[0]?.id || null);
      setAudioCurrentTime(0);
      setIsAudioPlaying(false);
      
      // Load existing receiver locations from show data
      if (stagedShow.receiver_locations) {
        try {
          const parsedLocations = JSON.parse(stagedShow.receiver_locations);
          setReceiverLocations(parsedLocations);
          setShowMetadata(prev => ({ ...prev, receiver_locations: parsedLocations }));
        } catch (e) {
          console.error('Failed to parse receiver_locations for show:', stagedShow.id, e);
          initializeDefaultLocations();
        }
      } else {
        initializeDefaultLocations();
      }
      
      // Load existing receiver labels from show data
      if (stagedShow.receiver_labels) {
        try {
          const parsedLabels = JSON.parse(stagedShow.receiver_labels);
          setReceiverLabels(parsedLabels);
          setShowMetadata(prev => ({ ...prev, receiver_labels: parsedLabels }));
        } catch (e) {
          console.error('Failed to parse receiver_labels for show:', stagedShow.id, e);
          setReceiverLabels({});
        }
      } else if (stagedShow.receiverLabels) {
        // Handle parsed labels from store
        setReceiverLabels(stagedShow.receiverLabels);
        setShowMetadata(prev => ({ ...prev, receiver_labels: stagedShow.receiverLabels }));
      } else {
        setReceiverLabels({});
      }
    } else {
      // Clear editor when show is unstaged. Use a functional update so we
      // don't clobber fields that the auto-select-protocol effect (declared
      // earlier in this component) queued in the same commit batch — e.g.
      // `protocol`, which would otherwise come back as undefined and leave
      // the editor stuck on "Please select a protocol".
      setItems([]);
      setShowMetadata((prev) => ({
        name: "",
        ...(prev?.protocol ? { protocol: prev.protocol } : {}),
      }));
      setAudioTracks([]);
      setActiveTrackId(null);
      setAudioCurrentTime(0);
      setIsAudioPlaying(false);
      setReceiverLocations({});
      setReceiverLabels({});
    }
  }, [stagedShow]);

  const initializeDefaultLocations = () => {
    if (activeReceivers && systemConfig.protocols) {
      const protocol = systemConfig.protocols[showMetadata.protocol];
      if (protocol && protocol.receivers) {
        const receivers = Object.keys(activeReceivers).filter(key => 
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
        const receivers = Object.keys(activeReceivers);
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

  // ---- Multi-track audio orchestration -----------------------------------

  // Central writer that updates `audioTracks` AND mirrors the result into
  // `showMetadata` so the upsert path persists it. Avoid setShowMetadata
  // calls inline elsewhere — go through this so the two stay in sync.
  const writeAudioTracks = (next) => {
    const arr = typeof next === "function" ? next(audioTracks) : next;
    setAudioTracks(arr);
    setShowMetadata((prev) => ({
      ...prev,
      audioTracks: arr,
      audioFile: arr[0] || null,
    }));
  };

  const patchTrack = (trackId, patch) => {
    writeAudioTracks((prev) =>
      prev.map((t) => (t.id === trackId ? { ...t, ...patch } : t))
    );
  };

  // The user clicked "Choose File" within a track's editor. Upload to
  // get a persistent URL, then kick off BPM auto-detection in the
  // background so the timeline beat grid lights up without an extra
  // click. The auto-detect also captures the audio duration so the
  // multi-track beat grid can render this song's beats even when its
  // tab isn't currently visible (i.e. a wavesurfer 'ready' event hasn't
  // fired for it yet).
  const handleTrackFileUpload = async (trackId, file) => {
    if (!file) return;
    setUploadingForTrackId(trackId);
    try {
      const formData = new FormData();
      formData.append("audio", file);
      const response = await fetch("/api/shows/upload-audio", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) throw new Error("upload failed");
      const result = await response.json();
      const audioUrl = result.url;
      patchTrack(trackId, {
        url: audioUrl,
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        durationSec: null,
        bpm: null,
        firstBeatOffsetSec: 0,
        bpmConfidence: null,
        bpmSource: null,
      });
      // Background BPM detection. Only applies if the user hasn't
      // already manually set a BPM in the few seconds we were running.
      setAutoDetectingTrackIds((prev) => {
        const next = new Set(prev);
        next.add(trackId);
        return next;
      });
      analyzeAudioFile(file)
        .then((res) => {
          if (!res || !Number.isFinite(res.bpm)) return;
          setAudioTracks((prev) => {
            const next = prev.map((t) => {
              if (t.id !== trackId) return t;
              if (t.bpm != null) return t;
              return {
                ...t,
                bpm: res.bpm,
                firstBeatOffsetSec: res.firstBeatOffsetSec,
                bpmConfidence: res.confidence,
                bpmSource: "auto",
                durationSec: Number.isFinite(res.durationSec)
                  ? res.durationSec
                  : t.durationSec,
              };
            });
            setShowMetadata((md) => ({
              ...md,
              audioTracks: next,
              audioFile: next[0] || null,
            }));
            return next;
          });
        })
        .catch((err) => {
          console.warn("Auto BPM detection failed:", err);
        })
        .finally(() => {
          setAutoDetectingTrackIds((prev) => {
            const next = new Set(prev);
            next.delete(trackId);
            return next;
          });
        });
    } catch (error) {
      console.error("Failed to upload audio file:", error);
      alert("Failed to upload audio file. See console for details.");
    } finally {
      setUploadingForTrackId(null);
    }
  };

  const handleTrackBpmChange = (trackId, next) => {
    patchTrack(trackId, {
      bpm: Number.isFinite(next.bpm) ? next.bpm : null,
      firstBeatOffsetSec: Number.isFinite(next.firstBeatOffsetSec)
        ? next.firstBeatOffsetSec
        : 0,
      beatsPerMeasure: Number.isFinite(next.beatsPerMeasure)
        ? next.beatsPerMeasure
        : 4,
      bpmConfidence: Number.isFinite(next.confidence) ? next.confidence : null,
      bpmSource: next.source || null,
    });
  };

  const handleAddTrack = () => {
    const id = newTrackId();
    writeAudioTracks((prev) => [
      ...prev,
      {
        id,
        url: null,
        name: `Track ${prev.length + 1}`,
        size: null,
        type: null,
        lastModified: null,
        durationSec: null,
        bpm: null,
        firstBeatOffsetSec: 0,
        beatsPerMeasure: 4,
        bpmConfidence: null,
        bpmSource: null,
      },
    ]);
    setActiveTrackId(id);
    // Don't move the cursor; let the user manually scrub or hit play.
  };

  const handleRemoveTrack = (trackId) => {
    const idx = audioTracks.findIndex((t) => t.id === trackId);
    if (idx === -1) return;
    if (!window.confirm("Delete this track?")) return;
    setIsAudioPlaying(false);
    const isActive = trackId === activeTrackId;
    const localTimeBefore = activeLocalTime;
    const nextTracks = audioTracks.filter((t) => t.id !== trackId);
    writeAudioTracks(nextTracks);
    if (isActive) {
      const fallback = nextTracks[idx] || nextTracks[idx - 1] || nextTracks[0];
      setActiveTrackId(fallback?.id || null);
      setAudioCurrentTime(0);
    } else {
      // Re-anchor the show cursor so the still-active track keeps its
      // local position in the song; only the offsets shifted.
      const newIdx = nextTracks.findIndex((t) => t.id === activeTrackId);
      if (newIdx >= 0) {
        const newOffsets = trackOffsets(nextTracks);
        setAudioCurrentTime((newOffsets[newIdx] || 0) + localTimeBefore);
      }
    }
  };

  const handleReorderTracks = (fromIndex, toIndex) => {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || toIndex < 0) return;
    if (fromIndex >= audioTracks.length || toIndex >= audioTracks.length) return;
    const localTimeBefore = activeLocalTime;
    const reordered = (() => {
      const next = [...audioTracks];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    })();
    writeAudioTracks(reordered);
    // Same active track, but its show-offset just changed -- shift the
    // show cursor by the offset delta so the local position is stable.
    if (activeTrackId) {
      const newIdx = reordered.findIndex((t) => t.id === activeTrackId);
      if (newIdx >= 0) {
        const newOffsets = trackOffsets(reordered);
        setAudioCurrentTime((newOffsets[newIdx] || 0) + localTimeBefore);
      }
    }
  };

  const handleAudioPlayChange = (playing) => {
    setIsAudioPlaying(!!playing);
  };

  // Local-time emit from the active track's wavesurfer -> show-time.
  const handleLocalTimeUpdate = (localSec) => {
    if (!isFinite(localSec) || localSec < 0) return;
    setAudioCurrentTime(activeTrackOffset + localSec);
  };

  // Per-track duration reported by each TrackPlayer's wavesurfer 'ready'.
  // Fires for every track regardless of which is active, since all of
  // them stay mounted. The dedupe avoids a feedback loop through
  // writeAudioTracks → render → effect when the value hasn't moved.
  const handleTrackDurationKnown = (trackId, durationSec) => {
    if (!trackId || !Number.isFinite(durationSec) || durationSec <= 0) return;
    const cur = audioTracks.find((t) => t.id === trackId);
    if (cur && Math.abs((cur.durationSec || 0) - durationSec) < 0.05) return;
    patchTrack(trackId, { durationSec });
  };

  // Active TrackPlayer's wavesurfer 'finish'. Auto-advance to the next
  // track. The next TrackPlayer is already mounted and warm (its audio
  // has been decoded since the song was added), so promoting it to
  // active immediately starts playback with no fetch / decode wait --
  // the gap users hear is essentially just one React commit.
  const handleActiveTrackEnded = () => {
    if (activeTrackIndex < 0) return;
    const nextIdx = activeTrackIndex + 1;
    if (nextIdx >= audioTracks.length) {
      setIsAudioPlaying(false);
      return;
    }
    setActiveTrackId(audioTracks[nextIdx].id);
    setAudioCurrentTime(audioOffsets[nextIdx] || 0);
  };

  // Show cursor moved (e.g. user clicked the timeline). If the new time
  // falls in a different track, switch to that track. The active
  // wavesurfer's seek effect handles the local-time delta.
  const handleShowCursorChange = (showSec) => {
    if (!isFinite(showSec) || showSec < 0) return;
    setAudioCurrentTime(showSec);
    if (audioTracks.length === 0) return;
    const hit = trackAtShowTime(audioTracks, showSec);
    if (hit && hit.track.id !== activeTrackId) {
      setActiveTrackId(hit.track.id);
    }
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

  // ---- Copy Item flow ----------------------------------------------------
  const startCopyItem = () => {
    setCopySourceItem(null);
    setCopyTargetZone(null);
    setCopyTargetCue(null);
    setIsCopyTargetModalOpen(false);
    setCopyMode("select-source");
  };

  const cancelCopyItem = () => {
    setCopyMode(null);
    setCopySourceItem(null);
    setCopyTargetZone(null);
    setCopyTargetCue(null);
    setIsCopyTargetModalOpen(false);
  };

  const handleCopySourceClick = (item) => {
    if (copyMode !== "select-source") return;
    setCopySourceItem(item);
    setIsCopyTargetModalOpen(true);
  };

  const handleCopyTargetConfirm = (zone, target) => {
    setCopyTargetZone(zone);
    setCopyTargetCue(target);
    setIsCopyTargetModalOpen(false);
    setCopyMode("select-position");
  };

  const handleCopyPlaceClick = (time) => {
    if (copyMode !== "select-position" || !copySourceItem) return;
    if (!Number.isFinite(time) || time < 0) return;

    // Deep clone so nested structures (shells/steps/cellData/etc.) on the
    // source aren't shared with the new item.
    const cloned = JSON.parse(JSON.stringify(copySourceItem));
    delete cloned.id; // addItemToTimeline assigns a fresh id
    cloned.startTime = time;
    cloned.zone = copyTargetZone;
    cloned.target = copyTargetCue;

    addItemToTimeline(cloned);
    cancelCopyItem();
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
        receiverLabels={receiverLabels}
      />
      {availableDevices && Object.keys(availableDevices).length > 0 ? (
        <div>
          {/* Audio editor: tab strip + per-track waveform/BPM card. */}
          <div className="mb-4">
            <AudioTrackTabs
              tracks={audioTracks}
              activeTrackId={activeTrackId}
              audioOffsets={audioOffsets}
              onSelect={(id) => {
                setActiveTrackId(id);
                const idx = audioTracks.findIndex((t) => t.id === id);
                if (idx >= 0) setAudioCurrentTime(audioOffsets[idx] || 0);
              }}
              onAdd={handleAddTrack}
              onRemove={handleRemoveTrack}
              onReorder={handleReorderTracks}
            />
            {audioTracks.length > 0 && activeTrack ? (
              <AudioWaveform
                tracks={audioTracks}
                activeTrackId={activeTrackId}
                localTime={activeLocalTime}
                isPlaying={isAudioPlaying}
                onLocalTimeUpdate={handleLocalTimeUpdate}
                onPlayChange={handleAudioPlayChange}
                onTrackEnded={handleActiveTrackEnded}
                onTrackDurationKnown={handleTrackDurationKnown}
                onAudioFileUploaded={(file) =>
                  handleTrackFileUpload(activeTrack.id, file)
                }
                onBpmInfoChange={(next) =>
                  handleTrackBpmChange(activeTrack.id, next)
                }
                onTrackRemove={
                  audioTracks.length > 1
                    ? () => handleRemoveTrack(activeTrack.id)
                    : undefined
                }
                trackLabel={activeTrack.name}
                isUploading={uploadingForTrackId === activeTrack.id}
                isAutoDetecting={autoDetectingTrackIds.has(activeTrack.id)}
              />
            ) : (
              <div className="p-4 bg-gray-800 rounded-b-lg border border-t-0 border-gray-700 text-sm text-gray-400">
                Click <span className="text-gray-200 font-semibold">+ Add track</span>{" "}
                above to attach an audio file to this show.
              </div>
            )}
          </div>

          {selectedItems.length >= 2 && (
            <Card tone="raised" padding="sm" className="mb-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-fg-secondary min-w-0">
                  <span className="num text-fg-primary">
                    {selectedItems.length}
                  </span>{" "}
                  items selected
                  <span className="text-fg-muted">
                    {" "}
                    · ⌘-click to add or remove
                  </span>
                </div>
                <Button size="sm" variant="primary" onClick={handleChainTiming}>
                  Chain timing…
                </Button>
              </div>
            </Card>
          )}

          <div className="mb-2 flex items-center justify-between gap-2 min-h-7">
            <div className="flex items-center gap-2 min-w-0 text-sm">
              {copyMode === "select-source" && (
                <Badge tone="accent" size="sm">Pick source</Badge>
              )}
              {copyMode === "select-source" && (
                <span className="text-fg-secondary truncate">
                  Click an item in the timeline to copy.
                </span>
              )}
              {copyMode === "select-position" && (
                <Badge tone="accent" size="sm">Place copy</Badge>
              )}
              {copyMode === "select-position" && (
                <span className="text-fg-secondary truncate">
                  Copying{" "}
                  <span className="font-medium text-fg-primary">
                    {copySourceItem?.name}
                  </span>{" "}
                  → {receiverLabels?.[copyTargetZone] || copyTargetZone}:
                  {copyTargetCue}. Click a spot on the timeline.
                </span>
              )}
            </div>
            <Button
              size="sm"
              variant={copyMode ? "danger" : "outline"}
              onClick={copyMode ? cancelCopyItem : startCopyItem}
              title="Copy an existing timeline item to another receiver/cue"
            >
              {copyMode ? "Cancel copy" : "Copy item"}
            </Button>
          </div>

          <Timeline
            items={items}
            setItems={setItems}
            openAddModal={openAddModal}
            setSelectedItem={(item) => handleItemSelect(item, false)}
            selectedItems={selectedItems}
            onItemSelect={handleItemSelect}
            clearSelection={clearSelection}
            timeCursor={audioCurrentTime}
            setTimeCursor={handleShowCursorChange}
            receiverLabels={receiverLabels}
            copyMode={copyMode}
            onCopySourceClick={handleCopySourceClick}
            onCopyPlaceClick={handleCopyPlaceClick}
            audioTracks={audioTracks}
            audioDurationSec={totalAudioDuration}
          />
          
          {/* Tabs Section */}
          <div className="mt-4">
            {/* Tab Navigation */}
            <div className="flex border-b border-gray-700 mb-4">
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleTabChange("target");
                  e.currentTarget.blur();
                }}
                className={`px-4 py-2 font-medium text-sm ${
                  activeTab === "target"
                    ? "text-blue-400 border-b-2 border-blue-400"
                    : "text-gray-400 hover:text-gray-300"
                }`}
              >
                Target Grid
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleTabChange("racks");
                  e.currentTarget.blur();
                }}
                className={`px-4 py-2 font-medium text-sm ${
                  activeTab === "racks"
                    ? "text-blue-400 border-b-2 border-blue-400"
                    : "text-gray-400 hover:text-gray-300"
                }`}
              >
                Racks
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleTabChange("test");
                  e.currentTarget.blur();
                }}
                className={`px-4 py-2 font-medium text-sm ${
                  activeTab === "test"
                    ? "text-blue-400 border-b-2 border-blue-400"
                    : "text-gray-400 hover:text-gray-300"
                }`}
              >
                Test Show Builder
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleTabChange("layout");
                  e.currentTarget.blur();
                }}
                className={`px-4 py-2 font-medium text-sm ${
                  activeTab === "layout"
                    ? "text-blue-400 border-b-2 border-blue-400"
                    : "text-gray-400 hover:text-gray-300"
                }`}
              >
                Show Layout
              </button>
            </div>
            
            {/* Tab Content */}
            <div className="tab-content">
              {activeTab === "target" && (
                <ShowTargetGrid  
                  items={items} 
                  setItems={setItems} 
                  availableDevices={availableDevices}
                  receiverLabels={receiverLabels}
                  setReceiverLabels={(labels) => {
                    setReceiverLabels(labels);
                    setShowMetadata(prev => ({ ...prev, receiver_labels: labels }));
                  }}
                />
              )}
              
              {activeTab === "racks" && (
                <RacksTab inventory={inventory} showId={showMetadata.id} showItems={items} />
              )}
              
              {activeTab === "test" && (
                <TestShowBuilder
                  receivers={filteredReceivers}
                  onGenerate={handleTestShowGenerate}
                  currentIndex={currentIndex}
                  setCurrentIndex={setCurrentIndex}
                  inventory={inventory}
                  inventoryById={inventoryById}
                  availableDevices={availableDevices}
                />
              )}
              
              {activeTab === "layout" && (
                <SpatialLayoutMap
                  receivers={activeReceivers}
                  items={items}
                  receiverLocations={receiverLocations}
                  setReceiverLocations={setReceiverLocations}
                  onSaveLocations={saveReceiverLocations}
                />
              )}
            </div>
          </div>
          
          <AddItemModal
            isOpen={isAddModalOpen}
            onClose={closeModal}
            onAdd={addItemToTimeline}
            startTime={addItemStartTime}
            items={items}
            inventory={inventory}
            availableDevices={availableDevices}
            receiverLabels={receiverLabels}
            showMetadata={showMetadata}
          />
          <ChainTimingModal
            isOpen={isChainTimingModalOpen}
            onClose={() => setIsChainTimingModalOpen(false)}
            onApply={handleChainTimingApply}
            selectedItems={selectedItems}
          />
          <CopyItemTargetModal
            isOpen={isCopyTargetModalOpen}
            onClose={cancelCopyItem}
            onConfirm={handleCopyTargetConfirm}
            sourceItem={copySourceItem}
            items={items}
            availableDevices={availableDevices}
            receiverLabels={receiverLabels}
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
        </div>
      ) : (
        <div className="text-center p-8">
          <h2 className="text-xl font-bold text-gray-700 mb-4">Show Editor</h2>
          <p className="text-gray-500 mb-4">
            No receivers available. Please check your system configuration.
          </p>
        </div>
      )}
    </div>
  );
};

export default ShowBuilder;
