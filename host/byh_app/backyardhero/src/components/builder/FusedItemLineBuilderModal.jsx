import React, { useEffect, useMemo, useState } from "react";

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

import FusedLineBuilderModal from "./FusedLineBuilderModal";

// Inventory item types that can be a step in a FUSED_LINE.
// Mirrors MULTIPLE_FIRE_TYPES in ShowBuilder, plus FUSED_SHELL_LINE.
const FUSED_LINE_STEP_TYPES = [
  { value: "CAKE_FOUNTAIN", label: "Cake Fountain" },
  { value: "CAKE_200G", label: "Cake 200g" },
  { value: "CAKE_350G", label: "Cake 350g" },
  { value: "CAKE_500G", label: "Cake 500g" },
  { value: "COMPOUND_CAKE", label: "Compound" },
  { value: "AERIAL_SHELL", label: "Aerial Shell" },
  { value: "FUSED_SHELL_LINE", label: "Fused Shell Line" },
];

// Item types that support firing multiples of the same physical item per step.
const MULTIPLE_FIRE_TYPES = new Set([
  "CAKE_FOUNTAIN",
  "CAKE_200G",
  "CAKE_350G",
  "CAKE_500G",
  "COMPOUND_CAKE",
  "AERIAL_SHELL",
]);

// Compute the visual duration of a single step.
const stepDuration = (step) => {
  if (!step) return 0;
  return Number.isFinite(step.duration) ? step.duration : 0;
};

const emptyStep = () => ({
  type: "CAKE_FOUNTAIN",
  itemId: null,
  name: "",
  duration: 0,
  fuseDelay: 0,
  multiple: 1,
  fusedShellLine: null,
  unit_cost: null,
});

const stepFromInventoryItem = (item, prev) => ({
  ...prev,
  type: item.type,
  itemId: item.id,
  name: item.name,
  duration: item.duration || 0,
  unit_cost: item.unit_cost ?? null,
  fuse_delay: item.fuse_delay ?? null,
  lift_delay: item.lift_delay ?? null,
  fusedShellLine: null,
});

const stepFromFusedShellLine = (fl, prev) => ({
  ...prev,
  type: "FUSED_SHELL_LINE",
  itemId: null,
  name: fl.name,
  duration: fl.duration || 0,
  unit_cost: null,
  fusedShellLine: fl,
});

const supportsMultipleStep = (step) => MULTIPLE_FIRE_TYPES.has(step?.type);

const FusedItemLineBuilderModal = ({
  isOpen,
  onClose,
  onAdd,
  inventory,
  initialLine,
  layer = 1,
}) => {
  const [steps, setSteps] = useState(() =>
    initialLine?.steps?.length ? initialLine.steps : [emptyStep()]
  );
  const [activeIdx, setActiveIdx] = useState(0);
  const [draft, setDraft] = useState(
    () => initialLine?.steps?.[0] || emptyStep()
  );
  const [isShellLineBuilderOpen, setShellLineBuilderOpen] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const init = initialLine?.steps?.length ? initialLine.steps : [emptyStep()];
      setSteps(init);
      setActiveIdx(0);
      setDraft({ ...init[0] });
      setShellLineBuilderOpen(false);
    }
  }, [isOpen, initialLine]);

  const filteredInventory = useMemo(
    () =>
      inventory
        .filter((item) => item.type === draft.type)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [inventory, draft.type]
  );

  const supportsMultiple = MULTIPLE_FIRE_TYPES.has(draft.type);
  const isShellLineStep = draft.type === "FUSED_SHELL_LINE";
  const hasSelection = isShellLineStep
    ? !!draft.fusedShellLine
    : !!draft.itemId;

  const stepsWithDraft = () =>
    steps.map((s, i) => (i === activeIdx ? { ...draft } : s));

  const switchToStep = (idx) => {
    if (idx < 0 || idx >= steps.length || idx === activeIdx) return;
    const next = stepsWithDraft();
    setSteps(next);
    setActiveIdx(idx);
    setDraft({ ...next[idx] });
  };

  const handleAddAnother = () => {
    if (!hasSelection) return;
    const next = stepsWithDraft();
    const newStep = emptyStep();
    next.splice(activeIdx + 1, 0, newStep);
    setSteps(next);
    setActiveIdx(activeIdx + 1);
    setDraft(newStep);
  };

  const handleDeleteStep = () => {
    if (steps.length <= 1) return;
    const next = steps.filter((_, i) => i !== activeIdx);
    const newIdx = Math.max(0, activeIdx - 1);
    setSteps(next);
    setActiveIdx(newIdx);
    setDraft({ ...next[newIdx] });
  };

  const handleTypeChange = (newType) => {
    setDraft((d) => ({
      ...emptyStep(),
      type: newType,
      fuseDelay: d.fuseDelay,
    }));
    if (newType === "FUSED_SHELL_LINE") {
      setShellLineBuilderOpen(true);
    }
  };

  const handleItemSelected = (item) => {
    setDraft((d) => stepFromInventoryItem(item, d));
  };

  const handleShellLineAdd = (fl) => {
    setDraft((d) => stepFromFusedShellLine(fl, d));
    setShellLineBuilderOpen(false);
  };

  const handleShellLineCancel = () => {
    setShellLineBuilderOpen(false);
  };

  // Project the live state of the line for display (right-rail + total).
  const projectedSteps = stepsWithDraft();
  const projectedTotal = projectedSteps.reduce((sum, s, i) => {
    const inter = i === 0 ? 0 : Math.max(0, Number(s.fuseDelay) || 0);
    return sum + inter + stepDuration(s);
  }, 0);
  const validProjected = projectedSteps.filter((s) =>
    s.type === "FUSED_SHELL_LINE" ? s.fusedShellLine : s.itemId
  );
  const canFinalize = validProjected.length > 0 && hasSelection;

  const handleFinalize = () => {
    const finalSteps = projectedSteps;
    const validSteps = finalSteps.filter((s) =>
      s.type === "FUSED_SHELL_LINE" ? s.fusedShellLine : s.itemId
    );
    if (!validSteps.length) return;

    const totalDuration = validSteps.reduce((sum, s, i) => {
      const inter = i === 0 ? 0 : Math.max(0, Number(s.fuseDelay) || 0);
      return sum + inter + stepDuration(s);
    }, 0);

    const defaultName = validSteps
      .map((s) => s.name)
      .filter(Boolean)
      .join(" + ")
      .slice(0, 80);

    onAdd({
      type: "FUSED_LINE",
      name: defaultName || "Fused Line",
      steps: validSteps.map((s) => ({
        type: s.type,
        itemId: s.itemId,
        name: s.name,
        duration: stepDuration(s),
        fuseDelay: Math.max(0, Number(s.fuseDelay) || 0),
        multiple: supportsMultipleStep(s)
          ? Math.max(1, Math.floor(s.multiple) || 1)
          : 1,
        fuse_delay: s.fuse_delay ?? null,
        lift_delay: s.lift_delay ?? null,
        unit_cost: s.unit_cost ?? null,
        fusedShellLine: s.fusedShellLine || null,
      })),
      duration: totalDuration,
      firstStepFuseDelay: Math.max(
        0,
        Number(validSteps[0].fuseDelay) || 0
      ),
    });
  };

  if (!isOpen) return null;

  const stepCount = steps.length;
  const multipleLabel = (step, isActive) => {
    const n = isActive ? draft.multiple : step?.multiple;
    return Number.isFinite(n) && n > 1 ? `×${n}` : null;
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={() => onClose(true)}
        title="Fused line builder"
        eyebrow={`Step ${activeIdx + 1} of ${stepCount} · Total ${projectedTotal.toFixed(2)}s`}
        size="3xl"
        layer={layer}
        bodyClassName="px-5 py-4"
        footerStart={
          activeIdx > 0 ? (
            <Button variant="danger" size="sm" onClick={handleDeleteStep}>
              Delete step
            </Button>
          ) : null
        }
        footer={
          <>
            <Button variant="outline" onClick={() => onClose(true)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleFinalize}
              disabled={!canFinalize}
            >
              Accept line
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-3 gap-5">
          {/* Left: editor for the active step */}
          <div className="col-span-2 flex flex-col gap-4">
            <Field label="Step type">
              <select
                className={selectClass}
                value={draft.type}
                onChange={(e) => handleTypeChange(e.target.value)}
              >
                {FUSED_LINE_STEP_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>

            {!isShellLineStep && (
              <Field
                label="Item"
                hint={
                  filteredInventory.length === 0
                    ? "No inventory of this type."
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
                      const selected = draft.itemId === item.id;
                      return (
                        <li
                          key={item.id}
                          className={cn(
                            "px-3 py-1.5 cursor-pointer text-sm flex items-center justify-between gap-3",
                            "transition-colors",
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

            {isShellLineStep && (
              <Card tone="inset" padding="md">
                {draft.fusedShellLine ? (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="eyebrow mb-1">Fused shell line</div>
                      <div className="text-sm font-medium text-fg-primary truncate">
                        {draft.fusedShellLine.name}
                      </div>
                      <div className="text-2xs text-fg-muted mt-0.5 num">
                        {draft.fusedShellLine.shells?.length || 0} shells ·{" "}
                        {draft.fusedShellLine.duration?.toFixed(2)}s
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShellLineBuilderOpen(true)}
                    >
                      Edit
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-fg-secondary">
                      Build the fused shell line for this step.
                    </p>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => setShellLineBuilderOpen(true)}
                    >
                      Build
                    </Button>
                  </div>
                )}
              </Card>
            )}

            {supportsMultiple && hasSelection && (
              <Field
                label="Fire multiple"
                hint="How many physical units fire together on this step."
              >
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-fg-secondary cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={(draft.multiple || 1) > 1}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          multiple: e.target.checked
                            ? Math.max(2, d.multiple || 2)
                            : 1,
                        }))
                      }
                    />
                    <span>Multiple per step</span>
                  </label>
                  {(draft.multiple || 1) > 1 && (
                    <input
                      type="number"
                      min={2}
                      step={1}
                      className={inputClass + " w-24"}
                      value={draft.multiple}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        setDraft((d) => ({
                          ...d,
                          multiple: Number.isFinite(v) && v >= 2 ? v : 2,
                        }));
                      }}
                    />
                  )}
                </div>
              </Field>
            )}

            <Field
              label={
                activeIdx === 0
                  ? "Fuse delay from cue (sec)"
                  : "Fuse delay from end of previous (sec)"
              }
              hint={
                activeIdx === 0
                  ? "Time for the lead-in fuse to reach the first item."
                  : "Time for the inter-step fuse to ignite this step after the previous step ends."
              }
            >
              <input
                type="number"
                min="0"
                step="0.01"
                className={inputClass}
                value={draft.fuseDelay}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    fuseDelay: Math.max(0, parseFloat(e.target.value) || 0),
                  }))
                }
              />
            </Field>
          </div>

          {/* Right rail: step list + add another */}
          <aside className="flex flex-col gap-3">
            <div className="eyebrow">Line</div>
            <Card tone="inset" padding="none">
              <ol className="flex flex-col py-1">
                {steps.map((s, i) => {
                  const isActive = i === activeIdx;
                  const label = isActive ? draft.name : s.name;
                  const dur = isActive ? stepDuration(draft) : stepDuration(s);
                  const mult = multipleLabel(s, isActive);
                  return (
                    <li
                      key={i}
                      className={cn(
                        "flex items-center justify-between gap-2 px-3 py-1.5 cursor-pointer text-sm transition-colors",
                        isActive
                          ? "bg-accent-muted text-accent-fg"
                          : "text-fg-secondary hover:bg-surface-3"
                      )}
                      onClick={() => switchToStep(i)}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <Badge
                          tone={isActive ? "accent" : "neutral"}
                          size="xs"
                        >
                          {i + 1}
                        </Badge>
                        <span className="truncate">
                          {label || (
                            <span className="italic text-fg-muted">
                              unselected
                            </span>
                          )}
                        </span>
                        {mult ? (
                          <span className="num text-2xs text-fg-muted">
                            {mult}
                          </span>
                        ) : null}
                      </span>
                      <span className="num text-2xs text-fg-muted shrink-0">
                        {dur.toFixed(1)}s
                      </span>
                    </li>
                  );
                })}
              </ol>
            </Card>
            <Button
              variant="subtle"
              onClick={handleAddAnother}
              disabled={!hasSelection}
              title={
                hasSelection
                  ? "Append another step after this one"
                  : "Pick an item for this step first"
              }
            >
              + Add another after
            </Button>
            <div className="text-2xs text-fg-muted leading-snug">
              Click any step to edit it. The line fires top-to-bottom; each
              row's delay starts when the previous row ends.
            </div>
          </aside>
        </div>
      </Modal>

      {/* Inline FUSED_SHELL_LINE builder for FUSED_SHELL_LINE-typed steps */}
      {isShellLineBuilderOpen && (
        <FusedLineBuilderModal
          isOpen={isShellLineBuilderOpen}
          onClose={handleShellLineCancel}
          onAdd={handleShellLineAdd}
          inventory={inventory}
          layer={layer + 1}
        />
      )}
    </>
  );
};

export default FusedItemLineBuilderModal;
export { FUSED_LINE_STEP_TYPES, MULTIPLE_FIRE_TYPES as FUSED_LINE_MULTIPLE_TYPES };
