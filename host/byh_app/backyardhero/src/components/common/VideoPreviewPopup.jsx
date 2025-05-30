import React from "react";

const getEmbedLinkFromVideo = (video_link, startTime=0) => {
  const extractedVcode = video_link.split("/")[3];
  return `https://www.youtube.com/embed/${extractedVcode}?a=OvglRGHN8FQEj5Xs&amp;start=${startTime}&autoplay=1`
}

export default function VideoPreviewPopup({ isVisible, items, onClose }) {
  if (!isVisible) return null;

  return (
    <div className="fixed top-4 left-4 w-auto p-1 bg-gray-800 shadow-lg rounded-lg border border-gray-700 flex w-full z-50">
      <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-800"
        >
          &times;
        </button>
      {items.map((item,i)=> {
        return (
          <div className={`mt-0 ${item.hide ? 'hidden':''}`}>
            <p className="text-xs text-gray-500">{item.name}</p>
            {item && item.youtube_link && item.youtube_link !== "" ? (
              <iframe src={getEmbedLinkFromVideo(item.youtube_link, item.youtube_link_start_sec)} allow="autoplay"></iframe>
            ) : (
              <p className="text-gray-500">No details available.</p>
            )}
          </div>
        )
      })}
    </div>
  );
}