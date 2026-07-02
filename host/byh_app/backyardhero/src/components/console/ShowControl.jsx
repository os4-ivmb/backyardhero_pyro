import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  FaPlay, FaPause, FaCheck, FaClock, FaRocket, FaTriangleExclamation, FaCircleCheck,
} from "react-icons/fa6";
import { FiUpload, FiX, FiAlertCircle } from "react-icons/fi";

import useAppStore from "@/store/useAppStore";
import useStateAppStore from "@/store/useStateAppStore";
import useAppMode from "@/design/useAppMode";
import { Card, Button, Badge, Stat, IconButton, cn } from "@/design";
import { protoStatusBadge, protoStatusLabel } from "@/util/protoStatus";
import {
  audioFieldFromShow,
  trackAtShowTime,
  trackOffsets,
  totalShowAudioDuration,
} from "@/utils/audioTracks";
import useShowReceiverVerification from "@/util/useShowReceiverVerification";
import { asyncPrompt, asyncAlert } from "@/components/common/AsyncPrompt";

// Per-press magnitude of the live audio sync scrubber.
const SYNC_NUDGE_MS = 50;

// ---------------------------------------------------------------------------
// ShowControl: the single hero surface that drives a staged show.
//
// The redesign brief called out "Multiple competing primary actions" — Play,
// Load, Armed, Manual Fire, Unstage all at the same visual weight. This
// component fixes that by deriving exactly ONE primary action at a time from
// the live show + daemon state. The action ladder runs top-down; the first
// matching rule wins, and load-state precedence is enforced before any
// load-dependent daemon flag is consulted (the daemon can carry stale
// `waiting_for_client_start` / `dstc` between sessions):
//
//   Live (proto handler running)        → Primary: "Abort"            (only)
//   No show staged                      → (component not rendered)
//   Staged, not loaded, ARM off         → Primary: "Awaiting ARM"     (warn, disabled)
//   Staged, not loaded, start sw on     → Primary: "Start switch ON"  (danger, disabled)
//   Staged, not loaded                  → Primary: "Load"             Secondary: Unstage / Preview
//   Loaded, errors                      → Primary: "Resolve errors"   Secondary: Unload
//   Loaded, post-show (STOPPED/ABORTED) → Primary: "Show finished"    hint: cycle switch / unload
//   Loaded, awaiting client start       → Primary: "Launch"           Secondary: Abort
//   Loaded, ok, ARM off, start on       → Primary: "ARM switch is OFF" (danger)
//   Loaded, ok, not armed               → Primary: "Awaiting ARM"     hint: "Turn the key on the box"
//   Loaded, armed, start switch off     → Primary: "Awaiting start"   hint: "Turn the show start switch on"
//   Anything else (transients)          → Primary: "Standby"          (outline, disabled)
//
// Preview play/pause for the local timeline cursor lives here too because
// it's a workflow concern (preview before load), but it's explicitly
// secondary-styled and disabled once the show is loaded.
// ---------------------------------------------------------------------------

const formatTime = (sec) => {
  const v = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
};

// Subdued operator-side preview waveform. Plays the audio for the show
// preview button AND drives audio playback during a live show. With
// multi-track shows it sequences through each track's URL: when one
// finishes we load the next and resume.
//
// The show-level audio sync offset is NOT applied here at start-of-
// play. The parent (ConsolePanel) takes care of that during a live
// show by scheduling `setAudioIsPlaying(true)` at `sst - offsetMs`,
// which is far more accurate than anything we can do post-hoc with a
// wavesurfer seek (the browser's audio-driver startup can vary by
// tens of ms).
//
// MiniWave is responsible for one offset job only: when the operator
// nudges ±50ms WHILE music is already playing, we seek the active
// track by the delta so the change is audible immediately.
function MiniWave({
  audioTracks,
  // Preview playback (local rehearsal) vs. the sst-scheduled live show. They
  // are mutually exclusive; the audio plays when either is true, but only
  // preview mode is cursor-synced (the live cursor is daemon-driven).
  previewPlaying,
  liveAudio,
  audioOffsetMs,
  muted,
  // Current show-time cursor (sec). The audio is a slave to this within the
  // audio window: preview playback starts/resumes from here and scrubs seek
  // to here. Read via a ref so per-frame cursor updates don't churn effects.
  showTime,
  // { seq, sec } — a user scrub on the timeline. `seq` bumps each scrub so we
  // seek once per gesture-step regardless of play state.
  seekRequest,
  // (showSec) => void — called each audioprocess tick during PREVIEW so the
  // cursor tracks the audio exactly (no drift).
  onAudioTime,
  // () => void — called when the audio stops being the clock (finished, or the
  // cursor moved outside the audio window) so the host resumes its wall-clock.
  onAudioInactive,
}) {
  const ref = useRef(null);
  const ws = useRef(null);
  const [ready, setReady] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // Action to apply once a (re)loaded track becomes ready: { local, play }.
  const pendingRef = useRef(null);

  const playableTracks = useMemo(
    () => (audioTracks || []).filter((t) => t?.url),
    [audioTracks]
  );
  const activeUrl = playableTracks[activeIdx]?.url || null;
  const offsets = useMemo(() => trackOffsets(playableTracks), [playableTracks]);
  const totalDur = useMemo(
    () => totalShowAudioDuration(playableTracks),
    [playableTracks]
  );

  const playing = !!previewPlaying || !!liveAudio;

  // Latest values the persistent wavesurfer event handlers need, kept in refs
  // so we don't have to tear down + rebind (or recreate wavesurfer) on every
  // render just to avoid stale closures.
  const previewPlayingRef = useRef(false);
  previewPlayingRef.current = !!previewPlaying;
  const activeIdxRef = useRef(0);
  activeIdxRef.current = activeIdx;
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const trackCountRef = useRef(0);
  trackCountRef.current = playableTracks.length;
  const onAudioTimeRef = useRef(onAudioTime);
  onAudioTimeRef.current = onAudioTime;
  const onAudioInactiveRef = useRef(onAudioInactive);
  onAudioInactiveRef.current = onAudioInactive;
  const showTimeRef = useRef(0);
  showTimeRef.current = Number.isFinite(showTime) ? showTime : 0;
  // Current show-level sync offset in seconds (positive = music is "ahead" of
  // the cue clock). During preview the audio leads/trails the cursor by this,
  // so the persistent audioprocess handler needs the latest value.
  const audioOffsetSecRef = useRef(0);
  audioOffsetSecRef.current = (Number.isFinite(audioOffsetMs) ? audioOffsetMs : 0) / 1000;

  // Reset to the first track whenever the playable URL list changes.
  useEffect(() => { setActiveIdx(0); }, [playableTracks.length]);

  // Seek the currently-loaded track to a local time (sec). Returns false when
  // wavesurfer isn't ready yet so the caller can stash the seek for on-ready.
  const applyLocalSeek = (localSec) => {
    if (!ws.current || !ready) return false;
    const dur = ws.current.getDuration?.() || 0;
    if (dur <= 0) return false;
    try { ws.current.seekTo(Math.max(0, Math.min(1, localSec / dur))); } catch { /* */ }
    return true;
  };

  // Position the audio to a cue-clock show-time. In preview the audio leads/
  // trails the cue clock by the show-level sync offset (positive = music ahead
  // of cues), so we map the requested cue-time to an audio show-time before
  // locating the track — this is what lets a ±offset nudge be *audible* against
  // the cues instead of dragging the cursor along with it. Outside the audio
  // window there's nothing to play, so we pause and hand the clock back to the
  // host. Inside, we switch to the containing track if needed (applying the
  // seek on ready) and optionally resume playback from there.
  const positionAudioTo = (sec, resume) => {
    // A small negative result means the cursor sits in the sub-offset lead-in
    // of a "music-after-cue-0" trim; clamp up to the audio head so playback
    // still starts (the reported cursor lands at |offset|) rather than going
    // silent. Past the end there's genuinely nothing to play, so `hit` is null
    // and we hand the clock back.
    let audioSec = Number.isFinite(sec) ? sec + audioOffsetSecRef.current : NaN;
    if (Number.isFinite(audioSec) && audioSec < 0) audioSec = 0;
    const hit = Number.isFinite(audioSec) && audioSec < totalDur
      ? trackAtShowTime(playableTracks, audioSec)
      : null;
    if (!hit) {
      try { ws.current?.pause(); } catch { /* */ }
      onAudioInactiveRef.current?.();
      return;
    }
    if (hit.index !== activeIdx) {
      pendingRef.current = { local: hit.localTime, play: resume };
      setActiveIdx(hit.index);
      return;
    }
    if (!applyLocalSeek(hit.localTime)) {
      pendingRef.current = { local: hit.localTime, play: resume };
      return;
    }
    if (resume) { try { ws.current?.play(); } catch { /* */ } }
  };

  useEffect(() => {
    if (!ref.current || ws.current || !activeUrl) return;
    let cancelled = false;
    // W6: load wavesurfer.js lazily. It used to be a top-level static
    // import, which dragged its bundle into the console's first-load JS
    // even though the mini-waveform only appears once a show WITH audio is
    // staged. Dynamic import() pushes it into a separate chunk fetched on
    // demand, keeping the default firing screen lean.
    import("wavesurfer.js")
      .then(({ default: WaveSurfer }) => {
        if (cancelled || !ref.current || ws.current) return;
        ws.current = WaveSurfer.create({
          container: ref.current,
          waveColor: "#5b6470",
          progressColor: "#608ec4",
          cursorColor: "transparent",
          barWidth: 1, barRadius: 1, cursorWidth: 0,
          height: 28, barGap: 1, normalize: true, interact: false,
        });
        ws.current.on("ready", () => {
          setReady(true);
          // Apply a seek (and optional resume) queued while this track loaded.
          const p = pendingRef.current;
          pendingRef.current = null;
          if (p) {
            const dur = ws.current.getDuration?.() || 0;
            if (dur > 0) {
              try { ws.current.seekTo(Math.max(0, Math.min(1, p.local / dur))); } catch { /* */ }
            }
            if (p.play) { try { ws.current.play(); } catch { /* */ } }
          }
        });
        ws.current.on("error", () => setReady(false));
        ws.current.on("finish", () => {
          // Advance to the next track and resume; when the last track ends,
          // hand the clock back so the rest of the (audio-less) show keeps
          // advancing.
          setActiveIdx((i) => {
            const next = i + 1;
            if (next < trackCountRef.current) {
              pendingRef.current = { local: 0, play: true };
              return next;
            }
            onAudioInactiveRef.current?.();
            return i;
          });
        });
        // During PREVIEW, drive the cursor from the audio position so the two
        // can't drift. Skipped for the live show (daemon owns the cursor).
        ws.current.on("audioprocess", () => {
          if (!ws.current || !previewPlayingRef.current) return;
          const cur = ws.current.getCurrentTime?.() || 0;
          const audioShowTime = (offsetsRef.current[activeIdxRef.current] || 0) + cur;
          // Report the cue clock, not the audio position: they differ by the
          // sync offset, so nudging the offset shifts the music against the
          // cursor (and thus the cues) rather than moving both together.
          onAudioTimeRef.current?.(audioShowTime - audioOffsetSecRef.current);
        });
        // ws.load() returns a Promise that rejects with AbortError when
        // the instance is destroyed mid-load (StrictMode double-mount,
        // staged-show swap, etc). Catch it explicitly so it doesn't
        // surface as an unhandled rejection.
        Promise.resolve()
          .then(() => ws.current?.load(activeUrl))
          .catch((err) => {
            if (err?.name === 'AbortError') return;
            // eslint-disable-next-line no-console
            console.error('MiniWave load failed:', err);
          });
      })
      .catch((err) => {
        if (!cancelled) console.error('wavesurfer import failed:', err);
      });
    return () => {
      cancelled = true;
      if (ws.current) {
        try { ws.current.pause(); ws.current.destroy(); } catch { /* */ }
      }
      ws.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUrl]);

  // Play / pause. On the rising edge we position the audio: the live show
  // starts from the top (its precise timing is owned by the sst scheduler),
  // while a preview starts/resumes from the current cursor. On pause we leave
  // the preview position parked (so a scrub or replay resumes from the cursor)
  // but rewind the live audio to the head as before.
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    if (!ws.current || !ready) return;
    const was = wasPlayingRef.current;
    wasPlayingRef.current = playing;
    try {
      if (playing && !was) {
        if (liveAudio) {
          if (activeIdx !== 0) {
            pendingRef.current = { local: 0, play: true };
            setActiveIdx(0);
          } else {
            applyLocalSeek(0);
            ws.current.play();
          }
        } else {
          positionAudioTo(showTimeRef.current, true);
        }
      } else if (!playing && was) {
        ws.current.pause();
        if (liveAudio) applyLocalSeek(0);
      } else if (playing && was) {
        // Same play state across a track switch — make sure it's running.
        ws.current.play();
      }
    } catch { /* */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, ready, liveAudio, activeIdx]);

  // User scrub on the timeline: seek the audio to match, once per gesture-step.
  // Resumes playback after the seek when we're mid-preview so the sound tracks
  // the cursor live.
  const lastSeekSeqRef = useRef(0);
  useEffect(() => {
    if (!seekRequest || seekRequest.seq === lastSeekSeqRef.current) return;
    lastSeekSeqRef.current = seekRequest.seq;
    positionAudioTo(seekRequest.sec, !!previewPlaying);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest]);

  // Silence the browser's own output when the host device is playing the
  // audio (the "Play show audio on this device" setting). We keep wavesurfer
  // running so it still drives the timeline cursor / cue previews from the
  // same sst clock -- it's just muted, so the only sound comes from the box.
  // Re-applied on (re)load since a fresh wavesurfer starts at full volume.
  useEffect(() => {
    if (!ws.current || !ready) return;
    try { ws.current.setMuted(!!muted); } catch { /* */ }
  }, [muted, ready, activeIdx]);

  // Live nudge while playing: when `audioOffsetMs` changes during
  // playback, seek the active track by the delta so the operator's
  // nudge is audible immediately. Convention: positive offset = music
  // is "ahead" of cues, so an increase in offset means we need to
  // advance the wavesurfer position by that delta.
  const appliedOffsetMsRef = useRef(0);
  useEffect(() => {
    // Capture the current offset as "applied" each time playback
    // starts -- the parent already shifted the audio start, and
    // future nudges should be relative to that baseline.
    if (playing) appliedOffsetMsRef.current = audioOffsetMs;
    // We intentionally DON'T re-run this effect on audioOffsetMs
    // change; the dedicated nudge effect below handles those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, ready, activeIdx]);
  useEffect(() => {
    if (!ws.current || !ready || !playing) return;
    const applied = appliedOffsetMsRef.current || 0;
    if (audioOffsetMs === applied) return;
    const dur = ws.current.getDuration?.() || 0;
    if (dur <= 0) return;
    const deltaSec = (audioOffsetMs - applied) / 1000;
    const newTime = (ws.current.getCurrentTime?.() || 0) + deltaSec;
    try {
      ws.current.seekTo(Math.max(0, Math.min(1, newTime / dur)));
    } catch { /* */ }
    appliedOffsetMsRef.current = audioOffsetMs;
  }, [audioOffsetMs, ready, playing]);

  if (!activeUrl) return null;
  return <div ref={ref} className="w-40 rounded-sm bg-surface-inset" aria-hidden />;
}

// Live audio sync scrubber. One number for the whole show: positive =
// music is "ahead" of cue 0 (we kick the audio off `+offset` ms before
// the daemon's start instant); negative = music starts after cue 0.
// The number reflects the working value, which is the saved value
// plus any unsaved nudges from this rehearsal pass. Save is only
// enabled when no playback is happening AND the working value differs
// from the persisted one.
function SyncOffsetCluster({
  liveOffsetMs,
  savedOffsetMs,
  isPlaying,
  onNudge,
  onSave,
}) {
  const fmt = (ms) => {
    const v = Math.round(ms);
    if (v === 0) return "0 ms";
    return `${v > 0 ? "+" : "−"}${Math.abs(v)} ms`;
  };
  const dirty = liveOffsetMs !== savedOffsetMs;
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 px-2 h-9 rounded border",
        "border-border bg-surface-inset"
      )}
      title="Audio sync for the show. + = music starts before cue 0; − = music starts after."
    >
      <span className="eyebrow leading-none">Sync</span>
      <Button
        size="xs"
        variant="subtle"
        onClick={() => onNudge(-SYNC_NUDGE_MS)}
        title="Delay the audio 50ms (music starts 50ms later relative to cue 0)"
      >
        −{SYNC_NUDGE_MS}
      </Button>
      <span
        className={cn(
          "tabular-nums text-sm min-w-[64px] text-center",
          dirty ? "text-warn font-semibold" : "text-fg-primary"
        )}
        aria-label={`Audio sync offset ${fmt(liveOffsetMs)}${dirty ? " (unsaved)" : ""}`}
      >
        {fmt(liveOffsetMs)}
      </span>
      <Button
        size="xs"
        variant="subtle"
        onClick={() => onNudge(SYNC_NUDGE_MS)}
        title="Advance the audio 50ms (music starts 50ms earlier relative to cue 0)"
      >
        +{SYNC_NUDGE_MS}
      </Button>
      <Button
        size="xs"
        variant="primary"
        onClick={onSave}
        disabled={isPlaying || !dirty}
        className="ml-1"
        title={
          isPlaying
            ? "Stop playback to save the current sync offset"
            : dirty
              ? "Persist the current sync offset to this show; future runs will reuse it"
              : "No changes to save"
        }
      >
        Save
      </Button>
    </div>
  );
}

// Big countdown widget used in the show-control header during the
// seconds-to-start phase (proto_handler_status === "START_CONFIRMED").
// Replaces the small "Ready" / "Running" badge so the operator can see
// the time-to-zero from across the room. Large tabular numerics with a
// gentle pulse on the eyebrow; the digit itself stays static so the
// number is never blurry mid-tick.
function CountdownDisplay({ seconds }) {
  const display = Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  return (
    <div
      className={cn(
        "flex flex-col items-end justify-center leading-none",
        "px-4 py-2 rounded-md border",
        "bg-live/10 border-live/60 text-live-fg",
        "shadow-[0_0_0_1px_rgb(var(--live)/0.25),0_0_24px_0_rgb(var(--live)/0.25)]"
      )}
      role="timer"
      aria-live="polite"
      aria-label={display != null ? `T minus ${display} seconds` : "Countdown"}
    >
      <span className="eyebrow text-live animate-livePulse">Countdown</span>
      <span className="num text-5xl font-bold tabular-nums tracking-tight mt-0.5">
        {display != null ? `T−${display}` : "T−"}
        <span className="text-2xl align-baseline ml-0.5 text-live/70">s</span>
      </span>
    </div>
  );
}

export default function ShowControl({
  timeCursor, setTimeCursor,
  isPlaying, setIsPlaying,
  audioIsPlaying, onAudioTimeUpdate,
  countdownSeconds,
  isReadyToFire, hasErrors, allReceiversOnline,
  errors,
  playVideos, onPlayVideosChange,
  // Show-level audio sync offset (ms). Owned by ConsolePanel so the
  // sst-based start scheduler can read it directly; ShowControl just
  // exposes the scrubber UI. Convention: positive = music starts
  // BEFORE cue 0 (audio is "ahead"); negative = music starts after.
  liveAudioOffsetMs,
  onLiveAudioOffsetMsChange,
  // Timeline scrub toggle (console rehearsal aid). Owned by ConsolePanel so it
  // can also gate the Timeline's `allowScrub`; here we render the toggle and
  // feed the seek target to MiniWave. `canScrub` is false once the show is
  // loaded/live (the cursor is daemon-driven then).
  scrubEnabled,
  onScrubEnabledChange,
  canScrub,
  // Audio seek plumbing for scrubbing: `audioSeekReq` ({seq, sec}) is a
  // user-scrub event; `onAudioInactive` lets MiniWave hand the cursor clock
  // back to ConsolePanel when the audio window ends.
  audioSeekReq,
  onAudioInactive,
}) {
  const { stagedShow, setStagedShow, updateShow, systemConfig } = useAppStore();
  const { stateData } = useStateAppStore();
  const { mode, isShowLoaded, protoStatus, isArmed, startSwActive } = useAppMode();
  // Receiver verification for the staged show. Drives the Load Show
  // disabled/blocked state below: if the show references a missing /
  // disabled / under-cued receiver the operator can't load until they
  // fix it on the Receivers page (or re-edit the show).
  const showRcvVerification = useShowReceiverVerification();

  // ---------------------------------------------------------------------
  // Audio sync offset rendering. The state itself lives in ConsolePanel
  // so the sst-based start scheduler can read it without prop chains;
  // here we only need to render the scrubber + Save and compute the
  // dirty flag against the persisted value.
  // ---------------------------------------------------------------------
  const audioTracks = useMemo(() => {
    if (Array.isArray(stagedShow?.audioTracks)) return stagedShow.audioTracks;
    if (stagedShow?.audioFile?.url) return [stagedShow.audioFile];
    return [];
  }, [stagedShow?.audioTracks, stagedShow?.audioFile]);
  const hasAnyAudio = audioTracks.some((t) => t?.url);

  const savedAudioOffsetMs = Number.isFinite(stagedShow?.audioOffsetMs)
    ? stagedShow.audioOffsetMs
    : 0;
  const workingOffsetMs = Number.isFinite(liveAudioOffsetMs) ? liveAudioOffsetMs : 0;

  // When the box is playing the audio itself (host audio setting on), this
  // console stays silent for the WHOLE live show so the sound comes solely
  // from the box -- including if the operator hits local preview mid-show
  // (otherwise the console would play on top of the box's output, double
  // audio). Local preview still plays normally when NO live show is running
  // (audioIsPlaying false) so the operator can rehearse. audioIsPlaying is the
  // sst-driven live flag from ConsolePanel.
  const hostAudioActive = !!systemConfig?.system?.hostAudio?.enabled;
  const liveMuted = hostAudioActive && !!audioIsPlaying;

  const nudgeSync = (deltaMs) => {
    onLiveAudioOffsetMsChange?.(workingOffsetMs + deltaMs);
  };

  // Persist the show-level offset back to the show row. We rebuild the
  // entire PATCH body (the API requires every field) by spreading the
  // staged show and overriding the audio blob -- this matches what
  // ShowStateHeader does when the editor saves.
  const saveSyncOffset = async () => {
    if (!stagedShow?.id) return;
    const apiAudioBlob = audioFieldFromShow({
      tracks: audioTracks,
      audioOffsetMs: workingOffsetMs,
    });
    const apiShowData = {
      name: stagedShow.name,
      duration: stagedShow.duration,
      version: stagedShow.version,
      runtime_version: stagedShow.runtime_version,
      display_payload: stagedShow.display_payload,
      runtime_payload: stagedShow.runtime_payload,
      authorization_code: stagedShow.authorization_code,
      protocol: stagedShow.protocol,
      audioFile: apiAudioBlob,
      receiver_locations: stagedShow.receiver_locations || null,
      receiver_labels: stagedShow.receiver_labels || null,
    };
    const res = await updateShow(stagedShow.id, apiShowData);
    if (res && res.ok === false) {
      // Surface the failure instead of silently pretending the offset
      // saved (W6: updateShow now reports save errors).
      setCmdError?.(res.error || 'Failed to save audio sync offset.');
      return;
    }
    // Mirror the change into the in-memory staged show so the next
    // playback picks up the new saved offset without a refetch.
    setStagedShow({
      ...stagedShow,
      audioOffsetMs: workingOffsetMs,
    });
  };

  // ---------------------------------------------------------------------
  // Action derivation. We compute the next primary action exactly once,
  // and label every other affordance as "secondary" / icon-only.
  // ---------------------------------------------------------------------
  const handlerInStartPhase = protoStatus &&
    protoStatus.split("_")[0]?.startsWith("START");
  const isLive = handlerInStartPhase || stateData.fw_state?.show_running;
  const waitingClientStart = !!stateData.fw_state?.waiting_for_client_start;
  const dstc = !!stateData.fw_state?.dstc;

  // W5: a 200 from this endpoint only means "command file written", not
  // "daemon accepted" — but a failed POST (network / validation reject)
  // must not be silent. Surface it inline.
  const [cmdError, setCmdError] = useState(null);
  const callDaemon = async (type, body = {}) => {
    setCmdError(null);
    try {
      await axios.post("/api/system/cmd_daemon", { type, ...body }, {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      const detail = e?.response?.data?.error || e?.message || String(e);
      setCmdError(`Command "${type}" failed: ${detail}`);
    }
  };

  const handleLoad = async () => {
    if (!stagedShow?.id) return;
    const code = await asyncPrompt({
      title: "Load show",
      message: "Auth code for this show:",
      type: "password",
      okLabel: "Load",
    });
    if (code === null) return; // cancelled
    if (code !== stagedShow.authorization_code) {
      await asyncAlert("Auth code is incorrect.");
      return;
    }
    await callDaemon("load_show", { id: stagedShow.id });
  };
  const handleUnload = () => callDaemon("unload_show", { id: stagedShow.id });
  const handleStart = () => callDaemon("start_show");
  const handleStop = () => callDaemon("stop_show");
  const handleAbortLoad = () => callDaemon("abort_show_load");
  const handleUnstage = () => setStagedShow({});

  // A load is in flight when the proto handler reports LOADING — covers
  // both the cue-send phase and the async wait for receivers to confirm
  // loadComplete. `isShowLoaded` stays false this whole time, so without
  // this the primary button would just keep saying "Load show".
  const isLoadingShow = protoStatus === "LOADING";

  // Primary action descriptor: { label, variant, onClick, icon, hint, disabled }
  const primary = useMemo(() => {
    // A load in progress turns the hero button into "Cancel load" so a
    // hanging load (receiver never confirms) can be aborted without
    // digging through menus. Checked first: during LOADING the show is
    // neither live nor loaded, so it would otherwise fall through to the
    // "Load show" branch and offer to start the load again.
    if (isLoadingShow) return {
      label: "Cancel load",
      variant: "danger",
      onClick: handleAbortLoad,
      icon: <FiX className="text-xl" aria-hidden />,
      hint: "Sending cues to receivers… cancel if it's stuck (auto-fails after 60s).",
    };
    // ABORT always wins -- if the proto handler is running we want a
    // single red button, regardless of any other flags.
    if (isLive) return {
      label: "Abort",
      variant: "danger",
      onClick: handleStop,
      icon: <FiX className="text-xl" aria-hidden />,
      hint: protoStatusLabel(protoStatus),
    };
    // Loading is a hard precondition for every other "loaded" branch.
    // Check it before consulting any of the load-dependent flags (the
    // daemon can carry stale `waiting_for_client_start` / `dstc` from a
    // previous session and would otherwise mislead us into showing
    // "Launch" while the show is unloaded).
    if (!isShowLoaded) {
      // Two physical preconditions on the box, in order:
      //   1. ARM key on. The daemon technically lets the load through
      //      while disarmed but immediately fails pre-checks ("System
      //      is not armed. Re-arm, then reload the show."), leaving
      //      the operator in a broken loaded state. Gate it here.
      //   2. Start switch off. The daemon refuses outright with
      //      "Cannot load a show when the START button is active."
      if (!isArmed) return {
        label: "Awaiting ARM",
        variant: "warn",
        disabled: true,
        icon: <FaClock aria-hidden />,
        hint: "Turn the ARM key on before loading.",
      };
      if (startSwActive) return {
        label: "Start switch is ON",
        variant: "danger",
        disabled: true,
        icon: <FaTriangleExclamation aria-hidden />,
        hint: "Turn the show start switch OFF, then load.",
      };
      // Receiver verification block. We refuse to load a show that
      // references receivers that aren't there / are disabled / can't
      // accommodate the configured cue count — the daemon would surface
      // less helpful errors mid-load anyway. The operator can resolve
      // either on the Receivers page or by re-editing the show.
      if (showRcvVerification.hasError) {
        return {
          label: "Resolve receivers",
          variant: "danger",
          disabled: true,
          icon: <FaTriangleExclamation aria-hidden />,
          hint: showRcvVerification.summary
            ? `Receivers: ${showRcvVerification.summary}`
            : "Show has receiver verification errors",
        };
      }
      return {
        label: "Load show",
        variant: "primary",
        onClick: handleLoad,
        icon: <FiUpload aria-hidden />,
        hint: !allReceiversOnline ? "Some receivers offline" : "Send cues to receivers",
      };
    }
    if (hasErrors) return {
      label: "Resolve errors",
      variant: "warn",
      icon: <FiAlertCircle aria-hidden />,
      disabled: true,
      hint: `${errors?.length || 0} pre-check failure(s)`,
    };
    // Post-show. The proto handler settles into STOPPED on natural
    // completion or ABORTED when stopped/errored. The daemon does NOT
    // unload the show or auto-cycle the start switch, so we end up
    // with show_loaded=true, show_running=false, and (typically)
    // start_sw_active still true from before the show. Tell the
    // operator the show is done and what to do next.
    if (protoStatus === "STOPPED" || protoStatus === "ABORTED") {
      const aborted = protoStatus === "ABORTED";
      return {
        label: aborted ? "Show aborted" : "Show finished",
        variant: aborted ? "warn" : "outline",
        disabled: true,
        icon: aborted
          ? <FaTriangleExclamation aria-hidden />
          : <FaCircleCheck aria-hidden />,
        hint: startSwActive
          ? "Cycle the start switch off to run again, or unload."
          : "Run again, or unload to stage another show.",
      };
    }
    if (waitingClientStart && dstc) return {
      label: "Launch",
      variant: "live",
      onClick: handleStart,
      icon: <FaRocket aria-hidden />,
      hint: "All systems go",
    };
    // Loaded + pre-checks pass, but we haven't yet been handed control to
    // launch. Two physical preconditions on the box: ARM key, then the
    // SHOW START switch. We tell the operator which one is missing rather
    // than parking on a generic "awaiting hardware" message.
    if (isReadyToFire && !waitingClientStart) {
      if (!isArmed) {
        // The daemon does NOT reset start_sw_active when the operator
        // disarms with the start switch still flipped on, so this combo
        // is a real, observable state. Call it out explicitly: if the
        // operator arms again the daemon will be in start-pending and
        // they may have meant to abort instead.
        if (startSwActive) return {
          label: "ARM switch is OFF",
          variant: "danger",
          disabled: true,
          icon: <FaTriangleExclamation aria-hidden />,
          hint: "Start switch is on. Turn the ARM key back on, or cycle the start switch off first.",
        };
        return {
          label: "Awaiting ARM",
          variant: "warn",
          disabled: true,
          icon: <FaClock aria-hidden />,
          hint: "Turn the key on the box",
        };
      }
      if (!startSwActive) return {
        label: "Awaiting start switch",
        variant: "warn",
        disabled: true,
        icon: <FaClock aria-hidden />,
        hint: "Turn the show start switch on",
      };
      // Armed + start switch on but the daemon hasn't asserted
      // waiting_for_client_start yet. This is a sub-second transient
      // (WS lag) or means delegate_start_to_client is off and the
      // proto handler is about to take over. Fall through to the
      // generic Standby default below rather than invent a label.
    }
    return {
      label: "Standby",
      variant: "outline",
      disabled: true,
      icon: <FaClock aria-hidden />,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, isLoadingShow, waitingClientStart, dstc, isShowLoaded, hasErrors, isReadyToFire,
      allReceiversOnline, errors?.length, protoStatus, isArmed, startSwActive,
      showRcvVerification.hasError, showRcvVerification.summary,
      // W5/stale-closure: the primary action's onClick (handleLoad) closes
      // over the staged show's id + auth code; recompute when those change
      // so a click never acts on a previous staging.
      stagedShow?.id, stagedShow?.authorization_code]);

  // Status chip describing show pre-checks (calm wording, single source).
  // Note: the T-N countdown is *not* rendered here -- during
  // START_CONFIRMED the top-right slot switches to a dedicated large
  // countdown widget below. This keeps the badge for chrome states only.
  const statusChip = useMemo(() => {
    if (isLive) {
      if (protoStatus === "STARTED") return { tone: "live", label: protoStatusBadge("STARTED") };
      if (protoStatus === "START_PENDING") return { tone: "armed", label: protoStatusBadge("START_PENDING") };
    }
    if (isLoadingShow) return { tone: "armed", label: "Loading" };
    if (!isShowLoaded) return { tone: "neutral", label: "Not loaded" };
    if (hasErrors) return { tone: "danger", label: "Checks failed" };
    if (isReadyToFire) return { tone: "ok", label: "Ready" };
    return { tone: "neutral", label: "Loaded" };
  }, [isLive, protoStatus, isShowLoaded, hasErrors, isReadyToFire, isLoadingShow]);

  // Are we in the seconds-to-start countdown? Only true once the proto
  // handler is confirmed; pre-start hasn't picked a start time yet.
  const inCountdown = isLive && protoStatus === "START_CONFIRMED";

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  const previewDisabled = isShowLoaded || isLive;

  return (
    <Card
      padding="md"
      tone={mode.id === "armed" ? "armed" : mode.id === "live" ? "ok" : "raised"}
      className="flex flex-col gap-3"
    >
      {/* Header: name + status chip + actions overflow */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="eyebrow">Staged show</div>
          <h2 className="text-2xl font-semibold text-fg-primary truncate tracking-tight">
            {stagedShow?.name || "Untitled"}
          </h2>
        </div>

        {inCountdown ? (
          <CountdownDisplay seconds={countdownSeconds} />
        ) : (
          <Badge tone={statusChip.tone} size="md" pulse={statusChip.tone === "live" || statusChip.tone === "armed"}>
            {statusChip.label}
          </Badge>
        )}

        {/* Secondary actions live in the top-right; never compete with primary. */}
        <div className="flex items-center gap-1.5">
          {isShowLoaded && !isLive ? (
            <Button size="sm" variant="outline" onClick={handleUnload}>Unload</Button>
          ) : null}
          {!isShowLoaded && !isLive ? (
            <Button size="sm" variant="ghost" onClick={handleUnstage}>Unstage</Button>
          ) : null}
        </div>
      </div>

      {/* Receiver verification banner. Shown ONLY when the staged show
          has verification errors AND it isn't already loaded — at that
          point the daemon is already enforcing whatever set of receivers
          the load wired up, so warning here would be noise. */}
      {!isShowLoaded && showRcvVerification.hasError ? (
        <div className="flex items-start gap-2 rounded-sm border border-danger/40 bg-danger-bg/60 px-3 py-2 text-xs text-danger-fg">
          <FaTriangleExclamation className="mt-0.5 shrink-0" aria-hidden />
          <div>
            <div className="font-medium">
              This show can't be loaded: {showRcvVerification.summary}.
            </div>
            <div className="opacity-80 mt-0.5">
              Fix the affected receivers on the Receivers page (add, enable,
              or increase their cue count) — or re-open the show and adjust
              its receiver list.
            </div>
          </div>
        </div>
      ) : null}

      {/* Command-failure banner: surfaces a failed POST to cmd_daemon
          (network error / server-side validation reject) so a control
          action that did nothing isn't silent (W5). */}
      {cmdError ? (
        <div className="flex items-start gap-2 rounded-sm border border-danger/40 bg-danger-bg/60 px-3 py-2 text-xs text-danger-fg">
          <FaTriangleExclamation className="mt-0.5 shrink-0" aria-hidden />
          <div>{cmdError}</div>
        </div>
      ) : null}

      {/* Primary action row: ONE button, hero size. */}
      <div className="flex items-center gap-4 flex-wrap">
        <Button
          size="xl"
          variant={primary.variant}
          onClick={primary.onClick}
          disabled={primary.disabled}
          leading={primary.icon}
          className="min-w-[220px]"
        >
          {primary.label}
        </Button>

        {primary.hint ? (
          <div className="flex flex-col">
            <span className="eyebrow">Next</span>
            <span className="text-sm text-fg-secondary">{primary.hint}</span>
          </div>
        ) : null}

        {!isShowLoaded && !allReceiversOnline ? (
          <span className="inline-flex items-center gap-1.5 text-warn text-xs">
            <FaTriangleExclamation aria-hidden /> Some receivers offline
          </span>
        ) : null}

        {/* Preview cluster: subdued, right-justified. */}
        <div className="ml-auto flex items-center gap-2">
          <MiniWave
            audioTracks={audioTracks}
            previewPlaying={isPlaying}
            liveAudio={audioIsPlaying}
            audioOffsetMs={workingOffsetMs}
            muted={liveMuted}
            showTime={timeCursor}
            seekRequest={audioSeekReq}
            onAudioTime={onAudioTimeUpdate}
            onAudioInactive={onAudioInactive}
          />
          {hasAnyAudio ? (
            <SyncOffsetCluster
              liveOffsetMs={workingOffsetMs}
              savedOffsetMs={savedAudioOffsetMs}
              isPlaying={isPlaying || audioIsPlaying}
              onNudge={nudgeSync}
              onSave={saveSyncOffset}
            />
          ) : null}
          <label
            className={cn(
              "inline-flex items-center gap-1.5 text-xs select-none",
              previewDisabled
                ? "text-fg-muted cursor-not-allowed"
                : "text-fg-secondary cursor-pointer"
            )}
            title="Pop up YouTube previews as cues fire during preview playback"
          >
            <input
              type="checkbox"
              className="cursor-inherit"
              checked={!!playVideos}
              disabled={previewDisabled}
              onChange={(e) => onPlayVideosChange?.(e.target.checked)}
            />
            Play videos
          </label>
          <label
            className={cn(
              "inline-flex items-center gap-1.5 text-xs select-none",
              !canScrub
                ? "text-fg-muted cursor-not-allowed"
                : "text-fg-secondary cursor-pointer"
            )}
            title="Drag or click the timeline to move the cursor; the preview audio seeks to match. Available before the show is loaded."
          >
            <input
              type="checkbox"
              className="cursor-inherit"
              checked={!!scrubEnabled}
              disabled={!canScrub}
              onChange={(e) => onScrubEnabledChange?.(e.target.checked)}
            />
            Scrub
          </label>
          <IconButton
            label={isPlaying ? "Pause preview" : "Play preview"}
            variant="outline"
            disabled={previewDisabled}
            onClick={() => setIsPlaying(!isPlaying)}
          >
            {isPlaying ? <FaPause /> : <FaPlay />}
          </IconButton>
          <Stat
            label="Cursor"
            size="sm"
            numeric
            value={`${formatTime(timeCursor)} / ${formatTime(stagedShow?.duration || 0)}`}
          />
        </div>
      </div>
    </Card>
  );
}
