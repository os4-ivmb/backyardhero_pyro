import React, { useEffect, useMemo, useState } from "react";

import {
  Modal,
  Button,
  Field,
  inputClass,
  selectClass,
  Card,
  Badge,
} from "@/design";

// Inner builder for FUSED_AERIAL_LINE — a chain of aerial shells fused
// together off a single cue. The output object is consumed by the outer
// Add Item modal (or by the FusedItemLine builder when picking a
// FUSED_SHELL_LINE step).

const FusedLineBuilderModal = ({ isOpen, onClose, onAdd, inventory, layer = 1 }) => {
  const [fuseType, setFuseType] = useState("");
  const [shellCount, setShellCount] = useState(1);
  const [spacing, setSpacing] = useState(2.75);
  const [leadInInches, setLeadInInches] = useState(1);
  const [shellSlots, setShellSlots] = useState([]);

  const fuseInventory = useMemo(
    () => inventory.filter((item) => item.type === "FUSE"),
    [inventory]
  );
  const shellInventory = useMemo(
    () => inventory.filter((item) => item.type === "AERIAL_SHELL"),
    [inventory]
  );

  // Reset state when reopened so a previously-cancelled session doesn't
  // leak into a fresh one. (The previous version held stale slots.)
  useEffect(() => {
    if (isOpen) {
      setFuseType("");
      setShellCount(1);
      setSpacing(2.75);
      setLeadInInches(1);
      setShellSlots([null]);
    }
  }, [isOpen]);

  // Resize slots when the count changes; preserve already-assigned shells.
  useEffect(() => {
    setShellSlots((prev) =>
      Array.from({ length: shellCount }, (_, i) => prev[i] ?? null)
    );
  }, [shellCount]);

  const fuse = useMemo(
    () => fuseInventory.find((f) => f.id === parseInt(fuseType, 10)) || null,
    [fuseInventory, fuseType]
  );

  const handleAssignShell = (index, shell) => {
    setShellSlots((prev) => prev.map((slot, i) => (i === index ? shell : slot)));
  };

  const handleAssignShellToAll = () => {
    const first = shellSlots[0];
    if (!first) return;
    setShellSlots(Array.from({ length: shellCount }, () => first));
  };

  const allSlotsFilled = shellSlots.length > 0 && shellSlots.every(Boolean);
  const isValid = fuse && allSlotsFilled;

  // Live duration estimate, mirrors the math in handleAddFusedLine so the
  // user can see how their inputs change the bar before committing.
  const previewDuration = useMemo(() => {
    if (!isValid) return null;
    const burnRate = fuse?.burn_rate || 0;
    const totalFuseInches = parseFloat(spacing) * (shellSlots.length - 1);
    const fuseBurn = (totalFuseInches / 12) * burnRate;
    const last = shellSlots[shellSlots.length - 1];
    const lastDelays = (last?.lift_delay || 0) + (last?.fuse_delay || 0);
    return fuseBurn + lastDelays;
  }, [isValid, fuse, spacing, shellSlots]);

  const handleAddFusedLine = () => {
    if (!isValid) return;
    const lastShell = shellSlots[shellSlots.length - 1];
    const burnRate = fuse?.burn_rate || 0;
    const totalFuseLength = parseFloat(spacing) * (shellSlots.length - 1);
    const fuseBurnTime = (totalFuseLength / 12) * burnRate;
    const lastShellDelays =
      (lastShell?.lift_delay || 0) + (lastShell?.fuse_delay || 0);
    const calcDuration = fuseBurnTime + lastShellDelays;

    const name = `${fuse.name} x ${shellSlots.length} shell`;
    onAdd({
      type: "FUSED_AERIAL_LINE",
      fuse,
      spacing,
      leadInInches,
      duration: calcDuration,
      shells: shellSlots,
      name,
    });
    onClose(false);
  };

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => onClose(true)}
      title="Fused shell line"
      eyebrow="Builder"
      size="lg"
      layer={layer}
      footer={
        <>
          <Button variant="outline" onClick={() => onClose(true)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleAddFusedLine}
            disabled={!isValid}
          >
            Add fused line
          </Button>
        </>
      }
      footerStart={
        previewDuration != null ? (
          <span className="text-2xs text-fg-muted">
            Estimated duration{" "}
            <span className="num text-fg-secondary">
              {previewDuration.toFixed(2)}s
            </span>
          </span>
        ) : (
          <span className="text-2xs text-fg-muted">
            Pick a fuse and assign every slot.
          </span>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Fuse type"
          hint={
            fuse
              ? `${fuse.burn_rate} sec/ft burn rate`
              : "Drives lead-in time and the gap between shells."
          }
        >
          <select
            className={selectClass}
            value={fuseType}
            onChange={(e) => setFuseType(e.target.value)}
          >
            <option value="" disabled>
              Select fuse type…
            </option>
            {fuseInventory.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.burn_rate} s/ft)
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Shells">
            <input
              type="number"
              min="1"
              step="1"
              className={inputClass}
              value={shellCount}
              onChange={(e) =>
                setShellCount(Math.max(1, parseInt(e.target.value, 10) || 1))
              }
            />
          </Field>
          <Field label="Spacing (in)">
            <input
              type="number"
              min="0.01"
              step="0.01"
              className={inputClass}
              value={spacing}
              onChange={(e) =>
                setSpacing(Math.max(0.01, parseFloat(e.target.value) || 0.01))
              }
            />
          </Field>
          <Field label="Lead-in (in)">
            <input
              type="number"
              min="0"
              step="0.01"
              className={inputClass}
              value={leadInInches}
              onChange={(e) =>
                setLeadInInches(Math.max(0, parseFloat(e.target.value) || 0))
              }
            />
          </Field>
        </div>

        <div className="flex items-end justify-between gap-3">
          <div className="eyebrow">Assign shells</div>
          <Button
            size="xs"
            variant="ghost"
            onClick={handleAssignShellToAll}
            disabled={!shellSlots[0] || shellSlots.length < 2}
            title="Copy slot 1 into every slot below"
          >
            Apply slot 1 to all
          </Button>
        </div>

        <Card tone="inset" padding="sm">
          {shellInventory.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No aerial shells in inventory yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {shellSlots.map((slot, index) => (
                <li
                  key={index}
                  className="flex items-center gap-3 min-w-0"
                >
                  <Badge tone={slot ? "accent" : "neutral"} size="sm">
                    {index + 1}
                  </Badge>
                  <select
                    className={selectClass + " flex-1"}
                    value={slot ? slot.id : ""}
                    onChange={(e) =>
                      handleAssignShell(
                        index,
                        shellInventory.find(
                          (shell) => shell.id === parseInt(e.target.value, 10)
                        ) || null
                      )
                    }
                  >
                    <option value="">Select shell…</option>
                    {shellInventory.map((shell) => (
                      <option key={shell.id} value={shell.id}>
                        {shell.name}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Modal>
  );
};

export default FusedLineBuilderModal;
