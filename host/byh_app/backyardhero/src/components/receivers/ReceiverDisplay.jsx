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
  MdAccessTime
} from 'react-icons/md';
import { FaSpinner } from 'react-icons/fa';


function SingleReceiver({ rcv_name, receiver, showMapping, showId }) {
  const [popup, setPopup] = useState(null);
  const receiverRef = useRef(null);

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
    txmtLatency = receiver.status.lat
    isConnectionGood = (latency <= 5000);
  } else {
    isConnectionGood = receiver.connectionStatus === "good";
  }

  const lfx = (latency / 1000).toFixed(1)


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
        <h2 className="text-lg font-semibold">{rcv_name}</h2>

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
          <div className="flex items-center justify-center gap-1">
            <MdAccessTime />
            <span>Latency: {lfx}s (RTT: {txmtLatency}ms)</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReceiverDisplay() {
    const { systemConfig, stagedShow } = useAppStore();
    const { stateData } = useStateAppStore()
    const [ targetRcvMap, setTargetRcvMap ] = useState({});

    const [receivers, setReceivers] = useState([]);

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

    return (
        <div className="w-full flex flex-wrap gap-5 p-4 justify-center">
        {Object.keys(receivers).map((rcv_key, i) => (
            <SingleReceiver key={i} rcv_name={rcv_key} receiver={receivers[rcv_key]}  showMapping={targetRcvMap[rcv_key]} showId={stagedShow?.id}/>
        ))}
        </div>
    );
}