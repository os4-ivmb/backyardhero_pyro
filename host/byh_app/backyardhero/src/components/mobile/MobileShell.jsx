import React from "react";
import { cn } from "@/design";

// Mobile-only chrome shell. Three rows:
//   1. Compact top bar: logo + mode badge.
//   2. Scrollable main content (mobile-tuned panels live in this slot).
//   3. Bottom tab bar: thumb-friendly nav with a `+more` sheet for
//      secondary tabs.
//
// A condensed status sheet is exposed via a swipe-up handle docked just
// above the bottom nav -- desktop's StatusBar holds far too much
// information for a 390px-wide viewport, so the mobile variant collapses
// it to the most operationally critical signals (Link, Receivers, Show)
// and tucks the rest behind an expander.
//
// `armedRail` is preserved verbatim from the desktop AppShell -- the
// barber-pole hairline is the single strongest peripheral cue we have
// and we want it on a phone, too.
export default function MobileShell({
  topBar,
  bottomNav,
  statusBar,
  armedRail,
  children,
}) {
  return (
    <div
      className={cn(
        "w-full grid bg-surface-base text-fg-primary",
        "h-screen h-[100dvh]",
        "grid-rows-[auto_minmax(0,1fr)_auto_auto]"
      )}
    >
      {armedRail ? <div className="armed-rail" aria-hidden /> : null}
      <header className="z-40 bg-surface-base/95 backdrop-blur border-b border-border-subtle">
        {topBar}
      </header>
      <main className="min-w-0 min-h-0 overflow-y-auto overscroll-contain">
        {children}
      </main>
      {statusBar ? (
        <div className="border-t border-border-subtle bg-surface-1/95 backdrop-blur">
          {statusBar}
        </div>
      ) : null}
      {bottomNav ? (
        <footer className="z-40 border-t border-border-subtle bg-surface-1/98 backdrop-blur safe-bottom">
          {bottomNav}
        </footer>
      ) : null}
    </div>
  );
}
