// Per-show configuration that isn't part of the cue list itself, persisted as
// the `show_config` JSON column:
//
//   {
//     showType: 'timeline' | 'manual_sequence',
//     fireKey:  { code, key, label } | null,   // manual_sequence only
//     steps:    [{ id }],                      // manual_sequence only, in order
//   }
//
// Shows saved before this column existed have it NULL and are timeline shows.
// In a manual-sequence show every cue carries a `stepId` pointing at one of
// `steps`; the console fires a step's cues together via manual fire, so the
// cues' `startTime` is irrelevant there.

export const SHOW_TYPE_TIMELINE = 'timeline';
export const SHOW_TYPE_MANUAL_SEQUENCE = 'manual_sequence';

export const SHOW_TYPE_OPTIONS = [
  { value: SHOW_TYPE_TIMELINE, label: 'Timeline show' },
  { value: SHOW_TYPE_MANUAL_SEQUENCE, label: 'Manual sequence' },
];

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
    ? cfg.steps.filter((s) => s && s.id != null).map((s) => ({ id: String(s.id) }))
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

// Ordered [{ id, number, items }] for the configured steps. Cues whose
// stepId doesn't match a step are ignored (they can't be fired).
export function groupItemsIntoSteps(steps, items) {
  const byStep = new Map((steps || []).map((s) => [String(s.id), []]));
  for (const it of items || []) {
    if (it?.stepId == null) continue;
    const bucket = byStep.get(String(it.stepId));
    if (bucket) bucket.push(it);
  }
  return (steps || []).map((s, i) => ({
    id: String(s.id),
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
    steps.push({ id });
    indexes.forEach((i) => { stepIdByIndex[i] = id; });
  }
  return {
    steps,
    items: list.map((it, i) => ({ ...it, stepId: stepIdByIndex[i] })),
  };
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
