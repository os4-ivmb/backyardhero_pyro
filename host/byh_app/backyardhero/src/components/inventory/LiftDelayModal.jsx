import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { MdRefresh, MdSave } from "react-icons/md";

import useAppStore from "@/store/useAppStore";
import { extractYouTubeVideoId } from "@/util/youtube";
import { Modal, Button, Stat, Field, inputClass, cn } from "@/design";

// Estimates an aerial shell's lift delay (lift -> break) from its YouTube
// video's audio and proposes it. Nothing is saved until the user clicks Save.
// Backed by POST /api/inventory/[id]/estimate-lift-delay
// (pythings/fp_gen/lift_break_timer.py).

const fmtS = (v) => (v == null ? "—" : `${Number(v).toFixed(2)}s`);

export default function LiftDelayModal({ isOpen, item, onClose }) {
  const { updateInventoryItem } = useAppStore();
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [value, setValue] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [startSec, setStartSec] = useState("");
  const [expected, setExpected] = useState("");
  const [sensitivity, setSensitivity] = useState("1");

  const videoId = item ? extractYouTubeVideoId(item.youtube_link) : null;
  const ytAt = (t) =>
    videoId ? `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(t))}s` : null;

  const run = useCallback(async (opts = {}) => {
    if (!item?.id) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const { data } = await axios.post(`/api/inventory/${item.id}/estimate-lift-delay`, opts);
      setResult(data);
      setValue(String(data.proposed));
    } catch (e) {
      setError(e.response?.data?.error || "Analysis failed.");
    } finally {
      setRunning(false);
    }
  }, [item?.id]);

  // Kick off the analysis as soon as the modal opens for an item.
  useEffect(() => {
    if (!isOpen || !item) return;
    setStartSec(item.youtube_link_start_sec ?? "");
    setExpected("");
    setSensitivity("1");
    setShowOptions(false);
    setValue("");
    run();
  }, [isOpen, item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rerun = () => run({
    startSec: startSec === "" ? undefined : Number(startSec),
    expected: expected === "" ? undefined : Number(expected),
    sensitivity: sensitivity === "" ? undefined : Number(sensitivity),
  });

  const numericValue = Number(value);
  const valueOk = value !== "" && Number.isFinite(numericValue) && numericValue >= 0;

  const save = async () => {
    if (!valueOk) return;
    setSaving(true);
    setError(null);
    try {
      // The inventory PATCH is a full-record update, so spread the item.
      await updateInventoryItem(item.id, { ...item, lift_delay: numericValue });
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || "Failed to save lift delay.");
    } finally {
      setSaving(false);
    }
  };

  if (!item) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      eyebrow="Estimate lift delay"
      title={item.name}
      size="lg"
      footerStart={
        <Button size="sm" variant="ghost" leading={<MdRefresh />} onClick={rerun} disabled={running}>
          Re-run
        </Button>
      }
      footer={
        <>
          <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            size="sm" variant="primary" leading={<MdSave />}
            onClick={save} disabled={!valueOk || running} loading={saving}
          >
            Save lift delay
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {running ? (
          <div className="flex items-center gap-3 py-6 text-fg-secondary">
            <span className="inline-block w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            Listening for lifts and breaks… this usually takes 10–30 seconds.
          </div>
        ) : null}

        {error && !running ? (
          <div className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-fg">
            {error}
            <div className="text-xs text-fg-muted mt-1">
              Check the YouTube start time is at (or just before) the first lift, then Re-run.
            </div>
          </div>
        ) : null}

        {result && !running ? (
          <>
            <div className="grid grid-cols-4 gap-3">
              <Stat label="Proposed" value={fmtS(result.proposed)} numeric size="lg" />
              <Stat label="Current" value={fmtS(result.current)} numeric size="lg" />
              <Stat label="Shells paired" value={String(result.pairs.length)} numeric size="lg" />
              <Stat
                label="Spread"
                value={`±${Number(result.stdev).toFixed(2)}s`}
                tone={result.stdev > 0.25 ? "warn" : "neutral"}
                numeric size="lg"
                hint={`${fmtS(result.min)} – ${fmtS(result.max)}`}
              />
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-fg-muted text-2xs uppercase tracking-wider">
                  <th className="py-1 font-semibold">#</th>
                  <th className="py-1 font-semibold text-right">Lift</th>
                  <th className="py-1 font-semibold text-right">Break</th>
                  <th className="py-1 font-semibold text-right">Delay</th>
                </tr>
              </thead>
              <tbody className="num font-mono">
                {result.pairs.map((p, i) => (
                  <tr key={p.lift} className="border-t border-border-subtle">
                    <td className="py-1 text-fg-muted">{i + 1}</td>
                    <td className="py-1 text-right">
                      {ytAt(p.lift) ? (
                        <a href={ytAt(p.lift)} target="_blank" rel="noreferrer"
                           className="hover:text-accent" title="Open the video here">
                          {fmtS(p.lift)}
                        </a>
                      ) : fmtS(p.lift)}
                    </td>
                    <td className="py-1 text-right">{fmtS(p.break)}</td>
                    <td className="py-1 text-right text-fg-primary">{fmtS(p.delay)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {result.unpaired?.length ? (
              <p className="text-xs text-fg-muted">
                Unpaired sounds (a lift hidden under the previous shell, or noise):{" "}
                <span className="num font-mono">{result.unpaired.map(fmtS).join(", ")}</span>
              </p>
            ) : null}

            <Field
              label="Lift delay to save (s)"
              hint="Measured from sound. Breaks are heard slightly late, so the real delay can be up to ~0.2s shorter when filmed close to the rack."
            >
              <input
                type="number" step="0.05" min="0"
                className={cn(inputClass, "max-w-[10rem] num font-mono")}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
          </>
        ) : null}

        {!running ? (
          <div>
            <button
              type="button"
              className="text-xs text-fg-muted hover:text-fg-primary"
              onClick={() => setShowOptions((s) => !s)}
            >
              {showOptions ? "Hide options" : "Options…"}
            </button>
            {showOptions ? (
              <div className="grid grid-cols-3 gap-3 mt-2">
                <Field label="First lift at (s)" hint="Defaults to the item's start time">
                  <input type="number" step="0.1" min="0" className={inputClass}
                         value={startSec} onChange={(e) => setStartSec(e.target.value)} />
                </Field>
                <Field label="Expected delay (s)" hint="Optional starting guess">
                  <input type="number" step="0.1" min="0" className={inputClass} placeholder="auto"
                         value={expected} onChange={(e) => setExpected(e.target.value)} />
                </Field>
                <Field label="Sensitivity" hint=">1 finds quieter sounds">
                  <input type="number" step="0.1" min="0.1" max="10" className={inputClass}
                         value={sensitivity} onChange={(e) => setSensitivity(e.target.value)} />
                </Field>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
