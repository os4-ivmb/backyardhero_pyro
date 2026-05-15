import React, { useEffect, useMemo, useState } from "react";
import useAppStore from "@/store/useAppStore";
import useStateAppStore from "@/store/useStateAppStore";
import { Button, Field, inputClass } from "@/design";
import { MdSettingsBackupRestore } from "react-icons/md";

// Receiver-side runtime config (paired with receiver FW v22+ / dongle FW v16+).
//
// Today the only writable knob is `fire_duration_ms` -- the pulse width
// the receiver holds on a fired cue line. Future per-receiver knobs
// (e.g. continuity sample rate, low-battery threshold) land here as
// additional inputs; each one writes through the same broadcast
// `rxcfg` daemon command, with the cached value pulled out of
// receivers[*].config_data.
//
// The "Apply to all receivers" button broadcasts to every currently-
// connected, enabled receiver. Per-receiver overrides happen on the
// Receivers page via the per-card "Fetch cfg" button + edit panel.

// Show a fire_duration_ms summary as: distinct value if all receivers
// agree, else a "varies (Xms..Yms)" string. Lets the operator see at a
// glance whether the fleet is uniform without paging through every
// card.
function summarizeFireDuration(receivers) {
  const onlineWithCfg = Object.values(receivers || {}).filter((r) => {
    if (r?.type === "BILUSOCN_433_TX_ONLY") return false;
    if (!r?.enabled) return false;
    return r?.config_data?.fire_duration_ms != null;
  });
  if (onlineWithCfg.length === 0) {
    return { mode: "unknown", text: "(no receivers reporting yet)" };
  }
  const values = onlineWithCfg.map((r) => Number(r.config_data.fire_duration_ms));
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    return { mode: "uniform", text: `${min} ms`, value: min, count: values.length };
  }
  return {
    mode: "varies",
    text: `varies (${min}–${max} ms across ${values.length})`,
    min,
    max,
    count: values.length,
  };
}

const FIRE_DURATION_MIN = 50;
const FIRE_DURATION_MAX = 5000;

export default function ReceiverConfigSettings() {
  const { receivers, fetchReceivers, fetchReceiverConfig } = useAppStore();
  const { stateData } = useStateAppStore();
  const [draftFire, setDraftFire] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  // Refresh the DB-backed receivers list on mount so cached values
  // (cues_available, fire_duration_ms) reflect the latest persisted
  // rxcfg responses without waiting for the next routine fetchReceivers.
  useEffect(() => {
    fetchReceivers().catch((e) => console.error("fetchReceivers:", e));
  }, [fetchReceivers]);

  // Re-pull a few seconds after a broadcast write so the fleet's new
  // values surface in the summary. The daemon writes per-receiver as
  // each rxcfg response lands.
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => {
      fetchReceivers().catch((e) => console.error("post-save fetchReceivers:", e));
    }, 2500);
    return () => clearTimeout(t);
  }, [savedAt, fetchReceivers]);

  const summary = useMemo(() => summarizeFireDuration(receivers), [receivers]);

  const onlineCount = useMemo(() => {
    const live = stateData?.fw_state?.receivers || {};
    let n = 0;
    for (const id of Object.keys(receivers || {})) {
      const r = receivers[id];
      if (!r?.enabled) continue;
      if (r?.type === "BILUSOCN_433_TX_ONLY") continue;
      const lmt = live[id]?.status?.lmt;
      if (lmt && Date.now() - lmt < 10000) n++;
    }
    return n;
  }, [receivers, stateData]);

  const draftValid = (() => {
    if (draftFire === "" || draftFire == null) return false;
    const v = Number(draftFire);
    return Number.isInteger(v) && v >= FIRE_DURATION_MIN && v <= FIRE_DURATION_MAX;
  })();

  const handleApplyAll = async () => {
    if (!draftValid) return;
    setBusy(true);
    setError(null);
    try {
      await fetchReceiverConfig(null, { fire_duration_ms: Number(draftFire) });
      setSavedAt(Date.now());
      setDraftFire("");
    } catch (e) {
      setError(
        e?.response?.data?.error || e?.message || "Failed to broadcast rxcfg.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRefreshAll = async () => {
    setBusy(true);
    setError(null);
    try {
      await fetchReceiverConfig(null);
      setSavedAt(Date.now());
    } catch (e) {
      setError(
        e?.response?.data?.error || e?.message || "Failed to broadcast rxcfg.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="text-xs text-fg-muted">
        Settings here are pushed to every connected receiver via the dongle's
        radio. Each receiver also persists its values across reboots, so a
        broadcast only needs to happen when you want to change something.
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
        <Field
          label="Fire pulse width (all receivers)"
          htmlFor="rxcfg_fire_duration"
          hint={
            <>
              Currently reported: <span className="text-fg-secondary">{summary.text}</span>.
              Allowed range {FIRE_DURATION_MIN}–{FIRE_DURATION_MAX} ms (clamped on
              the receiver). Applies to {onlineCount} connected receiver
              {onlineCount === 1 ? "" : "s"}.
            </>
          }
        >
          <div className="relative">
            <input
              id="rxcfg_fire_duration"
              type="number"
              min={FIRE_DURATION_MIN}
              max={FIRE_DURATION_MAX}
              step={10}
              value={draftFire}
              placeholder={
                summary.mode === "uniform" ? String(summary.value) : "e.g. 1000"
              }
              onChange={(e) => setDraftFire(e.target.value)}
              className={inputClass + " num tabular-nums pr-9"}
            />
            <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-2xs text-fg-muted">
              ms
            </span>
          </div>
        </Field>
        <Button
          size="sm"
          variant="primary"
          onClick={handleApplyAll}
          disabled={!draftValid || busy || onlineCount === 0}
          loading={busy}
        >
          Apply to all
        </Button>
      </div>

      <div className="flex items-center gap-3 pt-3 border-t border-border-subtle">
        <div className="text-xs flex-1 min-w-0 truncate">
          {error ? (
            <span className="text-danger-fg">{error}</span>
          ) : savedAt && Date.now() - savedAt < 5000 ? (
            <span className="text-ok-fg">Broadcast queued. Receivers will respond shortly.</span>
          ) : (
            <span className="text-fg-muted">
              Use "Refresh all" to re-query every connected receiver without
              changing any settings.
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleRefreshAll}
          disabled={busy || onlineCount === 0}
        >
          <MdSettingsBackupRestore className="mr-1" />
          Refresh all
        </Button>
      </div>
    </div>
  );
}
