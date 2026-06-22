import React, { useState, useEffect } from "react";
import { Modal, Button, Field, inputClass, selectClass } from "@/design";
import { asyncAlert } from "@/components/common/AsyncPrompt";

// Modal for creating *or editing* a fuse.
//
// Create mode:
//   <FuseModal isOpen mode="create" inventory={...}
//     onConfirm={({ fuseType, leadIn }) => ...}
//     onClose={...}/>
//
// Edit mode (also exposes delete):
//   <FuseModal isOpen mode="edit" inventory={...}
//     initialFuseType={fuse.type} initialLeadIn={fuse.leadIn}
//     onConfirm={({ fuseType, leadIn }) => ...}
//     onDelete={() => ...}
//     onClose={...}/>
export default function FuseModal({
  isOpen,
  onClose,
  onConfirm,
  onDelete,
  inventory,
  mode = "create",
  initialFuseType = "",
  initialLeadIn = 1,
  title,
}) {
  const [fuseType, setFuseType] = useState(initialFuseType || "");
  const [leadIn, setLeadIn] = useState(initialLeadIn);

  // Re-seed every time we re-open with a different target fuse so we
  // don't carry stale state from a prior edit.
  useEffect(() => {
    if (!isOpen) return;
    setFuseType(initialFuseType ? String(initialFuseType) : "");
    setLeadIn(initialLeadIn ?? 1);
  }, [isOpen, initialFuseType, initialLeadIn]);

  const fuseInventory = (inventory || []).filter(
    (item) => item.type === "FUSE"
  );

  const handleConfirm = () => {
    if (!fuseType) {
      asyncAlert("Please select a fuse type");
      return;
    }
    onConfirm?.({ fuseType, leadIn });
  };

  const resolvedTitle =
    title || (mode === "edit" ? "Edit fuse" : "Pick fuse type");

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={resolvedTitle}
      size="md"
      footerStart={
        mode === "edit" && onDelete ? (
          <Button variant="danger" onClick={onDelete}>
            Delete fuse
          </Button>
        ) : null
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleConfirm}>
            {mode === "edit" ? "Save changes" : "Start fuse"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Fuse type">
          <select
            className={selectClass}
            value={fuseType}
            onChange={(e) => setFuseType(e.target.value)}
          >
            <option value="" disabled>
              -- Select fuse type --
            </option>
            {fuseInventory.map((fuse) => (
              <option key={fuse.id} value={fuse.id}>
                {fuse.name} ({fuse.burn_rate} s/ft)
              </option>
            ))}
          </select>
        </Field>

        <Field label="Lead-in (inches)">
          <input
            type="number"
            min="0"
            step="0.1"
            value={leadIn}
            onChange={(e) => setLeadIn(parseFloat(e.target.value) || 0)}
            className={inputClass}
          />
        </Field>

        {mode === "create" ? (
          <p className="text-xs text-fg-muted">
            After confirming, click cells on the rack in order to chain
            them. You can save or discard the fuse from the toolbar.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
