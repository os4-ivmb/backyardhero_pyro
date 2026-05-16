import React from "react";
import Image from "next/image";
import ModeBadge from "../shell/ModeBadge";

// Compact top strip for mobile. Logo on the left (small), mode badge
// in the centre/right -- mode changes are the single most important
// thing the operator needs to see across the room, so we leave it
// here even though it duplicates the bottom-nav highlight.
export default function MobileTopBar({ mode }) {
  return (
    <div className="flex items-center h-12 px-3 gap-2 select-none">
      <a
        href="/"
        className="flex items-center shrink-0"
        aria-label="Backyard Hero home"
      >
        <span className="relative h-10 w-20 overflow-hidden flex items-center justify-center">
          <Image
            src="/BYHLOGOv1.png"
            alt=""
            width={120}
            height={60}
            className="h-12 w-24 max-w-none object-contain"
            style={{ filter: "invert(1) brightness(1.08)" }}
          />
        </span>
      </a>
      <div className="ml-auto">
        <ModeBadge mode={mode} size="sm" />
      </div>
    </div>
  );
}
