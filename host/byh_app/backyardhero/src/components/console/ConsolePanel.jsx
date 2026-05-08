import React, { useEffect, useMemo, useRef, useState } from "react";

import useAppStore from "@/store/useAppStore";
import useStateAppStore from "@/store/useStateAppStore";
import useAppMode from "@/design/useAppMode";

import ShowPicker from "./ShowPicker";
import ShowControl from "./ShowControl";
import ShowHealthStrip from "./ShowHealthStrip";
import ShowDetails from "./ShowDetails";
import Timeline from "../common/Timeline";
import VideoPreviewPopup from "../common/VideoPreviewPopup";
import { Card } from "@/design";
import { isPollableReceiver } from "@/util/receivers";
import { parseAudioField } from "@/utils/audioTracks";

// ---------------------------------------------------------------------------
// ConsolePanel — the operational console (replaces homepanel/StatusPanel.jsx).
//
// Layout when a show is staged (top to bottom):
//
//   ┌────────────────────────────────────────────────────────────┐
//   │ ShowControl   primary action + cursor + preview            │
//   ├────────────────────────────────────────────────────────────┤
//   │ ShowHealthStrip   4 receiver pre-flight metrics, calm      │
//   ├────────────────────────────────────────────────────────────┤
//   │ Timeline (gets the visual majority of the screen)          │
//   ├────────────────────────────────────────────────────────────┤
//   │ ShowDetails  collapsible: errors / status explainer        │
//   └────────────────────────────────────────────────────────────┘
//
// When no show is staged → ShowPicker takes the whole canvas.
// ---------------------------------------------------------------------------

export default function ConsolePanel() {
  const {
    stagedShow, shows, setStagedShow, setLoadedShow, inventoryById, systemConfig,
  } = useAppStore();
  const { stateData } = useStateAppStore();
  const { isShowLoaded } = useAppMode();

  const [timeCursor, setTimeCursor] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [vidItems, setVidItems] = useState([]);
  const [countdownSeconds, setCountdownSeconds] = useState(null);
  const [audioIsPlaying, setAudioIsPlaying] = useState(false);
  // Working show-level audio sync offset (ms). Positive = music plays
  // BEFORE cue 0 (audio is "ahead"); negative = music plays after.
  // Seeded from the saved value when a show is staged; mutated by the
  // ±50ms scrubber in ShowControl while a rehearsal is going. The
  // sst-based start scheduler below uses this value to fire the audio
  // earlier or later than the daemon's start instant so the operator
  // can dial out the systematic browser/audio-driver startup delay.
  const [liveAudioOffsetMs, setLiveAudioOffsetMs] = useState(0);
  useEffect(() => {
    setLiveAudioOffsetMs(
      Number.isFinite(stagedShow?.audioOffsetMs) ? stagedShow.audioOffsetMs : 0
    );
    // Reset is keyed on the show identity, not the offset value, so a
    // save round-trip back into stagedShow doesn't clobber whatever the
    // operator was working on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagedShow?.id]);
  // Preview-only setting: whether to pop up the YouTube video previews as
  // cues fire during a local Play preview. Off by default so the preview
  // doesn't autoplay videos every time the operator scrubs the show; the
  // operator opts in via the checkbox in ShowControl.
  const [playVideos, setPlayVideos] = useState(false);
  const lastUpdateTimeRef = useRef(null);
  const requestRef = useRef(null);
  const countdownIntervalRef = useRef(null);
  const prevProtoHandlerStatusRef = useRef(null);
  const useAudioTimeRef = useRef(false);

  // -------------------------------------------------------------------------
  // Receiver online check (preserved from StatusPanel). The result feeds the
  // ShowControl hint and the ShowHealth strip.
  // -------------------------------------------------------------------------
  // "All receivers online" gates the Load action's warning chip. It only
  // considers pollable receivers -- TX-only units (bilusocn) can never
  // report status back, so we don't block on them.
  const allReceiversOnline = useMemo(() => {
    if (!stagedShow || !stagedShow.items) return true;
    const receivers = stateData.fw_state?.receivers || systemConfig?.receivers || {};
    const showReceivers = new Set();
    stagedShow.items.forEach((item) => {
      if (!item.zone || !item.target) return;
      Object.entries(receivers).forEach(([k, r]) => {
        if (!isPollableReceiver(r)) return;
        if (r.cues?.[item.zone]?.includes(item.target)) showReceivers.add(k);
      });
    });
    let allOnline = true;
    showReceivers.forEach((k) => {
      const r = receivers[k];
      if (!r) { allOnline = false; return; }
      const lmt = r.status?.lmt;
      if (lmt) { if (Date.now() - lmt > 10_000) allOnline = false; }
      else if (r.connectionStatus !== "good") allOnline = false;
    });
    return allOnline;
  }, [stagedShow, stateData.fw_state?.receivers, systemConfig]);

  // -------------------------------------------------------------------------
  // Sync UI staged/loaded show with daemon's loaded_show_id on first connect.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!stateData.fw_state?.loaded_show_id || !shows.length) return;
    const found = shows.find((s) => s.id === stateData.fw_state.loaded_show_id);
    if (!found) return;
    let parsedItems = [];
    try {
      parsedItems = JSON.parse(found.display_payload).map((pi) => ({
        ...inventoryById[pi.itemId], ...pi,
      }));
    } catch { /* tolerate */ }
    let audioTracks = [];
    let audioFile = null;
    let audioOffsetMs = 0;
    if (found.audio_file) {
      try {
        const r = parseAudioField(JSON.parse(found.audio_file));
        audioTracks = r.tracks;
        audioOffsetMs = r.audioOffsetMs;
        audioFile = audioTracks[0] || null;
      } catch { /* */ }
    }
    const merged = { ...found, items: parsedItems, audioFile, audioTracks, audioOffsetMs };
    setStagedShow(merged);
    setLoadedShow(merged);
  }, [stateData.fw_state?.loaded_show_id, shows, inventoryById, setStagedShow, setLoadedShow]);

  // -------------------------------------------------------------------------
  // Audio start/stop tracking.
  //
  // The daemon publishes `sst` (laptop wall-clock ms at which cue 0 will
  // fire) once the proto handler reaches START_CONFIRMED. We schedule
  // the audio play directly off that timestamp instead of waiting for
  // the proto_handler_status change to STARTED to round-trip through
  // the websocket -> store -> render -> effect -> MiniWave -> play()
  // chain. Sidestepping that chain takes the systematic music-vs-cues
  // delay from ~50-100ms down to one React commit + wavesurfer's own
  // play() startup, which is in the noise of the per-song offset
  // scrubber.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const status = stateData.fw_state?.proto_handler_status;
    const sst = stateData.fw_state?.sst;
    if (status !== "START_CONFIRMED" || !Number.isFinite(sst)) return;
    // sign convention: +offset = audio starts BEFORE sst, so the
    // wake-up time we schedule is `sst - offset`. setTimeout with a
    // non-positive delay fires immediately, which correctly handles a
    // mid-countdown nudge that pushes the wake-up into the past.
    const audioStartMs = sst - liveAudioOffsetMs;
    const delay = Math.max(0, audioStartMs - Date.now());
    const timer = setTimeout(() => setAudioIsPlaying(true), delay);
    // If the operator aborts mid-countdown the status leaves
    // START_CONFIRMED and this effect re-runs, clearing the timer so
    // we don't kick off audio after the show has been cancelled. Also
    // re-runs on offset change so a live nudge during the countdown
    // re-aims the timer.
    return () => clearTimeout(timer);
  }, [stateData.fw_state?.proto_handler_status, stateData.fw_state?.sst, liveAudioOffsetMs]);

  // Fallback / stop. The scheduled timer above is the fast path; the
  // status-edge effect here covers two cases it doesn't:
  //   * STARTED arrives without a prior START_CONFIRMED+sst (or after
  //     a page refresh into a running show), so audio still kicks on.
  //   * Anything other than STARTED -> stop audio.
  useEffect(() => {
    const cur = stateData.fw_state?.proto_handler_status;
    const prev = prevProtoHandlerStatusRef.current;
    if (cur === "STARTED" && prev !== "STARTED") setAudioIsPlaying(true);
    if (prev === "STARTED" && cur !== "STARTED") setAudioIsPlaying(false);
    prevProtoHandlerStatusRef.current = cur;
  }, [stateData.fw_state?.proto_handler_status]);

  // We treat the show as "audio-driven" if at least one track has a URL.
  // The legacy single audioFile alias keeps working for any older shows
  // that haven't been migrated; the canonical source is audioTracks.
  const hasAudio =
    (Array.isArray(stagedShow?.audioTracks) &&
      stagedShow.audioTracks.some((t) => t?.url)) ||
    !!stagedShow?.audioFile?.url;

  // Audio time → cursor + preview items (preserved).
  const handleAudioTimeUpdate = (time) => {
    if (isPlaying && hasAudio) {
      setTimeCursor(time);
      useAudioTimeRef.current = true;
      const items = stagedShow.items
        .filter((o) => o.startTime - 1.5 < time)
        .sort((a, b) => a.startTime - b.startTime);
      setVidItems(items.map((o) => ({ ...o, hide: o.startTime + o.duration < time })));
    }
  };

  // Manual cursor tick when audio isn't driving (preserved).
  const updateCursor = (timestamp) => {
    if (hasAudio && useAudioTimeRef.current) {
      requestRef.current = requestAnimationFrame(updateCursor);
      return;
    }
    if (!lastUpdateTimeRef.current) lastUpdateTimeRef.current = timestamp;
    const elapsed = (timestamp - lastUpdateTimeRef.current) / 1000;
    setTimeCursor((prev) => {
      const next = prev + elapsed;
      const items = stagedShow.items
        .filter((o) => o.startTime - 1.5 < next)
        .sort((a, b) => a.startTime - b.startTime);
      setVidItems(items.map((o) => ({ ...o, hide: o.startTime + o.duration < next })));
      return next >= stagedShow.duration ? stagedShow.duration : next;
    });
    lastUpdateTimeRef.current = timestamp;
    requestRef.current = requestAnimationFrame(updateCursor);
  };

  useEffect(() => {
    if (stateData.fw_state?.show_running) setTimeCursor(stateData.fw_cursor);
  }, [stateData.fw_state?.show_running, stateData.fw_cursor]);

  useEffect(() => {
    if (isPlaying && stagedShow?.items) {
      requestRef.current = requestAnimationFrame(updateCursor);
    } else {
      cancelAnimationFrame(requestRef.current);
    }
    return () => cancelAnimationFrame(requestRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, stagedShow]);

  // Countdown timer for START_CONFIRMED phase.
  useEffect(() => {
    const status = stateData.fw_state?.proto_handler_status;
    const sst = stateData.fw_state?.sst;
    if (status === "START_CONFIRMED" && sst) {
      const tick = () => {
        const remaining = Math.max(0, Math.floor((sst - Date.now()) / 1000));
        setCountdownSeconds(remaining);
        if (remaining === 0 && countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
      };
      tick();
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = setInterval(tick, 1000);
    } else {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      setCountdownSeconds(null);
    }
    return () => {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, [stateData.fw_state?.proto_handler_status, stateData.fw_state?.sst]);

  // -------------------------------------------------------------------------
  // Derived flags reused by ShowControl / ShowDetails.
  // -------------------------------------------------------------------------
  const errors = useMemo(() => {
    return [
      ...(stateData.fw_state?.fire_check_failures || []),
      ...(stateData.fw_state?.proto_handler_errors || []),
    ];
  }, [stateData.fw_state?.fire_check_failures, stateData.fw_state?.proto_handler_errors]);

  const hasErrors = errors.length > 0;
  const isReadyToFire = isShowLoaded && !hasErrors;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (!stagedShow?.items) return <ShowPicker />;

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-3">
      <ShowControl
        timeCursor={timeCursor}
        setTimeCursor={setTimeCursor}
        isPlaying={isPlaying}
        setIsPlaying={(v) => {
          setIsPlaying(v);
          if (!hasAudio) {
            useAudioTimeRef.current = false;
            if (v) {
              setTimeCursor(0);
              lastUpdateTimeRef.current = null;
            }
          }
        }}
        audioIsPlaying={audioIsPlaying}
        onAudioTimeUpdate={handleAudioTimeUpdate}
        countdownSeconds={countdownSeconds}
        isReadyToFire={isReadyToFire}
        hasErrors={hasErrors}
        allReceiversOnline={allReceiversOnline}
        errors={errors}
        playVideos={playVideos}
        onPlayVideosChange={setPlayVideos}
        liveAudioOffsetMs={liveAudioOffsetMs}
        onLiveAudioOffsetMsChange={setLiveAudioOffsetMs}
      />

      <ShowHealthStrip />

      <Card padding="none" tone="neutral" className="overflow-hidden">
        <Timeline
          items={stagedShow.items}
          setTimeCursor={setTimeCursor}
          timeCursor={timeCursor}
          readOnly
          timeCapSeconds={stagedShow.duration}
          audioTracks={stagedShow.audioTracks}
        />
      </Card>

      <ShowDetails
        errors={errors}
        protoHandlerStatus={stateData.fw_state?.proto_handler_status}
      />

      {playVideos && vidItems.length ? (
        <VideoPreviewPopup items={vidItems} isVisible={isPlaying && vidItems.length} />
      ) : null}
    </div>
  );
}
