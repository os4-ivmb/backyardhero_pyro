// BPM + first-beat phase detector for show audio.
//
// We want a single global tempo and the offset of beat 1 so the timeline
// can draw a beat/downbeat grid the user can time cues to. For most pop /
// rock / EDM tracks a single tempo is correct; variable-tempo music is
// out of scope and the user can still hand-edit the result.
//
// Pipeline: decode → downmix mono → 1-pole LPF (kick/bass band) → RMS
// envelope at 10ms hops → positive derivative (onset signal) → light
// smoothing → autocorrelation in the 60-180 BPM lag range to find the
// beat period → phase search (slide a click train and maximise alignment).
// Confidence is the normalised prominence of the autocorrelation peak.

const MIN_BPM = 60;
const MAX_BPM = 180;
const HOP_SEC = 0.01;
const LOWPASS_HZ = 200;

export async function analyzeAudioFile(file) {
  if (typeof window === "undefined") {
    throw new Error("BPM analysis requires a browser environment");
  }
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio API not supported in this browser");

  const arrayBuf = await file.arrayBuffer();
  const ctx = new Ctor();
  let audio;
  try {
    // Some browsers consume the buffer; pass a copy so downstream consumers
    // (e.g. wavesurfer) can still decode the original File handle.
    audio = await ctx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    if (typeof ctx.close === "function") {
      try { await ctx.close(); } catch (_) { /* ignore */ }
    }
  }
  return analyzeAudioBuffer(audio);
}

export function analyzeAudioBuffer(audio) {
  const sr = audio.sampleRate;
  const channels = audio.numberOfChannels;
  const len = audio.length;
  if (!len || !sr) {
    throw new Error("Empty or invalid audio buffer");
  }

  const mono = new Float32Array(len);
  for (let c = 0; c < channels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i];
  }
  if (channels > 1) {
    const inv = 1 / channels;
    for (let i = 0; i < len; i++) mono[i] *= inv;
  }

  // 1-pole IIR low-pass: y[n] = y[n-1] + a*(x[n] - y[n-1]).
  // a = 1 - exp(-2π fc / sr) keeps the response stable across sample rates.
  const a = 1 - Math.exp((-2 * Math.PI * LOWPASS_HZ) / sr);
  let prev = 0;
  for (let i = 0; i < len; i++) {
    prev = prev + a * (mono[i] - prev);
    mono[i] = prev;
  }

  const hop = Math.max(1, Math.floor(HOP_SEC * sr));
  const win = hop * 2;
  if (len <= win) {
    throw new Error("Audio too short to analyse");
  }
  const envLen = Math.floor((len - win) / hop) + 1;
  const env = new Float32Array(envLen);
  for (let i = 0; i < envLen; i++) {
    const start = i * hop;
    let s = 0;
    for (let j = 0; j < win; j++) {
      const v = mono[start + j];
      s += v * v;
    }
    env[i] = Math.sqrt(s / win);
  }

  // Onset = positive part of the envelope derivative, then 3-tap smooth.
  const onset = new Float32Array(envLen);
  for (let i = 1; i < envLen; i++) {
    const d = env[i] - env[i - 1];
    onset[i] = d > 0 ? d : 0;
  }
  const sm = new Float32Array(envLen);
  for (let i = 0; i < envLen; i++) {
    const a0 = i > 0 ? onset[i - 1] : onset[i];
    const a1 = onset[i];
    const a2 = i < envLen - 1 ? onset[i + 1] : onset[i];
    sm[i] = (a0 + a1 + a2) / 3;
  }

  let mean = 0;
  for (let i = 0; i < envLen; i++) mean += sm[i];
  mean /= envLen;

  const lagMin = Math.max(2, Math.floor(60 / MAX_BPM / HOP_SEC));
  const lagMax = Math.min(envLen - 1, Math.ceil(60 / MIN_BPM / HOP_SEC));
  if (lagMax <= lagMin) {
    throw new Error("Audio too short to analyse");
  }

  const scores = new Float32Array(lagMax - lagMin + 1);
  let bestLag = lagMin;
  let bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    const limit = envLen - lag;
    for (let i = 0; i < limit; i++) {
      s += (sm[i] - mean) * (sm[i + lag] - mean);
    }
    scores[lag - lagMin] = s;
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }

  // Sub-sample refine via parabolic interpolation of the autocorrelation peak.
  let refinedLag = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const ym1 = scores[bestLag - 1 - lagMin];
    const y0 = scores[bestLag - lagMin];
    const yp1 = scores[bestLag + 1 - lagMin];
    const denom = ym1 - 2 * y0 + yp1;
    if (denom !== 0) {
      const dx = (0.5 * (ym1 - yp1)) / denom;
      if (dx > -1 && dx < 1) refinedLag = bestLag + dx;
    }
  }

  // Confidence: how much the peak stands out from the rest of the lag scan.
  let nearbySum = 0;
  let nearbyN = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (Math.abs(lag - bestLag) > 4) {
      nearbySum += scores[lag - lagMin];
      nearbyN++;
    }
  }
  const meanNearby = nearbyN > 0 ? nearbySum / nearbyN : 0;
  const denomConf = Math.max(Math.abs(bestScore), 1e-9);
  const confidence = Math.max(
    0,
    Math.min(1, (bestScore - meanNearby) / denomConf)
  );

  const bpm = 60 / (refinedLag * HOP_SEC);

  // Phase: try every integer offset within one beat period and pick the
  // shift where a click train hits the highest cumulative onset energy.
  const periodInt = Math.max(1, Math.round(refinedLag));
  let bestPhase = 0;
  let bestPhaseScore = -Infinity;
  for (let phase = 0; phase < periodInt; phase++) {
    let s = 0;
    for (let beat = 0; ; beat++) {
      const idx = Math.round(phase + beat * refinedLag);
      if (idx >= envLen) break;
      s += sm[idx];
    }
    if (s > bestPhaseScore) {
      bestPhaseScore = s;
      bestPhase = phase;
    }
  }
  const firstBeatOffsetSec = bestPhase * HOP_SEC;

  return {
    bpm: Number(bpm.toFixed(2)),
    firstBeatOffsetSec: Number(firstBeatOffsetSec.toFixed(3)),
    confidence: Number(confidence.toFixed(2)),
  };
}

// Compute the array of beat times (seconds) from offset to maxTimeSec.
// Returns objects so consumers can style downbeats differently.
export function computeBeatGrid({
  bpm,
  firstBeatOffsetSec = 0,
  beatsPerMeasure = 4,
  maxTimeSec,
}) {
  if (!bpm || bpm <= 0 || !maxTimeSec || maxTimeSec <= 0) return [];
  const period = 60 / bpm;
  if (!isFinite(period) || period <= 0) return [];

  // Allow a negative offset so users can nudge below zero; clamp the first
  // emitted beat to its in-range index.
  let n = 0;
  if (firstBeatOffsetSec < 0) {
    n = Math.ceil(-firstBeatOffsetSec / period);
  }

  const out = [];
  // Cap to a sane upper bound so a misconfigured grid can't lock the UI.
  const HARD_LIMIT = 4096;
  for (let i = 0; i < HARD_LIMIT; i++) {
    const t = firstBeatOffsetSec + n * period;
    if (t > maxTimeSec) break;
    if (t >= 0) {
      out.push({
        t,
        n,
        downbeat: beatsPerMeasure > 0 && n % beatsPerMeasure === 0,
        measure: beatsPerMeasure > 0 ? Math.floor(n / beatsPerMeasure) + 1 : null,
      });
    }
    n++;
  }
  return out;
}

// Convert tap-times (ms timestamps) into a BPM estimate. Uses the median
// inter-tap interval to be robust to one stray tap.
export function bpmFromTapTimes(tapTimesMs) {
  if (!Array.isArray(tapTimesMs) || tapTimesMs.length < 2) return null;
  const intervals = [];
  for (let i = 1; i < tapTimesMs.length; i++) {
    intervals.push(tapTimesMs[i] - tapTimesMs[i - 1]);
  }
  intervals.sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  const median =
    intervals.length % 2
      ? intervals[mid]
      : 0.5 * (intervals[mid - 1] + intervals[mid]);
  if (!median || median <= 0) return null;
  return Number((60000 / median).toFixed(2));
}
