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
    const almClass = " basis-1/5 flex items-center text-xs justify-center text-sm shadow-lg p-2 ml-2"
    let recentError = stateData.fw_d_error ? stateData.fw_d_error[0] : false
    if(recentError){
        if(!checkIfLogIsRecent(recentError)){
            recentError=""
        }
    }

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
            txClass = "bg-green-800"
            txLabel = stateData.fw_state?.active_protocol
        }else{
            txClass = "bg-yellow-800"
            txLabel = "Unknown TX"
        }
    }

    return (
        <div className="w-full items-center justify-center">
            <div className="text-xs flex flex-row ">
                <div className="basis-2/5">
                    <span className="bg-gray-600 mr-2">System Status: </span>
                    <span><b>Temp:</b> {stateData.fw_system?.temp}F  </span>
                    <span><b>CPU:</b> {stateData.fw_system?.usage?.cpu_percent}%  </span>
                    <span><b>Memory:</b> {stateData.fw_system?.usage?.cpu_percent}%  </span>
                </div>
                <div className="basis-4/5 text-right">
                    <span className="ml-8 text-red-700">{recentError ? recentError : ''}</span>
                </div>
            </div>
            <div className={`flex flex-row w-full ${stateData.fw_state?.daemon_active ? '' : 'opacity-60'}`}>
                <div className="flex flex-row basis-1/2">
                    <div className={`${almClass} ${isConnected ? 'bg-green-800' : 'bg-red-800'}`}>
                        <button
                        onClick={() => {
                            if (isConnected) {
                                disconnectWebSocket();
                            } else {
                                connectWebSocket();
                            }
                        }}
                        >
                            {isConnected ? (<span>Connected</span> ) : <span className="text-xs">Click to Reconnect</span>}
                        </button>
                    </div>
                    <div className={`${almClass} ${stateData.fw_state?.daemon_active ? 'bg-green-800' : 'bg-red-800'}`}>{stateData.fw_state?.daemon_active ? "Daemon Active" : "Daemon Down"}</div>
                    <div className={`${almClass} group text-xs ${txClass}`}>
                        <div className="group-hover:hidden">{txLabel}</div>
                        <div className="hidden group-hover:block">{`${stateData.fw_state?.settings?.rf?.addr}@${stateData.fw_state?.settings?.rf?.baud}`}</div>
                    </div>
                    <div className={`${almClass} ${stateData.fw_state?.manual_fire_active ? 'bg-yellow-800' : 'bg-green-800'}`}>{stateData.fw_state?.manual_fire_active ? "Manual Fire" : "MF Disarm"}</div>
                    <div className={`${almClass} ${stateData.fw_state?.device_is_armed ? 'bg-green-800' : 'bg-red-800'}`}>{stateData.fw_state?.device_is_armed ? "ARMED" : "DISARMED"}</div>
                </div>
                <div className="flex flex-row basis-1/2">
                    <div className={`${almClass} ${stateData.fw_state?.loaded_show_name ? 'bg-green-800' : 'bg-gray-800'}`}>{stateData.fw_state?.loaded_show_name ? `${stateData.fw_state?.loaded_show_name} loaded`: `No show loaded`}</div>
                    <div className={`${almClass} ${stateData.fw_state?.device_is_transmitting ? 'bg-yellow-800' : 'bg-gray-800'}`}>{stateData.fw_state?.device_is_transmitting ? "TX ACTIVE": "NO TX"}</div>
                    <div className={`${almClass} p-0 bg-${stateData.fw_cursor >= 0 ? 'green' : 'blue'}-800`}><div className="text-xs">Cursor @</div><b>{stateData.fw_cursor}</b></div>
                    <div className={`${almClass} ${showRunClass}`}>{showRunLabel}</div>
                </div>
            </div>
        </div>
    );
}