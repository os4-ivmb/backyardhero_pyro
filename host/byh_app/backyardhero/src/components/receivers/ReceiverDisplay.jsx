import useAppStore from "@/store/useAppStore"
import useStateAppStore from "@/store/useStateAppStore";
import { useEffect, useRef, useState } from "react";
import { 
  MdBatteryFull, 
  MdBatteryAlert, 
  MdBatteryUnknown, 
  MdSignalWifi4Bar, 
  MdSignalWifiOff, 
  MdPlayArrow,
  MdAccessTime,
  MdAssignment
} from 'react-icons/md';
import { FaSpinner } from 'react-icons/fa';
import ShowHealth from "../homepanel/ShowHealth";

// FW_VERSION: Frontend version tracking for ReceiverDisplay component
// v1.0.0: Initial version - Basic receiver display with battery, connectivity, and cue status
// v1.1.0: Added health bar at top of receiver cards displaying successPercent (0-100% with red-to-green gradient)
// v1.2.0: Increased connection timeout threshold from 5 seconds to 10 seconds
// v1.3.0: Added latency scale bar (1s=100%/green, 10s=0%/red) with smooth animations, moved health bar to bottom with percentage text
const FW_VERSION = "1.3.0";

function SingleReceiver({ rcv_name, receiver, showMapping, showId, receiverLabel }) {
  const [popup, setPopup] = useState(null);
  const receiverRef = useRef(null);
  const [smoothedLatency, setSmoothedLatency] = useState(0);
  const latencyRef = useRef(0);

  const handleTargetClick = (target, item, event) => {
    if (item) {
      const rect = event.target.getBoundingClientRect();
      const containerRect = receiverRef.current.getBoundingClientRect();
      setPopup({
        target,
        item,
        position: {
          top: rect.top - containerRect.top,
          left: rect.left - containerRect.left + rect.width / 2,
        },
      });
    } else {
      setPopup(null);
    }
  };

  let isSynced = false;
  if(receiver.drift){
    if(receiver.drift < 5000){
      isSynced = true;
    }
  }

  // Calculate battery level from status if available (convert 0–256 into a percentage)
  let batteryLevel;
  if (receiver.status && receiver.status.battery != null) {
    batteryLevel = Math.floor((receiver.status.battery / 256) * 100);
  } else {
    batteryLevel = receiver.battery || "N/A";
  }

  // Determine connectivity using the last message timestamp (lmt)
  let isConnectionGood;
  let latency = 0;
  let txmtLatency = 0;
  if (receiver.status && receiver.status.lmt) {
    latency = Date.now() - receiver.status.lmt
    isConnectionGood = (latency <= 10000);
  } else {
    isConnectionGood = receiver.connectionStatus === "good";
  }

  // Smooth latency value to reduce jumpiness (exponential moving average)
  useEffect(() => {
    if (receiver.status && receiver.status.lmt && latency > 0) {
      // Use exponential moving average with smoothing factor of 0.9 (highly responsive)
      // Higher value = more responsive, lower value = smoother but slower
      const smoothingFactor = 0.8;
      const newSmoothed = latencyRef.current === 0 
        ? latency 
        : latencyRef.current + (latency - latencyRef.current) * smoothingFactor;
      
      latencyRef.current = newSmoothed;
      setSmoothedLatency(newSmoothed);
    } else {
      latencyRef.current = 0;
      setSmoothedLatency(0);
    }
  }, [latency, receiver.status?.lmt]);

  // Use smoothed latency for both display and bar calculation for consistency
  const latencyForDisplay = smoothedLatency > 0 ? smoothedLatency : latency;
  const lfx = (latencyForDisplay / 1000).toFixed(1)

  // Calculate latency percentage for visual bar (0 sec = 100%, 10 sec = 0%)
  // Use smoothed latency so bar moves smoothly
  // 5 seconds = 50% (halfway point)
  let latencyPercent = null;
  if (receiver.status && receiver.status.lmt && latencyForDisplay >= 0) {
    if (lfx <= 1) {
      latencyPercent = 100;
    } else if (lfx >= 10) {
      latencyPercent = 0;
    } else {
      // Linear interpolation: 100% at 0s, 0% at 10s
      latencyPercent = 100 - (lfx / 10) * 100;
    }
    // Clamp to ensure valid percentage
    latencyPercent = Math.max(0, Math.min(100, latencyPercent));
  }

  // Get successPercent for health bar (0-100)
  const successPercent = receiver.status?.successPercent ?? null;
  const healthPercent = successPercent !== null ? Math.max(0, Math.min(100, successPercent)) : null;

  // Determine battery styling and icon based on level
  const batteryClass =
    typeof batteryLevel === 'number'
      ? batteryLevel > 20
        ? 'text-green-400'
        : 'text-red-400'
      : 'text-gray-400';

  const BatteryIcon =
    typeof batteryLevel === 'number'
      ? batteryLevel > 20
        ? MdBatteryFull
        : MdBatteryAlert
      : MdBatteryUnknown;

  const firstZone = Object.keys(receiver.cues)[0]
  const bgColor = "bg-gray-800" + (isConnectionGood ? " opacity-100" : " opacity-50")

  return (
    <div
      ref={receiverRef}
      className={`border rounded-xl p-4 ${bgColor} text-white shadow-md dark:bg-gray-700 dark:border-gray-600 flex flex-col gap-3 w-72 relative`}
    >
      {/* Receiver Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          {receiverLabel ? (
            <>
              <span>{receiverLabel}</span>
              <span className="text-gray-500 text-sm font-normal">({rcv_name})</span>
            </>
          ) : (
            <span>{rcv_name}</span>
          )}
        </h2>

        {isConnectionGood ? (
        <div className="flex items-center gap-2">
            
          <BatteryIcon className={batteryClass} />
          <span className="text-sm text-gray-400">
            {typeof batteryLevel === 'number' ? batteryLevel : "N/A"}%
          </span>

          {/* Connectivity Indicator */}
          {isConnectionGood ? (
            <MdSignalWifi4Bar className="text-green-400" />
          ) : (
            <MdSignalWifiOff className="text-red-400" />
          )}

          {/* New Status Icons */}
          {receiver.status && (
            <>
              {/* Loading Icon */}
              <FaSpinner
                className={
                  receiver.status.showId === showId && receiver.status.loadComplete
                    ? "text-green-400"
                    : "text-gray-400"
                }
                title="Loading Status"
              />
              {/* Start Ready Icon */}
              <MdPlayArrow
                className={
                  receiver.status.startReady ? "text-green-400" : "text-gray-400"
                }
                title="Start Ready"
              />
            </>
          )}
        </div>
        ):(
          <div className="text-red-400 text-sm flex items-center gap-2 ">
            {receiver.type[0] == 'B' ? '' : 'Not Connected'}
          </div>
        )}
      </div>

      {/* Cues Section */}
      <b className="text-gray-300 mt-1 mb-1">Cues</b>
      <div className="flex flex-wrap gap-2 mt-1">
        {firstZone && receiver.cues[firstZone] && receiver.cues[firstZone].map((target, k) => {
          // In the previous version, showMapping was keyed by zone. With a single zone, we assume:
          const item = showMapping?.[firstZone]?.[target]
          const borderClass = item ? "border-4 border-purple-800" : "border border-gray-500";

          // Determine if this cue is active by checking the continuity bits.
          // receiver.continuity is an array of 4 64-bit numbers covering 256 outputs.
          let continuityActive = false;
          if (receiver.status?.continuity && receiver.status?.continuity.length === 2) {
            const blockIndex = Math.floor(k / 64);
            const bitIndex = k % 64;
            const block = receiver.status.continuity[blockIndex];
            if (block !== undefined) {
              // Use BigInt to safely handle 64-bit operations.
              continuityActive = (BigInt(block) & (BigInt(1) << BigInt(bitIndex))) !== BigInt(0);
            }
          }
          const bgClass = continuityActive ? "bg-green-400" : "bg-red-200";

          return (
            <div
              key={k}
              className={`px-4 py-2 rounded-lg text-sm text-black ${bgClass} cursor-pointer ${borderClass}`}
              onClick={(e) => handleTargetClick(target, item, e)}
            >
              {target}
            </div>
          );
        })}
      </div>

      {/* Popup for Item Details */}
      {popup && (
        <div
          className="absolute bg-gray-700 text-white p-4 rounded-md shadow-lg border border-gray-500"
          style={{
            top: `${popup.position.top}px`,
            left: `${popup.position.left}px`,
            transform: "translate(-50%, -100%)",
            zIndex: 10,
          }}
        >
          <h4 className="text-sm font-semibold">{popup.item.name}</h4>
          {popup.item.image && (
            <img
              src={popup.item.image}
              alt={popup.item.name}
              className="mt-2 w-24 h-24 object-cover rounded-md"
            />
          )}
          <button
            className="mt-2 px-2 py-1 text-sm bg-red-500 rounded-md hover:bg-red-600"
            onClick={() => setPopup(null)}
          >
            Close
          </button>
        </div>
      )}

      {/* New Latency Display Section */}
      {isConnectionGood && (
        <div className="text-sm text-gray-400 mt-auto pt-2 border-t border-gray-700">
          <div className="flex items-center justify-center gap-1 mb-2">
            <MdAccessTime />
            <span>Latency: {lfx}s (RTT: {txmtLatency}ms)</span>
          </div>
          {/* Latency Bar */}
          {latencyPercent !== null && (
            <div className="relative w-full">
              <div className="w-full h-1 bg-gray-700 rounded-full overflow-hidden opacity-80">
                <div
                  className="h-full transition-all duration-1000 ease-out"
                  style={{
                    width: `${latencyPercent}%`,
                    backgroundColor: latencyPercent >= 50 
                      ? `rgba(${Math.floor(225 * (1 - (latencyPercent - 50) / 50))}, 225, 0, 0.85)` 
                      : `rgba(225, ${Math.floor(225 * (latencyPercent / 50))}, 0, 0.85)`
                  }}
                  title={`Latency Quality: ${latencyPercent.toFixed(0)}%`}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Health Bar - Muted at bottom */}
      {healthPercent !== null && (
        <div className="relative w-full mt-2">
          {/* Percentage text above the bar end */}
          <div
            className="absolute text-xs text-gray-500 -top-4 transition-all duration-300 ease-out"
            style={{
              left: `${healthPercent}%`,
              transform: 'translateX(-50%)'
            }}
          >
            {healthPercent}%
          </div>
          {/* Health bar */}
          <div className="w-full h-1 bg-gray-700 rounded-full overflow-hidden opacity-80">
            <div
              className="h-full transition-all duration-300 ease-out"
              style={{
                width: `${healthPercent}%`,
                backgroundColor: healthPercent >= 50 
                  ? `rgba(${Math.floor(225 * (1 - (healthPercent - 50) / 50))}, 225, 0, 0.85)` 
                  : `rgba(225, ${Math.floor(225 * (healthPercent / 50))}, 0, 0.85)`
              }}
              title={`Success Rate: ${healthPercent}%`}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReceiverDisplay({ setCurrentTab }) {
    const { systemConfig, stagedShow } = useAppStore();
    const { stateData } = useStateAppStore()
    const [ targetRcvMap, setTargetRcvMap ] = useState({});
    const [showUnusedReceivers, setShowUnusedReceivers] = useState(false);
    const [receiverLabels, setReceiverLabels] = useState({});

    const [receivers, setReceivers] = useState([]);
    
    // Load receiver labels from show data
    useEffect(() => {
      if (stagedShow?.receiverLabels) {
        setReceiverLabels(stagedShow.receiverLabels);
      } else if (stagedShow?.receiver_labels) {
        try {
          const parsedLabels = JSON.parse(stagedShow.receiver_labels);
          setReceiverLabels(parsedLabels);
        } catch (e) {
          console.error('Failed to parse receiver_labels for show:', stagedShow.id, e);
        }
      } else {
        setReceiverLabels({});
      }
    }, [stagedShow]);

    useEffect(() => {
      let receiversTmp = systemConfig?.receivers || {};
  
      if (receiversTmp) {
        // if(stateData.fw_state?.active_protocol){
        //   receiversTmp= Object.fromEntries(
        //     Object.entries(systemConfig?.receivers).filter(([key, val]) => val.protocol === stateData.fw_state?.active_protocol)
        //   )
        // }
        if(stateData.fw_state?.receivers){
          receiversTmp = stateData.fw_state?.receivers
        }

        setReceivers(receiversTmp);
  
        // Build a lookup table for zones and targets to receivers
        const lookupTable = {};
        Object.keys(receiversTmp).forEach((receiverKey) => {
          const receiver = receiversTmp[receiverKey];
          Object.keys(receiver.cues).forEach((zoneKey) => {
            receiver.cues[zoneKey].forEach((target) => {
              lookupTable[`${zoneKey}:${target}`] = receiverKey; // Create a key for zone:target
            });
          });
        });

  
        // If stagedShow exists, process display_payload
        if (stagedShow?.items) {
          const map = {};
          const parsedPayload = JSON.parse(stagedShow.display_payload);
  
          stagedShow.items.forEach((payloadItem) => {
            const { itemId, zone, target } = payloadItem;
  
            const receiverKey = lookupTable[`${zone}:${target}`]; // Lookup receiver from table
            if (receiverKey) {
              // Initialize receiver in the map if it doesn't exist
              if (!map[receiverKey]) {
                map[receiverKey] = {};
              }

              // Initialize zone in the receiver if it doesn't exist
              if (!map[receiverKey][zone]) {
                map[receiverKey][zone] = {};
              }

              // Assign the item to the corresponding target within the zone
              map[receiverKey][zone][target] = payloadItem;
            }

          });
          setTargetRcvMap(map);
        } else {
          setTargetRcvMap({});
        }
      }
    }, [systemConfig.receivers, stagedShow, stateData.fw_state?.active_protocol, stateData.fw_state?.receivers]);

    // Calculate system health metrics
    const calculateSystemHealth = () => {
      const onlineReceivers = Object.entries(receivers).filter(([ident, receiver]) => {
        if (!receiver.status || !receiver.status.lmt) return false;
        const latency = Date.now() - receiver.status.lmt;
        return latency <= 10000; // 10 second timeout
      });

      if (onlineReceivers.length === 0) {
        return { avgLatencyPercent: null, worstLatencyPercent: null, worstLatencyIdent: null, avgSuccessPercent: null, worstSuccessPercent: null, worstSuccessIdent: null, continuityPercent: null, continuityCount: null, continuityTotal: null };
      }

      // Calculate latency metrics with ident tracking
      const latencyData = onlineReceivers.map(([ident, receiver]) => {
        const latency = Date.now() - receiver.status.lmt;
        const lfx = latency / 1000;
        let percent;
        if (lfx <= 1) percent = 100;
        else if (lfx >= 10) percent = 0;
        else percent = 100 - (lfx / 10) * 100;
        return { ident, percent };
      });

      const avgLatencyPercent = latencyData.reduce((sum, d) => sum + d.percent, 0) / latencyData.length;
      const worstLatency = latencyData.reduce((worst, current) => current.percent < worst.percent ? current : worst);
      const worstLatencyPercent = worstLatency.percent;
      const worstLatencyIdent = worstLatency.ident;

      // Calculate success percent metrics with ident tracking
      const successData = onlineReceivers
        .map(([ident, receiver]) => ({
          ident,
          percent: receiver.status?.successPercent ?? null
        }))
        .filter(d => d.percent !== null);

      if (successData.length === 0) {
        return { avgLatencyPercent, worstLatencyPercent, worstLatencyIdent, avgSuccessPercent: null, worstSuccessPercent: null, worstSuccessIdent: null, continuityPercent: null, continuityCount: null, continuityTotal: null };
      }

      const avgSuccessPercent = successData.reduce((sum, d) => sum + d.percent, 0) / successData.length;
      const worstSuccess = successData.reduce((worst, current) => current.percent < worst.percent ? current : worst);
      const worstSuccessPercent = worstSuccess.percent;
      const worstSuccessIdent = worstSuccess.ident;

      // Calculate continuity metrics (only if show is loaded)
      let continuityPercent = null;
      let continuityCount = null;
      let continuityTotal = null;
      
      if (stagedShow && targetRcvMap && Object.keys(targetRcvMap).length > 0) {
        let totalCues = 0;
        let connectedCues = 0;
        
        Object.entries(receivers).forEach(([receiverKey, receiver]) => {
          const receiverMapping = targetRcvMap[receiverKey];
          if (!receiverMapping || !receiver.cues) return;
          
          // Iterate through all zones and targets in the receiver
          Object.entries(receiver.cues).forEach(([zoneKey, targets]) => {
            const zoneMapping = receiverMapping[zoneKey];
            if (!zoneMapping) return;
            
            targets.forEach((target, targetIndex) => {
              // Only count cues that have items assigned in the show
              if (zoneMapping[target]) {
                totalCues++;
                
                // Check continuity for this cue
                if (receiver.status?.continuity && receiver.status.continuity.length === 2) {
                  const blockIndex = Math.floor(targetIndex / 64);
                  const bitIndex = targetIndex % 64;
                  const block = receiver.status.continuity[blockIndex];
                  if (block !== undefined) {
                    const continuityActive = (BigInt(block) & (BigInt(1) << BigInt(bitIndex))) !== BigInt(0);
                    if (continuityActive) {
                      connectedCues++;
                    }
                  }
                }
              }
            });
          });
        });
        
        if (totalCues > 0) {
          continuityTotal = totalCues;
          continuityCount = connectedCues;
          continuityPercent = (connectedCues / totalCues) * 100;
        }
      }

      return { avgLatencyPercent, worstLatencyPercent, worstLatencyIdent, avgSuccessPercent, worstSuccessPercent, worstSuccessIdent, continuityPercent, continuityCount, continuityTotal };
    };

    const systemHealth = calculateSystemHealth();

    return (
        <div className="w-full">
            <ShowHealth />
            {/* System Health Bar - Fixed at top */}
            {(systemHealth.avgLatencyPercent !== null || systemHealth.avgSuccessPercent !== null || systemHealth.continuityPercent !== null) && (
              <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-700 py-2 px-3">
                <div className="max-w-7xl mx-auto">
                  <div className="flex gap-4">
                    {/* Latency Health Bar */}
                    {systemHealth.avgLatencyPercent !== null && (
                      <div className="flex-1">
                        <div className="text-xs text-gray-500 mb-0.5">Latency</div>
                        <div className="relative w-full h-1.5 bg-gray-800 rounded-full overflow-visible">
                          {/* Average bar with full 0-100 color gradient */}
                          <div
                            className="absolute h-full transition-all duration-1000 ease-out rounded-full"
                            style={{
                              width: `${systemHealth.avgLatencyPercent}%`,
                              backgroundColor: systemHealth.avgLatencyPercent >= 50 
                                ? `rgba(${Math.floor(225 * (1 - (systemHealth.avgLatencyPercent - 50) / 50))}, 225, 0, 0.85)` 
                                : `rgba(225, ${Math.floor(225 * (systemHealth.avgLatencyPercent / 50))}, 0, 0.85)`
                            }}
                          />
                          {/* Red tick marker for worst value */}
                          <div
                            className="absolute top-0 w-0.5 h-full bg-red-500 transition-all duration-1000 ease-out"
                            style={{
                              left: `${systemHealth.worstLatencyPercent}%`,
                              transform: 'translateX(-50%)',
                              boxShadow: '0 0 4px 2px rgba(239, 68, 68, 0.5)'
                            }}
                          />
                          {/* Worst receiver ident */}
                          {systemHealth.worstLatencyIdent && (
                            <div
                              className="absolute text-[10px] text-gray-300 transition-all duration-1000 ease-out whitespace-nowrap z-10"
                              style={{
                                left: `${systemHealth.worstLatencyPercent}%`,
                                top: '-14px',
                                transform: 'translateX(-100%)',
                                marginRight: '4px',
                                textShadow: '0 1px 2px rgba(0, 0, 0, 0.8), 0 0 4px rgba(0, 0, 0, 0.6)'
                              }}
                            >
                              {systemHealth.worstLatencyIdent}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {/* Success Percent Health Bar */}
                    {systemHealth.avgSuccessPercent !== null && (
                      <div className="flex-1">
                        <div className="text-xs text-gray-500 mb-0.5">Success Rate</div>
                        <div className="relative w-full h-1.5 bg-gray-800 rounded-full overflow-visible">
                          {/* Average bar with full 0-100 color gradient */}
                          <div
                            className="absolute h-full transition-all duration-1000 ease-out rounded-full"
                            style={{
                              width: `${systemHealth.avgSuccessPercent}%`,
                              backgroundColor: systemHealth.avgSuccessPercent >= 50 
                                ? `rgba(${Math.floor(225 * (1 - (systemHealth.avgSuccessPercent - 50) / 50))}, 225, 0, 0.85)` 
                                : `rgba(225, ${Math.floor(225 * (systemHealth.avgSuccessPercent / 50))}, 0, 0.85)`
                            }}
                          />
                          {/* Red tick marker for worst value */}
                          <div
                            className="absolute top-0 w-0.5 h-full bg-red-500 transition-all duration-1000 ease-out"
                            style={{
                              left: `${systemHealth.worstSuccessPercent}%`,
                              transform: 'translateX(-50%)',
                              boxShadow: '0 0 4px 2px rgba(239, 68, 68, 0.5)'
                            }}
                          />
                          {/* Worst receiver ident */}
                          {systemHealth.worstSuccessIdent && (
                            <div
                              className="absolute text-[10px] text-gray-300 transition-all duration-1000 ease-out whitespace-nowrap z-10"
                              style={{
                                left: `${systemHealth.worstSuccessPercent}%`,
                                top: '-14px',
                                transform: 'translateX(-100%)',
                                marginRight: '4px',
                                textShadow: '0 1px 2px rgba(0, 0, 0, 0.8), 0 0 4px rgba(0, 0, 0, 0.6)'
                              }}
                            >
                              {systemHealth.worstSuccessIdent}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Header with Show Loadout button */}
            <div className="flex justify-between items-center p-4 border-b border-gray-700">
                <h1 className="text-2xl font-bold text-white">Receivers</h1>
                {stagedShow && (
                    <button
                        onClick={() => setCurrentTab('loadout')}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                    >
                        <MdAssignment />
                        View Show Loadout
                    </button>
                )}
            </div>
            
            {/* Used Receivers */}
            {stagedShow && Object.keys(targetRcvMap).length > 0 && (
                <div className="flex flex-wrap gap-5 p-4 justify-center">
                    {Object.keys(receivers)
                        .filter(rcv_key => targetRcvMap[rcv_key])
                        .map((rcv_key, i) => (
                            <SingleReceiver key={i} rcv_name={rcv_key} receiver={receivers[rcv_key]} showMapping={targetRcvMap[rcv_key]} showId={stagedShow?.id} receiverLabel={receiverLabels[rcv_key]}/>
                        ))}
                </div>
            )}

            {/* Unused Receivers - Collapsible */}
            {stagedShow && Object.keys(targetRcvMap).length > 0 && (
                <div className="border-t border-gray-700">
                    <button
                        onClick={() => setShowUnusedReceivers(!showUnusedReceivers)}
                        className="w-full px-4 py-2 text-left text-sm text-slate-400 hover:text-slate-300 hover:bg-slate-800 transition-colors flex items-center justify-between"
                    >
                        <span>
                            Unused Receivers ({Object.keys(receivers).filter(rcv_key => !targetRcvMap[rcv_key]).length})
                        </span>
                        <span className="text-xs">{showUnusedReceivers ? '▼' : '▶'}</span>
                    </button>
                    {showUnusedReceivers && (
                        <div className="flex flex-wrap gap-5 p-4 justify-center">
                            {Object.keys(receivers)
                                .filter(rcv_key => !targetRcvMap[rcv_key])
                                .map((rcv_key, i) => (
                                    <SingleReceiver key={i} rcv_name={rcv_key} receiver={receivers[rcv_key]} showMapping={targetRcvMap[rcv_key]} showId={stagedShow?.id} receiverLabel={receiverLabels[rcv_key]}/>
                                ))}
                        </div>
                    )}
                </div>
            )}

            {/* All Receivers (when no show is staged) */}
            {(!stagedShow || Object.keys(targetRcvMap).length === 0) && (
                <div className="flex flex-wrap gap-5 p-4 justify-center">
                    {Object.keys(receivers).map((rcv_key, i) => (
                        <SingleReceiver key={i} rcv_name={rcv_key} receiver={receivers[rcv_key]} showMapping={targetRcvMap[rcv_key]} showId={stagedShow?.id} receiverLabel={receiverLabels[rcv_key]}/>
                    ))}
                </div>
            )}
        </div>
    );
}