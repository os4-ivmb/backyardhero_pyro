import React, { useState, useEffect } from "react";
import axios from "axios";
import useStateAppStore from "@/store/useStateAppStore";
import useAppStore from "@/store/useAppStore";

const ReceiverSettings = () => {
  // Global settings that apply to all receivers (one-directional, not reading from receivers)
  const [globalSettings, setGlobalSettings] = useState({
    fireMsDuration: 1000,
    statusInterval: 2000,
    txPower: 3, // Default HIGH
  });
  
  // Initialize settings from defaults (not from receiver configs since it's one-directional)
  useEffect(() => {
    // Keep defaults, don't read from receiver configs
    setGlobalSettings({
      fireMsDuration: 1000,
      statusInterval: 2000,
      txPower: 3,
    });
  }, []);
  
  const handleSettingChange = (setting, value) => {
    setGlobalSettings(prev => ({
      ...prev,
      [setting]: parseInt(value) || 0,
    }));
  };
  
  const handleSubmit = async () => {
    try {
      await axios.post(
        "/api/system/cmd_daemon",
        {
          type: "set_receiver_settings",
          fire_ms_duration: globalSettings.fireMsDuration,
          status_interval: globalSettings.statusInterval,
          tx_power: globalSettings.txPower,
        },
        {
          headers: { "Content-Type": "application/json" },
        }
      );
      console.log(`Receiver settings updated for all receivers`);
    } catch (error) {
      console.error("Error updating receiver settings", error.response?.data?.message || error.message);
    }
  };
  
  const txPowerLabels = {
    1: "MIN",
    2: "LOW",
    3: "HIGH",
    4: "MAX",
  };
  
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-bold text-white">Receiver Settings</h2>
      <p className="text-gray-400 text-sm">
        Configure receiver settings for all connected receivers. Changes are sent to all receivers when you click Update.
      </p>
      
      <div className="border border-gray-600 rounded-lg p-4 bg-gray-750">
        <div className="flex flex-col gap-3">
          {/* Fire Duration */}
          <div className="flex flex-col gap-1">
            <label className="block text-gray-200 text-sm font-bold" htmlFor="fire-duration">
              Fire Duration (ms)
            </label>
            <input
              id="fire-duration"
              type="number"
              min="100"
              max="10000"
              value={globalSettings.fireMsDuration}
              onChange={(e) => handleSettingChange('fireMsDuration', e.target.value)}
              className="shadow appearance-none border rounded w-full py-2 px-3 text-white leading-tight focus:outline-none focus:shadow-outline bg-gray-700 border-gray-600 placeholder-gray-400"
              placeholder="1000"
            />
            <p className="text-gray-400 text-xs">Duration to hold fire signal (100-10000ms)</p>
          </div>
          
          {/* Status Interval */}
          <div className="flex flex-col gap-1">
            <label className="block text-gray-200 text-sm font-bold" htmlFor="status-interval">
              Status Interval (ms)
            </label>
            <input
              id="status-interval"
              type="number"
              min="500"
              max="30000"
              value={globalSettings.statusInterval}
              onChange={(e) => handleSettingChange('statusInterval', e.target.value)}
              className="shadow appearance-none border rounded w-full py-2 px-3 text-white leading-tight focus:outline-none focus:shadow-outline bg-gray-700 border-gray-600 placeholder-gray-400"
              placeholder="2000"
            />
            <p className="text-gray-400 text-xs">How often to send unsolicited status (500-30000ms)</p>
          </div>
          
          {/* TX Power */}
          <div className="flex flex-col gap-1">
            <label className="block text-gray-200 text-sm font-bold" htmlFor="tx-power">
              TX Power Level
            </label>
            <select
              id="tx-power"
              value={globalSettings.txPower}
              onChange={(e) => handleSettingChange('txPower', e.target.value)}
              className="shadow appearance-none border rounded w-full py-2 px-3 text-white leading-tight focus:outline-none focus:shadow-outline bg-gray-700 border-gray-600"
            >
              <option value="1">1 - MIN</option>
              <option value="2">2 - LOW</option>
              <option value="3">3 - HIGH</option>
              <option value="4">4 - MAX</option>
            </select>
            <p className="text-gray-400 text-xs">Radio transmission power level</p>
          </div>
          
          {/* Submit Button */}
          <button
            onClick={handleSubmit}
            className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline mt-2 self-start"
          >
            Update All Receivers
          </button>
        </div>
      </div>
    </div>
  );
};

export default ReceiverSettings;

