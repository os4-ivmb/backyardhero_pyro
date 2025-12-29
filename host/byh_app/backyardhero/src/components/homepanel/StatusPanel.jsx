import useAppStore from "@/store/useAppStore";
import ShowBrowser from "./ShowBrowser";
import Timeline from "../common/Timeline";
import { useState, useEffect, useRef, memo, useMemo } from "react";
import { FaPlay, FaPause, FaListAlt, FaMusic } from "react-icons/fa";
import { FaCheck, FaClock, FaHandPointDown, FaRocket, FaX, FaTriangleExclamation } from "react-icons/fa6";
import MultiShowSection from "./MultiShowSection";
import useStateAppStore from "@/store/useStateAppStore";
import axios from "axios";
import VideoPreviewPopup from "../common/VideoPreviewPopup";
import WaveSurfer from 'wavesurfer.js';
import ShowHealth from "./ShowHealth";

import styles from './StatusPanel.module.css'

const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
};

// Minimal Audio Waveform Component
const MinimalAudioWaveform = ({ audioFile, isPlaying, onTimeUpdate }) => {
    const waveformRef = useRef(null);
    const wavesurferRef = useRef(null);
    const [isReady, setIsReady] = useState(false);

    useEffect(() => {
        if (waveformRef.current && !wavesurferRef.current && audioFile?.url) {
            try {
                wavesurferRef.current = WaveSurfer.create({
                    container: waveformRef.current,
                    waveColor: '#6B7280',
                    progressColor: '#10B981',
                    cursorColor: '#EF4444',
                    barWidth: 1,
                    barRadius: 1,
                    cursorWidth: 0,
                    height: 30,
                    barGap: 1,
                    responsive: true,
                    normalize: true,
                    interact: false, // Disable interaction for minimal version
                });

                wavesurferRef.current.on('ready', () => {
                    setIsReady(true);
                });

                wavesurferRef.current.on('audioprocess', (currentTime) => {
                    if (onTimeUpdate) {
                        onTimeUpdate(currentTime);
                    }
                });

                wavesurferRef.current.on('finish', () => {
                    if (onTimeUpdate) {
                        onTimeUpdate(0);
                    }
                });

                wavesurferRef.current.on('error', (error) => {
                    console.error('WaveSurfer error:', error);
                    setIsReady(false);
                });

                // Load the audio file
                wavesurferRef.current.load(audioFile.url);
            } catch (error) {
                console.error('Error creating WaveSurfer instance:', error);
            }
        }

        return () => {
            if (wavesurferRef.current && isReady) {
                try {
                    // Pause before destroying to avoid abort errors
                    wavesurferRef.current.pause();
                    wavesurferRef.current.destroy();
                } catch (error) {
                    console.error('Error destroying WaveSurfer:', error);
                } finally {
                    wavesurferRef.current = null;
                    setIsReady(false);
                }
            }
        };
    }, [audioFile?.url]);

    useEffect(() => {
        console.log("isPlayingEFFECT", isPlaying)
        if (wavesurferRef.current && isReady) {
            try {
                console.log("isPlaying", isPlaying)
                if (isPlaying) {
                    console.log("playing")
                    wavesurferRef.current.play();
                } else {
                    wavesurferRef.current.pause();
                    wavesurferRef.current.seekTo(0);
                }
            } catch (error) {
                console.error('Error controlling WaveSurfer playback:', error);
            }
        }
    }, [isPlaying, isReady]);

    if (!audioFile?.url) return null;

    return (
        <div className="flex items-center gap-2 text-xs text-gray-400">
            <FaMusic className="text-blue-400" />
            <div 
                ref={waveformRef} 
                className="w-32 bg-gray-800 rounded"
            />
        </div>
    );
};

export default function StatusPanel(props) {
    const { stagedShow, shows, deleteShow, setStagedShow, loadedShow, setLoadedShow, inventoryById, systemConfig } = useAppStore();
    const { stateData } = useStateAppStore();
    const [timeCursor, setTimeCursor] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [vidItems, setVidItems] = useState([])
    const [countdownSeconds, setCountdownSeconds] = useState(null);
    const [audioIsPlaying, setAudioIsPlaying] = useState(false);
    const lastUpdateTimeRef = useRef(null);
    const requestRef = useRef(null);
    const countdownIntervalRef = useRef(null);
    const prevProtoHandlerStatusRef = useRef(null);
    const useAudioTimeRef = useRef(false); // Track if we should use audio time vs manual time

    // Check if all required receivers are online
    const allReceiversOnline = useMemo(() => {
        if (!stagedShow || !stagedShow.items) return true; // No show staged, no issue
        
        const receivers = stateData.fw_state?.receivers || systemConfig?.receivers || {};
        const showReceivers = new Set();
        
        // Get all receivers used in the staged show
        stagedShow.items.forEach((item) => {
            if (item.zone && item.target) {
                Object.entries(receivers).forEach(([receiverKey, receiver]) => {
                    if (receiver.cues && receiver.cues[item.zone] && receiver.cues[item.zone].includes(item.target)) {
                        showReceivers.add(receiverKey);
                    }
                });
            }
        });

        // Check if all required receivers are online
        let allOnline = true;
        showReceivers.forEach((receiverKey) => {
            const receiver = receivers[receiverKey];
            if (receiver) {
                let isConnectionGood;
                if (receiver.status && receiver.status.lmt) {
                    const latency = Date.now() - receiver.status.lmt;
                    isConnectionGood = latency <= 10000; // 10 second timeout
                } else {
                    isConnectionGood = receiver.connectionStatus === "good";
                }
                if (!isConnectionGood) {
                    allOnline = false;
                }
            } else {
                allOnline = false; // Receiver not found
            }
        });

        return allOnline;
    }, [stagedShow, stateData.fw_state?.receivers, systemConfig]);

    // Sync UI state with daemon state when page reloads
    useEffect(() => {
        console.log("HOOK")
        console.log(stateData.fw_state?.loaded_show_id)
        console.log(shows)
        if (stateData.fw_state?.loaded_show_id && shows.length > 0) {
            console.log("LSID");
            const loadedShowFromDaemon = shows.find(show => show.id === stateData.fw_state.loaded_show_id);
            
            if (loadedShowFromDaemon) {
                console.log("LOADED SHOW FROM DAEMON");
                // Parse the show data similar to how it's done in handleShowAction
                const parsedItems = JSON.parse(loadedShowFromDaemon.display_payload).map((pi, i) => ({ ...inventoryById[pi.itemId], ...pi }));
                
                // Parse audio_file JSON string if it exists
                let audioFile = null;
                if (loadedShowFromDaemon.audio_file) {
                    try {
                        audioFile = JSON.parse(loadedShowFromDaemon.audio_file);
                    } catch (e) {
                        console.error('Failed to parse audio_file for show:', loadedShowFromDaemon.id, e);
                    }
                }
                
                const showWithParsedData = { 
                    ...loadedShowFromDaemon, 
                    items: parsedItems,
                    audioFile: audioFile
                };
                
                // Set both staged and loaded show to match daemon state
                setStagedShow(showWithParsedData);
                setLoadedShow(showWithParsedData);
            }
        }
    }, [stateData.fw_state?.loaded_show_id, shows, inventoryById, setStagedShow, setLoadedShow]);

    // Handle audio playback based on show state
    useEffect(() => {
        const currentStatus = stateData.fw_state?.proto_handler_status;
        const prevStatus = prevProtoHandlerStatusRef.current;

        // Start audio when transitioning from START_PENDING to STARTED
        if (prevStatus === "START_PENDING" && currentStatus === "STARTED") {
            setAudioIsPlaying(true);
        }
        
        // Stop audio when show ends (any terminal state)
        if (prevStatus === "STARTED" && currentStatus !== "STARTED") {
            setAudioIsPlaying(false);
        }

        prevProtoHandlerStatusRef.current = currentStatus;
    }, [stateData.fw_state?.proto_handler_status]);

    // Handle audio time updates - sync timeline cursor with audio playback
    const handleAudioTimeUpdate = (time) => {
        if (isPlaying && stagedShow?.audioFile?.url) {
            // Use audio time as source of truth when audio is playing
            setTimeCursor(time);
            useAudioTimeRef.current = true;
            
            // Update video items based on audio time
            const itemsToFire = stagedShow.items.filter(obj => ( obj.startTime-1.5 < time)).sort((a, b) => a.startTime - b.startTime);
            setVidItems(itemsToFire.map(ob=>({...ob, hide: (ob.startTime+ob.duration < time)})));
        }
    };

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
            deleteShow(show.id);
        } else if (action === "Stage") {
            const parsedItems = JSON.parse(show.display_payload).map((pi, i) => ({ ...inventoryById[pi.itemId], ...pi }));
            
            // Parse audio_file JSON string if it exists
            let audioFile = null;
            if (show.audio_file) {
                try {
                    audioFile = JSON.parse(show.audio_file);
                } catch (e) {
                    console.error('Failed to parse audio_file for show:', show.id, e);
                }
            }
            
            setStagedShow({ 
                ...show, 
                items: parsedItems,
                audioFile: audioFile // Add the parsed audioFile object
            });
            // setCurrentTab might not be available here, consider if this is needed or how to handle
            // props.setCurrentTab('editor'); 
        } else if (action === "Load") {
            if (true) {
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

    // Smooth timer using requestAnimationFrame (only used when no audio is playing)
    const updateCursor = (timestamp) => {
        // If audio is playing, let audio time drive the cursor instead
        if (stagedShow?.audioFile?.url && useAudioTimeRef.current) {
            requestRef.current = requestAnimationFrame(updateCursor);
            return;
        }

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
    const hasErrors = showErrors.length > 0
    let showFireButton = false

    let showStateLabel = "Not Ready"
    let showStateCls = "bg-slate-900 border-slate-600 text-slate-400"
    let ShowStateIcon = FaClock
    
    if (isReady) {
        showStateLabel = "Ready To Fire"
        showStateCls = "bg-slate-900 border-emerald-500 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.3)]"
        ShowStateIcon = FaCheck
    } else if (hasErrors && stateData.fw_state?.show_loaded) {
        showStateLabel = "Checks Failed"
        showStateCls = "bg-slate-900 border-red-500 text-red-300"
        ShowStateIcon = FaX
    }

    const handlerInStartPhase = stateData.fw_state?.proto_handler_status ? 
        stateData.fw_state?.proto_handler_status.split('_')[0]?.startsWith("START") : false

    if(isReady && stateData.fw_state?.dstc && !stateData.fw_state?.waiting_for_client_start){
        if(handlerInStartPhase){
            showStateCls="bg-slate-900 border-emerald-500 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.3)]"
            showStateLabel=stateData.fw_state?.proto_handler_status == "STARTED" ? "Started": "Starting"
            ShowStateIcon= FaPlay
        }else{
            showStateCls="bg-slate-900 border-amber-500 text-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.3)]"
            showStateLabel="Waiting on Start"
            ShowStateIcon= FaHandPointDown
        }
    }else if(stateData.fw_state?.waiting_for_client_start){
        showStateCls="bg-slate-900 border-emerald-500 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.3)]"
        showStateLabel="Ready To Go"
        showFireButton = true
    }

    return (
        <div className="max-w-auto">
            <ShowBrowser setCurrentTab={props.setCurrentTab} />
            <ShowHealth />
            {stagedShow?.items ? (
                <div className="fixed top-10 left-0 right-0 mb-2 bg-gray-1000 text-white p-4 text-center">
                    
                    <Timeline 
                        items={stagedShow.items} 
                        setTimeCursor={setTimeCursor} 
                        timeCursor={timeCursor} 
                        readOnly={true} 
                        timeCapSeconds={stagedShow.duration} 
                    />
                    {/* Play/Pause Controls & Time Display */}
                    <div className="flex justify-between items-center mb-4 bg-gray-900 ">
                        {/* Play/Pause Buttons */}
                        <div className="flex gap-4 bg-gray-900 p-2">
                            <button
                                onClick={() => {
                                    setIsPlaying(true);
                                    if (!stagedShow?.audioFile?.url) {
                                        // If no audio, reset to use manual timing
                                        useAudioTimeRef.current = false;
                                        setTimeCursor(0);
                                        lastUpdateTimeRef.current = null;
                                    }
                                }}
                                disabled={isPlaying || stateData.fw_state.show_loaded}
                                className={`p-3 rounded-sm border transition-all duration-200 ${
                                    isPlaying 
                                        ? "bg-slate-900 border-slate-600 text-slate-500 cursor-not-allowed" 
                                        : "bg-slate-900 border-emerald-500 text-emerald-300 hover:border-emerald-400 hover:shadow-[0_0_8px_rgba(16,185,129,0.3)]"
                                }`}
                            >
                                <FaPlay size={24} />
                            </button>

                            <button
                                onClick={() => {
                                    setIsPlaying(false);
                                    useAudioTimeRef.current = false;
                                }}
                                disabled={!isPlaying}
                                className={`p-3 rounded-sm border transition-all duration-200 ${
                                    !isPlaying 
                                        ? "bg-slate-900 border-slate-600 text-slate-500 cursor-not-allowed" 
                                        : "bg-slate-900 border-amber-500 text-amber-300 hover:border-amber-400 hover:shadow-[0_0_8px_rgba(245,158,11,0.3)]"
                                }`}
                            >
                                <FaPause size={24} />
                            </button>
                            <div className="leading-[3rem] text-center text-sm">
                                {formatTime(timeCursor)} / {formatTime(stagedShow.duration)}
                            </div>
                            <div className="text-lg leading-[3rem] text-center font-semibold ml-12">{stagedShow.name} Timeline</div>
                            <MinimalAudioWaveform 
                                audioFile={stagedShow.audioFile}
                                isPlaying={isPlaying || audioIsPlaying}
                                onTimeUpdate={handleAudioTimeUpdate}
                            />
                            <div className="flex items-center ml-12 h-[3rem]">
                                <div className={`text-lg h-full flex items-center justify-center font-semibold px-3 rounded-sm border ${
                                    stateData.fw_state.show_loaded 
                                        ? 'bg-slate-900 border-emerald-500 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.3)]' 
                                        : 'bg-slate-900 border-amber-500 text-amber-300'
                                }`}>
                                    {stateData.fw_state.show_loaded ? 'Loaded' : 'Not Loaded'}
                                </div>
                                <button
                                    onClick={()=>{unloadOrLoadShow(stateData.fw_state.show_loaded)}}
                                    className="bg-slate-900 border border-blue-500 text-blue-300 hover:border-blue-400 hover:shadow-[0_0_8px_rgba(59,130,246,0.3)] font-bold px-3 h-full ml-2 rounded-sm transition-all duration-200 flex items-center justify-center relative"
                                    type="button"
                                >
                                    {stateData.fw_state.show_loaded ? "Unload" : "Load"}
                                    {!stateData.fw_state.show_loaded && !allReceiversOnline && (
                                        <FaTriangleExclamation className="absolute top-0 right-0 text-amber-400 text-xs -mt-1 -mr-1" title="Some receivers are offline. Loading probably wont"/>
                                    )}
                                </button>
                            </div>
                            {stateData.fw_state.show_loaded ? (
                                <div className={`flex items-center text-lg leading-[3rem] text-center font-semibold ml-6 px-4 rounded-sm border ${
                                    isReady 
                                        ? 'bg-slate-900 border-emerald-500 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.3)]' 
                                        : 'bg-slate-900 border-red-500 text-red-300'
                                }`}>
                                    <ShowStateIcon className="mr-2"/> {showStateLabel}
                                </div>
                            ):""}
                            {
                                (stateData.fw_state?.proto_handler_status == "START_PENDING") && 
                                (<div 
                                    className={`flex items-center text-lg leading-[3rem] text-center font-semibold ml-6 px-4 rounded-sm ${styles.rotating_border}`}
                                >
                                    <FaListAlt className="mr-2"/> Pre-Start
                                </div>)
                            }
                            {
                                (stateData.fw_state?.proto_handler_status == "START_CONFIRMED") && 
                                (<div 
                                    className={`flex items-center text-lg leading-[3rem] text-center font-semibold ml-6 px-4 rounded-sm ${styles.rotating_border_fast}`}
                                >
                                    <FaClock className="mr-2"/> In Countdown! {countdownSeconds !== null && countdownSeconds >= 0 ? formatTime(countdownSeconds) : ""}
                                </div>)
                            }
                            { 
                                (stateData.fw_state?.dstc && stateData.fw_state?.waiting_for_client_start || handlerInStartPhase) && (
                                    <div>
                                    { stateData.fw_state?.show_running ||  handlerInStartPhase ? (
                                        <div
                                            className="flex items-center text-lg leading-[3rem] text-center font-semibold ml-6 px-4 bg-slate-900 border border-red-500 text-red-300 hover:border-red-400 hover:shadow-[0_0_12px_rgba(239,68,68,0.4)] font-bold rounded-sm cursor-pointer transition-all duration-200"
                                            onClick={()=> delegatedShowAction('stop')}
                                        >
                                            <FaX className="mr-2"/> Abort
                                        </div>
                                    ): (
                                        <div 
                                            className="flex items-center text-lg leading-[3rem] text-center font-semibold ml-6 px-4 bg-slate-900 border border-emerald-500 text-emerald-300 hover:border-emerald-400 hover:shadow-[0_0_12px_rgba(16,185,129,0.5)] font-bold rounded-sm cursor-pointer transition-all duration-200"
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
                    {vidItems.length ? (
                        <VideoPreviewPopup items={vidItems} isVisible={isPlaying && vidItems.length}/>
                    ):""}
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
                                                    
                                                    targetCount = items.length;
                                                } catch (e) {
                                                    console.error("Failed to parse display_payload for show:", show.name, e);
                                                }
                                            }
                                            return (
                                            <tr key={show.id} className="hover:bg-gray-700">
                                                <td className="px-5 py-4 border-b border-gray-700 text-sm">
                                                    <p className="text-gray-100 whitespace-no-wrap">
                                                        {show.name}
                                                        {show.audio_file && (
                                                            <FaMusic className="inline ml-2 text-blue-400" title="Has audio" />
                                                        )}
                                                    </p>
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
                                                        className={`bg-slate-900 border border-emerald-500 text-emerald-300 hover:border-emerald-400 hover:shadow-[0_0_8px_rgba(16,185,129,0.3)] font-bold py-1 px-3 rounded-sm text-xs mr-1 transition-all duration-200 ${stagedShow?.id === show.id ? "opacity-50 cursor-not-allowed border-slate-600 text-slate-500" : ""}`}
                                                    >
                                                        Stage
                                                    </button>
                                                    <button
                                                        onClick={() => handleShowAction("Load", show)}
                                                        disabled={loadedShow?.id === show.id}
                                                        className={`bg-slate-900 border border-amber-500 text-amber-300 hover:border-amber-400 hover:shadow-[0_0_8px_rgba(245,158,11,0.3)] font-bold py-1 px-3 rounded-sm text-xs mr-1 transition-all duration-200 ${loadedShow?.id === show.id ? "opacity-50 cursor-not-allowed border-slate-600 text-slate-500" : ""}`}
                                                    >
                                                        Load
                                                    </button>
                                                     <button
                                                        onClick={() => handleShowAction("Delete", show)}
                                                        className="bg-slate-900 border border-red-500 text-red-300 hover:border-red-400 hover:shadow-[0_0_8px_rgba(239,68,68,0.3)] font-bold py-1 px-3 rounded-sm text-xs transition-all duration-200"
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
