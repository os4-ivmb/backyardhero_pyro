import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import useStateAppStore from "@/store/useStateAppStore";
import { Slider } from "@/design";

// LED brightness on the box. Daemon stores it on a 0-100 scale (mapped
// internally to whatever PWM range the LED driver wants). This is a
// fire-and-forget setting -- no Save button -- so we commit on pointer
// release / keyboard arrow release rather than typing-debouncing.
//
// The slider hydrates once from `fw_state.settings.led_brightness` so
// what the operator sees is what the daemon thinks is set, even after a
// page reload.

export default function BrightnessSlider() {
  const { stateData } = useStateAppStore();
  const upstream = stateData?.fw_state?.settings?.led_brightness;
  const [value, setValue] = useState(typeof upstream === "number" ? upstream : 50);
  const draggingRef = useRef(false);

  // Sync from upstream as long as the user isn't currently dragging.
  // Keeps us truthful after page reload / external change.
  useEffect(() => {
    if (draggingRef.current) return;
    if (typeof upstream === "number" && upstream !== value) {
      setValue(upstream);
    }
    // We intentionally exclude `value` from deps so we don't fight a
    // user-typed drag-in-progress. draggingRef gates the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upstream]);

  const commit = async (next) => {
    try {
      await axios.post(
        "/api/system/cmd_daemon",
        { type: "set_brightness", brightness: next },
        { headers: { "Content-Type": "application/json" } },
      );
    } catch {
      /* a toast will surface from daemon.err if it actually broke */
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor="brightness-slider" className="text-sm text-fg-primary">
          Device LED brightness
        </label>
        <span className="num text-sm tabular-nums text-fg-secondary">
          {value}%
        </span>
      </div>
      <Slider
        id="brightness-slider"
        value={value}
        min={0}
        max={100}
        ariaLabel="Device LED brightness"
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
        Front-panel LED brightness. Lowering it helps in dim environments
        (and saves a couple mA off the bus).
      </p>
    </div>
  );
}
