import React, { useState, useEffect } from "react";
import axios from "axios";
import useStateAppStore from "@/store/useStateAppStore";

const DaemonSettings = () => {
  const { stateData, setStateData } = useStateAppStore();

  // Initialize local state with values from global store or defaults from user's last diff
  const [currentReceiverTimeout, setCurrentReceiverTimeout] = useState(
    stateData?.fw_state?.settings?.receiver_timeout_ms || 30000
  );
  const [currentCommandResponseTimeout, setCurrentCommandResponseTimeout] = useState(
    stateData?.fw_state?.settings?.command_response_timeout_ms || 100
  );
  const [currentClockSyncInterval, setCurrentClockSyncInterval] = useState(
    stateData?.fw_state?.settings?.clock_sync_interval_ms || 200 // Default from user's diff
  );
  const [currentDongleSyncInterval, setCurrentDongleSyncInterval] = useState(
    stateData?.fw_state?.settings?.dongle_sync_interval_ms || 20000
  );
  const [currentConfigQueryInterval, setCurrentConfigQueryInterval] = useState(
    stateData?.fw_state?.settings?.config_query_interval_ms || 120000
  );
  const [currentDebugMode, setCurrentDebugMode] = useState(
    stateData?.fw_state?.settings?.debug_mode || 0
  );
  const [currentDebugCommands, setCurrentDebugCommands] = useState(
    stateData?.fw_state?.settings?.debug_commands || 0
  );

  useEffect(() => {
    // The following lines are removed/commented out to prevent overwriting user edits
    // if (stateData && stateData.fw_state?.settings) {
    //   setCurrentReceiverTimeout(stateData.fw_state.settings.receiver_timeout_ms || 30000);
    //   setCurrentCommandResponseTimeout(stateData.fw_state.settings.command_response_timeout_ms || 100);
    //   setCurrentClockSyncInterval(stateData.fw_state.settings.clock_sync_interval_ms || 2000); // Original default was 2000 here
    //   setCurrentDebugMode(stateData.fw_state.settings.debug_mode || 0);
    // }
    // This useEffect can be used for other reactions to stateData if needed in the future.
  }, [stateData]);

  const handleSubmit = async (settingType, value) => {
    let commandType = "";
    let payload = {};
    let settingKey = "";

    switch (settingType) {
      case "receiver_timeout":
        commandType = "set_receiver_timeout";
        payload = { timeout_ms: parseInt(value) };
        settingKey = "receiver_timeout_ms";
        break;
      case "command_response_timeout":
        commandType = "set_command_response_timeout";
        payload = { timeout_ms: parseInt(value) };
        settingKey = "command_response_timeout_ms";
        break;
      case "clock_sync_interval":
        commandType = "set_clock_sync_interval";
        payload = { interval_ms: parseInt(value) };
        settingKey = "clock_sync_interval_ms";
        break;
      case "dongle_sync_interval":
        commandType = "set_dongle_sync_interval";
        payload = { interval_ms: parseInt(value) };
        settingKey = "dongle_sync_interval_ms";
        break;
      case "config_query_interval":
        commandType = "set_config_query_interval";
        payload = { interval_ms: parseInt(value) };
        settingKey = "config_query_interval_ms";
        break;
      case "debug_mode":
        commandType = "set_debug_mode";
        payload = { debug_mode: parseInt(value) };
        settingKey = "debug_mode";
        break;
      case "debug_commands":
        commandType = "set_debug_commands";
        payload = { debug_commands: parseInt(value) };
        settingKey = "debug_commands";
        break;
      default:
        console.error("Invalid setting type.");
        return;
    }

    try {
      await axios.post("/api/system/cmd_daemon", { type: commandType, ...payload }, {
        headers: { "Content-Type": "application/json" },
      });
      console.log(`${settingType.replace("_", " ")} updated successfully.`);
      
      // Update global app store after successful API call, using the correct fw_state path
      const newStateData = {
        ...stateData,
        fw_state: {
          ...(stateData.fw_state || {}), // Preserve other fw_state properties
          settings: {
            ...(stateData.fw_state?.settings || {}), // Preserve other settings
            [settingKey]: parseInt(value),
          },
        },
      };
      setStateData(newStateData);

    } catch (error) {
      console.error("Error updating setting", error.response?.data?.message || error.message);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-bold text-white">Daemon Configuration</h2>

      <div className="flex flex-col gap-1">
        <label className="block text-gray-200 text-sm font-bold" htmlFor="receiver_timeout">
          Receiver Timeout (ms)
        </label>
        <input
          id="receiver_timeout"
          type="number"
          value={currentReceiverTimeout}
          onChange={(e) => setCurrentReceiverTimeout(e.target.value)}
          className="shadow appearance-none border rounded w-full py-2 px-3 text-white leading-tight focus:outline-none focus:shadow-outline bg-gray-700 border-gray-600 placeholder-gray-400"
        />
        <button 
          onClick={() => handleSubmit("receiver_timeout", currentReceiverTimeout)}
          className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline mt-1 self-start"
        >
          Update
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className="block text-gray-200 text-sm font-bold" htmlFor="command_response_timeout">
          Command Response Timeout (ms)
        </label>
        <input
          id="command_response_timeout"
          type="number"
          value={currentCommandResponseTimeout}
          onChange={(e) => setCurrentCommandResponseTimeout(e.target.value)}
          className="shadow appearance-none border rounded w-full py-2 px-3 text-white leading-tight focus:outline-none focus:shadow-outline bg-gray-700 border-gray-600 placeholder-gray-400"
        />
        <button 
          onClick={() => handleSubmit("command_response_timeout", currentCommandResponseTimeout)}
          className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline mt-1 self-start"
        >
          Update
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className="block text-gray-200 text-sm font-bold" htmlFor="clock_sync_interval">
          Clock Sync Interval (ms) - Dongle to Receivers
        </label>
        <input
          id="clock_sync_interval"
          type="number"
          value={currentClockSyncInterval}
          onChange={(e) => setCurrentClockSyncInterval(e.target.value)}
          className="shadow appearance-none border rounded w-full py-2 px-3 text-white leading-tight focus:outline-none focus:shadow-outline bg-gray-700 border-gray-600 placeholder-gray-400"
        />
        <p className="text-gray-400 text-xs italic mt-1">
          How often the dongle syncs clocks with receivers
        </p>
        <button 
          onClick={() => handleSubmit("clock_sync_interval", currentClockSyncInterval)}
          className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline mt-1 self-start"
        >
          Update
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className="block text-gray-200 text-sm font-bold" htmlFor="dongle_sync_interval">
          Dongle Sync Interval (ms) - Daemon to Dongle
        </label>
        <input
          id="dongle_sync_interval"
          type="number"
          value={currentDongleSyncInterval}
          onChange={(e) => setCurrentDongleSyncInterval(e.target.value)}
          className="shadow appearance-none border rounded w-full py-2 px-3 text-white leading-tight focus:outline-none focus:shadow-outline bg-gray-700 border-gray-600 placeholder-gray-400"
        />
        <p className="text-gray-400 text-xs italic mt-1">
          How often the Python daemon syncs the dongle's clock
        </p>
        <button 
          onClick={() => handleSubmit("dongle_sync_interval", currentDongleSyncInterval)}
          className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline mt-1 self-start"
        >
          Update
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className="block text-gray-200 text-sm font-bold" htmlFor="config_query_interval">
          Config Query Interval (ms)
        </label>
        <input
          id="config_query_interval"
          type="number"
          value={currentConfigQueryInterval}
          onChange={(e) => setCurrentConfigQueryInterval(e.target.value)}
          className="shadow appearance-none border rounded w-full py-2 px-3 text-white leading-tight focus:outline-none focus:shadow-outline bg-gray-700 border-gray-600 placeholder-gray-400"
        />
        <p className="text-gray-400 text-xs italic mt-1">
          How often to query receiver configs (FW version, board count, etc.)
        </p>
        <button 
          onClick={() => handleSubmit("config_query_interval", currentConfigQueryInterval)}
          className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline mt-1 self-start"
        >
          Update
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className="block text-gray-200 text-sm font-bold" htmlFor="debug_mode">
          Debug Mode (0 or 1)
        </label>
        <input
          id="debug_mode"
          type="number"
          value={currentDebugMode}
          onChange={(e) => setCurrentDebugMode(e.target.value)}
          min={0}
          max={1}
          className="shadow appearance-none border rounded w-full py-2 px-3 text-white leading-tight focus:outline-none focus:shadow-outline bg-gray-700 border-gray-600 placeholder-gray-400"
        />
        <button 
          onClick={() => handleSubmit("debug_mode", currentDebugMode)}
          className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline mt-1 self-start"
        >
          Update
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className="block text-gray-200 text-sm font-bold" htmlFor="debug_commands">
          Command Debug (0 or 1)
        </label>
        <input
          id="debug_commands"
          type="number"
          value={currentDebugCommands}
          onChange={(e) => setCurrentDebugCommands(e.target.value)}
          min={0}
          max={1}
          className="shadow appearance-none border rounded w-full py-2 px-3 text-white leading-tight focus:outline-none focus:shadow-outline bg-gray-700 border-gray-600 placeholder-gray-400"
        />
        <button 
          onClick={() => handleSubmit("debug_commands", currentDebugCommands)}
          className="bg-blue-900 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline mt-1 self-start"
        >
          Update
        </button>
      </div>
    </div>
  );
};

export default DaemonSettings; 