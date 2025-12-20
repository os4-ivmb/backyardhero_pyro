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

    // Define base classes for status items for better consistency
    const statusItemBaseClass = "flex-1 flex items-center justify-center text-xs font-medium shadow-md rounded-md px-2 py-1 min-w-[80px]";

    let showRunClass = "bg-gray-800"
    let showRunLabel = "No Show"
    if(stateData.fw_state?.loaded_show_name){
        showRunClass = stateData.fw_state?.show_running ? 'bg-green-800' : 'bg-red-800'
        showRunLabel= stateData.fw_state?.show_running ? 'Show Running' : 'Show Stopped'
    }

    let txClass = "bg-red-800"
    let txLabel = "No TX Conn"
    if(stateData.fw_state?.device_running){
        if(stateData.fw_state?.active_protocol){
            txClass = "bg-green-700"
            txLabel = stateData.fw_state?.active_protocol
        }else{
            txClass = "bg-yellow-600"
            txLabel = "Unknown TX"
        }
    } else {
        txClass = "bg-red-700";
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
                    className={`${statusItemBaseClass} ${isConnected ? 'bg-green-600 text-white' : 'bg-red-600 text-white hover:bg-red-700'}`}
                >
                    {isConnected ? (<span>Connected</span> ) : <span className="flex items-center"><MdRefresh className="mr-1" /> Reconnect</span>}
                </button>
                <div className={`${statusItemBaseClass} ${stateData.fw_state?.daemon_active ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>{stateData.fw_state?.daemon_active ? "Daemon Active" : "Daemon Down"}</div>
                <div className={`${statusItemBaseClass} group ${txClass} ${txClass.includes('yellow') ? 'text-yellow-900' : 'text-white'}`}>
                    <div className="group-hover:hidden">{txLabel}</div>
                    <div className="hidden group-hover:block text-xs p-1">{`${stateData.fw_state?.settings?.rf?.addr}@${stateData.fw_state?.settings?.rf?.baud}`}</div>
                </div>
                <div className={`${statusItemBaseClass} ${stateData.fw_state?.manual_fire_active ? 'bg-yellow-500 text-yellow-900' : 'bg-green-600 text-white'}`}>{stateData.fw_state?.manual_fire_active ? "Manual Fire" : "MF Disarm"}</div>
                <div className={`${statusItemBaseClass} ${stateData.fw_state?.device_is_armed ? 'armed-striped text-black' : 'bg-gray-500 text-white'}`}>{stateData.fw_state?.device_is_armed ? "ARMED" : "DISARMED"}</div>
                
                <div className={`${statusItemBaseClass} ${stateData.fw_state?.loaded_show_id ? 'bg-blue-600 text-white' : 'bg-gray-400 text-gray-800'}`}>{stateData.fw_state?.loaded_show_id ? `Show Loaded`: `No show loaded`}</div>
                <div className={`${statusItemBaseClass} ${stateData.fw_state?.device_is_transmitting ? 'bg-yellow-500 text-yellow-900' : 'bg-gray-400 text-gray-800'}`}>{stateData.fw_state?.device_is_transmitting ? "TX ACTIVE": "NO TX"}</div>
                <div className={`${statusItemBaseClass} ${(stateData.fw_cursor >= 0 ? 'bg-green-600' : 'bg-blue-600')} text-white flex flex-col items-center justify-center`}>
                    <span className="text-xxs -mb-0.5 leading-tight">Cursor @</span>
                    <b className="text-sm leading-tight">{stateData.fw_cursor}</b>
                </div>
                <div className={`${statusItemBaseClass} ${showRunClass.replace('-800', '-600').replace('-500', '-600')} text-white`}>{showRunLabel}</div>
            </div>

            {/* CSS for armed striped background */}
            <style jsx>{`
                .armed-striped {
                    color: #FFF;
                    font-size: 20px;
                    text-shadow: 
                        2px 2px 0px #000, 
                        -2px -2px 0px #000, 
                        2px -2px 0px #000, 
                        -2px 2px 0px #000;
                    background: repeating-linear-gradient(
                        45deg,
                        #fbbf24,
                        #fbbf24 10px,
                        #000000 10px,
                        #000000 20px
                    );
                    font-weight: bold;
                }
            `}</style>
        </div>
    );
}