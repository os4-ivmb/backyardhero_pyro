import React, { useCallback, useEffect, useState } from "react"
import { MdClose } from "react-icons/md";

import useAppStore from '@/store/useAppStore';
import InventoryList from "./InventoryList";
import { INV_TYPES } from "@/constants";
import { normalizeYouTubeUrl } from "@/util/youtube";
import { parseOptionalUnitCost } from "@/util/inventoryUnitCost";

const DEFAULT_DATA = {
    id: "",
    name: "",
    type: "FUSE",
    duration: "",
    fuse_delay: "",
    lift_delay: "",
    burn_rate: "",
    color: "",
    available_ct: "",
    unit_cost: "",
    youtube_link: "",
    youtube_link_start_sec: "",
    image: ""
}


export function CakeFields(props){
  console.log(props)
    return (
        <div className="mb-6">
            <label className="block text-gray-200 text-sm font-bold mb-2" htmlFor="password">
                Duration (seconds)
            </label>
            <input  value={props.formObject.duration} onChange={props.handleInputChange}  className="shadow appearance-none border rounded w-full py-2 px-3 text-white mb-3 leading-tight focus:outline-none focus:shadow-outline" name="duration" type="number"/>
            <label className="block text-gray-200 text-sm font-bold mb-2" htmlFor="password">
                Fuse Delay (seconds)
            </label>
            <input value={props.formObject.fuse_delay} onChange={props.handleInputChange}  className="shadow appearance-none border rounded w-full py-2 px-3 text-white mb-3 leading-tight focus:outline-none focus:shadow-outline" name="fuse_delay" type="number"/>
            <p className="text-gray-400 text-xs italic">Seconds delay from when charge is fired to the first shot of the cake.</p>
            <label className="block text-gray-200 text-sm font-bold mb-2" htmlFor="name">
                Youtube Link
            </label>
            <input value={props.formObject.youtube_link || ""} onChange={props.handleInputChange} onBlur={props.handleYouTubeLinkBlur} className="shadow appearance-none border rounded w-full py-2 px-3 mb-2 text-white leading-tight focus:outline-none focus:shadow-outline" name="youtube_link" type="text" placeholder="https://youtube.com/watch?v=... or https://youtu.be/..."/>
            <label className="block text-gray-200 text-sm font-bold mb-2" htmlFor="name">
                Youtube Link Start Seconds
            </label>
            <input value={props.formObject.youtube_link_start_sec|| 0} onChange={props.handleInputChange} className="shadow appearance-none border rounded w-full py-2 px-3 mb-2 text-white leading-tight focus:outline-none focus:shadow-outline" name="youtube_link_start_sec" type="text"/>
        </div>
    )
}

export function ShellFields(props){
    return (
        <div className="mb-6">
            <label className="block text-gray-200 text-sm font-bold mb-2" htmlFor="password">
                Lift Delay (seconds)
            </label>
            <input value={props.formObject.lift_delay} onChange={props.handleInputChange} className="shadow appearance-none border rounded w-full py-2 px-3 text-white mb-3 leading-tight focus:outline-none focus:shadow-outline" name="lift_delay" type="number"/>
            <p className="text-gray-400 text-xs italic">Seconds delay from when lift charge is fired to the break.</p>
            <label className="block text-gray-200 text-sm font-bold mb-2" htmlFor="password">
                Fuse Delay (seconds)
            </label>
            <input value={props.formObject.fuse_delay} onChange={props.handleInputChange} className="shadow appearance-none border rounded w-full py-2 px-3 text-white mb-3 leading-tight focus:outline-none focus:shadow-outline" name="fuse_delay" type="number"/>
            <p className="text-gray-400 text-xs italic">Seconds delay from when charge is fired to the life charge.</p>
            <label className="block text-gray-200 text-sm font-bold mb-2" htmlFor="name">
                Youtube Link
            </label>
            <input value={props.formObject.youtube_link || ""} onChange={props.handleInputChange} onBlur={props.handleYouTubeLinkBlur} className="shadow appearance-none border rounded w-full py-2 px-3 mb-2 text-white leading-tight focus:outline-none focus:shadow-outline" name="youtube_link" type="text" placeholder="https://youtube.com/watch?v=... or https://youtu.be/..."/>
            <label className="block text-gray-200 text-sm font-bold mb-2" htmlFor="name">
                Youtube Link Start Seconds
            </label>
            <input value={props.formObject.youtube_link_start_sec} onChange={props.handleInputChange} className="shadow appearance-none border rounded w-full py-2 px-3 mb-2 text-white leading-tight focus:outline-none focus:shadow-outline" name="youtube_link_start_sec" type="text"/>
        </div>
    )
}

export function FuseFields(props){
    return (
        <div className="mb-6">
            <label className="block text-gray-200 text-sm font-bold mb-2" htmlFor="burn_rate">
                Burn Rate (sec/ft)
            </label>
            <input value={props.formObject.burn_rate} onChange={props.handleInputChange} className="shadow appearance-none border rounded w-full py-2 px-3 text-white mb-3 leading-tight focus:outline-none focus:shadow-outline" name="burn_rate" type="number"/>
            <label className="block text-gray-200 text-sm font-bold mb-2" htmlFor="color">
                Color
            </label>
            <input value={props.formObject.color} onChange={props.handleInputChange}  className="shadow appearance-none w-full leading-tight focus:outline-none focus:shadow-outline" name="color" type="color"/>
        </div>
    )
}

const AddInventoryForm = (props) => {
    const [formObject, setFormObject] = useState(props.activeItem || DEFAULT_DATA);
    const [isNewItem, setIsNewItem] = useState(props.activeItem || DEFAULT_DATA);
  
    const commitObject = async () => {
      try {
        await props.addItemFnc(formObject);
      } catch (err) {
        console.error(err);
        alert(err.response?.data?.error || err.message || "Failed to save inventory item.");
      }
    };

    const handleDismiss = () => {
      props.onDismiss?.();
    };

    const handleDeleteItem = async () => {
      if (!formObject.id || !props.deleteInventoryItem) return;
      if (!window.confirm(`Delete "${formObject.name}"? This cannot be undone.`)) return;
      try {
        await props.deleteInventoryItem(formObject.id);
        props.onItemDeleted?.(formObject.id);
        props.onDismiss?.();
        setFormObject(DEFAULT_DATA);
      } catch (error) {
        console.error("Error deleting inventory item:", error);
        alert(error.response?.data?.error || "Failed to delete inventory item.");
      }
    };
  
    const handleInputChange = (e) => {
      const { name, value } = e.target;
      if (name === "type") {
        setFormObject({ ...DEFAULT_DATA, [name]: value, id: formObject.id });
      } else {
        setFormObject({ ...formObject, [name]: value });
      }
    };

    const handleYouTubeLinkBlur = (e) => {
      const { value } = e.target;
      if (value && value.trim() !== '') {
        const normalizedUrl = normalizeYouTubeUrl(value);
        if (normalizedUrl && normalizedUrl !== value) {
          // Update the form with normalized URL so user can see it
          setFormObject({ ...formObject, youtube_link: normalizedUrl });
        }
      }
    };
  
    useEffect(() => {
      if (props.showNewItem !== isNewItem) {
        if (props.showNewItem) {
          setFormObject(DEFAULT_DATA);
        }
      }
    }, [props.showNewItem]);
  
    useEffect(() => {
      if (props.activeItem?.id) {
        // Preserve metadata when loading item into form
        setFormObject({
          ...props.activeItem,
          // Ensure metadata is preserved (might be parsed object or string)
          metadata: props.activeItem.metadata || null
        });
      }
    }, [props.activeItem]);

    const shouldShow = Boolean(
      props.showNewItem || (props.activeItem && props.activeItem.id)
    );

    useEffect(() => {
      if (!shouldShow) return undefined;
      const onKey = (e) => {
        if (e.key === "Escape") props.onDismiss?.();
      };
      window.addEventListener("keydown", onKey);
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        window.removeEventListener("keydown", onKey);
        document.body.style.overflow = prevOverflow;
      };
    }, [shouldShow, props.onDismiss]);

    const FieldsComponent =
      formObject.type === "FUSE"
        ? FuseFields
        : formObject.type === "AERIAL_SHELL"
        ? ShellFields
        : CakeFields;
  
    if (!shouldShow) {
      return null;
    }

    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inventory-editor-title"
      >
        <div
          className="absolute inset-0 bg-black/60"
          onClick={handleDismiss}
          role="presentation"
        />
        <div
          id="editForm"
          className="relative z-[101] w-full max-w-md max-h-[min(90dvh,720px)] overflow-y-auto overscroll-contain rounded-lg border border-gray-600 bg-gray-900 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
        <form className="bg-gray-800 px-6 sm:px-8 pt-6 pb-8 rounded-lg">
          <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b border-gray-600">
            <h3 id="inventory-editor-title" className="text-base font-semibold text-gray-100">
              {props.activeItem?.id ? "Edit item" : "Add item"}
            </h3>
            <button
              type="button"
              onClick={handleDismiss}
              className="shrink-0 p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-cyan-500"
              title="Close"
              aria-label="Close editor"
            >
              <MdClose className="w-5 h-5" />
            </button>
          </div>
          {/* Form Fields */}
          <div className="mb-4">
            <label
              className="block text-gray-200 text-sm font-bold mb-2"
              htmlFor="type"
            >
              Type
            </label>
            <select
              value={formObject.type}
              onChange={handleInputChange}
              name="type"
              className="block appearance-none w-full border border-gray-400 hover:border-gray-500 px-4 py-2 pr-8 rounded shadow leading-tight focus:outline-none focus:shadow-outline"
            >
              {Object.keys(INV_TYPES).map((k, i) => (
                <option key={i} value={k}>
                  {INV_TYPES[k]}
                </option>
              ))}
            </select>
  
            <label
              className="block text-gray-200 text-sm font-bold mb-2"
              htmlFor="name"
            >
              Name
            </label>
            <input value={formObject.id} id="idx" type="hidden" />
            <input
              value={formObject.name}
              onChange={handleInputChange}
              className="shadow appearance-none border rounded w-full py-2 px-3 mb-2 text-white leading-tight focus:outline-none focus:shadow-outline"
              name="name"
              type="text"
            />
  
            <label
              className="block text-gray-200 text-sm font-bold mb-2"
              htmlFor="available_ct"
            >
              Quantity Available
            </label>
            <input
              value={formObject.available_ct}
              onChange={handleInputChange}
              className="shadow appearance-none border rounded w-full py-2 px-3 text-white mb-3 leading-tight focus:outline-none focus:shadow-outline"
              name="available_ct"
              type="number"
            />
            <p className="text-gray-400 text-xs italic">
              The Amount you have on you.
            </p>

            <label
              className="block text-gray-200 text-sm font-bold mb-2"
              htmlFor="unit_cost"
            >
              Unit cost (optional)
            </label>
            <input
              value={formObject.unit_cost === null || formObject.unit_cost === undefined ? "" : formObject.unit_cost}
              onChange={handleInputChange}
              className="shadow appearance-none border rounded w-full py-2 px-3 text-white mb-3 leading-tight focus:outline-none focus:shadow-outline"
              name="unit_cost"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
            />
            <p className="text-gray-400 text-xs italic">
              Cost per unit (2 decimal places). Leave blank if unknown.
            </p>
  
            <label
              className="block text-gray-200 text-sm font-bold mb-2"
              htmlFor="image"
            >
              Image URL
            </label>
            <input
              value={formObject.image || ""}
              onChange={handleInputChange}
              className="shadow appearance-none border rounded w-full py-2 px-3 text-white mb-3 leading-tight focus:outline-none focus:shadow-outline"
              name="image"
              type="text"
            />
            <p className="text-gray-400 text-xs italic">An image to use.</p>
          </div>
  
          <FieldsComponent
            handleInputChange={handleInputChange}
            handleYouTubeLinkBlur={handleYouTubeLinkBlur}
            formObject={formObject}
          />
  
          <div className="flex items-center justify-between gap-3 pt-2 border-t border-gray-700">
            <button
              onClick={commitObject}
              className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline"
              type="button"
            >
              {props.activeItem ? "Update" : "Add"}
            </button>
            {props.activeItem?.id && props.deleteInventoryItem ? (
              <button
                type="button"
                onClick={handleDeleteItem}
                className="text-xs text-gray-500 hover:text-red-400 focus:outline-none focus:underline"
                title="Permanently delete this item"
              >
                Delete
              </button>
            ) : null}
          </div>
        </form>
        </div>
      </div>
    );
  };

export default function InventoryManager(props){
    const { inventory, createInventoryItem, updateInventoryItem, fetchInventory, deleteInventoryItem } = useAppStore();
    const [activeItem, setActiveItem] = useState(false);
    const [newItem, setNewItem] = useState(false);

    const setEditorActive = (inv_item) => {
        setActiveItem({});
        setActiveItem(inv_item);
        setNewItem(false)
    }

    const startNewItem = () => {
        setActiveItem(false)
        setNewItem(true)
    }

    const dismissEditor = useCallback(() => {
        setActiveItem(false);
        setNewItem(false);
    }, []);

    const handleItemDeleted = (id) => {
        if (activeItem && activeItem.id === id) {
            setActiveItem(false);
        }
    };

    const addOrCreateItem = async (inv_item) => {
        // Normalize YouTube URL before saving
        let normalizedItem = { ...inv_item, unit_cost: parseOptionalUnitCost(inv_item.unit_cost) };
        if (inv_item.youtube_link && inv_item.youtube_link.trim() !== '') {
            const normalizedUrl = normalizeYouTubeUrl(inv_item.youtube_link);
            if (normalizedUrl) {
                normalizedItem.youtube_link = normalizedUrl;
            } else {
                // If URL is invalid, clear it or keep as-is (user might want to fix later)
                // For now, we'll clear invalid URLs
                normalizedItem.youtube_link = '';
            }
        }

        if (normalizedItem.id) {
            // Preserve existing metadata if not provided in the update
            const existingItem = inventory.find(item => item.id === normalizedItem.id);
            let metadataToSave = null;
            
            // If metadata is explicitly in the form object, use it
            if (normalizedItem.metadata !== undefined) {
                metadataToSave = normalizedItem.metadata;
            } else if (existingItem?.metadata) {
                // Otherwise, preserve existing metadata
                metadataToSave = existingItem.metadata;
            }
            
            // If metadata is an object (parsed), stringify it for the API
            if (metadataToSave && typeof metadataToSave === 'object') {
                metadataToSave = JSON.stringify(metadataToSave);
            }
            
            const updateData = {
                ...normalizedItem,
                metadata: metadataToSave
            };
            
            await updateInventoryItem(normalizedItem.id, updateData);
        } else {
            await createInventoryItem(normalizedItem);
        }
        dismissEditor();
    };

    return (
        <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 pb-8">
            <header className="flex flex-wrap items-center justify-between gap-3 mb-5 pt-2">
                <h2 className="text-2xl font-semibold text-gray-100 shrink-0">Inventory List</h2>
                <button onClick={()=>startNewItem()} className="shrink-0 bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline" type="button">
                    Add New
                </button>
            </header>
            <InventoryList
                inventory={inventory}
                setActiveItem={setEditorActive}
                refreshInventory={fetchInventory}
            />
            <AddInventoryForm
                activeItem={activeItem}
                showNewItem={newItem}
                addItemFnc={addOrCreateItem}
                deleteInventoryItem={deleteInventoryItem}
                onItemDeleted={handleItemDeleted}
                onDismiss={dismissEditor}
            />
        </div>
    )
}