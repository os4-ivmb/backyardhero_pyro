import useAppStore from "@/store/useAppStore";
import ShowBrowser from "./ShowBrowser";
import Timeline from "../common/Timeline";
import { useState, useEffect, useRef } from "react";
import { FaPlay, FaPause, FaListAlt } from "react-icons/fa";
import { FaCheck, FaClock, FaHandPointDown, FaRocket, FaX } from "react-icons/fa6";
import MultiShowSection from "./MultiShowSection";
import useStateAppStore from "@/store/useStateAppStore";
import axios from "axios";
import VideoPreviewPopup from "../common/VideoPreviewPopup";

import styles from './StatusPanel.module.css'

export default function StatusPanel(props) {
    const { stagedShow, shows, deleteShow, setStagedShow, loadedShow, inventoryById } = useAppStore();
    const { stateData } = useStateAppStore();
    const [timeCursor, setTimeCursor] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [vidItems, setVidItems] = useState([])
    const [countdownSeconds, setCountdownSeconds] = useState(null);
    const lastUpdateTimeRef = useRef(null);
    const requestRef = useRef(null);
    const countdownIntervalRef = useRef(null);

    const unloadOrLoadShow = async (isloaded) => {
        if(isloaded){
        await axios.post(
            "/api/system/cmd_daemon",
            { type: "unload_show", id: stagedShow.id },
            {
              headers: {
                "Content-Type": "application/json",
              }
            }
          );
        }else{
            if(prompt("Please enter the auth code for this show") == stagedShow.authorization_code){
                await axios.post(
                    "/api/system/cmd_daemon",
                    { type: "load_show", id: stagedShow.id },
                    {
                      headers: {
                        "Content-Type": "application/json",
                      }
                    }
                  );
            }else{
                alert("Thats not right")
            }
        }
    }

    const handleShowAction = async (action, show) => {
        if (!show) return alert("Internal error - show not provided for action");

        if (action === "Delete") {
            if (confirm("Are you sure you wanna delete this show?")) {
                deleteShow(show.id);
            }
        } else if (action === "Stage") {
            const parsedItems = JSON.parse(show.display_payload).map((pi, i) => ({ ...inventoryById[pi.itemId], ...pi }));
            setStagedShow({ ...show, items: parsedItems });
            // setCurrentTab might not be available here, consider if this is needed or how to handle
            // props.setCurrentTab('editor'); 
        } else if (action === "Load") {
            if (prompt("Please enter the auth code for this show to load it") == show.authorization_code) {
                await axios.post(
                    "/api/system/cmd_daemon",
                    { type: "load_show", id: show.id },
                    {
                        headers: {
                            "Content-Type": "application/json",
                        }
                    }
                );
            } else {
                alert("That wasnt it.");
            }
        }
    };

    const delegatedShowAction = async (action) => {
        await axios.post(
            "/api/system/cmd_daemon",
            { type: `${action}_show`, meh: ":)" },
            {
              headers: {
                "Content-Type": "application/json",
              }
            }
          );
    }

    // Function to format time as MM:SS
    const formatTime = (seconds) => {
        const min = Math.floor(seconds / 60);
        const sec = Math.floor(seconds % 60);
        return `${min.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
    };

    // Smooth timer using requestAnimationFrame
    const updateCursor = (timestamp) => {
        if (!lastUpdateTimeRef.current) {
            lastUpdateTimeRef.current = timestamp;
        }

        const elapsed = (timestamp - lastUpdateTimeRef.current) / 1000; // Convert ms to sec

        setTimeCursor((prev) => {
            const nextTime = prev + elapsed;

            // Filter out objects that exist in the subset
            const itemsToFire = stagedShow.items.filter(obj => ( obj.startTime-1.5 < nextTime)).sort((a, b) => a.startTime - b.startTime);

            setVidItems(itemsToFire.map(ob=>({...ob, hide: (ob.startTime+ob.duration < nextTime)})))

            return nextTime >= stagedShow.duration ? stagedShow.duration : nextTime;
        });

        lastUpdateTimeRef.current = timestamp;
        requestRef.current = requestAnimationFrame(updateCursor);
    };
    
    useEffect(()=>{
        if(stateData.fw_state?.show_running){
            console.log(stateData.fw_cursor)
            setTimeCursor(stateData.fw_cursor)
        }
    }, [stateData.fw_state?.show_running, stateData.fw_cursor])

    // Start/Stop Animation Frame Loop
    useEffect(() => {
        if (isPlaying && stagedShow?.items) {
            requestRef.current = requestAnimationFrame(updateCursor);
        } else {
            cancelAnimationFrame(requestRef.current);
        }

        return () => cancelAnimationFrame(requestRef.current);
    }, [isPlaying, stagedShow]);

    useEffect(() => {
        if (stateData.fw_state?.proto_handler_status === "START_CONFIRMED" && stateData.fw_state?.sst) {
            const updateCountdown = () => {
                const now = Date.now();
                const remaining = Math.max(0, Math.floor((stateData.fw_state.sst - now) / 1000));
                setCountdownSeconds(remaining);

                if (remaining === 0) {
                    clearInterval(countdownIntervalRef.current);
                    countdownIntervalRef.current = null;
                }
            };

            updateCountdown(); // Initial call to set countdown immediately
            if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current); // Clear existing interval
            countdownIntervalRef.current = setInterval(updateCountdown, 1000);

        } else {
            if (countdownIntervalRef.current) {
                clearInterval(countdownIntervalRef.current);
                countdownIntervalRef.current = null;
            }
            setCountdownSeconds(null);
        }

        return () => {
            if (countdownIntervalRef.current) {
                clearInterval(countdownIntervalRef.current);
            }
        };
    }, [stateData.fw_state?.proto_handler_status, stateData.fw_state?.sst]);

    const showErrors = (stateData.fw_state?.fire_check_failures || []).concat(stateData.fw_state?.proto_handler_errors || [])

    const isReady = stateData.fw_state?.show_loaded && showErrors.length == 0
    let showFireButton = false

    let showStateLabel=(isReady ? "Ready To Fire" : "Checks Failed")
    let showStateCls=(isReady ? "bg-green-900 border border-green-800" : "bg-red-900 border border-red-800")
    let ShowStateIcon=(isReady ? FaCheck : FaX)

    const handlerInStartPhase = stateData.fw_state?.proto_handler_status ? 
        stateData.fw_state?.proto_handler_status.split('_')[0]?.startsWith("START") : false

    if(isReady && stateData.fw_state?.dstc && !stateData.fw_state?.waiting_for_client_start){
        if(handlerInStartPhase){
            showStateCls="bg-green-900 border border-green-800"
            showStateLabel=stateData.fw_state?.proto_handler_status == "STARTED" ? "Started": "Starting"
            ShowStateIcon= FaPlay
        }else{
            showStateCls="bg-yellow-900 border border-yellow-800"
            showStateLabel="Waiting on Start"
            ShowStateIcon= FaHandPointDown
        }
    }else if(stateData.fw_state?.waiting_for_client_start){
        showStateCls="bg-green-900 border bg-green-800"
        showStateLabel="Ready To Go"
        showFireButton = true
    }

    const loadedCls = stateData.fw_state?.show_loaded ? "bg-green-900 border border-green-800" : "bg-yellow-900 border border-yellow-800"

    return (
        <div className="max-w-auto">
            <ShowBrowser setCurrentTab={props.setCurrentTab} />
            {stagedShow?.items ? (
                <div className="fixed top-10 left-0 right-0 mb-2 bg-gray-1000 text-white p-4 text-center">
                    
                    <Timeline 
                        items={stagedShow.items} 
                        setTimeCursor={setTimeCursor} 
                        timeCursor={timeCursor} 
                        readOnly={true} 
                        timeCapSeconds={stagedShow.duration} 
                    />
                    {vidItems.length ? (
                        <VideoPreviewPopup items={vidItems} isVisible={isPlaying && vidItems.length}/>
                    ):""}
                    {/* Play/Pause Controls & Time Display */}
                    <div className="flex justify-between items-center mb-4 bg-gray-900 ">
                        {/* Play/Pause Buttons */}
                        <div className="flex gap-4 bg-gray-900 p-2">
                            <button
                                onClick={() => setIsPlaying(true)}
                                disabled={isPlaying || stateData.fw_state.show_loaded}
                                className={`p-3 rounded-full transition-all duration-300 shadow-md ${
                                    isPlaying ? "bg-gray-700 text-gray-500 cursor-not-allowed" : "bg-gray-800 hover:bg-gray-700 text-white"
                                }`}
                            >
                                <FaPlay size={24} />
                            </button>

                            <button
                                onClick={() => setIsPlaying(false)}
                                disabled={!isPlaying}
                                className={`p-3 rounded-full transition-all duration-300 shadow-md ${
                                    !isPlaying ? "bg-gray-700 text-gray-500 cursor-not-allowed" : "bg-gray-800 hover:bg-gray-700 text-white"
                                }`}
                            >
                                <FaPause size={24} />
                            </button>
                            <div className="leading-[3rem] text-center text-sm">
                                {formatTime(timeCursor)} / {formatTime(stagedShow.duration)}
                            </div>
                            <div className="text-lg leading-[3rem] text-center font-semibold ml-12">{stagedShow.name} Timeline</div>
                            <div className={`text-lg leading-[3rem] text-center font-semibold ml-12 px-4 ${loadedCls}`}>
                                 {stateData.fw_state.show_loaded ? '' : 'Not '} Loaded 
                                 <button
                                    onClick={()=>{unloadOrLoadShow(stateData.fw_state.show_loaded)}}
                                    className="bg-blue-900 hover:bg-blue-700 text-white font-bold px-2 mx-1 rounded focus:outline-none focus:shadow-outline"
                                    type="button"
                                    >
                                    {stateData.fw_state.show_loaded ? "Unload" : "Load"}
                                </button>
                            </div>
                            <div className={`flex items-center text-lg leading-[3rem] text-center font-semibold ml-6 px-4 ${showStateCls}`}>
                                <ShowStateIcon className="mr-2"/> {showStateLabel}
                            </div>
                            {
                                (stateData.fw_state?.proto_handler_status == "START_PENDING") && 
                                (<div 
                                    className={`flex items-center text-lg leading-[3rem] text-center font-semibold ml-6 px-4 ${styles.rotating_border}`}
                                >
                                    <FaListAlt className="mr-2"/> Pre-Start
                                </div>)
                            }
                            {
                                (stateData.fw_state?.proto_handler_status == "START_CONFIRMED") && 
                                (<div 
                                    className={`flex items-center text-lg leading-[3rem] text-center font-semibold ml-6 px-4 ${styles.rotating_border_fast}`}
                                >
                                    <FaClock className="mr-2"/> In Countdown! {countdownSeconds !== null && countdownSeconds >= 0 ? formatTime(countdownSeconds) : ""}
                                </div>)
                            }
                            { 
                                (stateData.fw_state?.dstc && stateData.fw_state?.waiting_for_client_start || handlerInStartPhase) && (
                                    <div>
                                    { stateData.fw_state?.show_running ||  handlerInStartPhase ? (
                                        <div
                                            className={`flex items-center text-lg leading-[3rem] text-center font-semibold ml-6 px-4 bg-red-600 hover:bg-red-500 text-white font-bold rounded cursor-pointer border border-red-500`}
                                            onClick={()=> delegatedShowAction('stop')}
                                        >
                                            <FaX className="mr-2"/> Abort
                                        </div>
                                    ): (
                                        <div 
                                            className={`flex items-center text-lg leading-[3rem] text-center font-semibold ml-6 px-4 ${styles.pushy_green_border}`}
                                            onClick={()=> delegatedShowAction('start')}
                                        >
                                            <FaRocket className="mr-2"/> Launch!  
                                        </div>
                                    )}
                                    </div>
                                )
                            }
                        </div>
                    </div>
                    <div className="p-3 bg-gray-800 w-full">
                        <MultiShowSection errorsForShow={showErrors} protoHandlerStatus={stateData.fw_state?.proto_handler_status}/>
                    </div>

                </div>
            ) : (
                <div className="fixed top-10 left-0 right-0 mb-2 bg-gray-1000 text-white p-4 text-center min-h-[300px]">
                    <div className="flex flex-col items-center justify-center h-full pt-10">
                        <FaRocket size={50} className="mb-4 text-blue-400" />
                        <h2 className="text-2xl font-semibold mb-3">No Show Staged Yet!</h2>
                        <p className="text-md text-gray-300 mb-4">
                            Please select a show from the list below to get started.
                        </p>
                        {shows && shows.length > 0 ? (
                            <div className="w-full max-w-2xl mx-auto bg-gray-900 shadow-md rounded-lg overflow-y-auto max-h-72">
                                <table className="min-w-full leading-normal">
                                    <thead>
                                        <tr>
                                            <th className="px-5 py-3 border-b-2 border-gray-700 bg-gray-800 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider">
                                                Show Name
                                            </th>
                                            <th className="px-5 py-3 border-b-2 border-gray-700 bg-gray-800 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider">
                                                Duration
                                            </th>
                                            <th className="px-5 py-3 border-b-2 border-gray-700 bg-gray-800 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider">
                                                Targets
                                            </th>
                                            <th className="px-5 py-3 border-b-2 border-gray-700 bg-gray-800 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider">
                                                Status
                                            </th>
                                            <th className="px-5 py-3 border-b-2 border-gray-700 bg-gray-800 text-center text-xs font-semibold text-gray-300 uppercase tracking-wider">
                                                Actions
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {shows.map((show) => {
                                            let targetCount = 0;
                                            if (show.display_payload) {
                                                try {
                                                    const items = JSON.parse(show.display_payload);
                                                    const uniqueTargets = new Set();
                                                    items.forEach(item => {
                                                        // Assuming each item in display_payload that is a "cue" has a target_id
                                                        // and items in inventoryById (which are merged) also have target_id if they are devices
                                                        const fullItem = inventoryById[item.itemId] || {};
                                                        const targetId = item.target_id || fullItem.target_id;
                                                        if (targetId) {
                                                            uniqueTargets.add(targetId);
                                                        }
                                                    });
                                                    targetCount = uniqueTargets.size;
                                                } catch (e) {
                                                    console.error("Failed to parse display_payload for show:", show.name, e);
                                                }
                                            }
                                            return (
                                            <tr key={show.id} className="hover:bg-gray-700">
                                                <td className="px-5 py-4 border-b border-gray-700 text-sm">
                                                    <p className="text-gray-100 whitespace-no-wrap">{show.name}</p>
                                                </td>
                                                <td className="px-5 py-4 border-b border-gray-700 text-sm">
                                                    <p className="text-gray-300 whitespace-no-wrap">
                                                        {Math.floor(show.duration / 60)}:
                                                        {String(Math.round(show.duration) % 60).padStart(2, "0")}
                                                    </p>
                                                </td>
                                                <td className="px-5 py-4 border-b border-gray-700 text-sm">
                                                    <p className="text-gray-300 whitespace-no-wrap">{targetCount}</p>
                                                </td>
                                                <td className="px-5 py-4 border-b border-gray-700 text-sm">
                                                    {loadedShow?.id === show.id && <span className="text-yellow-400">Loaded</span>}
                                                    {stagedShow?.id === show.id && loadedShow?.id !== show.id && <span className="text-green-400">Staged</span>}
                                                    {loadedShow?.id !== show.id && stagedShow?.id !== show.id && <span className="text-gray-500">-</span>}
                                                </td>
                                                <td className="px-5 py-4 border-b border-gray-700 text-sm text-center">
                                                    <button
                                                        onClick={() => handleShowAction("Stage", show)}
                                                        disabled={stagedShow?.id === show.id}
                                                        className={`bg-green-700 hover:bg-green-600 text-white font-bold py-1 px-3 rounded text-xs mr-1 ${stagedShow?.id === show.id ? "opacity-50 cursor-not-allowed" : ""}`}
                                                    >
                                                        Stage
                                                    </button>
                                                    <button
                                                        onClick={() => handleShowAction("Load", show)}
                                                        disabled={loadedShow?.id === show.id}
                                                        className={`bg-yellow-600 hover:bg-yellow-500 text-white font-bold py-1 px-3 rounded text-xs mr-1 ${loadedShow?.id === show.id ? "opacity-50 cursor-not-allowed" : ""}`}
                                                    >
                                                        Load
                                                    </button>
                                                     <button
                                                        onClick={() => handleShowAction("Delete", show)}
                                                        className="bg-red-700 hover:bg-red-600 text-white font-bold py-1 px-3 rounded text-xs"
                                                    >
                                                        Delete
                                                    </button>
                                                </td>
                                            </tr>
                                        )})}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                             <p className="mt-2 text-sm text-gray-500">
                                No shows available to display. Create a new show in the editor.
                            </p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
