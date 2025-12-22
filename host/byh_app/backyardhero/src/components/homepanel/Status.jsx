// File: /pages/wsClient.js
import useStateAppStore from '@/store/useStateAppStore';
import { useEffect, useState, useRef } from 'react';
import { MdRefresh } from "react-icons/md";

const checkIfLogIsRecent = (log) => {
    // Extract the timestamp from the string
    const timestampMatch = log.match(/\[([^\]]+)\]/); // Match content inside brackets
    if (!timestampMatch) {
    console.error("No valid timestamp found in the string.");
    } else {
    const timestamp = timestampMatch[1]; // Extract the matched timestamp
    const logTime = new Date(timestamp); // Convert to a Date object


    // Get the current time and calculate the difference
    const now = new Date();
    const diffInMs = now - logTime; // Difference in milliseconds
    const diffInMinutes = diffInMs / (1000 * 60); // Convert to minutes

    // Check if the log time is within the last 5 minutes
    return (diffInMinutes <= 5)
    }
}

export default function Status() {

    const { stateData, setStateData } = useStateAppStore()
    const [isConnected, setIsConnected] = useState(false);
    const [sysIsArmed, setSysIsArmed] = useState(false);
    const [status, setStatus] = useState("Inactive"); // State for "Active" or "Inactive"
    const socketRef = useRef(null); // Use ref to keep track of the WebSocket instance

    const connectWebSocket = () => {
        // Initialize the WebSocket connection
        const socket = new WebSocket(`ws://${window.location.host.split(":")[0]}:8090`);
        console.log("CWS")

        socket.onopen = () => {
        console.log("WebSocket connected");
        setStatus("Active");
        setIsConnected(true);
        };

        socket.onmessage = (event) => {
        const receivedData = JSON.parse(event.data);
        setStateData(receivedData);
        };

        socket.onerror = (error) => {
        console.error("WebSocket error:", error);
        };

        socket.onclose = () => {
        console.log("WebSocket disconnected");
        setIsConnected(false);
        };

        // Store the WebSocket instance in the ref
        socketRef.current = socket;
    };

    const disconnectWebSocket = () => {
        if (socketRef.current) {
        console.log("Closing WebSocket connection");
        socketRef.current.close();
        socketRef.current = null;
        }
    };

    useEffect(() => {
        // Automatically connect when the component mounts
        connectWebSocket();

        // Clean up when the component unmounts
        return () => disconnectWebSocket();
    }, []);
    // Periodically check the daemon_lup timestamp
    useEffect(() => {
        const checkDaemonStatus = () => {
            if (stateData.fw_last_update) {
            const now = Date.now();
            const lastUpdated = stateData.fw_last_update;
            if (now - lastUpdated < 4020) {
                setStatus("Active");
            } else {
                setStatus("Inactive");
            }
            } else {
                setStatus("Inactive");
            }
        };

        // Check daemon status every 4 seconds
        const intervalId = setInterval(checkDaemonStatus, 4000);

        return () => clearInterval(intervalId); // Cleanup interval on component unmount
    }, [stateData]);

    // Define base classes for status items for better consistency - futuristic square design
    const statusItemBaseClass = "flex-1 flex items-center justify-center text-xs font-medium border border-opacity-30 rounded-sm px-2 py-1 min-w-[80px] backdrop-blur-sm transition-all duration-200";

    let showRunClass = "bg-slate-900 border-slate-600 text-slate-300"
    let showRunLabel = "No Show"
    if(stateData.fw_state?.loaded_show_name){
        showRunClass = stateData.fw_state?.show_running 
            ? 'bg-emerald-950 border-emerald-500 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.3)]' 
            : 'bg-slate-900 border-red-500 text-red-300'
        showRunLabel= stateData.fw_state?.show_running ? 'Show Running' : 'Show Stopped'
    }

    let txClass = "bg-slate-900 border-red-500 text-red-300"
    let txLabel = "No TX Conn"
    if(stateData.fw_state?.device_running){
        if(stateData.fw_state?.active_protocol){
            txClass = "bg-slate-900 border-cyan-500 text-cyan-300 shadow-[0_0_8px_rgba(6,182,212,0.3)]"
            txLabel = stateData.fw_state?.active_protocol
        }else{
            txClass = "bg-slate-900 border-amber-500 text-amber-300"
            txLabel = "Unknown TX"
        }
    } else {
        txClass = "bg-slate-900 border-red-500 text-red-300";
    }

    return (
        <div className="w-full items-center justify-center p-2 space-y-2">
            {/* Top Row: System Status & Errors - REMOVED */}
            {/* <div className="text-xs flex flex-row items-center gap-x-4">
                <div className="flex items-center gap-x-2 flex-wrap">
                    <span className="font-semibold text-gray-700 dark:text-gray-300 mr-1">System:</span>
                    <span className="text-gray-600 dark:text-gray-400"><b>Temp:</b> {stateData.fw_system?.temp}°F</span>
                    <span className="text-gray-600 dark:text-gray-400"><b>CPU:</b> {stateData.fw_system?.usage?.cpu_percent}%</span>
                    <span className="text-gray-600 dark:text-gray-400"><b>Mem:</b> {stateData.fw_system?.usage?.memory_percent}%</span>
                </div>
                <div className="flex-grow text-right">
                    <span className="ml-4 text-red-500 dark:text-red-400">{recentError ? recentError : ''}</span>
                </div>
            </div> */}

            {/* Bottom Row: Main Status Indicators - All items in a single wrapping container */}
            <div className={`flex flex-row flex-wrap w-full gap-2 ${stateData.fw_state?.daemon_active ? '' : 'opacity-60'}`}>
                {/* All status items will now be direct children here */}
                <button
                    onClick={() => {
                        if (isConnected) {
                            disconnectWebSocket();
                        } else {
                            connectWebSocket();
                        }
                    }}
                    className={`${statusItemBaseClass} ${isConnected 
                        ? 'bg-slate-900 border-emerald-500 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.3)] hover:shadow-[0_0_12px_rgba(16,185,129,0.5)]' 
                        : 'bg-slate-900 border-red-500 text-red-300 hover:border-red-400 hover:shadow-[0_0_8px_rgba(239,68,68,0.3)]'}`}
                >
                    {isConnected ? (<span>Connected</span> ) : <span className="flex items-center"><MdRefresh className="mr-1" /> Reconnect</span>}
                </button>
                <div className={`${statusItemBaseClass} ${stateData.fw_state?.daemon_active 
                    ? 'bg-slate-900 border-emerald-500 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.3)]' 
                    : 'bg-slate-900 border-red-500 text-red-300'}`}>
                    {stateData.fw_state?.daemon_active ? "Daemon Active" : "Daemon Down"}
                </div>
                <div className={`${statusItemBaseClass} group ${txClass}`}>
                    <div className="group-hover:hidden">{txLabel}</div>
                    <div className="hidden group-hover:block text-xs p-1">{`${stateData.fw_state?.settings?.rf?.addr}@${stateData.fw_state?.settings?.rf?.baud}`}</div>
                </div>
                <div className={`${statusItemBaseClass} ${stateData.fw_state?.manual_fire_active 
                    ? 'bg-slate-900 border-amber-500 text-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.3)]' 
                    : 'bg-slate-900 border-slate-600 text-slate-400'}`}>
                    {stateData.fw_state?.manual_fire_active ? "Manual Fire" : "MF Disarm"}
                </div>
                <div className={`${statusItemBaseClass} ${stateData.fw_state?.device_is_armed 
                    ? 'armed-striped-futuristic' 
                    : 'bg-slate-900 border-slate-600 text-slate-400'}`}>
                    {stateData.fw_state?.device_is_armed ? "ARMED" : "DISARMED"}
                </div>
                
                <div className={`${statusItemBaseClass} ${stateData.fw_state?.loaded_show_id 
                    ? 'bg-slate-900 border-blue-500 text-blue-300 shadow-[0_0_8px_rgba(59,130,246,0.3)]' 
                    : 'bg-slate-900 border-slate-600 text-slate-400'}`}>
                    {stateData.fw_state?.loaded_show_id ? `Show Loaded`: `No show loaded`}
                </div>
                <div className={`${statusItemBaseClass} ${stateData.fw_state?.device_is_transmitting 
                    ? 'bg-slate-900 border-amber-500 text-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.3)]' 
                    : 'bg-slate-900 border-slate-600 text-slate-400'}`}>
                    {stateData.fw_state?.device_is_transmitting ? "TX ACTIVE": "NO TX"}
                </div>
                <div className={`${statusItemBaseClass} ${(stateData.fw_cursor >= 0 
                    ? 'bg-slate-900 border-emerald-500 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.3)]' 
                    : 'bg-slate-900 border-blue-500 text-blue-300')} flex items-center justify-center gap-1`}>
                    <span className="text-xs">Time:</span>
                    <b className="text-sm">{stateData.fw_cursor > 0 ? stateData.fw_cursor : 0}</b>
                </div>
                <div className={`${statusItemBaseClass} ${showRunClass} text-white`}>{showRunLabel}</div>
            </div>

            {/* CSS for armed striped background - futuristic style */}
            <style jsx>{`
                .armed-striped-futuristic {
                    color: #fbbf24;
                    font-size: 20px;
                    font-weight: bold;
                    text-shadow: 
                        0 0 10px rgba(251, 191, 36, 0.8),
                        0 0 20px rgba(251, 191, 36, 0.5),
                        2px 2px 4px rgba(0, 0, 0, 0.8);
                    background: linear-gradient(
                        135deg,
                        #1e293b 0%,
                        #0f172a 50%,
                        #1e293b 100%
                    );
                    border: 2px solid #fbbf24 !important;
                    box-shadow: 
                        0 0 12px rgba(251, 191, 36, 0.4),
                        inset 0 0 20px rgba(251, 191, 36, 0.1);
                    position: relative;
                    overflow: hidden;
                }
                .armed-striped-futuristic::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: -100%;
                    width: 100%;
                    height: 100%;
                    background: linear-gradient(
                        90deg,
                        transparent,
                        rgba(251, 191, 36, 0.2),
                        transparent
                    );
                    animation: shine 3s infinite;
                }
                @keyframes shine {
                    0% { left: -100%; }
                    100% { left: 100%; }
                }
            `}</style>
        </div>
    );
}