import React, { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Button,
  Field,
  inputClass,
  selectClass,
} from "@/design";
import {
  SHOW_RECEIVER_CUE_OPTIONS,
  highestUsedCueForReceiver,
} from "@/util/showReceivers";

// Modal for adding or editing a single show-receiver entry.
//
// Add mode (entry == null):
//   - "Receiver" select lists every DB receiver that is enabled AND not
//     already used by the show. The user picks one, optionally types a
//     label override, and picks a cue count (multiples of 8 up to 64).
//
// Edit mode (entry != null):
//   - Receiver id is read-only (changing the binding would orphan all of
//     this entry's items). The user can edit label and cue count.
//   - Shrinking the cue count below the highest cue currently fired on
//     this receiver is blocked with an explanatory message so the user
//     resolves the conflict by either deleting items or picking a larger
//     count first.
//
// onSave({ id, label, cues }) is invoked with the cleaned entry; the
// parent owns persistence into showReceivers state.
export default function ShowReceiverModal({
  isOpen,
  onClose,
  onSave,
  // Add mode: pass null. Edit mode: pass the current entry to seed inputs.
  entry = null,
  // Full list of DB receivers (id -> def). We surface only enabled rows
  // (`def.enabled !== false`) in the dropdown to keep operators from
  // wiring a show to a receiver they've already taken offline.
  dbReceivers = {},
  // Existing showReceivers entries. The dropdown filters these out in add
  // mode so the user can't accidentally pick the same receiver twice.
  existingShowReceivers = [],
  // Timeline items, used to validate that a shrink/remove won't orphan
  // anything. Only consulted in edit mode.
  items = [],
}) {
  const isEdit = !!entry;

  const [receiverId, setReceiverId] = useState(entry?.id || "");
  const [label, setLabel] = useState(entry?.label || "");
  const [cues, setCues] = useState(entry?.cues || SHOW_RECEIVER_CUE_OPTIONS[0]);
  const [error, setError] = useState(null);

  // Reset internal state whenever the modal is (re)opened with a fresh
  // payload. Crucially this clears `error` between opens so a previous
  // failed save doesn't haunt a different entry.
  useEffect(() => {
    if (!isOpen) return;
    setReceiverId(entry?.id || "");
    setLabel(entry?.label || "");
    setCues(entry?.cues || SHOW_RECEIVER_CUE_OPTIONS[0]);
    setError(null);
  }, [isOpen, entry]);

  // Receivers selectable in ADD mode: enabled, and not already in the
  // show. The current entry is always allowed (no-op in edit mode where
  // the receiver field is read-only anyway).
  const selectableReceivers = useMemo(() => {
    const used = new Set(
      (existingShowReceivers || [])
        .filter((e) => !entry || e.id !== entry.id)
        .map((e) => e.id)
    );
    return Object.entries(dbReceivers || {})
      .filter(([id, def]) => {
        if (!def) return false;
        if (def.enabled === false) return false;
        if (used.has(id)) return false;
        return true;
      })
      .sort(([a], [b]) => a.localeCompare(b));
  }, [dbReceivers, existingShowReceivers, entry]);

  // Default-select the first receiver in add mode once the list resolves.
  useEffect(() => {
    if (!isOpen || isEdit) return;
    if (!receiverId && selectableReceivers.length > 0) {
      setReceiverId(selectableReceivers[0][0]);
    }
  }, [isOpen, isEdit, receiverId, selectableReceivers]);

  // Highest cue number actually used on this receiver right now. Drives
  // the shrink validation and the "max used" hint under the cue dropdown.
  const highestUsedCue = useMemo(() => {
    if (!isEdit || !entry?.id) return 0;
    return highestUsedCueForReceiver(items, entry.id);
  }, [isEdit, entry, items]);

  const handleSave = () => {
    setError(null);
    if (!receiverId) {
      setError("Pick a receiver.");
      return;
    }
    const cueCount = parseInt(cues, 10);
    if (!SHOW_RECEIVER_CUE_OPTIONS.includes(cueCount)) {
      setError("Cue count must be a multiple of 8 between 8 and 64.");
      return;
    }
    // Block shrink-below-used. In ADD mode `highestUsedCue` is 0 so this
    // is always satisfied for new entries; in EDIT mode it protects the
    // operator from orphaning timeline items by lowering the cue count.
    if (isEdit && cueCount < highestUsedCue) {
      setError(
        `Cue ${highestUsedCue} is in use by this receiver. Delete or move those items, ` +
          `or pick a count of at least ${highestUsedCue}.`
      );
      return;
    }
    const cleaned = {
      id: receiverId,
      cues: cueCount,
    };
    const trimmedLabel = (label || "").trim();
    if (trimmedLabel) cleaned.label = trimmedLabel;
    onSave(cleaned);
  };

  const noReceiversAvailable = !isEdit && selectableReceivers.length === 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? "Edit receiver / zone" : "Add receiver / zone"}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!receiverId || noReceiversAvailable}
          >
            {isEdit ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {noReceiversAvailable ? (
          <div className="rounded-sm border border-warn/40 bg-warn-bg/60 px-3 py-2 text-xs text-warn-fg">
            No enabled receivers are available to add. Add or enable a
            receiver on the Receivers page first.
          </div>
        ) : null}

        <Field label="Receiver">
          {isEdit ? (
            <input
              type="text"
              readOnly
              value={receiverId}
              className={`${inputClass} opacity-70 cursor-not-allowed`}
              title="Re-binding to a different receiver isn't supported; remove and re-add instead."
            />
          ) : (
            <select
              value={receiverId}
              onChange={(e) => setReceiverId(e.target.value)}
              className={selectClass}
              disabled={selectableReceivers.length === 0}
            >
              {selectableReceivers.length === 0 ? (
                <option value="">(none available)</option>
              ) : (
                selectableReceivers.map(([id, def]) => (
                  <option key={id} value={id}>
                    {def.label && def.label !== id ? `${def.label} (${id})` : id}
                  </option>
                ))
              )}
            </select>
          )}
        </Field>

        <Field label="Label (optional)">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={inputClass}
            placeholder={receiverId ? `defaults to ${receiverId}` : ""}
          />
        </Field>

        <Field
          label="Number of cues"
          hint={
            isEdit && highestUsedCue > 0
              ? `Highest cue used in this show on this receiver: ${highestUsedCue}`
              : undefined
          }
        >
          <select
            value={cues}
            onChange={(e) => setCues(parseInt(e.target.value, 10))}
            className={selectClass}
          >
            {SHOW_RECEIVER_CUE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>

        {error ? (
          <div className="rounded-sm border border-danger/40 bg-danger-bg/60 px-3 py-2 text-xs text-danger-fg">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
