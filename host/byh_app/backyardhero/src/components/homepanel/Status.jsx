// File: /pages/wsClient.js
import useStateAppStore from '@/store/useStateAppStore';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MdRefresh } from "react-icons/md";
import Toast from '../common/Toast';

// Cap on toasts kept in DOM. The previous implementation appended forever
// which slowly tanked render perf whenever the daemon hit a noisy error
// path. Old toasts past this point are dropped.
const MAX_TOASTS = 5;
// Reconnect schedule: start fast and back off so a brief blip doesn't make
// the user click "Reconnect" but a sustained outage doesn't spam.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;

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

    const stateData = useStateAppStore((s) => s.stateData);
    const setStateData = useStateAppStore((s) => s.setStateData);
    const patchStateData = useStateAppStore((s) => s.patchStateData);
    const [isConnected, setIsConnected] = useState(false);
    const [sysIsArmed, setSysIsArmed] = useState(false);
    const [status, setStatus] = useState("Inactive"); // State for "Active" or "Inactive"
    const socketRef = useRef(null); // Use ref to keep track of the WebSocket instance
    const reconnectTimerRef = useRef(null);
    const reconnectAttemptRef = useRef(0);
    const intentionalDisconnectRef = useRef(false);
    const [toasts, setToasts] = useState([]);
    const previousErrorsRef = useRef(new Set());

    // Latest stateData inside a ref, so the daemon-staleness interval below
    // can be created exactly once for the component's lifetime instead of
    // being torn down + rebuilt on every WebSocket message.
    const stateDataRef = useRef(stateData);
    useEffect(() => {
        stateDataRef.current = stateData;
    }, [stateData]);

    const scheduleReconnect = useCallback(() => {
        if (intentionalDisconnectRef.current) return;
        if (reconnectTimerRef.current) return;
        const attempt = reconnectAttemptRef.current;
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
        reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            reconnectAttemptRef.current = attempt + 1;
            connectWebSocketRef.current && connectWebSocketRef.current();
        }, delay);
    }, []);

    // connect / disconnect have a circular dep (onclose -> scheduleReconnect
    // -> connect). Use a ref to break the cycle without re-creating the
    // callback on every render.
    const connectWebSocketRef = useRef(null);

    const connectWebSocket = useCallback(() => {
        // Defensive: don't open a second socket if one is already (re)connecting.
        if (socketRef.current && socketRef.current.readyState <= 1) {
            return;
        }
        intentionalDisconnectRef.current = false;
        const socket = new WebSocket(`ws://${window.location.host.split(":")[0]}:8090`);

        socket.onopen = () => {
            console.log("WebSocket connected");
            setStatus("Active");
            setIsConnected(true);
            // Successful connect resets backoff.
            reconnectAttemptRef.current = 0;
        };

        socket.onmessage = (event) => {
            let receivedData;
            try {
                receivedData = JSON.parse(event.data);
            } catch (err) {
                console.error("WS parse failed", err);
                return;
            }
            // Heartbeat frames only carry fw_last_update -- merge in place
            // so the rest of the cached daemon snapshot stays intact.
            if (receivedData && receivedData._hb) {
                patchStateData({ fw_last_update: receivedData.fw_last_update });
            } else {
                setStateData(receivedData);
            }
        };

        socket.onerror = (error) => {
            console.error("WebSocket error:", error);
        };

        socket.onclose = () => {
            console.log("WebSocket disconnected");
            setIsConnected(false);
            socketRef.current = null;
            scheduleReconnect();
        };

        socketRef.current = socket;
    }, [setStateData, patchStateData, scheduleReconnect]);

    useEffect(() => {
        connectWebSocketRef.current = connectWebSocket;
    }, [connectWebSocket]);

    const disconnectWebSocket = useCallback(() => {
        intentionalDisconnectRef.current = true;
        if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
        }
        if (socketRef.current) {
            console.log("Closing WebSocket connection");
            socketRef.current.close();
            socketRef.current = null;
        }
    }, []);

    useEffect(() => {
        connectWebSocket();
        return () => disconnectWebSocket();
        // connect/disconnect callbacks are stable; mount-only effect is intentional.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Periodically check the daemon's last-update timestamp. This interval
    // used to be rebuilt on every WebSocket message because `stateData` was
    // in the deps array; here it lives for the component's whole lifetime
    // and reads the latest value through a ref.
    useEffect(() => {
        const checkDaemonStatus = () => {
            const cur = stateDataRef.current;
            if (cur?.fw_last_update && Date.now() - cur.fw_last_update < 4020) {
                setStatus("Active");
            } else {
                setStatus("Inactive");
            }
        };
        // Run once immediately so we don't sit at "Inactive" for a second.
        checkDaemonStatus();
        const intervalId = setInterval(checkDaemonStatus, 1000);
        return () => clearInterval(intervalId);
    }, []);

    // Watch for new errors and show them as toasts. Previously this effect
    // ran on every WS push (every 500ms) and walked all error arrays even
    // when nothing had changed. Now we compute a stable signature of the
    // error sets and bail early if it's identical to the last evaluation.
    const lastErrorSignatureRef = useRef(null);
    useEffect(() => {
        const fireCheckFailures = stateData.fw_state?.fire_check_failures || [];
        const protoHandlerErrors = stateData.fw_state?.proto_handler_errors || [];
        const fwErrors = stateData.fw_error || [];
        const fwDErrors = stateData.fw_d_error || [];

        // Cheap fingerprint: lengths + last entry of each list. If lengths
        // didn't change AND the tail item didn't change, nothing to do.
        const sig = JSON.stringify([
            fireCheckFailures.length,
            fireCheckFailures[fireCheckFailures.length - 1] ?? null,
            protoHandlerErrors.length,
            protoHandlerErrors[protoHandlerErrors.length - 1] ?? null,
            fwErrors.length,
            fwErrors[fwErrors.length - 1] ?? null,
            fwDErrors.length,
            fwDErrors[fwDErrors.length - 1] ?? null,
        ]);
        if (sig === lastErrorSignatureRef.current) return;
        lastErrorSignatureRef.current = sig;

        const errorToString = (error) => {
            if (typeof error === 'string') return error;
            if (typeof error === 'object' && error !== null) {
                return JSON.stringify(error);
            }
            return String(error);
        };

        const extractErrorMessage = (logEntry) => {
            if (typeof logEntry !== 'string') {
                return errorToString(logEntry);
            }
            return logEntry.replace(/^\[[^\]]+\]\s*/, '').trim();
        };

        const currentErrors = new Set();
        const newToasts = [];

        const considerError = (rawKey, errorMessage) => {
            currentErrors.add(rawKey);
            if (!previousErrorsRef.current.has(rawKey)) {
                newToasts.push({ id: Date.now() + Math.random(), message: errorMessage });
            }
        };

        fireCheckFailures.forEach((error) => {
            const msg = errorToString(error);
            considerError(`fire_check_${msg}`, msg);
        });
        protoHandlerErrors.forEach((error) => {
            const msg = errorToString(error);
            considerError(`proto_handler_${msg}`, msg);
        });
        fwErrors.forEach((error) => {
            const msg = errorToString(error);
            considerError(`fw_error_${msg}`, msg);
        });
        fwDErrors.forEach((errorLog) => {
            if (checkIfLogIsRecent(errorLog)) {
                considerError(`fw_d_error_${errorLog}`, extractErrorMessage(errorLog));
            }
        });

        previousErrorsRef.current = currentErrors;

        if (newToasts.length > 0) {
            // Cap the visible toast pile so a noisy error path can't grow
            // an unbounded DOM list (and re-render pressure).
            setToasts((prev) => {
                const combined = [...prev, ...newToasts];
                return combined.length > MAX_TOASTS
                    ? combined.slice(combined.length - MAX_TOASTS)
                    : combined;
            });
        }
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