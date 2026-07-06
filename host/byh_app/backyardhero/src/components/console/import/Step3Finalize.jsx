import React, { useMemo } from "react";
import { Field, inputClass, selectClass } from "@/design";

const fmtDuration = (s) => {
  if (!s || !Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.round(s) % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
};

// Step 3: name the show, set its auth code + protocol, and review a summary
// before the final save.
export default function Step3Finalize({
  conversion,
  name,
  onNameChange,
  authCode,
  onAuthCodeChange,
  protocol,
  onProtocolChange,
  protocols,
  saveError,
}) {
  const summary = useMemo(() => {
    const cues = conversion?.cues || [];
    const duration = cues.length
      ? Math.round(
          Math.max(...cues.map((c) => (c.startTime || 0) + (c.duration || 0))),
        )
      : 0;
    return {
      cues: cues.length,
      receivers: conversion?.receivers?.length || 0,
      duration,
    };
  }, [conversion]);

  const protocolKeys = protocols || [];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-2">
        <SummaryCell label="Cues" value={summary.cues} />
        <SummaryCell label="Receivers" value={summary.receivers} />
        <SummaryCell label="Duration" value={fmtDuration(summary.duration)} />
      </div>

      <Field label="Show name">
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className={inputClass}
          placeholder="Imported show"
          autoFocus
        />
      </Field>

      <Field label="Auth code" hint="Used to edit and launch this show.">
        <input
          type="password"
          value={authCode}
          onChange={(e) => onAuthCodeChange(e.target.value)}
          className={inputClass}
          placeholder="Enter an auth code"
          autoComplete="new-password"
        />
      </Field>

      <Field label="Protocol">
        {protocolKeys.length > 0 ? (
          <select
            value={protocol || ""}
            onChange={(e) => onProtocolChange(e.target.value)}
            className={selectClass}
          >
            {protocolKeys.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={protocol || ""}
            onChange={(e) => onProtocolChange(e.target.value)}
            className={inputClass}
            placeholder="Protocol"
          />
        )}
      </Field>

      {saveError ? (
        <div className="rounded-sm border border-danger/40 bg-danger-bg/60 px-3 py-2 text-xs text-danger-fg">
          {saveError}
        </div>
      ) : null}
    </div>
  );
}

function SummaryCell({ label, value }) {
  return (
    <div className="rounded-sm bg-surface-1 border border-border-subtle px-2 py-1.5">
      <div className="text-2xs text-fg-muted">{label}</div>
      <div className="num text-sm text-fg-primary leading-none mt-0.5 tabular-nums">
        {value}
      </div>
    </div>
  );
}
