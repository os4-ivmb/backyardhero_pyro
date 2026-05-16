import React, { useEffect, useMemo, useState } from "react";
import {
  MdBatteryFull, MdBatteryAlert, MdBatteryUnknown,
  MdSignalWifi4Bar, MdSignalWifiOff,
  MdRefresh, MdAssignment, MdSettingsBackupRestore,
} from "react-icons/md";
import { FaCircleQuestion, FaTriangleExclamation } from "react-icons/fa6";

import useAppStore from "@/store/useAppStore";
import useStateAppStore from "@/store/useStateAppStore";
import { Card, Button, Badge, Section, cn } from "@/design";
import { isPollableReceiver } from "@/util/receivers";
import { SHOW_RECEIVER_STATUS } from "@/util/showReceivers";
import useShowReceiverVerification from "@/util/useShowReceiverVerification";

// ---------------------------------------------------------------------------
// MobileReceiverDisplay -- mobile layout of the receivers admin page.
//
// The desktop ReceiverDisplay packs ~12 affordances per card (label, battery,
// FW, board, fire-ms, retry, fetch-cfg, two cue editors, force-zones, ...)
// because the desktop page also doubles as the configuration surface.
// On mobile we strip the page back to the day-of operating signals an
// operator actually consults from the field:
//
//   * Per-receiver freshness + battery + cue-continuity grid (read-only).
//   * Tap "Retry" to re-register a pruned unit with the dongle.
//   * Tap "Fetch cfg" to refresh receiver-reported config.
//   * Show-verification banner with the same wording as the desktop one.
//
// Edit mode (label / cue-count / force-zones / add-receiver) is desk
// work; not duplicated here.
// ---------------------------------------------------------------------------

const FRESHNESS_OK_MS = 4000;
const FRESHNESS_WARN_MS = 8000;

const TONE_TEXT = {
  ok: "text-ok-fg",
  warn: "text-warn-fg",
  danger: "text-danger-fg",
};

const TONE_BG = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
};

function freshnessTone(freshnessMs) {
  if (freshnessMs == null || !Number.isFinite(freshnessMs)) return "danger";
  if (freshnessMs <= FRESHNESS_OK_MS) return "ok";
  if (freshnessMs <= FRESHNESS_WARN_MS) return "warn";
  return "danger";
}

function MobileReceiverCard({
  rcvName,
  receiver,
  receiverLabel,
  showMapping,
  onRetry,
  retryBusy,
  onFetchConfig,
  fetchConfigBusy,
  insufficient,
}) {
  const isEnabled = receiver.enabled !== false;

  let batteryLevel;
  if (receiver.status?.battery != null) {
    batteryLevel = Math.floor((receiver.status.battery / 256) * 100);
  } else {
    batteryLevel = receiver.battery ?? null;
  }

  let freshness = null;
  let isOnline = false;
  if (receiver.status?.lmt) {
    freshness = Date.now() - receiver.status.lmt;
    isOnline = freshness <= 10_000;
  } else {
    isOnline = receiver.connectionStatus === "good";
  }
  const tone = freshnessTone(freshness);

  const BatteryIcon = batteryLevel == null ? MdBatteryUnknown
    : batteryLevel > 20 ? MdBatteryFull
    : MdBatteryAlert;
  const batteryClass = batteryLevel == null ? "text-fg-muted"
    : batteryLevel > 20 ? "text-ok" : "text-danger";

  const firstZone = Object.keys(receiver.cues || {})[0];
  const cues = (firstZone && receiver.cues?.[firstZone]) || [];
  const isBilusocn = receiver.type === "BILUSOCN_433_TX_ONLY";

  // Continuity bits, mirrored from the desktop card -- BigInt-decoded
  // out of the two 64-bit blocks the daemon publishes.
  const continuityBits = useMemo(() => {
    const cont = receiver.status?.continuity;
    if (!Array.isArray(cont) || cont.length !== 2) return null;
    return cont;
  }, [receiver.status?.continuity]);

  const cueHasContinuity = (idx) => {
    if (!continuityBits) return null;
    try {
      const block = Math.floor(idx / 64);
      const pos = idx % 64;
      const big = typeof continuityBits[block] === "bigint"
        ? continuityBits[block]
        : BigInt(continuityBits[block]);
      return (big & (BigInt(1) << BigInt(pos))) !== BigInt(0);
    } catch { return null; }
  };

  const successPercent = receiver.status?.successPercent ?? null;
  const healthPercent = successPercent != null
    ? Math.max(0, Math.min(100, successPercent))
    : null;

  return (
    <Card
      padding="md"
      tone="raised"
      className={cn(
        "flex flex-col gap-3",
        !isEnabled && "opacity-60",
        insufficient && "border-danger/60 ring-1 ring-danger/40"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {isOnline ? (
              <MdSignalWifi4Bar className={cn("text-base", TONE_TEXT[tone])} aria-hidden />
            ) : (
              <MdSignalWifiOff className="text-base text-danger" aria-hidden />
            )}
            <h3 className="text-base font-semibold text-fg-primary truncate">
              {receiverLabel || rcvName}
            </h3>
            {receiverLabel && receiverLabel !== rcvName ? (
              <span className="text-fg-muted text-xs truncate">({rcvName})</span>
            ) : null}
          </div>
          {!isEnabled ? (
            <div className="mt-1">
              <Badge tone="neutral" size="sm">Disabled</Badge>
            </div>
          ) : null}
          {insufficient ? (
            <div className="mt-1 text-2xs text-danger-fg">
              Show needs more cues than this receiver has
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <BatteryIcon className={cn("text-lg", batteryClass)} aria-hidden />
          <span className="text-xs text-fg-muted num">
            {batteryLevel != null ? `${batteryLevel}%` : "—"}
          </span>
        </div>
      </div>

      {/* Action row: retry + fetch cfg. Hidden for one-way Bilusocn modules. */}
      {isEnabled && !isBilusocn ? (
        <div className="flex items-center gap-2">
          {onFetchConfig ? (
            <Button
              size="sm"
              variant="outline"
              leading={
                <MdSettingsBackupRestore
                  className={fetchConfigBusy ? "animate-spin" : ""}
                />
              }
              disabled={fetchConfigBusy || !isOnline}
              onClick={() => onFetchConfig(rcvName)}
              className="flex-1"
            >
              Fetch cfg
            </Button>
          ) : null}
          {onRetry ? (
            <Button
              size="sm"
              variant="outline"
              leading={<MdRefresh className={retryBusy ? "animate-spin" : ""} />}
              disabled={retryBusy}
              onClick={() => onRetry(rcvName)}
              className="flex-1"
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Cue grid -- 5 wide on mobile (matches desktop) so it's still
          easy to spot a bad block of 8. */}
      {cues.length > 0 ? (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="eyebrow">
              {isBilusocn && firstZone
                ? `Zone ${firstZone}`
                : "Cues"}
            </span>
            <span className="text-2xs text-fg-muted num">
              {cues.length} cue{cues.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {cues.map((target, idx) => {
              const item = showMapping?.[firstZone]?.[target];
              const continuityActive = cueHasContinuity(idx);
              const bg = continuityActive
                ? "bg-ok-bg border-ok/60 text-ok-fg"
                : continuityActive === false
                ? "bg-danger-bg/70 border-danger/40 text-danger-fg"
                : "bg-surface-1 border-border-subtle text-fg-muted";
              const ring = item ? "ring-2 ring-accent/70" : "";
              return (
                <div
                  key={`${target}-${idx}`}
                  className={cn(
                    "h-9 rounded-sm border flex items-center justify-center",
                    "text-xs font-mono num",
                    bg,
                    ring
                  )}
                  title={item ? `Cue ${target} -- ${item.name || "assigned"}` : `Cue ${target}`}
                >
                  {target}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {healthPercent !== null ? (
        <div>
          <div className="flex items-center justify-between mb-0.5">
            <span className="eyebrow">Success rate</span>
            <span className="text-2xs text-fg-muted num">{healthPercent}%</span>
          </div>
          <div className="w-full h-1 rounded-full bg-surface-3 overflow-hidden">
            <div
              className="h-full transition-all duration-300 ease-out"
              style={{
                width: `${healthPercent}%`,
                backgroundColor:
                  healthPercent >= 50
                    ? `rgba(${Math.floor(225 * (1 - (healthPercent - 50) / 50))}, 225, 0, 0.85)`
                    : `rgba(225, ${Math.floor(225 * (healthPercent / 50))}, 0, 0.85)`,
              }}
            />
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function ErrorReceiverCard({ entry, kind }) {
  const Icon = kind === SHOW_RECEIVER_STATUS.MISSING ? FaCircleQuestion : FaTriangleExclamation;
  const title = entry.label ? `${entry.label} (${entry.id})` : entry.id;
  const message = kind === SHOW_RECEIVER_STATUS.MISSING ? "Not on this system." : "Disabled.";
  const hint = kind === SHOW_RECEIVER_STATUS.MISSING
    ? "Add it on the Receivers page (or remove it from the show)."
    : "Re-enable it to load this show.";
  return (
    <Card padding="md" tone="danger" className="flex items-start gap-3">
      <Icon className="text-2xl text-danger shrink-0 mt-0.5" aria-hidden />
      <div className="min-w-0">
        <div className="font-semibold text-danger-fg">{title}</div>
        <div className="text-sm text-danger-fg/90 mt-0.5">{message}</div>
        <div className="text-xs text-fg-muted mt-1">{hint}</div>
        <div className="text-2xs text-fg-muted mt-1 num">
          Show expects {entry.cues} cue{entry.cues === 1 ? "" : "s"}.
        </div>
      </div>
    </Card>
  );
}

export default function MobileReceiverDisplay({ setCurrentTab }) {
  const {
    stagedShow, systemConfig,
    receivers: dbReceivers, fetchReceivers,
    retryReceiver, fetchReceiverConfig,
  } = useAppStore();
  const { stateData } = useStateAppStore();
  const verification = useShowReceiverVerification();

  const [receiverLabels, setReceiverLabels] = useState({});
  const [retryBusy, setRetryBusy] = useState({});
  const [fetchConfigBusy, setFetchConfigBusy] = useState({});

  useEffect(() => {
    fetchReceivers().catch(() => {});
  }, [fetchReceivers]);

  useEffect(() => {
    if (stagedShow?.receiverLabels) {
      setReceiverLabels(stagedShow.receiverLabels);
    } else if (stagedShow?.receiver_labels) {
      try { setReceiverLabels(JSON.parse(stagedShow.receiver_labels)); }
      catch { setReceiverLabels({}); }
    } else {
      setReceiverLabels({});
    }
  }, [stagedShow]);

  const receivers = useMemo(() => {
    const live = stateData.fw_state?.receivers || {};
    const out = {};
    for (const id of Object.keys(dbReceivers || {})) {
      const def = dbReceivers[id];
      const liveRow = live[id] || {};
      out[id] = {
        ...def,
        status: liveRow.status,
        drift: liveRow.drift,
        cues: def.cues,
        enabled: def.enabled,
      };
    }
    // Fall through to systemConfig receivers if there's nothing in the DB
    // (e.g. fresh install / dev). Keeps the UI populated rather than
    // showing a blank page.
    if (Object.keys(out).length === 0) {
      const fallback = systemConfig?.receivers || {};
      for (const id of Object.keys(fallback)) {
        out[id] = { ...fallback[id], status: live[id]?.status, drift: live[id]?.drift };
      }
    }
    return out;
  }, [dbReceivers, stateData.fw_state?.receivers, systemConfig?.receivers]);

  const [targetRcvMap, setTargetRcvMap] = useState({});
  useEffect(() => {
    const lookup = {};
    Object.keys(receivers).forEach((rcvKey) => {
      const r = receivers[rcvKey];
      if (!r?.cues) return;
      Object.keys(r.cues).forEach((zoneKey) => {
        r.cues[zoneKey].forEach((target) => {
          lookup[`${zoneKey}:${target}`] = rcvKey;
        });
      });
    });
    if (stagedShow?.items) {
      const map = {};
      stagedShow.items.forEach((payloadItem) => {
        const { zone, target } = payloadItem;
        const rcvKey = lookup[`${zone}:${target}`];
        if (rcvKey) {
          if (!map[rcvKey]) map[rcvKey] = {};
          if (!map[rcvKey][zone]) map[rcvKey][zone] = {};
          map[rcvKey][zone][target] = payloadItem;
        }
      });
      setTargetRcvMap(map);
    } else {
      setTargetRcvMap({});
    }
  }, [receivers, stagedShow]);

  const handleRetry = async (id) => {
    setRetryBusy((p) => ({ ...p, [id]: true }));
    try { await retryReceiver(id); }
    finally {
      setTimeout(() => {
        setRetryBusy((p) => { const n = { ...p }; delete n[id]; return n; });
      }, 800);
    }
  };

  const handleFetchConfig = async (id) => {
    setFetchConfigBusy((p) => ({ ...p, [id]: true }));
    try {
      await fetchReceiverConfig(id);
      setTimeout(() => fetchReceivers().catch(() => {}), 1500);
    } finally {
      setTimeout(() => {
        setFetchConfigBusy((p) => { const n = { ...p }; delete n[id]; return n; });
      }, 1500);
    }
  };

  // Aggregated freshness segments, same idea as the desktop top strip.
  const segments = useMemo(() => {
    return Object.entries(receivers)
      .filter(([_, r]) => isPollableReceiver(r))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ident, receiver]) => {
        const lmt = receiver?.status?.lmt;
        const fresh = typeof lmt === "number" ? Date.now() - lmt : null;
        return { ident, tone: freshnessTone(fresh) };
      });
  }, [receivers]);

  const unusedReceivers = useMemo(() => {
    if (!verification.hasStagedShow) return [];
    const referenced = new Set(verification.results.map((r) => r.entry.id));
    return Object.keys(receivers).filter((k) =>
      !referenced.has(k)
      && receivers[k]?.enabled !== false
      && isPollableReceiver(receivers[k])
    );
  }, [verification, receivers]);

  return (
    <div className="w-full px-3 py-3 space-y-3">
      {/* Sticky freshness strip */}
      {segments.length > 0 ? (
        <div className="sticky top-0 -mx-3 px-3 py-2 bg-surface-base/95 backdrop-blur z-10 border-b border-border-subtle">
          <div className="text-2xs text-fg-muted mb-1">Freshness</div>
          <div className="flex w-full h-1.5 gap-0.5 rounded-full overflow-hidden bg-surface-2">
            {segments.map((seg) => (
              <div
                key={seg.ident}
                className={cn("flex-1", TONE_BG[seg.tone])}
                title={`${seg.ident}: ${seg.tone}`}
              />
            ))}
          </div>
        </div>
      ) : null}

      <Section title="Receivers">
        {verification.hasStagedShow && stagedShow ? (
          <Button
            size="md"
            variant="primary"
            leading={<MdAssignment />}
            className="w-full"
            onClick={() => setCurrentTab?.("loadout")}
          >
            View show loadout
          </Button>
        ) : null}

        {/* Show-verification: render whichever shape each entry is in. */}
        {verification.hasStagedShow ? (
          <div className="flex flex-col gap-3 mt-2">
            {verification.results.map((r, i) => {
              const id = r.entry.id;
              if (
                r.status === SHOW_RECEIVER_STATUS.MISSING ||
                r.status === SHOW_RECEIVER_STATUS.DISABLED
              ) {
                return (
                  <ErrorReceiverCard
                    key={`err-${id}-${i}`}
                    entry={r.entry}
                    kind={r.status}
                  />
                );
              }
              return (
                <MobileReceiverCard
                  key={`ok-${id}-${i}`}
                  rcvName={id}
                  receiver={receivers[id]}
                  receiverLabel={r.entry.label || receiverLabels[id]}
                  showMapping={targetRcvMap[id]}
                  onRetry={handleRetry}
                  retryBusy={!!retryBusy[id]}
                  onFetchConfig={handleFetchConfig}
                  fetchConfigBusy={!!fetchConfigBusy[id]}
                  insufficient={r.status === SHOW_RECEIVER_STATUS.INSUFFICIENT}
                />
              );
            })}
          </div>
        ) : null}

        {!verification.hasStagedShow ? (
          <div className="flex flex-col gap-3 mt-2">
            {Object.keys(receivers).map((rcvKey) => (
              <MobileReceiverCard
                key={rcvKey}
                rcvName={rcvKey}
                receiver={receivers[rcvKey]}
                receiverLabel={receiverLabels[rcvKey]}
                showMapping={targetRcvMap[rcvKey]}
                onRetry={handleRetry}
                retryBusy={!!retryBusy[rcvKey]}
                onFetchConfig={handleFetchConfig}
                fetchConfigBusy={!!fetchConfigBusy[rcvKey]}
              />
            ))}
            {Object.keys(receivers).length === 0 ? (
              <Card padding="lg" tone="neutral" className="text-center">
                <p className="text-fg-muted text-sm">
                  No receivers registered yet. Add them on a tablet or laptop.
                </p>
              </Card>
            ) : null}
          </div>
        ) : null}
      </Section>

      {/* Unused (DB receivers not referenced by the show). Collapsed by
          default; in mobile we just label them. */}
      {verification.hasStagedShow && unusedReceivers.length > 0 ? (
        <Section title={`Unused (${unusedReceivers.length})`}>
          <div className="flex flex-col gap-3">
            {unusedReceivers.map((rcvKey) => (
              <MobileReceiverCard
                key={rcvKey}
                rcvName={rcvKey}
                receiver={receivers[rcvKey]}
                receiverLabel={receiverLabels[rcvKey]}
                showMapping={targetRcvMap[rcvKey]}
                onRetry={handleRetry}
                retryBusy={!!retryBusy[rcvKey]}
                onFetchConfig={handleFetchConfig}
                fetchConfigBusy={!!fetchConfigBusy[rcvKey]}
              />
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
