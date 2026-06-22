import React, { useCallback, useEffect, useRef, useState } from "react";
import { MdClose } from "react-icons/md";
import { FaImage } from "react-icons/fa6";

import useAppStore from "@/store/useAppStore";
import { Section, Button, IconButton, Card } from "@/design";

import InventoryList from "./InventoryList";
import { INV_TYPES } from "@/constants";
import { normalizeYouTubeUrl } from "@/util/youtube";
import { parseOptionalUnitCost } from "@/util/inventoryUnitCost";
import { apiUrl, PROFILE } from "@/util/clientEnv";
import { asyncConfirm, asyncAlert } from "@/components/common/AsyncPrompt";

const DEFAULT_DATA = {
  id: "", name: "", type: "FUSE",
  duration: "", fuse_delay: "", lift_delay: "", burn_rate: "", color: "",
  available_ct: "", unit_cost: "",
  youtube_link: "", youtube_link_start_sec: "",
  image: "",
};

// Calm reusable input helpers. Keep field semantics identical to the
// previous form -- only the chrome (border / spacing / focus) changed.
const labelClass = "block text-fg-secondary text-xs uppercase tracking-wider font-semibold mb-1";
const inputClass = "h-9 w-full rounded-sm bg-surface-1 border border-border px-2.5 text-sm text-fg-primary placeholder:text-fg-muted focus:border-accent transition-colors";
const helpClass  = "text-fg-muted text-xs italic mt-1";

function Field({ label, hint, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label className={labelClass}>{label}</label>
      {children}
      {hint ? <p className={helpClass}>{hint}</p> : null}
    </div>
  );
}

// Image picker: paste a URL or (local profile only) upload a file. Uploaded
// images go through /api/inventory/upload-image, which stores them in the
// persistent uploads dir (same place music tracks live) and returns a URL we
// stash in formObject.image -- so the data model is unchanged (still a single
// URL string). The on-device build is the only one with local file storage;
// in the cloud profile we keep the URL field only.
function ImageField({ value, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);
  const canUpload = PROFILE === "local";

  // App-absolute paths (our serve route) need the deploy basePath; external
  // URLs are used verbatim.
  const previewSrc = value ? (value.startsWith("/") ? apiUrl(value) : value) : null;

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the user re-pick the same file later
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const body = new FormData();
      body.append("image", file);
      const resp = await fetch(apiUrl("/api/inventory/upload-image"), {
        method: "POST",
        body,
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || "Upload failed.");
      }
      const result = await resp.json();
      onChange(result.url);
    } catch (err) {
      setError(err.message || "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Field
      label="Image"
      hint={canUpload
        ? "Paste an image URL or upload a file. Uploads are stored locally and survive app updates."
        : "Paste an image URL."}
    >
      <div className="flex items-start gap-3">
        {previewSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewSrc}
            alt="Item preview"
            className="h-14 w-14 shrink-0 rounded-sm border border-border bg-surface-2 object-cover"
            onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
          />
        ) : (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-sm border border-dashed border-border bg-surface-2 text-fg-muted">
            <FaImage aria-hidden />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <input
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
            name="image" type="text"
            placeholder={canUpload ? "https://… or upload a file" : "https://…"}
            className={inputClass}
          />
          <div className="flex items-center gap-2">
            {canUpload ? (
              <>
                <input
                  ref={fileRef} type="file" accept="image/*"
                  className="hidden" onChange={handleFile}
                />
                <Button
                  type="button" size="sm" variant="outline"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading} loading={uploading}
                >
                  {uploading ? "Uploading…" : "Upload"}
                </Button>
              </>
            ) : null}
            {value ? (
              <Button
                type="button" size="sm" variant="ghost"
                onClick={() => onChange("")}
                className="text-fg-muted hover:text-danger"
              >
                Remove
              </Button>
            ) : null}
          </div>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
      </div>
    </Field>
  );
}

export function CakeFields({ formObject, handleInputChange, handleYouTubeLinkBlur }) {
  return (
    <div className="space-y-3">
      <Field label="Duration (seconds)">
        <input
          value={formObject.duration} onChange={handleInputChange}
          name="duration" type="number" className={inputClass}
        />
      </Field>
      <Field label="Fuse delay (seconds)" hint="Seconds delay from when the charge is fired to the first shot of the cake.">
        <input
          value={formObject.fuse_delay} onChange={handleInputChange}
          name="fuse_delay" type="number" className={inputClass}
        />
      </Field>
      <Field label="YouTube link">
        <input
          value={formObject.youtube_link || ""} onChange={handleInputChange}
          onBlur={handleYouTubeLinkBlur} name="youtube_link" type="text"
          placeholder="https://youtube.com/watch?v=…"
          className={inputClass}
        />
      </Field>
      <Field label="YouTube start (seconds)">
        <input
          value={formObject.youtube_link_start_sec || 0}
          onChange={handleInputChange} name="youtube_link_start_sec"
          type="text" className={inputClass}
        />
      </Field>
    </div>
  );
}

export function ShellFields({ formObject, handleInputChange, handleYouTubeLinkBlur }) {
  return (
    <div className="space-y-3">
      <Field label="Lift delay (seconds)" hint="Seconds delay from lift charge to break.">
        <input value={formObject.lift_delay} onChange={handleInputChange}
          name="lift_delay" type="number" className={inputClass} />
      </Field>
      <Field label="Fuse delay (seconds)" hint="Seconds delay from when charge is fired to lift charge.">
        <input value={formObject.fuse_delay} onChange={handleInputChange}
          name="fuse_delay" type="number" className={inputClass} />
      </Field>
      <Field label="YouTube link">
        <input
          value={formObject.youtube_link || ""} onChange={handleInputChange}
          onBlur={handleYouTubeLinkBlur} name="youtube_link" type="text"
          placeholder="https://youtube.com/watch?v=…" className={inputClass}
        />
      </Field>
      <Field label="YouTube start (seconds)">
        <input value={formObject.youtube_link_start_sec} onChange={handleInputChange}
          name="youtube_link_start_sec" type="text" className={inputClass} />
      </Field>
    </div>
  );
}

export function FuseFields({ formObject, handleInputChange }) {
  return (
    <div className="space-y-3">
      <Field label="Burn rate (sec/ft)">
        <input value={formObject.burn_rate} onChange={handleInputChange}
          name="burn_rate" type="number" className={inputClass} />
      </Field>
      <Field label="Color">
        <input
          value={formObject.color} onChange={handleInputChange}
          name="color" type="color"
          className="h-9 w-full rounded-sm border border-border bg-surface-1 cursor-pointer"
        />
      </Field>
    </div>
  );
}

const AddInventoryForm = (props) => {
  const [formObject, setFormObject] = useState(props.activeItem || DEFAULT_DATA);
  const [isNewItem, setIsNewItem] = useState(props.activeItem || DEFAULT_DATA);

  const commitObject = async () => {
    try { await props.addItemFnc(formObject); }
    catch (err) {
      console.error(err);
      await asyncAlert(err.response?.data?.error || err.message || "Failed to save item.");
    }
  };

  const handleDismiss = () => props.onDismiss?.();

  const handleDeleteItem = async () => {
    if (!formObject.id || !props.deleteInventoryItem) return;
    if (!(await asyncConfirm({ message: `Delete "${formObject.name}"? This cannot be undone.`, destructive: true }))) return;
    try {
      await props.deleteInventoryItem(formObject.id);
      props.onItemDeleted?.(formObject.id);
      props.onDismiss?.();
      setFormObject(DEFAULT_DATA);
    } catch (e) {
      await asyncAlert(e.response?.data?.error || "Failed to delete item.");
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    if (name === "type") setFormObject({ ...DEFAULT_DATA, [name]: value, id: formObject.id });
    else setFormObject({ ...formObject, [name]: value });
  };

  const handleYouTubeLinkBlur = (e) => {
    const v = e.target.value;
    if (v && v.trim() !== "") {
      const norm = normalizeYouTubeUrl(v);
      if (norm && norm !== v) setFormObject({ ...formObject, youtube_link: norm });
    }
  };

  useEffect(() => {
    if (props.showNewItem !== isNewItem) {
      if (props.showNewItem) setFormObject(DEFAULT_DATA);
    }
  }, [props.showNewItem]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (props.activeItem?.id) {
      setFormObject({ ...props.activeItem, metadata: props.activeItem.metadata || null });
    }
  }, [props.activeItem]);

  const shouldShow = Boolean(props.showNewItem || (props.activeItem && props.activeItem.id));

  useEffect(() => {
    if (!shouldShow) return undefined;
    const onKey = (e) => { if (e.key === "Escape") props.onDismiss?.(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [shouldShow, props.onDismiss]);

  if (!shouldShow) return null;

  const Fields =
    formObject.type === "FUSE" ? FuseFields :
    formObject.type === "AERIAL_SHELL" ? ShellFields :
    CakeFields;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
      role="dialog" aria-modal="true" aria-labelledby="inventory-editor-title"
    >
      <div
        className="absolute inset-0 bg-surface-base/70 backdrop-blur-sm"
        onClick={handleDismiss} role="presentation"
      />
      <div
        id="editForm"
        className="relative z-[101] w-full max-w-md max-h-[min(90dvh,720px)] overflow-y-auto overscroll-contain rounded-md border border-border bg-surface-1 shadow-e3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-5 h-12 border-b border-border-subtle">
          <h3 id="inventory-editor-title" className="text-base font-semibold text-fg-primary">
            {props.activeItem?.id ? "Edit item" : "Add item"}
          </h3>
          <IconButton label="Close editor" onClick={handleDismiss}>
            <MdClose className="w-5 h-5" />
          </IconButton>
        </div>

        <form className="p-5 space-y-4" onSubmit={(e) => e.preventDefault()}>
          <Field label="Type">
            <select value={formObject.type} onChange={handleInputChange}
              name="type" className={inputClass}>
              {Object.keys(INV_TYPES).map((k) => (
                <option key={k} value={k}>{INV_TYPES[k]}</option>
              ))}
            </select>
          </Field>
          <Field label="Name">
            <input value={formObject.name} onChange={handleInputChange}
              name="name" type="text" className={inputClass} />
          </Field>
          <Field label="Quantity available" hint="The amount you have on hand.">
            <input value={formObject.available_ct} onChange={handleInputChange}
              name="available_ct" type="number" className={inputClass} />
          </Field>
          <Field label="Unit cost (optional)" hint="Cost per unit in dollars. Blank if unknown.">
            <input
              value={formObject.unit_cost ?? ""}
              onChange={handleInputChange}
              name="unit_cost" type="number" min="0" step="0.01"
              placeholder="0.00" className={inputClass}
            />
          </Field>
          <ImageField
            value={formObject.image}
            onChange={(v) => setFormObject((prev) => ({ ...prev, image: v }))}
          />

          <div className="border-t border-border-subtle pt-4">
            <Fields
              formObject={formObject}
              handleInputChange={handleInputChange}
              handleYouTubeLinkBlur={handleYouTubeLinkBlur}
            />
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
            <Button variant="primary" onClick={commitObject}>
              {props.activeItem ? "Save changes" : "Add item"}
            </Button>
            {props.activeItem?.id && props.deleteInventoryItem ? (
              <Button variant="ghost" size="sm" onClick={handleDeleteItem}
                className="text-fg-muted hover:text-danger">
                Delete
              </Button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
};

export default function InventoryManager() {
  const { inventory, createInventoryItem, updateInventoryItem, fetchInventory, deleteInventoryItem } = useAppStore();
  const [activeItem, setActiveItem] = useState(false);
  const [newItem, setNewItem] = useState(false);

  const setEditorActive = (it) => { setActiveItem(it); setNewItem(false); };
  const startNewItem = () => { setActiveItem(false); setNewItem(true); };
  const dismissEditor = useCallback(() => { setActiveItem(false); setNewItem(false); }, []);
  const handleItemDeleted = (id) => {
    if (activeItem && activeItem.id === id) setActiveItem(false);
  };

  const addOrCreateItem = async (item) => {
    let normalized = { ...item, unit_cost: parseOptionalUnitCost(item.unit_cost) };
    if (item.youtube_link && item.youtube_link.trim() !== "") {
      const norm = normalizeYouTubeUrl(item.youtube_link);
      normalized.youtube_link = norm || "";
    }
    if (normalized.id) {
      const existing = inventory.find((i) => i.id === normalized.id);
      let metadata = normalized.metadata !== undefined ? normalized.metadata : existing?.metadata;
      if (metadata && typeof metadata === "object") metadata = JSON.stringify(metadata);
      await updateInventoryItem(normalized.id, { ...normalized, metadata });
    } else {
      await createInventoryItem(normalized);
    }
    dismissEditor();
  };

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 py-6">
      <Section
        title="Inventory"
        description="Catalogue of fireables. Cakes, aerial shells and fuses live here."
        actions={<Button variant="primary" onClick={startNewItem}>Add item</Button>}
      >
        <InventoryList
          inventory={inventory}
          setActiveItem={setEditorActive}
          refreshInventory={fetchInventory}
        />
      </Section>
      <AddInventoryForm
        activeItem={activeItem}
        showNewItem={newItem}
        addItemFnc={addOrCreateItem}
        deleteInventoryItem={deleteInventoryItem}
        onItemDeleted={handleItemDeleted}
        onDismiss={dismissEditor}
      />
    </div>
  );
}
