const CAKE_TYPES = new Set([
  "CAKE_FOUNTAIN",
  "CAKE_200G",
  "CAKE_350G",
  "CAKE_500G",
  "COMPOUND_CAKE",
]);

const GRID_CANDIDATES = [
  { key: "downbeats", label: "Downbeats", divisor: 1, measureOnly: true, simplicity: 1 },
  { key: "beats", label: "Beats", divisor: 1, measureOnly: false, simplicity: 0.92 },
  { key: "half", label: "1/2 beat", divisor: 2, measureOnly: false, simplicity: 0.82 },
  { key: "quarter", label: "1/4 beat", divisor: 4, measureOnly: false, simplicity: 0.68 },
];

const BPM_RELATIONS = [
  { key: "exact", label: "exact", factor: 1, bonus: 1 },
  { key: "half", label: "half-time", factor: 0.5, bonus: 0.95 },
  { key: "double", label: "double-time", factor: 2, bonus: 0.9 },
];

function normalizeShots(shotTimestamps) {
  if (!Array.isArray(shotTimestamps)) return [];
  const starts = shotTimestamps
    .map((shot) => Array.isArray(shot) ? Number(shot[0]) : null)
    .filter((start) => Number.isFinite(start) && start >= 0)
    .sort((a, b) => a - b);
  if (starts.length < 2) return [];
  const first = starts[0];
  return starts.map((start) => (start - first) / 1000);
}

function circularDistance(value, period) {
  if (!Number.isFinite(value) || !Number.isFinite(period) || period <= 0) return Infinity;
  const mod = ((value % period) + period) % period;
  return Math.min(mod, period - mod);
}

function uniquePhases(startsSec, gridSec) {
  const phases = new Set(["0.0000"]);
  startsSec.forEach((start) => {
    const mod = ((start % gridSec) + gridSec) % gridSec;
    phases.add(mod.toFixed(4));
  });
  return [...phases].map(Number);
}

function scoreGrid(startsSec, { bpm, baseSongBpm, beatsPerMeasure, relation, grid }) {
  const beatSec = 60 / bpm;
  const gridSec = grid.measureOnly
    ? beatSec * beatsPerMeasure
    : beatSec / grid.divisor;
  if (!Number.isFinite(gridSec) || gridSec <= 0) return null;

  let best = null;
  const toleranceSec = Math.min(0.16, Math.max(0.055, gridSec * 0.22));
  const hitToleranceSec = Math.min(0.1, toleranceSec);

  uniquePhases(startsSec, gridSec).forEach((phase) => {
    const distances = startsSec.map((start) => circularDistance(start - phase, gridSec));
    const hits = distances.filter((distance) => distance <= hitToleranceSec).length;
    const avgErrorSec = distances.reduce((sum, distance) => sum + distance, 0) / distances.length;
    const closeness = distances.reduce(
      (sum, distance) => sum + Math.max(0, 1 - distance / toleranceSec),
      0
    ) / distances.length;
    const hitRate = hits / distances.length;
    const score =
      (hitRate * 0.62 + closeness * 0.38) *
      grid.simplicity *
      relation.bonus;

    const candidate = {
      score,
      hitRate,
      hits,
      avgErrorMs: avgErrorSec * 1000,
      suggestedOffsetSec: phase,
      grid: grid.label,
      relation: relation.label,
      effectiveBpm: bpm,
      songBpm: baseSongBpm,
    };

    if (!best || candidate.score > best.score) best = candidate;
  });

  return best;
}

export function rankShotProfilesForBpm({
  profiles,
  bpm,
  beatsPerMeasure = 4,
  limit = 50,
}) {
  const baseSongBpm = Number(bpm);
  if (!Number.isFinite(baseSongBpm) || baseSongBpm <= 0 || !Array.isArray(profiles)) {
    return [];
  }

  return profiles
    .map((profile) => {
      if (!CAKE_TYPES.has(profile.type)) return null;
      const startsSec = normalizeShots(profile.shot_timestamps);
      if (startsSec.length < 2) return null;

      let best = null;
      BPM_RELATIONS.forEach((relation) => {
        const effectiveBpm = baseSongBpm * relation.factor;
        if (effectiveBpm < 30 || effectiveBpm > 320) return;
        GRID_CANDIDATES.forEach((grid) => {
          const scored = scoreGrid(startsSec, {
            bpm: effectiveBpm,
            baseSongBpm,
            beatsPerMeasure,
            relation,
            grid,
          });
          if (scored && (!best || scored.score > best.score)) best = scored;
        });
      });

      if (!best) return null;
      return {
        ...profile,
        shotCount: startsSec.length,
        score: Math.round(best.score * 100),
        fit: best,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.fit.avgErrorMs - b.fit.avgErrorMs;
    })
    .slice(0, limit);
}
