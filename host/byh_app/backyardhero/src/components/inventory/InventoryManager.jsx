import React, { useEffect, useState } from "react"

import useAppStore from '@/store/useAppStore';
import InventoryList from "./InventoryList";
import { INV_TYPES } from "@/constants";

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
            <input value={props.formObject.youtube_link || ""} onChange={props.handleInputChange} className="shadow appearance-none border rounded w-full py-2 px-3 mb-2 text-white leading-tight focus:outline-none focus:shadow-outline" name="youtube_link" type="text"/>
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
            <input value={props.formObject.youtube_link || ""} onChange={props.handleInputChange} className="shadow appearance-none border rounded w-full py-2 px-3 mb-2 text-white leading-tight focus:outline-none focus:shadow-outline" name="youtube_link" type="text"/>
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
  
    const commitObject = () => {
      props.addItemFnc(formObject);
    };
  
    const handleInputChange = (e) => {
      const { name, value } = e.target;
      if (name === "type") {
        setFormObject({ ...DEFAULT_DATA, [name]: value, id: formObject.id });
      } else {
        setFormObject({ ...formObject, [name]: value });
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
  
    const shouldShow = props.activeItem || props.showNewItem;
  
    const FieldsComponent =
      formObject.type === "FUSE"
        ? FuseFields
        : formObject.type === "AERIAL_SHELL"
        ? ShellFields
        : CakeFields;
  
    return (
      <div
        className={`w-full sticky top-4 max-w-xs ${
          shouldShow ? "" : "hidden"
        }`}
        id="editForm"
      >
        <form className="bg-gray-800 shadow-md rounded px-8 pt-6 pb-8 mb-4">
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
            formObject={formObject}
          />
  
          <div className="flex items-center justify-between">
            <button
              onClick={commitObject}
              className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline"
              type="button"
            >
              {props.activeItem ? "Update" : "Add"}
            </button>
          </div>
        </form>
      </div>
    );
  };

export default function InventoryManager(props){
    const { inventory, createInventoryItem, updateInventoryItem} = useAppStore();
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

    const addOrCreateItem = (inv_item) => {
        if(inv_item.id){
            // Preserve existing metadata if not provided in the update
            const existingItem = inventory.find(item => item.id === inv_item.id);
            let metadataToSave = null;
            
            // If metadata is explicitly in the form object, use it
            if (inv_item.metadata !== undefined) {
                metadataToSave = inv_item.metadata;
            } else if (existingItem?.metadata) {
                // Otherwise, preserve existing metadata
                metadataToSave = existingItem.metadata;
            }
            
            // If metadata is an object (parsed), stringify it for the API
            if (metadataToSave && typeof metadataToSave === 'object') {
                metadataToSave = JSON.stringify(metadataToSave);
            }
            
            const updateData = {
                ...inv_item,
                metadata: metadataToSave
            };
            
            updateInventoryItem(inv_item.id, updateData)
        }else{
            createInventoryItem(inv_item)
        }
        setNewItem(false)
    }

    return (
        <div className="mx-2">
            <div className="w-full flex justify-center items-center gap-2 my-6">
                <div className="w-4/6 justify-left items-left">
                    <h2 className="text-2xl">Inventory List</h2>
                </div>
                <div className="w-1/6">
                    <button onClick={()=>startNewItem()} className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline" type="button">
                        Add New
                    </button>
                </div>
            </div>
            <div className="flex">
            <InventoryList  className="w-3/4" inventory={inventory} setActiveItem={setEditorActive}/>
            <AddInventoryForm activeItem={activeItem} showNewItem={newItem} addItemFnc={addOrCreateItem} className="w-1/4"/>
            </div>
        </div>
    )
}