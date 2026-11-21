import useStateFields from "@/store/useStateFields";
import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import { Slider } from "@/design";
import {
  RF433_REPEAT_DEFAULT,
  RF433_REPEAT_MAX,
  RF433_REPEAT_MIN,
  rf433MaxCuesPerSecond,
  rf433MinSpacingMs,
} from "@/util/rf433";

// How many times the dongle repeats each Bilusocn 433MHz fire frame.
// More repeats ride out RF dropouts; fewer let Bilusocn cues fire closer
// together, because the dongle sends every repeat before it starts the
// next cue. Daemon stores this under `rf433_repeat_ct`.

function formatSpacing(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

export default function TransmitRepetitionCount() {
  const stateData = useStateFields(["fw_state.settings"]);
  const upstream = stateData?.fw_state?.settings?.rf433_repeat_ct;
  const [value, setValue] = useState(
    typeof upstream === "number" ? upstream : RF433_REPEAT_DEFAULT,
  );
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
        { type: "set_rf433_repeat", repeat_ct: next },
        { headers: { "Content-Type": "application/json" } },
      );
    } catch {
      /* daemon error log surfaces actual failures */
    }
  };

  const spacingMs = rf433MinSpacingMs(value);
  const perSecond = rf433MaxCuesPerSecond(value);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor="rf433-repeat-slider" className="text-sm text-fg-primary">
          Bilusocn 433 MHz repeats
        </label>
        <span className="num text-sm tabular-nums text-fg-secondary">
          {value}×{value === RF433_REPEAT_DEFAULT ? " (default)" : ""}
        </span>
      </div>
      <Slider
        id="rf433-repeat-slider"
        value={value}
        min={RF433_REPEAT_MIN}
        max={RF433_REPEAT_MAX}
        ariaLabel="Bilusocn 433 MHz repeat count"
        onChange={(e) => {
          draggingRef.current = true;
          setValue(parseInt(e.target.value, 10));
        }}
        onCommit={() => {
          draggingRef.current = false;
          commit(value);
        }}
      />
      <div className="flex items-baseline justify-between gap-2 rounded-md bg-surface-2 px-3 py-2">
        <span className="text-xs text-fg-muted">Fastest back-to-back cues</span>
        <span className="num text-sm tabular-nums text-fg-primary">
          every {formatSpacing(spacingMs)}
          <span className="text-fg-muted"> · {perSecond.toFixed(1)}/s</span>
        </span>
      </div>
      <p className="text-xs text-fg-muted leading-snug">
        Each Bilusocn fire is sent this many times, and the base finishes
        all of them before starting the next cue. Fewer repeats let cues
        fire closer together, but a dropout is more likely to miss one.
        More repeats are more reliable. Cues scheduled closer than the
        spacing above fire late. Doesn&apos;t affect Backyard Hero
        receivers.
      </p>
    </div>
  );
}
