import React from "react";
import { cn } from "@/design";

// Three-row grid: top nav, main scrollable area, footer status bar.
//
// Height is locked to the viewport (`h-[100dvh]` with an `h-screen`
// fallback for browsers that don't support dynamic viewport units).
// `min-h-screen` was wrong here because it let the grid container grow
// past the viewport when the inner content overflowed — at which point
// the `1fr` row stopped clamping and the footer fell off the bottom of
// the screen. With a fixed viewport height, `<main>` becomes the scroll
// container and the StatusBar stays anchored to the bottom edge no
// matter how tall the page is.
//
// `armedRail` renders a fixed barber-pole hairline at the very top of the
// viewport. It only appears in `armed` / `live` modes and is the single
// strongest peripheral-vision cue that the system is dangerous.
export default function AppShell({ topBar, statusBar, armedRail, children }) {
  return (
    <div
      className={cn(
        "w-full grid bg-surface-base text-fg-primary",
        "h-screen h-[100dvh]",
        "grid-rows-[auto_minmax(0,1fr)_auto]"
      )}
    >
      {armedRail ? <div className="armed-rail" aria-hidden /> : null}
      <header className="z-40 bg-surface-base/95 backdrop-blur border-b border-border-subtle">
        {topBar}
      </header>
      <main className="min-w-0 min-h-0 overflow-y-auto">
        {children}
      </main>
      {statusBar ? (
        <footer className="z-40 border-t border-border-subtle bg-surface-1/95 backdrop-blur">
          {statusBar}
        </footer>
      ) : null}
    </div>
  );
}
