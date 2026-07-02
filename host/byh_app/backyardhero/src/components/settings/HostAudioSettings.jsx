import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import useAppStore from "@/store/useAppStore";
import { Toggle, Field, Button, inputClass, selectClass, fieldHintClass } from "@/design";
import SaveBar from "./SaveBar";

// Host-device audio output. When enabled, the box running the show plays the
// soundtrack out its OWN audio output (wired to the venue PA, etc.), scheduled
// off the same show-start clock the operator's console uses -- so the music
// lines up with the fireworks. The `audio-player` daemon reads these values
// from systemcfg (`system.hostAudio`); the operator console mutes its own
// browser playback while this is on so the sound only comes from the box.
//
//   enabled          on/off
//   deviceId         which output to play through ("default" = system
//                    default; anything else is an ALSA device string from
//                    /api/system/audio_devices)
//   deviceLatencyMs  per-device sync trim: ms EARLIER to start (hides the
//                    on-box player's own startup lag)

function normalize(cfg) {
  const ha = cfg?.system?.hostAudio || {};
  return {
    enabled: !!ha.enabled,
    deviceId: typeof ha.deviceId === "string" && ha.deviceId ? ha.deviceId : "default",
    deviceLatencyMs: Number.isFinite(ha.deviceLatencyMs) ? ha.deviceLatencyMs : 0,
  };
}

export default function HostAudioSettings() {
  const { systemConfig, fetchSystemConfig, saveSystemConfig } = useAppStore();
  const [draft, setDraft] = useState(() => normalize(systemConfig));
  const [baseline, setBaseline] = useState(() => JSON.stringify(normalize(systemConfig)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [devices, setDevices] = useState([{ id: "default", label: "System default" }]);
  // Test-tone playback: { state: "idle"|"playing"|"ok"|"error", message? }.
  const [test, setTest] = useState({ state: "idle" });

  useEffect(() => {
    if (!systemConfig || Object.keys(systemConfig).length === 0) fetchSystemConfig();
  }, [fetchSystemConfig, systemConfig]);

  // Enumerate the host's output devices for the picker. Best-effort: on
  // failure we keep the "System default" fallback already in state.
  useEffect(() => {
    let cancelled = false;
    axios
      .get("/api/system/audio_devices")
      .then(({ data }) => {
        if (cancelled || !Array.isArray(data?.devices) || !data.devices.length) return;
        setDevices(data.devices);
      })
      .catch(() => { /* keep default-only fallback */ });
    return () => { cancelled = true; };
  }, []);

  // Adopt upstream values while the operator hasn't started editing.
  useEffect(() => {
    const upstream = normalize(systemConfig);
    if (baseline === JSON.stringify(draft)) {
      setDraft(upstream);
      setBaseline(JSON.stringify(upstream));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemConfig]);

  const dirty = useMemo(() => JSON.stringify(draft) !== baseline, [draft, baseline]);

  // `keepDraftLatency` is set by the discrete auto-commit controls: they save
  // their own change but must NOT commit a start-trim the operator has typed
  // but not yet confirmed via the SaveBar, so we leave the in-progress
  // deviceLatencyMs edit sitting in the draft (still dirty) after saving.
  const persist = async (next, { keepDraftLatency = false } = {}) => {
    setError(null);
    setSaving(true);
    try {
      const body = {
        ...(systemConfig || {}),
        system: {
          ...(systemConfig?.system || {}),
          hostAudio: {
            enabled: !!next.enabled,
            deviceId: next.deviceId || "default",
            deviceLatencyMs: Number.isFinite(next.deviceLatencyMs) ? next.deviceLatencyMs : 0,
          },
        },
      };
      await saveSystemConfig(body);
      setBaseline(JSON.stringify(next));
      setDraft((d) => (keepDraftLatency ? { ...next, deviceLatencyMs: d.deviceLatencyMs } : next));
      setSavedAt(Date.now());
    } catch (e) {
      console.error("Failed to save host audio settings:", e);
      setError(e?.response?.data?.error || e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // The enable toggle and the device dropdown auto-commit (discrete choices);
  // the numeric start-trim uses the SaveBar since it's fiddled. Both commit
  // against the last-SAVED start-trim (from `baseline`), never the operator's
  // unconfirmed draft value, so flipping the toggle doesn't sneak an unsaved
  // trim edit through.
  const committedLatencyMs = () => {
    try {
      const v = JSON.parse(baseline)?.deviceLatencyMs;
      return Number.isFinite(v) ? v : draft.deviceLatencyMs;
    } catch {
      return draft.deviceLatencyMs;
    }
  };
  const onToggle = (enabled) =>
    persist({ ...draft, deviceLatencyMs: committedLatencyMs(), enabled }, { keepDraftLatency: true });
  const onDevice = (deviceId) => {
    setTest({ state: "idle" }); // prior result was for the old device
    return persist({ ...draft, deviceLatencyMs: committedLatencyMs(), deviceId }, { keepDraftLatency: true });
  };

  const onReset = () => {
    setDraft(normalize(systemConfig));
    setError(null);
  };

  // Play a short test tone out of the currently-selected device so the
  // operator can confirm it makes sound. The device dropdown auto-commits, so
  // draft.deviceId is what's actually saved -- test exactly that. The tone is
  // ~1.2s; the request resolves once playback finishes (or reports why not).
  const onTest = async () => {
    setTest({ state: "playing" });
    try {
      await axios.post("/api/system/audio_test", { deviceId: draft.deviceId });
      setTest({ state: "ok" });
    } catch (e) {
      setTest({
        state: "error",
        message: e?.response?.data?.error || e?.message || "Test failed",
      });
    }
  };

  // Make sure a previously-saved device that isn't in the enumerated list
  // (e.g. hardware not attached this boot) still shows as the selection.
  const deviceOptions = useMemo(() => {
    const opts = [...devices];
    if (draft.deviceId && !opts.some((d) => d.id === draft.deviceId)) {
      opts.push({ id: draft.deviceId, label: `${draft.deviceId} (not detected)` });
    }
    return opts;
  }, [devices, draft.deviceId]);

  return (
    <div className="flex flex-col gap-4">
      <Toggle
        id="host-audio-enabled"
        checked={draft.enabled}
        onChange={onToggle}
        disabled={saving}
        label="Play show audio on this device"
        description="The box hosting the show drives its own audio output, synced to firing. Consoles on other devices go silent so the sound only comes from here."
      />

      <Field
        label="Output device"
        hint="Which of this device's audio outputs to play through. 'System default' follows the OS setting."
      >
        <div className="flex items-center gap-2">
          <select
            value={draft.deviceId}
            disabled={!draft.enabled || saving}
            onChange={(e) => onDevice(e.target.value)}
            className={`${selectClass} flex-1`}
          >
            {deviceOptions.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            onClick={onTest}
            loading={test.state === "playing"}
            disabled={!draft.enabled || saving || test.state === "playing"}
          >
            {test.state === "playing" ? "Playing…" : "Test"}
          </Button>
        </div>
        {test.state === "ok" ? (
          <p className={fieldHintClass}>Test tone played on this device.</p>
        ) : null}
        {test.state === "error" ? (
          <p className="text-sm text-danger-fg">{test.message}</p>
        ) : null}
      </Field>

      <Field
        label="Audio start trim (ms)"
        hint="Fine-tune sync for this device's speakers. Higher = the box starts the music earlier to hide audio-output startup lag. Applies on top of each show's own sync offset."
      >
        <input
          type="number"
          step={10}
          value={draft.deviceLatencyMs}
          disabled={!draft.enabled}
          onChange={(e) =>
            setDraft((d) => ({ ...d, deviceLatencyMs: parseInt(e.target.value, 10) || 0 }))
          }
          className={`${inputClass} num max-w-[10rem]`}
        />
      </Field>

      {!draft.enabled ? (
        <p className={fieldHintClass}>
          Enable host audio to choose an output device and start trim.
        </p>
      ) : null}

      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        savedAt={savedAt}
        onSave={() => persist(draft)}
        onReset={onReset}
      />
    </div>
  );
}
