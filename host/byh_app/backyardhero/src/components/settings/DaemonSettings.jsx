import React from "react";
import axios from "axios";
import useStateAppStore from "@/store/useStateAppStore";
import { Field, inputClass } from "@/design";
import useDraft from "@/hooks/useDraft";
import SaveBar from "./SaveBar";

// Daemon timing knobs. Each field maps to its own daemon command, but
// the panel has a single Save button so the operator commits everything
// at once -- we diff baseline → draft and POST only the commands whose
// values actually changed.

const FIELDS = [
  {
    key: "receiver_timeout_ms",
    cmd: "set_receiver_timeout",
    payloadKey: "timeout_ms",
    label: "Receiver timeout",
    hint: "Drop receivers we haven't heard from in this many milliseconds.",
    suffix: "ms",
    min: 1000,
  },
  {
    key: "command_response_timeout_ms",
    cmd: "set_command_response_timeout",
    payloadKey: "timeout_ms",
    label: "Command response timeout",
    hint: "Wait this long for a receiver ack before retrying.",
    suffix: "ms",
    min: 25,
  },
  {
    key: "clock_sync_interval_ms",
    cmd: "set_clock_sync_interval",
    payloadKey: "interval_ms",
    label: "Clock sync interval",
    hint: "How often the dongle re-syncs the network clock.",
    suffix: "ms",
    min: 100,
  },
];

export default function DaemonSettings() {
  const { stateData, setStateData } = useStateAppStore();
  const settings = stateData?.fw_state?.settings || {};

  const upstream = {
    receiver_timeout_ms: settings.receiver_timeout_ms ?? 30000,
    command_response_timeout_ms: settings.command_response_timeout_ms ?? 100,
    clock_sync_interval_ms: settings.clock_sync_interval_ms ?? 200,
  };
  const draft = useDraft(upstream);

  const onSave = () =>
    draft.save(async (s) => {
      const calls = [];
      for (const f of FIELDS) {
        const next = parseInt(s[f.key], 10);
        if (Number.isFinite(next) && next !== upstream[f.key]) {
          calls.push(
            axios.post(
              "/api/system/cmd_daemon",
              { type: f.cmd, [f.payloadKey]: next },
              { headers: { "Content-Type": "application/json" } },
            ),
          );
        }
      }
      await Promise.all(calls);

      // Optimistically rebase the local mirror so the rest of the UI
      // sees the new values immediately, before the WS pushes them.
      setStateData({
        ...stateData,
        fw_state: {
          ...(stateData.fw_state || {}),
          settings: {
            ...(stateData.fw_state?.settings || {}),
            receiver_timeout_ms: parseInt(s.receiver_timeout_ms, 10),
            command_response_timeout_ms: parseInt(s.command_response_timeout_ms, 10),
            clock_sync_interval_ms: parseInt(s.clock_sync_interval_ms, 10),
          },
        },
      });
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {FIELDS.map((f) => (
          <Field
            key={f.key}
            label={f.label}
            htmlFor={f.key}
            hint={f.hint}
          >
            <div className="relative">
              <input
                id={f.key}
                type="number"
                min={f.min}
                value={draft.state[f.key] ?? ""}
                onChange={(e) => draft.set(f.key, e.target.value)}
                className={inputClass + " num tabular-nums pr-9"}
              />
              <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-2xs text-fg-muted">
                {f.suffix}
              </span>
            </div>
          </Field>
        ))}
      </div>

      <SaveBar
        dirty={draft.dirty}
        saving={draft.saving}
        error={draft.error}
        savedAt={draft.savedAt}
        onSave={onSave}
        onReset={draft.reset}
      />
    </div>
  );
}
