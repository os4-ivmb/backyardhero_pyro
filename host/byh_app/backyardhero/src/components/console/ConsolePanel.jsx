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
    let audioFile = null;
    if (found.audio_file) {
      try { audioFile = JSON.parse(found.audio_file); } catch { /* */ }
    }
    const merged = { ...found, items: parsedItems, audioFile };
    setStagedShow(merged);
    setLoadedShow(merged);
  }, [stateData.fw_state?.loaded_show_id, shows, inventoryById, setStagedShow, setLoadedShow]);

  // -------------------------------------------------------------------------
  // Audio start/stop tracking (preserved).
  // -------------------------------------------------------------------------
  useEffect(() => {
    const cur = stateData.fw_state?.proto_handler_status;
    const prev = prevProtoHandlerStatusRef.current;
    if (prev === "START_PENDING" && cur === "STARTED") setAudioIsPlaying(true);
    if (prev === "STARTED" && cur !== "STARTED") setAudioIsPlaying(false);
    prevProtoHandlerStatusRef.current = cur;
  }, [stateData.fw_state?.proto_handler_status]);

  // Audio time → cursor + preview items (preserved).
  const handleAudioTimeUpdate = (time) => {
    if (isPlaying && stagedShow?.audioFile?.url) {
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
    if (stagedShow?.audioFile?.url && useAudioTimeRef.current) {
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
          if (!stagedShow?.audioFile?.url) {
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
      />

      <ShowHealthStrip />

      <Card padding="none" tone="neutral" className="overflow-hidden">
        <Timeline
          items={stagedShow.items}
          setTimeCursor={setTimeCursor}
          timeCursor={timeCursor}
          readOnly
          timeCapSeconds={stagedShow.duration}
          bpm={stagedShow.audioFile?.bpm}
          firstBeatOffsetSec={stagedShow.audioFile?.firstBeatOffsetSec}
          beatsPerMeasure={stagedShow.audioFile?.beatsPerMeasure}
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
