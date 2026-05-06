import React, { useState, useEffect, useMemo } from "react";
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

// Compute the visual duration of a single step. For inventory-backed items
// the duration field is the bar length; for FUSED_SHELL_LINE the inline
// builder already produces its own duration.
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
  fusedShellLine: null, // Holds the inline-built FUSED_SHELL_LINE if step type is that
  unit_cost: null,
});

// Builds a step object out of a selected inventory item.
const stepFromInventoryItem = (item, prev) => ({
  ...prev,
  type: item.type,
  itemId: item.id,
  name: item.name,
  duration: item.duration || 0,
  unit_cost: item.unit_cost ?? null,
  // Carry over the inventory item's delay metadata so cost/firing math can
  // see the same fields that the standalone add-item flow stores.
  fuse_delay: item.fuse_delay ?? null,
  lift_delay: item.lift_delay ?? null,
  fusedShellLine: null,
});

// Builds a step out of a finished inline FUSED_SHELL_LINE.
const stepFromFusedShellLine = (fl, prev) => ({
  ...prev,
  type: "FUSED_SHELL_LINE",
  itemId: null,
  name: fl.name,
  duration: fl.duration || 0,
  unit_cost: null, // Cost is summed from fl.shells in the cost util.
  fusedShellLine: fl,
});

const FusedItemLineBuilderModal = ({ isOpen, onClose, onAdd, inventory, initialLine }) => {
  const [steps, setSteps] = useState(() => (initialLine?.steps?.length ? initialLine.steps : [emptyStep()]));
  const [activeIdx, setActiveIdx] = useState(0);
  const [draft, setDraft] = useState(() => (initialLine?.steps?.[0] || emptyStep()));
  const [isShellLineBuilderOpen, setShellLineBuilderOpen] = useState(false);

  // Reset whenever the modal is reopened.
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
  const hasSelection = isShellLineStep ? !!draft.fusedShellLine : !!draft.itemId;

  // Compute next steps array with the current draft folded into the active slot.
  // Done outside of any setter so we can safely apply multiple state updates
  // off the same fresh snapshot (avoids the StrictMode double-invocation hazard
  // that arises from calling setters inside a setSteps updater).
  const stepsWithDraft = () => steps.map((s, i) => (i === activeIdx ? { ...draft } : s));

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
    // Just close. The step keeps `type === "FUSED_SHELL_LINE"` and the user
    // either re-opens the inline builder via the visible "Build" button or
    // changes the dropdown to a different type.
    setShellLineBuilderOpen(false);
  };

  // Build the final FUSED_LINE payload and pass back up.
  const handleFinalize = () => {
    const finalSteps = steps.map((s, i) => (i === activeIdx ? { ...draft } : s));
    // Drop any trailing/empty unselected steps so we don't ship a dangling row.
    const validSteps = finalSteps.filter(
      (s) => (s.type === "FUSED_SHELL_LINE" ? s.fusedShellLine : s.itemId)
    );
    if (!validSteps.length) return;

    // Total duration = sum of each step's bar duration plus the inter-step
    // fuse delays (the first step's fuseDelay rolls into the parent's `delay`).
    const totalDuration = validSteps.reduce((sum, s, i) => {
      const inter = i === 0 ? 0 : Math.max(0, Number(s.fuseDelay) || 0);
      return sum + inter + stepDuration(s);
    }, 0);

    // Default name = comma-separated step names, capped to keep it short.
    const defaultName = validSteps.map((s) => s.name).filter(Boolean).join(" + ").slice(0, 80);

    onAdd({
      type: "FUSED_LINE",
      name: defaultName || "Fused Line",
      steps: validSteps.map((s) => ({
        type: s.type,
        itemId: s.itemId,
        name: s.name,
        duration: stepDuration(s),
        fuseDelay: Math.max(0, Number(s.fuseDelay) || 0),
        multiple: supportsMultipleStep(s) ? Math.max(1, Math.floor(s.multiple) || 1) : 1,
        fuse_delay: s.fuse_delay ?? null,
        lift_delay: s.lift_delay ?? null,
        unit_cost: s.unit_cost ?? null,
        fusedShellLine: s.fusedShellLine || null,
      })),
      duration: totalDuration,
      // The first step's fuseDelay is the wire delay from the cue to the
      // first item's ignition; the parent's `delay` mirrors how AddItemModal
      // composes the firing-system delay (metaDelaySec is added there).
      firstStepFuseDelay: Math.max(0, Number(validSteps[0].fuseDelay) || 0),
    });
  };

  if (!isOpen) return null;

  const prevStep = activeIdx > 0 ? steps[activeIdx - 1] : null;
  const stepCount = steps.length;

  // Render "x{N}" badge text only for steps that fire >1 physical units. The
  // active row reads from `draft` so the badge updates live as the user edits.
  const multipleLabel = (step, isActive) => {
    const n = isActive ? draft.multiple : step?.multiple;
    return Number.isFinite(n) && n > 1 ? ` x${n}` : "";
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-gray-800 text-white p-6 rounded shadow-lg w-[640px] relative z-50">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl">
            Fused Line Builder — Step {activeIdx + 1} of {stepCount}
          </h2>
          {prevStep && (
            <button
              className="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-sm"
              onClick={() => switchToStep(activeIdx - 1)}
              title="Go back to previous step"
            >
              ← {prevStep.name || `Step ${activeIdx}`}{multipleLabel(prevStep, false)}
            </button>
          )}
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2 space-y-4">
            <div>
              <label className="block mb-1 text-sm">Type:</label>
              <select
                className="w-full p-2 bg-gray-700 rounded"
                value={draft.type}
                onChange={(e) => handleTypeChange(e.target.value)}
              >
                {FUSED_LINE_STEP_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {!isShellLineStep && (
              <div>
                <label className="block mb-1 text-sm">Item:</label>
                <ul className="h-32 overflow-y-auto bg-gray-700 p-2 rounded">
                  {filteredInventory.length === 0 && (
                    <li className="text-gray-400 text-sm p-2">No inventory of this type.</li>
                  )}
                  {filteredInventory.map((item) => (
                    <li
                      key={item.id}
                      className={`p-2 rounded cursor-pointer ${
                        draft.itemId === item.id ? "bg-blue-500" : "hover:bg-gray-600"
                      }`}
                      onClick={() => handleItemSelected(item)}
                    >
                      {item.name} ({item.duration} sec)
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isShellLineStep && (
              <div className="p-3 bg-gray-700 rounded">
                {draft.fusedShellLine ? (
                  <div>
                    <p className="text-sm">
                      <strong>Fused Shell Line:</strong> {draft.fusedShellLine.name}
                    </p>
                    <p className="text-xs text-gray-300">
                      {draft.fusedShellLine.shells?.length || 0} shells · {draft.fusedShellLine.duration?.toFixed(2)}s
                    </p>
                    <button
                      className="mt-2 bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded text-xs"
                      onClick={() => setShellLineBuilderOpen(true)}
                    >
                      Edit Fused Shell Line
                    </button>
                  </div>
                ) : (
                  <button
                    className="bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded text-sm"
                    onClick={() => setShellLineBuilderOpen(true)}
                  >
                    Build Fused Shell Line
                  </button>
                )}
              </div>
            )}

            {supportsMultiple && hasSelection && (
              <div>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={(draft.multiple || 1) > 1}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        multiple: e.target.checked ? Math.max(2, d.multiple || 2) : 1,
                      }))
                    }
                  />
                  <span>Fire Multiple</span>
                </label>
                {(draft.multiple || 1) > 1 && (
                  <input
                    type="number"
                    min={2}
                    step={1}
                    className="mt-2 w-full p-2 bg-gray-700 rounded text-white"
                    value={draft.multiple}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setDraft((d) => ({ ...d, multiple: Number.isFinite(v) && v >= 2 ? v : 2 }));
                    }}
                  />
                )}
              </div>
            )}

            <div>
              <label className="block mb-1 text-sm">
                {activeIdx === 0
                  ? "Fuse Delay from Cue (sec):"
                  : "Fuse Delay from End of Previous (sec):"}
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                className="w-full p-2 bg-gray-700 rounded text-white"
                value={draft.fuseDelay}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, fuseDelay: Math.max(0, parseFloat(e.target.value) || 0) }))
                }
              />
            </div>
          </div>

          {/* Right rail: step list + Add Another */}
          <div className="space-y-3">
            <div className="bg-gray-900 rounded p-2 text-xs">
              <div className="font-bold mb-1 text-gray-300">Line</div>
              <ol className="space-y-1">
                {steps.map((s, i) => {
                  const isActive = i === activeIdx;
                  const label = isActive ? draft.name : s.name;
                  const dur = isActive ? stepDuration(draft) : stepDuration(s);
                  return (
                    <li
                      key={i}
                      className={`flex items-center justify-between p-1 rounded cursor-pointer ${
                        isActive ? "bg-blue-700" : "hover:bg-gray-700"
                      }`}
                      onClick={() => switchToStep(i)}
                    >
                      <span className="truncate">
                        {i + 1}. {label || "(unselected)"}{multipleLabel(s, isActive)}
                      </span>
                      <span className="text-gray-400 ml-2">{dur.toFixed(1)}s</span>
                    </li>
                  );
                })}
              </ol>
            </div>
            <button
              className={`w-full px-3 py-2 rounded ${
                hasSelection ? "bg-green-600 hover:bg-green-700" : "bg-gray-600 cursor-not-allowed"
              }`}
              onClick={handleAddAnother}
              disabled={!hasSelection}
            >
              Add another after
            </button>
          </div>
        </div>

        {/* Bottom action row */}
        <div className="flex justify-between items-center mt-6">
          <div>
            {activeIdx > 0 && (
              <button
                className="bg-red-700 hover:bg-red-800 px-3 py-2 rounded text-sm"
                onClick={handleDeleteStep}
              >
                Delete Step
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button className="bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded" onClick={() => onClose(true)}>
              Cancel
            </button>
            <button
              className={`px-4 py-2 rounded ${
                hasSelection ? "bg-blue-600 hover:bg-blue-700" : "bg-gray-600 cursor-not-allowed"
              }`}
              onClick={handleFinalize}
              disabled={!hasSelection}
            >
              Accept Line
            </button>
          </div>
        </div>
      </div>

      {/* Inline FUSED_SHELL_LINE builder for FUSED_SHELL_LINE-typed steps */}
      {isShellLineBuilderOpen && (
        <FusedLineBuilderModal
          isOpen={isShellLineBuilderOpen}
          onClose={handleShellLineCancel}
          onAdd={handleShellLineAdd}
          inventory={inventory}
        />
      )}
    </div>
  );
};

const supportsMultipleStep = (step) => MULTIPLE_FIRE_TYPES.has(step?.type);

export default FusedItemLineBuilderModal;
export { FUSED_LINE_STEP_TYPES, MULTIPLE_FIRE_TYPES as FUSED_LINE_MULTIPLE_TYPES };
