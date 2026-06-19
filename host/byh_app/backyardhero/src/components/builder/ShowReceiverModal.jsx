import React, { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Button,
  Field,
  inputClass,
  selectClass,
  cn,
} from "@/design";
import {
  BILUSOCN_ZONE_CUES,
  BILUSOCN_ZONE_MAX,
  BILUSOCN_ZONE_MIN,
  RECEIVER_KIND_BILUSOCN,
  RECEIVER_KIND_NATIVE,
  SHOW_RECEIVER_CUE_OPTIONS,
  entryKind,
  highestUsedCueForReceiver,
  isBilusocnEntry,
  validateBilusocnZoneSelection,
} from "@/util/showReceivers";
import useAppStore from "@/store/useAppStore";

// The native (BYH) receiver type. Bilusocn zones are configured inline (the
// other tab) and never become palette rows, so the only kind we create here is
// the standard timeslot receiver whose ident the dongle parses as "RX<digits>".
const NATIVE_RECEIVER_TYPE = "BKYD_TS_24_1";

// cues_data shape mirrors ReceiverDisplay.buildCuesData: { ident: [1..count] }.
const buildCuesData = (ident, count) => {
  const safe = Math.max(0, Math.min(256, parseInt(count, 10) || 0));
  return { [ident]: Array.from({ length: safe }, (_, i) => i + 1) };
};

// Modal for adding or editing a single show-receiver entry.
//
// Two kinds, picked by the tab strip in ADD mode (and locked to the
// existing kind in EDIT mode):
//
// 1. Native (default)
//      - "Receiver" select lists every DB receiver that is enabled AND
//        not already used by the show. The user picks one, optionally
//        types a label override, and picks a cue count (multiples of 8
//        up to 64).
//      - In EDIT mode, the receiver id is read-only (changing the
//        binding would orphan all of this entry's items). Shrinking the
//        cue count below the highest cue currently fired on this
//        receiver is blocked with an explanatory message so the user
//        resolves the conflict by either deleting items or picking a
//        larger count first.
//
// 2. Bilusocn / 433 MHz
//      - The show owns a Bilusocn dipswitch zone outright -- there is
//        no DB receiver row backing it. The user picks a zone number
//        (1-256) and an optional label. Cue count is fixed at 12 (the
//        full zone, tiled by three 4-channel TX modules at dipswitch
//        ranges 1-4, 5-8, 9-12). Operators who only own one or two
//        modules still get all 12 slots in the grid; the unused cues
//        just won't physically actuate.
//      - Zone numbers must be unique within a show -- two entries on
//        the same zone would both fire the same physical channels.
//      - In EDIT mode, the zone is read-only (changing it would orphan
//        all of this entry's items, same reasoning as native receiver
//        rebinding).
//
// onSave({ id, kind, cues, label? }) is invoked with the cleaned entry;
// the parent owns persistence into showReceivers state.
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
  // mode so the user can't accidentally pick the same receiver twice;
  // also drives Bilusocn zone-uniqueness validation.
  existingShowReceivers = [],
  // Timeline items, used to validate that a shrink/remove won't orphan
  // anything. Only consulted in edit mode.
  items = [],
}) {
  const isEdit = !!entry;

  // In edit mode the kind is locked to the entry's kind. In add mode
  // it's the active tab; default to native.
  const [activeKind, setActiveKind] = useState(
    isEdit ? entryKind(entry) : RECEIVER_KIND_NATIVE,
  );

  // Native-tab state.
  const [receiverId, setReceiverId] = useState(
    !isEdit || entryKind(entry) === RECEIVER_KIND_NATIVE
      ? entry?.id || ""
      : "",
  );
  const [label, setLabel] = useState(entry?.label || "");
  const [cues, setCues] = useState(entry?.cues || SHOW_RECEIVER_CUE_OPTIONS[0]);

  // Bilusocn-tab state.
  const [bilusocnZone, setBilusocnZone] = useState(
    isBilusocnEntry(entry) ? String(entry.id) : "",
  );

  const [error, setError] = useState(null);

  // Inline "create a new native receiver" sub-form (ADD mode only). Lets the
  // user mint a receiver into the palette without leaving the editor — the only
  // way to add native receivers in the cloud profile, and a convenience on
  // device. Backed by the store's createReceiver (POST /api/receivers), which
  // refreshes the `receivers` slice so the new id appears in the dropdown.
  const createReceiver = useAppStore((s) => s.createReceiver);
  const fetchReceivers = useAppStore((s) => s.fetchReceivers);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newIdent, setNewIdent] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newCues, setNewCues] = useState(SHOW_RECEIVER_CUE_OPTIONS[0]);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState(null);

  // Reset internal state whenever the modal is (re)opened with a fresh
  // payload. Crucially this clears `error` between opens so a previous
  // failed save doesn't haunt a different entry.
  useEffect(() => {
    if (!isOpen) return;
    const kind = isEdit ? entryKind(entry) : RECEIVER_KIND_NATIVE;
    setActiveKind(kind);
    if (kind === RECEIVER_KIND_BILUSOCN) {
      setReceiverId("");
      setBilusocnZone(entry?.id ? String(entry.id) : "");
      setCues(BILUSOCN_ZONE_CUES);
    } else {
      setReceiverId(entry?.id || "");
      setBilusocnZone("");
      setCues(entry?.cues || SHOW_RECEIVER_CUE_OPTIONS[0]);
    }
    setLabel(entry?.label || "");
    setError(null);
    // Reset the inline create sub-form on every (re)open.
    setCreatingNew(false);
    setNewIdent("");
    setNewLabel("");
    setNewCues(SHOW_RECEIVER_CUE_OPTIONS[0]);
    setCreateBusy(false);
    setCreateError(null);
  }, [isOpen, entry, isEdit]);

  const handleCreateReceiver = async () => {
    setCreateError(null);
    // The id field holds only the number; "RX" is fixed chrome and prepended
    // here. Mirrors the Receivers page so the dongle (which parses the node id
    // out of "RX<digits>") can always address it, and operators can't mistype
    // the prefix.
    const digits = (newIdent || "").replace(/\D/g, "");
    const id = digits ? `RX${digits}` : "";
    if (!digits) {
      setCreateError("Enter the receiver number (e.g. 163).");
      return;
    }
    if (dbReceivers && dbReceivers[id]) {
      setCreateError(`Receiver "${id}" already exists.`);
      return;
    }
    setCreateBusy(true);
    try {
      await createReceiver({
        id,
        label: (newLabel || "").trim() || id,
        type: NATIVE_RECEIVER_TYPE,
        cues_data: buildCuesData(id, newCues),
        enabled: true,
      });
      // Re-pull the whole palette from the server so the `receivers` slice is
      // fully hydrated (createReceiver only merges the one new row, which in
      // the cloud — where the slice starts empty — would otherwise hide the
      // receivers that live only in systemConfig.receivers).
      try { await fetchReceivers(); } catch { /* optimistic row is already in */ }
      // Select the freshly-created receiver and collapse the sub-form.
      setReceiverId(id);
      setCreatingNew(false);
    } catch (err) {
      setCreateError(
        err?.response?.data?.error || err?.message || "Failed to create receiver.",
      );
    } finally {
      setCreateBusy(false);
    }
  };

  // Receivers selectable in ADD mode (native tab): enabled, and not
  // already in the show. The current entry is always allowed (no-op in
  // edit mode where the receiver field is read-only anyway).
  const selectableReceivers = useMemo(() => {
    const used = new Set(
      (existingShowReceivers || [])
        .filter((e) => !entry || e.id !== entry.id)
        .map((e) => e.id),
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

  // Default-select the first receiver in add mode (native tab) once the
  // list resolves OR when the user switches back to the native tab.
  useEffect(() => {
    if (!isOpen || isEdit) return;
    if (activeKind !== RECEIVER_KIND_NATIVE) return;
    if (!receiverId && selectableReceivers.length > 0) {
      setReceiverId(selectableReceivers[0][0]);
    }
  }, [isOpen, isEdit, activeKind, receiverId, selectableReceivers]);

  // Highest cue number actually used on this receiver right now. Drives
  // the shrink validation and the "max used" hint under the cue dropdown.
  // Computed for both kinds; for Bilusocn we surface the same hint so
  // operators can tell at a glance how much of the zone is wired up.
  const highestUsedCue = useMemo(() => {
    if (!isEdit || !entry?.id) return 0;
    return highestUsedCueForReceiver(items, entry.id);
  }, [isEdit, entry, items]);

  const handleSave = () => {
    setError(null);
    if (activeKind === RECEIVER_KIND_BILUSOCN) {
      // Edit mode: zone is locked, so we don't re-run the uniqueness
      // check (it would always pass since we'd be excluding ourselves).
      // Still validate the bounds in case the entry got corrupted.
      const zoneStr = isEdit ? String(entry.id) : bilusocnZone;
      const validationError = validateBilusocnZoneSelection({
        zone: zoneStr,
        showReceivers: existingShowReceivers,
        excludeEntryId: isEdit ? entry?.id : undefined,
      });
      if (validationError) {
        setError(validationError);
        return;
      }
      const cleaned = {
        id: String(parseInt(zoneStr, 10)),
        kind: RECEIVER_KIND_BILUSOCN,
        cues: BILUSOCN_ZONE_CUES,
      };
      const trimmedLabel = (label || "").trim();
      if (trimmedLabel) cleaned.label = trimmedLabel;
      onSave(cleaned);
      return;
    }

    // Native path.
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
          `or pick a count of at least ${highestUsedCue}.`,
      );
      return;
    }
    const cleaned = {
      id: receiverId,
      kind: RECEIVER_KIND_NATIVE,
      cues: cueCount,
    };
    const trimmedLabel = (label || "").trim();
    if (trimmedLabel) cleaned.label = trimmedLabel;
    onSave(cleaned);
  };

  const noReceiversAvailable =
    !isEdit &&
    activeKind === RECEIVER_KIND_NATIVE &&
    selectableReceivers.length === 0;
  const saveDisabled =
    activeKind === RECEIVER_KIND_NATIVE
      ? !receiverId || noReceiversAvailable
      : !isEdit && !bilusocnZone;

  const titleSuffix =
    activeKind === RECEIVER_KIND_BILUSOCN ? "Bilusocn zone" : "receiver";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? `Edit ${titleSuffix}` : `Add ${titleSuffix}`}
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saveDisabled}
          >
            {isEdit ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Tab strip: only visible in ADD mode. EDIT mode locks the
            kind because rebinding across kinds would orphan all
            timeline items pinned to this entry. */}
        {!isEdit && (
          <div className="flex border-b border-gray-700 -mt-1">
            <ReceiverKindTab
              active={activeKind === RECEIVER_KIND_NATIVE}
              onClick={() => {
                setActiveKind(RECEIVER_KIND_NATIVE);
                setError(null);
              }}
              label="Native"
            />
            <ReceiverKindTab
              active={activeKind === RECEIVER_KIND_BILUSOCN}
              onClick={() => {
                setActiveKind(RECEIVER_KIND_BILUSOCN);
                setError(null);
                setCues(BILUSOCN_ZONE_CUES);
              }}
              label="Bilusocn / 433 MHz"
            />
          </div>
        )}

        {activeKind === RECEIVER_KIND_NATIVE ? (
          <>
            <NativeReceiverFields
              isEdit={isEdit}
              noReceiversAvailable={noReceiversAvailable}
              receiverId={receiverId}
              onReceiverIdChange={setReceiverId}
              selectableReceivers={selectableReceivers}
              label={label}
              onLabelChange={setLabel}
              cues={cues}
              onCuesChange={setCues}
              highestUsedCue={highestUsedCue}
            />
            {!isEdit && (
              creatingNew ? (
                <NewReceiverCard
                  ident={newIdent}
                  onIdentChange={setNewIdent}
                  label={newLabel}
                  onLabelChange={setNewLabel}
                  cues={newCues}
                  onCuesChange={setNewCues}
                  busy={createBusy}
                  error={createError}
                  onCreate={handleCreateReceiver}
                  onCancel={() => {
                    setCreatingNew(false);
                    setCreateError(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setCreatingNew(true);
                    setError(null);
                  }}
                  className="self-start text-xs font-medium text-blue-400 hover:text-blue-300"
                >
                  + New receiver
                </button>
              )
            )}
          </>
        ) : (
          <BilusocnZoneFields
            isEdit={isEdit}
            zone={bilusocnZone}
            onZoneChange={setBilusocnZone}
            entryZone={entry?.id}
            label={label}
            onLabelChange={setLabel}
            highestUsedCue={highestUsedCue}
          />
        )}

        {error ? (
          <div className="rounded-sm border border-danger/40 bg-danger-bg/60 px-3 py-2 text-xs text-danger-fg">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

// Single tab button. Style matches ShowBuilder's main tab strip so the
// in-modal tabs feel native to the surrounding editor.
function ReceiverKindTab({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-4 py-2 font-medium text-sm",
        active
          ? "text-blue-400 border-b-2 border-blue-400"
          : "text-gray-400 hover:text-gray-300",
      )}
    >
      {label}
    </button>
  );
}

// Inline create-a-receiver card shown under the native picker in ADD mode.
// Mints a logical receiver into the user's palette (cloud: builder_receivers;
// device: the Receivers table) so it can immediately be picked above.
function NewReceiverCard({
  ident,
  onIdentChange,
  label,
  onLabelChange,
  cues,
  onCuesChange,
  busy,
  error,
  onCreate,
  onCancel,
}) {
  return (
    <div className="flex flex-col gap-3 rounded-sm border border-border-subtle bg-surface-base/40 px-3 py-3">
      <div className="text-xs font-semibold text-fg-secondary">New receiver</div>

      <Field label="Receiver id">
        {/* "RX" is a fixed prefix; the operator only types the number, so the
            ident is always a valid "RX<digits>". */}
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-fg-muted select-none">
            RX
          </span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={3}
            value={ident}
            onChange={(e) => onIdentChange(e.target.value.replace(/\D/g, "").slice(0, 3))}
            className={inputClass + " pl-9 font-mono"}
            placeholder="163"
            autoFocus
          />
        </div>
      </Field>

      <Field label="Label (optional)">
        <input
          type="text"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          className={inputClass}
          placeholder={ident ? `defaults to RX${ident}` : ""}
        />
      </Field>

      <Field label="Number of cues">
        <select
          value={cues}
          onChange={(e) => onCuesChange(parseInt(e.target.value, 10))}
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

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onCreate} disabled={busy || !ident.trim()}>
          {busy ? "Creating…" : "Create"}
        </Button>
      </div>
    </div>
  );
}

function NativeReceiverFields({
  isEdit,
  noReceiversAvailable,
  receiverId,
  onReceiverIdChange,
  selectableReceivers,
  label,
  onLabelChange,
  cues,
  onCuesChange,
  highestUsedCue,
}) {
  return (
    <>
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
            onChange={(e) => onReceiverIdChange(e.target.value)}
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
          onChange={(e) => onLabelChange(e.target.value)}
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
          onChange={(e) => onCuesChange(parseInt(e.target.value, 10))}
          className={selectClass}
        >
          {SHOW_RECEIVER_CUE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

function BilusocnZoneFields({
  isEdit,
  zone,
  onZoneChange,
  entryZone,
  label,
  onLabelChange,
  highestUsedCue,
}) {
  // The zone is the dipswitch number on the operator's Bilusocn TX
  // modules. Shared zone -> shared physical channels, hence the
  // uniqueness constraint enforced on save. We always grant 12 cues;
  // see the file header for the rationale.
  const hint = isEdit
    ? `Always covers cues 1-${BILUSOCN_ZONE_CUES} (three 4ch TX modules at dipswitch ranges 1-4, 5-8, 9-12).`
    : `Pick the dipswitch number set on your Bilusocn TX modules. The show grants cues 1-${BILUSOCN_ZONE_CUES} on this zone, tiled by three 4ch modules.`;

  return (
    <>
      <Field
        label="Zone"
        hint={hint}
      >
        {isEdit ? (
          <input
            type="text"
            readOnly
            value={String(entryZone ?? "")}
            className={`${inputClass} opacity-70 cursor-not-allowed`}
            title="Re-binding to a different zone isn't supported; remove and re-add instead."
          />
        ) : (
          <input
            type="number"
            min={BILUSOCN_ZONE_MIN}
            max={BILUSOCN_ZONE_MAX}
            value={zone}
            onChange={(e) => onZoneChange(e.target.value)}
            className={inputClass}
            placeholder={`${BILUSOCN_ZONE_MIN}-${BILUSOCN_ZONE_MAX}`}
          />
        )}
      </Field>

      <Field label="Label (optional)">
        <input
          type="text"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          className={inputClass}
          placeholder={
            zone || entryZone
              ? `defaults to Bilusocn zone ${zone || entryZone}`
              : ""
          }
        />
      </Field>

      {isEdit && highestUsedCue > 0 ? (
        <div className="rounded-sm border border-border-subtle bg-surface-base/40 px-3 py-2 text-xs text-fg-muted">
          Highest cue used on this zone in this show:{" "}
          <span className="num text-fg-secondary">{highestUsedCue}</span>
        </div>
      ) : null}
    </>
  );
}
