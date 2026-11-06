// Per-show configuration that isn't part of the cue list itself, persisted as
// the `show_config` JSON column:
//
//   {
//     showType: 'timeline' | 'manual_sequence',
//     fireKey:  { code, key, label } | null,   // manual_sequence only
//     steps:    [{ id, fireMode, intervalMs }], // manual_sequence only, in order
//   }
//
// Shows saved before this column existed have it NULL and are timeline shows.
// In a manual-sequence show every cue carries a `stepId` pointing at one of
// `steps`; the console fires a step's cues via manual fire, so the cues'
// `startTime` is irrelevant there. A step's `fireMode` is either
// simultaneous (all cues at once) or staggered (cues in list order, i.e. their
// order in the show's items array, `intervalMs` apart).

export const SHOW_TYPE_TIMELINE = 'timeline';
export const SHOW_TYPE_MANUAL_SEQUENCE = 'manual_sequence';

export const SHOW_TYPE_OPTIONS = [
  { value: SHOW_TYPE_TIMELINE, label: 'Timeline show' },
  { value: SHOW_TYPE_MANUAL_SEQUENCE, label: 'Manual sequence' },
];

export const STEP_FIRE_SIMULTANEOUS = 'simultaneous';
export const STEP_FIRE_STAGGERED = 'staggered';
export const DEFAULT_STEP_INTERVAL_MS = 100;
export const MAX_STEP_INTERVAL_MS = 60_000;

export function clampStepInterval(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_STEP_INTERVAL_MS;
  return Math.min(n, MAX_STEP_INTERVAL_MS);
}

export function normalizeStep(s) {
  return {
    id: String(s.id),
    fireMode: s.fireMode === STEP_FIRE_STAGGERED ? STEP_FIRE_STAGGERED : STEP_FIRE_SIMULTANEOUS,
    intervalMs: clampStepInterval(s.intervalMs ?? DEFAULT_STEP_INTERVAL_MS),
  };
}

export function normalizeShowConfig(raw) {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const showType = cfg.showType === SHOW_TYPE_MANUAL_SEQUENCE
    ? SHOW_TYPE_MANUAL_SEQUENCE
    : SHOW_TYPE_TIMELINE;
  const fireKey = cfg.fireKey && typeof cfg.fireKey === 'object' && (cfg.fireKey.code || cfg.fireKey.key)
    ? {
        code: cfg.fireKey.code || '',
        key: cfg.fireKey.key || '',
        label: cfg.fireKey.label || cfg.fireKey.key || cfg.fireKey.code,
      }
    : null;
  const steps = Array.isArray(cfg.steps)
    ? cfg.steps.filter((s) => s && s.id != null).map(normalizeStep)
    : [];
  return { showType, fireKey, steps };
}

export function parseShowConfig(json) {
  if (!json) return normalizeShowConfig(null);
  if (typeof json === 'object') return normalizeShowConfig(json);
  try {
    return normalizeShowConfig(JSON.parse(json));
  } catch {
    return normalizeShowConfig(null);
  }
}

// Accepts a staged show / show row and reads either the hydrated
// `showConfig` or the raw `show_config` column.
export function showConfigOf(show) {
  if (!show) return normalizeShowConfig(null);
  if (show.showConfig) return normalizeShowConfig(show.showConfig);
  return parseShowConfig(show.show_config);
}

export function isManualSequenceShow(show) {
  return showConfigOf(show).showType === SHOW_TYPE_MANUAL_SEQUENCE;
}

export function newStepId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// Ordered [{ id, number, fireMode, intervalMs, items }] for the configured
// steps; each step's items keep their order in `items`. Cues whose stepId
// doesn't match a step are ignored (they can't be fired).
export function groupItemsIntoSteps(steps, items) {
  const byStep = new Map((steps || []).map((s) => [String(s.id), []]));
  for (const it of items || []) {
    if (it?.stepId == null) continue;
    const bucket = byStep.get(String(it.stepId));
    if (bucket) bucket.push(it);
  }
  return (steps || []).map((s, i) => ({
    ...normalizeStep(s),
    number: i + 1,
    items: byStep.get(String(s.id)) || [],
  }));
}

// Converting an existing timeline show: cues that fire at the same instant
// (startTime - delay) become one step, in firing order.
export function stepsFromTimelineItems(items) {
  const list = items || [];
  const groups = new Map();
  list.forEach((it, index) => {
    const fireAt = Math.round(((Number(it.startTime) || 0) - (Number(it.delay) || 0)) * 1000);
    if (!groups.has(fireAt)) groups.set(fireAt, []);
    groups.get(fireAt).push(index);
  });
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  const steps = [];
  const stepIdByIndex = [];
  for (const [, indexes] of ordered) {
    const id = newStepId();
    steps.push(normalizeStep({ id }));
    indexes.forEach((i) => { stepIdByIndex[i] = id; });
  }
  return {
    steps,
    items: list.map((it, i) => ({ ...it, stepId: stepIdByIndex[i] })),
  };
}

// Makes every cue belong to a listed step so none are hidden: unknown stepIds
// get appended as steps, and cues with no stepId are grouped by fire time into
// new trailing steps. `changed` is false when the input was already consistent.
export function reconcileSequence(steps, items) {
  const outSteps = (steps || []).map(normalizeStep);
  const known = new Set(outSteps.map((s) => s.id));
  const list = items || [];
  let changed = false;

  for (const it of list) {
    if (it?.stepId == null) continue;
    const id = String(it.stepId);
    if (!known.has(id)) {
      known.add(id);
      outSteps.push(normalizeStep({ id }));
      changed = true;
    }
  }

  const unassignedIdx = [];
  list.forEach((it, i) => { if (it?.stepId == null) unassignedIdx.push(i); });
  if (unassignedIdx.length === 0) return { steps: outSteps, items: list, changed };

  const converted = stepsFromTimelineItems(unassignedIdx.map((i) => list[i]));
  const outItems = list.slice();
  unassignedIdx.forEach((i, k) => { outItems[i] = converted.items[k]; });
  return { steps: [...outSteps, ...converted.steps], items: outItems, changed: true };
}

// ---- Fire key ---------------------------------------------------------------

// Keys we refuse as a fire key: Escape cancels capture, and the arrows are
// the console's jog controls.
export const RESERVED_FIRE_KEYS = new Set(['Escape', 'ArrowLeft', 'ArrowRight', 'Tab']);

export function fireKeyFromEvent(e) {
  const key = e.key || '';
  const code = e.code || '';
  return { code, key, label: describeKey(key, code) };
}

export function describeKey(key, code) {
  if (key === ' ' || code === 'Space') return 'Space';
  if (key && key.length === 1) return key.toUpperCase();
  return key || code || 'Unknown';
}

// Match on the physical key when we have one so the binding survives layout /
// shift-state changes; fall back to the logical key for devices (clickers,
// pedals) that don't report a `code`.
export function eventMatchesFireKey(e, fireKey) {
  if (!fireKey) return false;
  if (fireKey.code && e.code) return e.code === fireKey.code;
  return !!fireKey.key && e.key === fireKey.key;
}
