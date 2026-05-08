// Multi-track audio model used by the show builder + console.
//
// Storage shape (the show row's `audio_file` JSON column):
//
//   { tracks: AudioTrack[], audioOffsetMs: number }
//
// `audioOffsetMs` is a SHOW-level audio sync trim. Positive values
// start the music that-many ms BEFORE the daemon's cue start (i.e. the
// audio is heard "ahead" of cue 0); negative values delay the music
// until after cue 0. It's a single number per show, not per track --
// the systematic audio-vs-cue delay (browser play() startup, audio
// driver buffering, etc.) is independent of which song is playing, so
// the operator should only have to dial it in once.
//
// Legacy shows persisted a single AudioTrack-shaped object directly,
// and an even-older intermediate revision stored a per-track
// `playbackOffsetMs`. We normalise either form on read so the rest of
// the app only ever deals with `{ tracks, audioOffsetMs }`.

import { computeBeatGrid } from "./bpmAnalyzer";

let _idCounter = 0;
export function newTrackId() {
  // Stable enough for React keys; the JSON file persists ids so reordering
  // is preserved across saves.
  _idCounter += 1;
  return `t_${Date.now().toString(36)}_${_idCounter.toString(36)}`;
}

export const DEFAULT_TRACK_BPM = {
  bpm: null,
  firstBeatOffsetSec: 0,
  beatsPerMeasure: 4,
  bpmConfidence: null,
  bpmSource: null,
};

// Normalise whatever we got back from the DB / props into a tracks array.
// Accepts: undefined/null, a single legacy track object, an array, or the
// new {tracks:[]} blob. Returns a plain AudioTrack[] (possibly empty).
export function normalizeAudioTracks(raw) {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw.map(coerceTrack).filter(Boolean);
  }

  if (typeof raw === "object") {
    if (Array.isArray(raw.tracks)) {
      return raw.tracks.map(coerceTrack).filter(Boolean);
    }
    // Legacy single-track shape: had a `url` and audio metadata directly.
    if (raw.url || raw.name || raw.file) {
      const t = coerceTrack(raw);
      return t ? [t] : [];
    }
  }

  return [];
}

function coerceTrack(t) {
  if (!t || typeof t !== "object") return null;
  return {
    id: t.id || newTrackId(),
    url: t.url || null,
    name: t.name || "",
    size: t.size ?? null,
    type: t.type ?? null,
    lastModified: t.lastModified ?? null,
    durationSec: Number.isFinite(t.durationSec) ? t.durationSec : null,
    bpm: Number.isFinite(t.bpm) ? t.bpm : null,
    firstBeatOffsetSec: Number.isFinite(t.firstBeatOffsetSec) ? t.firstBeatOffsetSec : 0,
    beatsPerMeasure: Number.isFinite(t.beatsPerMeasure) && t.beatsPerMeasure > 0
      ? t.beatsPerMeasure
      : 4,
    bpmConfidence: Number.isFinite(t.bpmConfidence) ? t.bpmConfidence : null,
    bpmSource: t.bpmSource || null,
  };
}

// Parse the raw `audio_file` JSON payload into the canonical in-memory
// shape: `{ tracks, audioOffsetMs }`. Accepts:
//   * the new `{ tracks: [...], audioOffsetMs }` blob
//   * a single legacy AudioTrack-shaped object
//   * an array of tracks
// Migrates the short-lived per-track `playbackOffsetMs` revision (only
// ever shipped as in-flight work in this branch) up to the show level
// by reading the first track's value if no top-level offset is set.
export function parseAudioField(raw) {
  const tracks = normalizeAudioTracks(raw);
  let audioOffsetMs = 0;
  if (raw && typeof raw === "object") {
    if (Number.isFinite(raw.audioOffsetMs)) {
      audioOffsetMs = raw.audioOffsetMs;
    } else if (raw.tracks && Array.isArray(raw.tracks) && raw.tracks[0]
      && Number.isFinite(raw.tracks[0].playbackOffsetMs)) {
      audioOffsetMs = raw.tracks[0].playbackOffsetMs;
    } else if (Number.isFinite(raw.playbackOffsetMs)) {
      audioOffsetMs = raw.playbackOffsetMs;
    }
  }
  return { tracks, audioOffsetMs };
}

// Shape we serialise back to `audio_file` in the DB. Takes the whole
// audio bundle (tracks + offset) so consumers don't accidentally drop
// the show-level offset on a partial save.
export function audioFieldFromShow({ tracks, audioOffsetMs }) {
  const arr = (tracks || []).map((t) => ({
    id: t.id,
    url: t.url,
    name: t.name,
    size: t.size,
    type: t.type,
    lastModified: t.lastModified,
    durationSec: t.durationSec,
    bpm: t.bpm,
    firstBeatOffsetSec: t.firstBeatOffsetSec,
    beatsPerMeasure: t.beatsPerMeasure,
    bpmConfidence: t.bpmConfidence,
    bpmSource: t.bpmSource,
  }));
  return {
    tracks: arr,
    audioOffsetMs: Number.isFinite(audioOffsetMs) ? audioOffsetMs : 0,
  };
}

// Cumulative offset (sec) of each track's start within the show timeline.
// Returns an array the same length as `tracks`. Tracks with unknown
// duration are treated as 0-length (won't push later tracks).
export function trackOffsets(tracks) {
  const out = new Array((tracks || []).length).fill(0);
  let acc = 0;
  for (let i = 0; i < (tracks || []).length; i++) {
    out[i] = acc;
    acc += Number.isFinite(tracks[i]?.durationSec) ? tracks[i].durationSec : 0;
  }
  return out;
}

export function totalShowAudioDuration(tracks) {
  return (tracks || []).reduce(
    (s, t) => s + (Number.isFinite(t?.durationSec) ? t.durationSec : 0),
    0
  );
}

// Locate the track containing a given show-time in seconds. Returns
// { index, track, localTime, offsetSec } or null when the time falls
// before track 0 / past the end. The right edge of track N belongs to
// track N (so localTime can equal track.durationSec on the seam).
export function trackAtShowTime(tracks, showTimeSec) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  if (!Number.isFinite(showTimeSec) || showTimeSec < 0) return null;
  let acc = 0;
  for (let i = 0; i < tracks.length; i++) {
    const dur = Number.isFinite(tracks[i]?.durationSec) ? tracks[i].durationSec : 0;
    const next = acc + dur;
    if (showTimeSec < next || (i === tracks.length - 1 && showTimeSec <= next)) {
      return {
        index: i,
        track: tracks[i],
        localTime: Math.max(0, showTimeSec - acc),
        offsetSec: acc,
      };
    }
    acc = next;
  }
  return null;
}

// Snap a show-time to the nearest beat in whichever track contains it.
// Returns the original time if no containing track has BPM set.
export function snapShowTimeToBeat(tracks, showTimeSec) {
  const hit = trackAtShowTime(tracks, showTimeSec);
  if (!hit || !hit.track?.bpm || hit.track.bpm <= 0) return showTimeSec;
  const period = 60 / hit.track.bpm;
  const phase = hit.track.firstBeatOffsetSec || 0;
  const localSnapped = Math.round((hit.localTime - phase) / period) * period + phase;
  const clampedLocal = Math.max(0, localSnapped);
  return Math.max(0, hit.offsetSec + clampedLocal);
}

// Compute beat-grid entries across the whole show by stitching each
// track's local grid into the show timeline. Returns an array of
// { t, n, downbeat, measure, trackIndex } sorted by show-time.
export function generateMultiTrackBeatGrid({
  tracks,
  maxTimeSec,
  beatsPerMeasureFallback = 4,
}) {
  if (!Array.isArray(tracks) || tracks.length === 0) return [];
  const offsets = trackOffsets(tracks);
  const out = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t || !t.bpm || t.bpm <= 0) continue;
    const dur = Number.isFinite(t.durationSec) ? t.durationSec : 0;
    if (dur <= 0) continue;
    const trackEnd = offsets[i] + dur;
    if (offsets[i] > maxTimeSec) break;
    const localMax = Math.min(dur, Math.max(0, maxTimeSec - offsets[i]));
    const local = computeBeatGrid({
      bpm: t.bpm,
      firstBeatOffsetSec: t.firstBeatOffsetSec || 0,
      beatsPerMeasure: t.beatsPerMeasure || beatsPerMeasureFallback,
      maxTimeSec: localMax,
    });
    for (const b of local) {
      out.push({
        t: offsets[i] + b.t,
        n: b.n,
        downbeat: b.downbeat,
        measure: b.measure,
        trackIndex: i,
      });
    }
    if (trackEnd > maxTimeSec) break;
  }
  return out;
}

// "Has any track with a known BPM?" — used to decide whether the beats
// grid mode is selectable in the timeline toolbar.
export function anyTrackHasBpm(tracks) {
  return (tracks || []).some((t) => t && t.bpm && t.bpm > 0);
}
