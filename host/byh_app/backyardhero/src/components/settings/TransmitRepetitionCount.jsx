import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import useStateAppStore from "@/store/useStateAppStore";
import { Slider } from "@/design";

// How many times the dongle re-broadcasts each fire packet. Higher is
// more reliable in noisy RF environments at the cost of slightly more
// airtime per cue. Range 1-10; daemon stores under `fire_repeat_ct`.

export default function TransmitRepetitionCount() {
  const { stateData } = useStateAppStore();
  const upstream = stateData?.fw_state?.settings?.fire_repeat_ct;
  const [value, setValue] = useState(typeof upstream === "number" ? upstream : 1);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (draggingRef.current) return;
    if (typeof upstream === "number" && upstream !== value) {
      setValue(upstream);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upstream]);

  const commit = async (next) => {
    try {
      await axios.post(
        "/api/system/cmd_daemon",
        { type: "set_fire_repeat", repeat_ct: next },
        { headers: { "Content-Type": "application/json" } },
      );
    } catch {
      /* daemon error log surfaces actual failures */
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor="repetition-slider" className="text-sm text-fg-primary">
          Transmit repetition
        </label>
        <span className="num text-sm tabular-nums text-fg-secondary">
          {value}×
        </span>
      </div>
      <Slider
        id="repetition-slider"
        value={value}
        min={1}
        max={10}
        ariaLabel="Transmit repetition count"
        onChange={(e) => {
          draggingRef.current = true;
          setValue(parseInt(e.target.value, 10));
        }}
        onCommit={() => {
          draggingRef.current = false;
          commit(value);
        }}
      />
      <p className="text-xs text-fg-muted leading-snug">
        Each fire packet is re-broadcast this many times. Bump up if you
        see receivers occasionally miss cues; lower for tighter timing in
        clean RF.
      </p>
    </div>
  );
}
