import React, { useRef, useState } from "react";
import usePersistentState from "@/utils/usePersistentState";

const getEmbedLinkFromVideo = (video_link, startTime=0) => {
  const extractedVcode = video_link.split("/")[3];
  return `https://www.youtube.com/embed/${extractedVcode}?a=OvglRGHN8FQEj5Xs&amp;start=${startTime}&autoplay=1`
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

export default function VideoPreviewPopup({ isVisible, items, onClose }) {
  // Persisted top-left corner of the floating window (px). Committed once on
  // drop; the live drag position lives in `dragPos` so we don't thrash
  // localStorage on every pointermove.
  const [savedPos, setSavedPos] = usePersistentState("byh.editor.videoPopupPos", { x: 16, y: 96 });
  const [dragPos, setDragPos] = useState(null);
  // True only while a drag is in flight. Used to disable hit-testing on the
  // video iframe: iframes are separate documents that swallow pointer events,
  // so without this the window-level pointermove stalls the moment the cursor
  // crosses the video and the drag "sticks".
  const [dragging, setDragging] = useState(false);
  const winRef = useRef(null);
  const dragRef = useRef(null);
  const pos = dragPos || savedPos;

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const w = winRef.current?.offsetWidth || 320;
    const h = winRef.current?.offsetHeight || 200;
    const nx = clamp(d.baseX + (e.clientX - d.startX), 0, window.innerWidth - w);
    const ny = clamp(d.baseY + (e.clientY - d.startY), 0, window.innerHeight - h);
    d.last = { x: nx, y: ny };
    setDragPos(d.last);
  };

  const endDrag = () => {
    const d = dragRef.current;
    if (d?.last) setSavedPos(d.last);
    dragRef.current = null;
    setDragPos(null);
    setDragging(false);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
  };

  // Drag only from the title bar so clicks inside the video/body don't move it.
  const onHeaderPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y, last: null };
    setDragging(true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
  };

  if (!isVisible) return null;

  return (
    <div
      ref={winRef}
      className="fixed z-[100] w-[340px] max-w-[90vw] rounded-lg border border-gray-700 bg-gray-800/95 shadow-lg"
      style={{ left: pos.x, top: pos.y }}
    >
      {/* Title bar doubles as the drag handle. */}
      <div
        onPointerDown={onHeaderPointerDown}
        className="flex items-center justify-between gap-2 px-2 py-1 cursor-move select-none rounded-t-lg border-b border-gray-700 bg-gray-900/60"
      >
        <span className="text-xs font-medium text-gray-300">Video preview</span>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white text-lg leading-none px-1"
          aria-label="Close preview"
        >
          &times;
        </button>
      </div>
      <div className="flex flex-wrap gap-2 p-2">
        {items.map((item, i) => (
          <div key={i} className={`mt-0 ${item.hide ? 'hidden' : ''}`}>
            <p className="text-xs text-gray-400 mb-1">{item.name}</p>
            {item && item.youtube_link && item.youtube_link !== "" ? (
              <iframe
                src={getEmbedLinkFromVideo(item.youtube_link, item.youtube_link_start_sec)}
                allow="autoplay"
                className="w-full aspect-video rounded"
                style={{ pointerEvents: dragging ? "none" : "auto" }}
              ></iframe>
            ) : (
              <p className="text-gray-500">No details available.</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
