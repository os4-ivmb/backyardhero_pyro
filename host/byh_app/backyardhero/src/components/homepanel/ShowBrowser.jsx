import React, { useState } from "react";
import useAppStore from "@/store/useAppStore";
import { FaBomb, FaPen, FaTrash } from "react-icons/fa6";
import axios from "axios";

export default function ShowBrowser({setCurrentTab, setEditorShowFnc}) {
  const { shows, deleteShow, setLoadedShow, setStagedShow, loadedShow, stagedShow, inventoryById} = useAppStore(); // Get shows from app state
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [selectedShow, setSelectedShow] = useState(null);

  const toggleMenu = () => setIsMenuOpen(!isMenuOpen);

  const handleSelectShow = (show) => {
    setSelectedShow(show);
  };

  const handleAction = async (action) => {
    if (!selectedShow) return alert("Select a show first!");

    if(action === "Unstage"){
      setStagedShow({})
    }

    if(action === "Delete"){
        if(confirm("Are you sure you wanna delete this show?")){
          deleteShow(selectedShow.id)
        }else{
          setStagedShow({...selectedShow, items: parsedItems})
        }
    }else if(action == "Stage"){
      const parsedItems = JSON.parse(selectedShow.display_payload).map((pi,i)=>({...inventoryById[pi.itemId], ...pi}))
      setStagedShow({...selectedShow, items: parsedItems})
      setCurrentTab('main')
    }else if(action == "Load"){
      if(prompt("Please enter the auth code for this show to load it") == selectedShow.authorization_code){
        setStagedShow({...selectedShow, items: parsedItems})
        await axios.post(
          "/api/system/cmd_daemon",
          { type: "load_show", id: selectedShow.id },
          {
            headers: {
              "Content-Type": "application/json",
            }
          }
        );
      }else{
        alert("That wasnt it.")
      }
    }
    // Perform the actual action here (e.g., edit, view, load, delete)
  };

  return (
    <div
      className={`fixed top-12 right-0 h-3/4 bg-gray-800 shadow-lg z-10 ${
        isMenuOpen ? "w-64" : "w-12"
      } transition-all duration-300`}
    >
      {/* Collapsible Toggle Button */}
      <div
        className="absolute top-4 left-[-40px] w-10 h-10 bg-blue-800 text-white flex items-center justify-center cursor-pointer"
        onClick={toggleMenu}
      >
        {isMenuOpen ? ">" : "<"}
      </div>
      {!isMenuOpen && (
        <h3 className="text-lg font-bold rotate-90 my-4 text-gray-400">
          Shows
        </h3>
      )}

      {/* Menu Content */}
      {isMenuOpen && (
        <div className="p-4 flex flex-col h-full">
          <h3 className="text-lg font-bold mb-4">Shows</h3>

          {/* List of Shows */}
          <div className="flex-1 overflow-y-auto space-y-2">
            {shows.map((show) => (
              <div
                key={show.id}
                onClick={() => handleSelectShow(show)}
                className={`p-3 rounded-md cursor-pointer flex items-center justify-between relative ${
                  selectedShow?.id === show.id
                    ? "bg-blue-700 text-white"
                    : "bg-gray-700 text-gray-300"
                } hover:bg-blue-600`}
              >
                {/* Show name and icons */}
                <span className="flex items-center gap-2">
                  {show.name}
                  {loadedShow.id === show.id && <FaBomb />}
                  {stagedShow.id === show.id && <FaPen />}
                </span>
              
                {/* Duration in m:ss format */}
                <span className="absolute top-1/2 right-0 transform -translate-y-1/2 text-xs text-gray-400 rotate-90">
                  {Math.floor(show.duration / 60)}:
                  {String(Math.round(show.duration) % 60).padStart(2, "0")}
                </span>
            </div>
            ))}
          </div>

          {/* Action Buttons */}
          {selectedShow && (
            <div className="mt-4 flex flex-row gap-2">

              <button
                className="w-1/4 bg-green-800 text-white p-2 rounded-md hover:bg-green-600"
                onClick={() => handleAction("Stage")}
              >
                Stage
              </button>
              <button
                className="w-1/4 bg-yellow-800 text-white p-2 rounded-md hover:bg-yellow-600"
                onClick={() => handleAction("Load")}
              >
                Load
              </button>
              <button
                className="w-1/4 bg-red-800 text-white p-2 rounded-md hover:bg-red-600"
                onClick={() => handleAction("Delete")}
              >
                <FaTrash />
              </button>
            </div>
          )}
          {stagedShow.id && (
            <div className="mt-4 flex flex-row gap-2">
              <button
                className="w-1/4 bg-yellow-400 text-white p-2 rounded-md hover:bg-yellow-300"
                onClick={() => handleAction("Unstage")}
              >
                Exit
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
