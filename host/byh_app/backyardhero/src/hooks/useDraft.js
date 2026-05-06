import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Generic draft / save bookkeeping for settings panels.
//
// Most settings cards have the same lifecycle: read N values from
// `stateData.fw_state.settings.*`, let the operator edit a draft locally,
// surface a single "Save" button + status indicator, and roll back to the
// upstream snapshot on demand. This hook removes that boilerplate.
//
// Usage:
//   const draft = useDraft({ timeout: settings.timeout, debug: settings.debug });
//   <input value={draft.state.timeout} onChange={(e) => draft.set("timeout", e.target.value)} />
//   <button onClick={() => draft.save(async (state) => { ... })} disabled={!draft.dirty} />
//
// Hydration model: as long as the user is *not* currently dirty, we
// rebase the draft and baseline whenever `upstream` changes. The moment
// they edit, we hold their draft in place until they save (which rebases
// to the just-committed values) or call reset() (which rebases to the
// current upstream). This prevents the daemon's WS pushes from yanking
// values out from under an in-flight edit, while still surfacing fresh
// values immediately on first load.

export default function useDraft(upstream) {
  const [baseline, setBaseline] = useState(upstream);
  const [state, setState] = useState(upstream);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  const baselineSig = useMemo(() => JSON.stringify(baseline), [baseline]);
  const stateSig = useMemo(() => JSON.stringify(state), [state]);
  const upstreamSig = useMemo(() => JSON.stringify(upstream), [upstream]);

  const dirty = baselineSig !== stateSig;

  // Pull `dirty` through a ref so the effect below doesn't need it as a
  // dependency (otherwise we'd re-run on every keystroke).
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Whenever the upstream changes, rebase the draft -- *unless* the user
  // is currently editing. This means values reload after WS pushes /
  // navigation, but never clobber an in-flight edit.
  useEffect(() => {
    if (dirtyRef.current) return;
    setBaseline(upstream);
    setState(upstream);
    // We deliberately depend on the stringified upstream so referentially
    // unequal objects with the same fields don't trigger a needless rebase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upstreamSig]);

  const set = useCallback((keyOrPatch, maybeValue) => {
    setState((prev) => {
      if (typeof keyOrPatch === "object" && keyOrPatch !== null) {
        return { ...prev, ...keyOrPatch };
      }
      return { ...prev, [keyOrPatch]: maybeValue };
    });
    // Drop a stale error the moment the user resumes editing.
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setState(upstream);
    setBaseline(upstream);
    setError(null);
  }, [upstream]);

  const save = useCallback(async (committer) => {
    if (typeof committer !== "function") return;
    setSaving(true);
    setError(null);
    try {
      // Snapshot the values we're about to commit so we can rebase the
      // baseline on success even if `state` mutates during the await.
      const snapshot = state;
      await committer(snapshot);
      setBaseline(snapshot);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }, [state]);

  return {
    state,
    set,
    reset,
    save,
    dirty,
    saving,
    error,
    savedAt,
  };
}
