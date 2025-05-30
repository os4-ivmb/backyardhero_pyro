import { useState } from "react";
import axios from "axios";

export default function TransmitRepetitionCount() {
  const [repetitionCount, setRepetitionCount] = useState(1);

  const updateRepetitionCount = async (evt) => {
    await axios.post(
      "/api/system/cmd_daemon",
      { type: "set_fire_repeat", repeat_ct: evt.target.value },
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
        htmlFor="repetition-slider"
        className="block text-sm font-medium text-gray-200"
      >
        Transmit Repetition Count
      </label>
      <input
        id="repetition-slider"
        type="range"
        min="1"
        max="10"
        value={repetitionCount}
        onChange={(e) => setRepetitionCount(e.target.value)}
        onMouseUp={updateRepetitionCount}
        className="w-full h-2 bg-gray-300 rounded-lg appearance-none cursor-pointer dark:bg-gray-700"
      />
      <span className="text-sm text-gray-400">
        Repetition Count: {repetitionCount}
      </span>
    </div>
  );
}
