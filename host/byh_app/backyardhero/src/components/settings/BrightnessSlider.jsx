import { useState } from "react";
import axios from "axios";

export default function BrightnessSlider() {
  const [brightVal, setBrightVal] = useState(50);

  const updateBrightness = async (evt) => {
    await axios.post(
      "/api/system/cmd_daemon",
      { type: "set_brightness", brightness: evt.target.value },
      {
        headers: {
          "Content-Type": "application/json",
        }
      }
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <label
        htmlFor="brightness-slider"
        className="block text-sm font-medium text-gray-200"
      >
        Device LED Brightness
      </label>
      <input
        id="brightness-slider"
        type="range"
        value={brightVal}
        onChange={(e) => setBrightVal(e.target.value)}
        onMouseUp={updateBrightness}
        className="w-full h-2 bg-gray-300 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
      />
      <span className="text-sm text-gray-400">Brightness: {brightVal}%</span>
    </div>
  );
}
