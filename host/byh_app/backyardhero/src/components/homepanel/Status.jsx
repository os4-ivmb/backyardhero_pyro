// File: /pages/wsClient.js
import useStateAppStore from '@/store/useStateAppStore';
import { useEffect, useState, useRef } from 'react';
import { MdRefresh } from "react-icons/md";
import Toast from '../common/Toast';

const checkIfLogIsRecent = (log) => {
    // Extract the timestamp from the string
    const timestampMatch = log.match(/\[([^\]]+)\]/); // Match content inside brackets
    if (!timestampMatch) {
        console.error("No valid timestamp found in the string.");
        return false; // If no timestamp, don't show as recent
    }
    
    const timestamp = timestampMatch[1]; // Extract the matched timestamp
    const logTime = new Date(timestamp); // Convert to a Date object
    
    // Check if date is valid
    if (isNaN(logTime.getTime())) {
        console.error("Invalid timestamp format:", timestamp);
        return false;
    }

    // Get the current time and calculate the difference
    const now = new Date();
    const diffInMs = now - logTime; // Difference in milliseconds
    const diffInMinutes = diffInMs / (1000 * 60); // Convert to minutes

    // Check if the log time is within the last 5 minutes
    return (diffInMinutes <= 5);
}

export default function Status() {

    const { stateData, setStateData } = useStateAppStore()
    const [isConnected, setIsConnected] = useState(false);
    const [sysIsArmed, setSysIsArmed] = useState(false);
    const [status, setStatus] = useState("Inactive"); // State for "Active" or "Inactive"
    const socketRef = useRef(null); // Use ref to keep track of the WebSocket instance
    const [toasts, setToasts] = useState([]);
    const previousErrorsRef = useRef(new Set());

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

    // Watch for new errors and show them as toasts
    useEffect(() => {
        const currentErrors = new Set();
        
        // Collect all errors from various sources
        const fireCheckFailures = stateData.fw_state?.fire_check_failures || [];
        const protoHandlerErrors = stateData.fw_state?.proto_handler_errors || [];
        const fwErrors = stateData.fw_error || [];
        const fwDErrors = stateData.fw_d_error || [];
        
        // Helper to convert error to string
        const errorToString = (error) => {
            if (typeof error === 'string') return error;
            if (typeof error === 'object' && error !== null) {
                return JSON.stringify(error);
            }
            return String(error);
        };
        
        // Helper to extract error message from log format (removes timestamp)
        const extractErrorMessage = (logEntry) => {
            if (typeof logEntry !== 'string') {
                return errorToString(logEntry);
            }
            // Remove timestamp pattern [timestamp] from the beginning
            return logEntry.replace(/^\[[^\]]+\]\s*/, '').trim();
        };
        
        // Add fire check failures
        fireCheckFailures.forEach((error) => {
            const errorMessage = errorToString(error);
            const errorKey = `fire_check_${errorMessage}`;
            currentErrors.add(errorKey);
            if (!previousErrorsRef.current.has(errorKey)) {
                setToasts((prev) => [...prev, { id: Date.now() + Math.random(), message: errorMessage }]);
            }
        });
        
        // Add proto handler errors
        protoHandlerErrors.forEach((error) => {
            const errorMessage = errorToString(error);
            const errorKey = `proto_handler_${errorMessage}`;
            currentErrors.add(errorKey);
            if (!previousErrorsRef.current.has(errorKey)) {
                setToasts((prev) => [...prev, { id: Date.now() + Math.random(), message: errorMessage }]);
            }
        });
        
        // Add fw errors
        fwErrors.forEach((error) => {
            const errorMessage = errorToString(error);
            const errorKey = `fw_error_${errorMessage}`;
            currentErrors.add(errorKey);
            if (!previousErrorsRef.current.has(errorKey)) {
                setToasts((prev) => [...prev, { id: Date.now() + Math.random(), message: errorMessage }]);
            }
        });
        
        // Add fw_d_error (daemon errors) - only show recent ones (within 5 minutes)
        fwDErrors.forEach((errorLog) => {
            // Check if the log is recent (within 5 minutes)
            if (checkIfLogIsRecent(errorLog)) {
                const errorMessage = extractErrorMessage(errorLog);
                const errorKey = `fw_d_error_${errorLog}`; // Use full log as key to track duplicates
                currentErrors.add(errorKey);
                if (!previousErrorsRef.current.has(errorKey)) {
                    setToasts((prev) => [...prev, { id: Date.now() + Math.random(), message: errorMessage }]);
                }
            }
        });
        
        // Update previous errors
        previousErrorsRef.current = currentErrors;
    }, [stateData.fw_state?.fire_check_failures, stateData.fw_state?.proto_handler_errors, stateData.fw_error, stateData.fw_d_error]);

    const handleDismissToast = (id) => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
    };

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
        <>
            {/* Toast Notifications - Bottom Left */}
            <div className="fixed bottom-4 left-4 z-[10000] flex flex-col-reverse">
                {toasts.map((toast) => (
                    <Toast
                        key={toast.id}
                        message={toast.message}
                        onDismiss={() => handleDismissToast(toast.id)}
                        duration={30000}
                    />
                ))}
            </div>

            <div className="w-full items-center justify-center p-2 space-y-2" style={{ zIndex: '2' }}>

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
        </>
    );
}