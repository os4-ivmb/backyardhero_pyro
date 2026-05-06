import React from "react";
import Image from "next/image";
import { cn } from "@/design";
import ModeBadge from "./ModeBadge";

// Top navigation strip. Tabs collapse / hide based on operational mode:
//   - In armed/live the design-time tabs (Editor/Inventory/Settings) are
//     hidden; only operationally-relevant surfaces remain.
//   - In disconnected the inventory and editor stay accessible because
//     they're DB-only and don't need the daemon.
//
// We deliberately use icons + labels (not icon-only) — icon-only is one of
// the call-outs in the design brief. Text scales down before icons disappear.
export default function TopBar({
  tabs,
  currentTab,
  onTabChange,
  mode,
  rightSlot,
}) {
  const reducedNav = mode?.id === "armed" || mode?.id === "live";

  const visibleTabs = tabs.filter((t) => {
    if (t.hidden) return false;
    if (reducedNav && !t.alwaysVisible) return false;
    return true;
  });

  return (
    <div className="flex items-stretch h-12 px-2 gap-2 select-none">
      <a
        href="/"
        className="flex items-center gap-3 px-2 shrink-0"
        aria-label="Backyard Hero home"
      >
        <span className="relative h-12 w-28 overflow-hidden shrink-0 flex items-center justify-center">
          <Image
            src="/BYHLOGOv1.png"
            alt=""
            width={156}
            height={78}
            className="h-16 w-36 max-w-none object-contain scale-125"
            style={{
              filter: "invert(1) brightness(1.08)",
            }}
          />
        </span>
        <span className="hidden sm:inline-block text-fg-secondary text-sm font-semibold tracking-wide">
          Backyard Hero
        </span>
      </a>

      <div className="self-center">
        <ModeBadge mode={mode} size="md" />
      </div>

      <nav className="flex items-stretch flex-1 min-w-0 ml-2" role="tablist">
        {visibleTabs.map((tab) => {
          const active = tab.key === currentTab;
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(tab.key)}
              className={cn(
                "relative inline-flex items-center gap-2 px-3 h-full text-sm font-medium transition-colors",
                "border-b-2",
                active
                  ? "text-fg-primary border-accent"
                  : "text-fg-muted border-transparent hover:text-fg-secondary"
              )}
            >
              <span className="text-base">{tab.icon}</span>
              <span className="hidden md:inline">{tab.label}</span>
              {tab.badge ? (
                <span className="ml-1 px-1.5 py-0.5 text-2xs rounded-sm bg-accent-muted text-accent-fg">
                  {tab.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {rightSlot ? (
        <div className="flex items-center gap-2 pr-2 shrink-0">{rightSlot}</div>
      ) : null}
    </div>
  );
}
