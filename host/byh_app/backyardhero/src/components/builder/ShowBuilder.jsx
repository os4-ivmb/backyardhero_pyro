import React, { useEffect, useState, useRef } from "react";
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
  const [audioFile, setAudioFile] = useState(null);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
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
      setAudioFile(null);
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
          {/* Audio Waveform */}
          <AudioWaveform
            onTimeUpdate={handleAudioTimeUpdate}
            currentTime={audioCurrentTime}
            duration={audioDuration}
            isPlaying={isAudioPlaying}
            onPlayPause={handleAudioPlayPause}
            onAudioFileChange={handleAudioFileChange}
          />
          {audioFile && (
            <div className="mb-2 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                className="text-fg-muted hover:text-danger"
                onClick={handleRemoveAudio}
              >
                Remove audio
              </Button>
            </div>
          )}

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
            setTimeCursor={setAudioCurrentTime}
            receiverLabels={receiverLabels}
            copyMode={copyMode}
            onCopySourceClick={handleCopySourceClick}
            onCopyPlaceClick={handleCopyPlaceClick}
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
