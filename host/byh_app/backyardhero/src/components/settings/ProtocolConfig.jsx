import React, { useState, useEffect } from "react";
import axios from "axios";
import useAppStore from "@/store/useAppStore";

const ProtocolConfig = () => {
  const { systemConfig, fetchSystemConfig, saveSystemConfig } = useAppStore();
  
  // Get the first protocol (or default to BKYD_TS_HYBRID)
  const protocolKey = systemConfig?.protocols ? Object.keys(systemConfig.protocols)[0] : "BKYD_TS_HYBRID";
  const protocol = systemConfig?.protocols?.[protocolKey];
  const currentConfig = protocol?.config || {};

  const [minBattery, setMinBattery] = useState(
    currentConfig.min_battery_to_fire_pct || 30
  );
  const [requireContinuity, setRequireContinuity] = useState(
    currentConfig.require_continuity || false
  );
  const [isSaving, setIsSaving] = useState(false);

  // Update local state when systemConfig changes
  useEffect(() => {
    if (protocol?.config) {
      setMinBattery(protocol.config.min_battery_to_fire_pct || 30);
      setRequireContinuity(protocol.config.require_continuity || false);
    }
  }, [systemConfig, protocol]);

  // Fetch config on mount
  useEffect(() => {
    if (!systemConfig || !systemConfig.protocols) {
      fetchSystemConfig();
    }
  }, [fetchSystemConfig, systemConfig]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Create updated config
      const updatedConfig = {
        ...systemConfig,
        protocols: {
          ...systemConfig.protocols,
          [protocolKey]: {
            ...systemConfig.protocols[protocolKey],
            config: {
              min_battery_to_fire_pct: parseInt(minBattery),
              require_continuity: requireContinuity,
            },
          },
        },
      };

      // Save to API
      await saveSystemConfig(updatedConfig);
      
      console.log("Protocol config updated successfully");
      alert("Protocol configuration saved successfully!");
    } catch (error) {
      console.error("Error saving protocol config:", error);
      alert("Failed to save protocol configuration. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  if (!protocol) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-bold text-white">Protocol Configuration</h2>
        <p className="text-gray-400">Loading protocol configuration...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-bold text-white">Protocol Configuration</h2>
      <p className="text-gray-400 text-sm">
        Protocol: <span className="font-semibold text-white">{protocol.label || protocolKey}</span>
      </p>

      <div className="flex flex-col gap-1">
        <label className="block text-gray-200 text-sm font-bold" htmlFor="min_battery">
          Minimum Battery to Fire (%)
        </label>
        <input
          id="min_battery"
          type="number"
          min="0"
          max="100"
          value={minBattery}
          onChange={(e) => setMinBattery(e.target.value)}
          className="shadow appearance-none border rounded w-full py-2 px-3 text-white leading-tight focus:outline-none focus:shadow-outline bg-gray-700 border-gray-600 placeholder-gray-400"
        />
        <p className="text-gray-400 text-xs italic">
          Receivers must have at least this battery percentage to fire. Default: 30%
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label className="block text-gray-200 text-sm font-bold" htmlFor="require_continuity">
          Require Continuity Check
        </label>
        <div className="flex items-center gap-2">
          <input
            id="require_continuity"
            type="checkbox"
            checked={requireContinuity}
            onChange={(e) => setRequireContinuity(e.target.checked)}
            className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
          />
          <span className="text-gray-300 text-sm">
            {requireContinuity ? "Enabled" : "Disabled"}
          </span>
        </div>
        <p className="text-gray-400 text-xs italic">
          When enabled, receivers must report continuity before firing. Default: Disabled
        </p>
      </div>

      <button 
        onClick={handleSave}
        disabled={isSaving}
        className="bg-slate-900 border border-blue-500 text-blue-300 hover:border-blue-400 hover:shadow-[0_0_8px_rgba(59,130,246,0.3)] font-bold py-2 px-4 rounded-sm transition-all duration-200 self-start disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSaving ? "Saving..." : "Save Configuration"}
      </button>
    </div>
  );
};

export default ProtocolConfig;

