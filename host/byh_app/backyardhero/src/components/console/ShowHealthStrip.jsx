import React, { useMemo } from "react";
import useAppStore from "@/store/useAppStore";
import useStateAppStore, { serverElapsedMs } from "@/store/useStateAppStore";
import { Card, Stat, cn } from "@/design";
import { isPollableReceiver } from "@/util/receivers";

// 4-metric pre-flight strip. Calm by default — only goes "loud" when a
// metric is failing AND that failure is operationally meaningful (e.g.
// continuity is only loud if the active protocol requires it).
//
// Replaces homepanel/ShowHealth.jsx. The previous version always painted
// every block in a saturated colour (green/amber/red) which created the
// "wall of statuses" effect.
function Metric({ label, current, total, failing }) {
  const ok = current === total && total > 0;
  const tone = total === 0 ? "neutral" : failing ? "danger" : ok ? "ok" : "warn";
  return (
    <div
      className={cn(
        "flex-1 min-w-0 px-3 py-2 rounded-sm border",
        tone === "ok"     && "border-border-subtle bg-surface-1",
        tone === "warn"   && "border-warn/40 bg-warn-bg/30",
        tone === "danger" && "border-danger/50 bg-danger-bg/40",
        tone === "neutral"&& "border-border-subtle bg-surface-1 opacity-70"
      )}
    >
      <div className="eyebrow truncate">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={cn(
          "text-lg font-semibold num font-mono",
          tone === "ok" && "text-fg-primary",
          tone === "warn" && "text-warn-fg",
          tone === "danger" && "text-danger-fg",
          tone === "neutral" && "text-fg-muted"
        )}>{current}</span>
        <span className="text-xs text-fg-muted">/ {total}</span>
      </div>
    </div>
  );
}

export default function ShowHealthStrip() {
  const { stagedShow, systemConfig } = useAppStore();
  const { stateData } = useStateAppStore();

  const metrics = useMemo(() => {
    if (!stagedShow || !stagedShow.items) return null;
    const receivers = stateData.fw_state?.receivers || systemConfig?.receivers || {};
    const protoKey = systemConfig?.protocols ? Object.keys(systemConfig.protocols)[0] : "BKYD_TS_HYBRID";
    const requireContinuity = systemConfig?.protocols?.[protoKey]?.config?.require_continuity || false;
    const showId = stagedShow.id;

    // Build the set of receivers and cues this show actually depends on,
    // but skip any that can't report status back (disabled rows, plus
    // transmit-only types like BILUSOCN_433_TX_ONLY). Including them
    // would peg every metric to "0 of N" forever even when the show is
    // perfectly healthy.
    const showReceivers = new Set();
    const showCues = new Set();

    stagedShow.items.forEach((item) => {
      if (!item.zone || !item.target) return;
      Object.entries(receivers).forEach(([k, r]) => {
        if (!isPollableReceiver(r)) return;
        if (r.cues && r.cues[item.zone] && r.cues[item.zone].includes(item.target)) {
          showReceivers.add(k);
          showCues.add(`${item.zone}:${item.target}`);
        }
      });
    });

    let connected = 0;
    showReceivers.forEach((k) => {
      const r = receivers[k];
      if (!r) return;
      const lmt = r.status?.lmt;
      const ok = lmt ? serverElapsedMs(lmt, stateData) <= 10_000 : r.connectionStatus === "good";
      if (ok) connected++;
    });

    let cuesOk = 0;
    showCues.forEach((cue) => {
      const [zone, target] = cue.split(":");
      const tgt = parseInt(target);
      Object.entries(receivers).forEach(([_, r]) => {
        if (!isPollableReceiver(r)) return;
        if (!r.cues?.[zone]?.includes(tgt)) return;
        const cont = r.status?.continuity;
        if (!Array.isArray(cont) || cont.length !== 2) return;
        const bit = tgt - 1;
        const block = Math.floor(bit / 64);
        const pos = bit % 64;
        try {
          const big = typeof cont[block] === "bigint" ? cont[block] : BigInt(cont[block]);
          if ((big & (BigInt(1) << BigInt(pos))) !== BigInt(0)) cuesOk++;
        } catch { /* ignore */ }
      });
    });

    let loaded = 0;
    showReceivers.forEach((k) => {
      const r = receivers[k];
      if (r?.status?.showId === showId && r.status.loadComplete) loaded++;
    });

    let ready = 0;
    showReceivers.forEach((k) => {
      const r = receivers[k];
      if (r?.status?.startReady) ready++;
    });

    return {
      receiversConnected: { current: connected, total: showReceivers.size, failing: false },
      cuesConnected: {
        current: cuesOk,
        total: showCues.size,
        failing: requireContinuity && cuesOk !== showCues.size,
      },
      receiversLoaded: { current: loaded, total: showReceivers.size, failing: false },
      receiversReady: { current: ready, total: showReceivers.size, failing: false },
    };
  }, [stagedShow, stateData.fw_state?.receivers, systemConfig]);

  if (!metrics) return null;

  return (
    <div className="flex items-stretch gap-2">
      <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-2">
        <Metric label="Receivers connected" {...metrics.receiversConnected} />
        <Metric label="Cues continuity" {...metrics.cuesConnected} />
        <Metric label="Receivers loaded" {...metrics.receiversLoaded} />
        <Metric label="Receivers ready" {...metrics.receiversReady} />
      </div>
    </div>
  );
}
