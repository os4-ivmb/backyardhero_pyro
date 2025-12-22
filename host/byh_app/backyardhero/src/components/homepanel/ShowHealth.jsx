import { useMemo } from "react";
import useAppStore from "@/store/useAppStore";
import useStateAppStore from "@/store/useStateAppStore";
import { FaCheck, FaTimes } from "react-icons/fa";

export default function ShowHealth() {
  const { stagedShow, systemConfig, setStagedShow } = useAppStore();
  const { stateData } = useStateAppStore();

  const healthMetrics = useMemo(() => {
    if (!stagedShow || !stagedShow.items) {
      return null;
    }

    const receivers = stateData.fw_state?.receivers || systemConfig?.receivers || {};
    const protocolKey = systemConfig?.protocols ? Object.keys(systemConfig.protocols)[0] : "BKYD_TS_HYBRID";
    const protocol = systemConfig?.protocols?.[protocolKey];
    const requireContinuity = protocol?.config?.require_continuity || false;
    const showId = stagedShow.id;

    // Get all receivers used in the staged show
    const showReceivers = new Set();
    const showCues = new Set();
    
    stagedShow.items.forEach((item) => {
      if (item.zone && item.target) {
        // Find which receiver handles this zone:target
        Object.entries(receivers).forEach(([receiverKey, receiver]) => {
          if (receiver.cues && receiver.cues[item.zone] && receiver.cues[item.zone].includes(item.target)) {
            showReceivers.add(receiverKey);
            showCues.add(`${item.zone}:${item.target}`);
          }
        });
      }
    });

    const totalReceivers = showReceivers.size;
    const totalCues = showCues.size;

    // 1. Receivers Connected
    let connectedCount = 0;
    showReceivers.forEach((receiverKey) => {
      const receiver = receivers[receiverKey];
      if (receiver) {
        let isConnectionGood;
        let latency = 0;
        if (receiver.status && receiver.status.lmt) {
          latency = Date.now() - receiver.status.lmt;
          isConnectionGood = latency <= 10000;
        } else {
          isConnectionGood = receiver.connectionStatus === "good";
        }
        if (isConnectionGood) {
          connectedCount++;
        }
      }
    });

    // 2. Cues Connected (continuity)
    let cuesConnectedCount = 0;
    showCues.forEach((cueKey) => {
      const [zone, target] = cueKey.split(':');
      const targetNum = parseInt(target);
      
      // Find receiver for this cue
      Object.entries(receivers).forEach(([receiverKey, receiver]) => {
        if (receiver.cues && receiver.cues[zone] && receiver.cues[zone].includes(targetNum)) {
          if (receiver.status?.continuity && receiver.status.continuity.length === 2) {
            const bitIndex = targetNum - 1; // Convert to 0-based
            const blockIndex = Math.floor(bitIndex / 64);
            const bitPos = bitIndex % 64;
            
            if (blockIndex < 2) {
              const block = receiver.status.continuity[blockIndex];
              if (block !== undefined) {
                try {
                  const blockBigInt = typeof block === 'bigint' ? block : BigInt(block);
                  const continuityActive = (blockBigInt & (BigInt(1) << BigInt(bitPos))) !== BigInt(0);
                  if (continuityActive) {
                    cuesConnectedCount++;
                  }
                } catch (e) {
                  // Handle conversion errors
                }
              }
            }
          }
        }
      });
    });

    // 3. Receivers Loaded
    let loadedCount = 0;
    showReceivers.forEach((receiverKey) => {
      const receiver = receivers[receiverKey];
      if (receiver?.status && receiver.status.showId === showId && receiver.status.loadComplete) {
        loadedCount++;
      }
    });

    // 4. Receivers Ready to Start
    let readyCount = 0;
    showReceivers.forEach((receiverKey) => {
      const receiver = receivers[receiverKey];
      if (receiver?.status && receiver.status.startReady) {
        readyCount++;
      }
    });

    return {
      receiversConnected: { current: connectedCount, total: totalReceivers },
      cuesConnected: { current: cuesConnectedCount, total: totalCues, requireContinuity },
      receiversLoaded: { current: loadedCount, total: totalReceivers },
      receiversReady: { current: readyCount, total: totalReceivers },
    };
  }, [stagedShow, stateData.fw_state?.receivers, systemConfig]);

  if (!healthMetrics) {
    return null;
  }

  const MetricBox = ({ label, current, total, isComplete, isError }) => {
    const bgClass = isComplete
      ? "bg-slate-900 border-emerald-500 text-emerald-300"
      : isError
      ? "bg-slate-900 border-red-500 text-red-300"
      : "bg-slate-900 border-amber-500 text-amber-300";

    return (
      <div className={`flex-1 border rounded-sm px-2 py-1 ${bgClass} transition-all duration-200`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-slate-400">{label}:</span>
          <span className="text-xs font-medium">
            {current} of {total}
          </span>
          {isComplete && (
            <FaCheck className="text-emerald-400 text-xs flex-shrink-0" />
          )}
        </div>
      </div>
    );
  };

  const handleUnstage = () => {
    setStagedShow({});
  };

  return (
    <div className="sticky top-0 z-[5] bg-slate-900 border-b border-slate-700 py-1 px-3">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 mr-1">Show Health</span>
          <div className="flex gap-2 flex-1">
          <MetricBox
            label="Receivers Connected"
            current={healthMetrics.receiversConnected.current}
            total={healthMetrics.receiversConnected.total}
            isComplete={healthMetrics.receiversConnected.current === healthMetrics.receiversConnected.total}
          />
          <MetricBox
            label="Cues Connected"
            current={healthMetrics.cuesConnected.current}
            total={healthMetrics.cuesConnected.total}
            isComplete={healthMetrics.cuesConnected.current === healthMetrics.cuesConnected.total}
            isError={healthMetrics.cuesConnected.requireContinuity && healthMetrics.cuesConnected.current !== healthMetrics.cuesConnected.total}
          />
          <MetricBox
            label="Receivers Loaded"
            current={healthMetrics.receiversLoaded.current}
            total={healthMetrics.receiversLoaded.total}
            isComplete={healthMetrics.receiversLoaded.current === healthMetrics.receiversLoaded.total}
          />
          <MetricBox
            label="Receivers Ready"
            current={healthMetrics.receiversReady.current}
            total={healthMetrics.receiversReady.total}
            isComplete={healthMetrics.receiversReady.current === healthMetrics.receiversReady.total}
          />
          </div>
          <button
            onClick={handleUnstage}
            className="bg-slate-900 border border-red-500 text-red-300 hover:border-red-400 hover:shadow-[0_0_8px_rgba(239,68,68,0.3)] px-3 py-1 rounded-sm transition-all duration-200 flex items-center gap-1.5 text-xs font-medium"
            title="Unstage Show"
          >
            <FaTimes className="text-xs" />
            Unstage
          </button>
        </div>
      </div>
    </div>
  );
}

