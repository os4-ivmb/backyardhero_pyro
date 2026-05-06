import React, { useEffect, useMemo } from "react";
import useAppStore from "@/store/useAppStore";
import { Field, Toggle, inputClass, Badge } from "@/design";
import useDraft from "@/hooks/useDraft";
import SaveBar from "./SaveBar";

// Per-protocol firing-handler safety knobs. Today there's a single
// protocol (BKYD_TS_HYBRID); when more land they'll fall out of the
// `systemConfig.protocols` map without UI changes.

export default function ProtocolConfig() {
  const { systemConfig, fetchSystemConfig, saveSystemConfig } = useAppStore();

  const protocolKey = useMemo(
    () => (systemConfig?.protocols ? Object.keys(systemConfig.protocols)[0] : "BKYD_TS_HYBRID"),
    [systemConfig?.protocols],
  );
  const protocol = systemConfig?.protocols?.[protocolKey];
  const cfg = protocol?.config || {};

  const upstream = {
    min_battery_to_fire_pct: Number.isFinite(cfg.min_battery_to_fire_pct)
      ? cfg.min_battery_to_fire_pct
      : 30,
    require_continuity: !!cfg.require_continuity,
  };
  const draft = useDraft(upstream);

  useEffect(() => {
    if (!systemConfig || !systemConfig.protocols) {
      fetchSystemConfig();
    }
  }, [fetchSystemConfig, systemConfig]);

  if (!protocol) {
    return (
      <p className="text-sm text-fg-muted">Loading protocol configuration…</p>
    );
  }

  const onSave = () =>
    draft.save(async (s) => {
      const updated = {
        ...systemConfig,
        protocols: {
          ...systemConfig.protocols,
          [protocolKey]: {
            ...systemConfig.protocols[protocolKey],
            config: {
              min_battery_to_fire_pct: parseInt(s.min_battery_to_fire_pct, 10),
              require_continuity: !!s.require_continuity,
            },
          },
        },
      };
      await saveSystemConfig(updated);
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-fg-muted">Protocol</span>
        <Badge tone="neutral">{protocol.label || protocolKey}</Badge>
      </div>

      <Field
        label="Minimum battery to fire"
        htmlFor="min-battery"
        hint="Receivers below this percentage will refuse to fire. Default 30%."
      >
        <div className="relative w-32">
          <input
            id="min-battery"
            type="number"
            min={0}
            max={100}
            value={draft.state.min_battery_to_fire_pct ?? ""}
            onChange={(e) => draft.set("min_battery_to_fire_pct", e.target.value)}
            className={inputClass + " num tabular-nums pr-7"}
          />
          <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-2xs text-fg-muted">
            %
          </span>
        </div>
      </Field>

      <Toggle
        id="require-continuity"
        checked={!!draft.state.require_continuity}
        onChange={(next) => draft.set("require_continuity", next)}
        tone="armed"
        label="Require continuity check"
        description="Only fire cues that report continuity at start time. Off by default."
      />

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
