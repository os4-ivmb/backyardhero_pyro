import React, { useState, useEffect } from "react";
import { FaCircleXmark } from "react-icons/fa6";
import { MdMoreHoriz, MdClose } from "react-icons/md";
import { cn } from "@/design";

// Bottom tab bar for mobile. Up to 4 primary tabs are always visible;
// anything else is tucked into the "More" bottom sheet. We split this
// way (rather than a horizontal scroll) so the operator never has to
// hunt for a tab that scrolled off-screen mid-show.
//
// Tab order is dictated by the parent (MobileMainNav). All visible
// tabs share the same width so the strip behaves like a fixed grid.
const PRIMARY_LIMIT = 4;

export default function MobileBottomNav({
  tabs,
  currentTab,
  onTabChange,
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const visible = tabs.filter((t) => !t.hidden);
  const primary = visible.slice(0, PRIMARY_LIMIT);
  const overflow = visible.slice(PRIMARY_LIMIT);
  const overflowActive = overflow.some((t) => t.key === currentTab);
  const showMoreButton = overflow.length > 0;

  // Close the sheet whenever the active tab changes from outside (e.g.
  // a panel programmatically navigates) so it doesn't sit stale on top
  // of the new view.
  useEffect(() => { setMoreOpen(false); }, [currentTab]);

  const tabButton = (tab, opts = {}) => {
    const active = tab.key === currentTab;
    return (
      <button
        key={tab.key}
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => {
          onTabChange(tab.key);
          setMoreOpen(false);
        }}
        className={cn(
          "relative flex-1 inline-flex flex-col items-center justify-center gap-0.5",
          "h-full min-w-0 px-1 text-2xs select-none transition-colors",
          active
            ? "text-fg-primary"
            : "text-fg-muted hover:text-fg-secondary",
          opts.fullWidth && "w-full flex-row gap-3 h-12 justify-start px-4 text-sm"
        )}
      >
        {/* Active indicator pill -- a thin top-line on bottom-nav, an
            accent dot in the more-sheet rows. */}
        {active && !opts.fullWidth ? (
          <span
            className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-b bg-accent"
            aria-hidden
          />
        ) : null}
        <span
          className={cn(
            "shrink-0",
            opts.fullWidth ? "text-lg" : "text-xl"
          )}
        >
          {tab.icon}
        </span>
        <span className={cn(
          opts.fullWidth ? "" : "leading-none truncate max-w-full"
        )}>
          {tab.label}
        </span>
        {tab.errorBadge ? (
          <FaCircleXmark
            className={cn(
              "text-danger-fg shrink-0",
              opts.fullWidth ? "ml-auto text-base" : "absolute top-1 right-3 text-xs"
            )}
            title={
              typeof tab.errorBadge === "string"
                ? tab.errorBadge
                : "Verification errors"
            }
            aria-label="verification errors"
          />
        ) : null}
      </button>
    );
  };

  return (
    <div className="relative">
      <nav
        role="tablist"
        className="flex items-stretch h-14"
      >
        {primary.map((t) => tabButton(t))}
        {showMoreButton ? (
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-label="More tabs"
            className={cn(
              "relative flex-1 inline-flex flex-col items-center justify-center gap-0.5",
              "h-full min-w-0 px-1 text-2xs select-none transition-colors",
              overflowActive || moreOpen
                ? "text-fg-primary"
                : "text-fg-muted hover:text-fg-secondary"
            )}
          >
            {overflowActive && !moreOpen ? (
              <span
                className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-b bg-accent"
                aria-hidden
              />
            ) : null}
            <span className="shrink-0 text-xl">
              {moreOpen ? <MdClose /> : <MdMoreHoriz />}
            </span>
            <span className="leading-none">More</span>
          </button>
        ) : null}
      </nav>

      {moreOpen ? (
        <>
          {/* Backdrop -- click-outside to close. */}
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
            onClick={() => setMoreOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal
            className={cn(
              "absolute bottom-full left-0 right-0 z-50",
              "bg-surface-1 border-t border-border-subtle shadow-e3"
            )}
          >
            <div className="px-3 pt-2 pb-1 eyebrow text-fg-muted">
              More
            </div>
            <ul className="flex flex-col">
              {overflow.map((t) => (
                <li key={t.key} className="border-t border-border-subtle">
                  {tabButton(t, { fullWidth: true })}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}
