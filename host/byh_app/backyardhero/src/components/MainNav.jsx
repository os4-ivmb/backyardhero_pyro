import React, { useEffect, useState } from "react";
import { FaExplosion, FaGear, FaList } from "react-icons/fa6";
import { FiTarget, FiEdit, FiRadio } from "react-icons/fi";
import { MdAssignment, MdHome } from "react-icons/md";

import useAppStore from "@/store/useAppStore";
import useAppMode from "@/design/useAppMode";
import useIsMobile from "@/design/useIsMobile";
import useShowReceiverVerification from "@/util/useShowReceiverVerification";
import AppShell from "./shell/AppShell";
import TopBar from "./shell/TopBar";
import StatusBar from "./shell/StatusBar";

import InventoryManager from "./inventory/InventoryManager";
import ManualFiring from "./manualFire/ManualFiring";
import ConsolePanel from "./console/ConsolePanel";
import SettingsPanel from "./settings/SettingsPanel";
import ShowBuilder from "./builder/ShowBuilder";
import ReceiverDisplay from "./receivers/ReceiverDisplay";
import ShowLoadout from "./receivers/ShowLoadout";

import MobileMainNav from "./mobile/MobileMainNav";

// ---------------------------------------------------------------------------
// MainNav is now a thin shell wrapper. All the per-tab logic moved to
// the panels themselves; chrome (header, mode badge, status footer) and
// mode-aware tab visibility live here. Panels are mounted lazily via the
// existing conditional-render pattern so heavy components (builder /
// loadout) don't run effects when their tab isn't active.
// ---------------------------------------------------------------------------

const TABS = [
  { key: "main",      label: "Console",   icon: <MdHome />,        alwaysVisible: true },
  { key: "receivers", label: "Receivers", icon: <FiRadio /> },
  { key: "editor",    label: "Editor",    icon: <FiEdit /> },
  { key: "loadout",   label: "Loadout",   icon: <MdAssignment />,  alwaysVisible: true },
  { key: "inventory", label: "Inventory", icon: <FaList /> },
  { key: "manual",    label: "Manual",    icon: <FiTarget />,      alwaysVisible: true },
  { key: "setting",   label: "Settings",  icon: <FaGear /> },
];

function DesktopMainNav() {
  const {
    fetchInventory, fetchShows, fetchSystemConfig,
    stagedShow, shows, inventoryById, hydrateStagedShowFromId,
  } = useAppStore();
  const [currTab, setCurrTab] = useState("main");
  const hasStagedShow = Boolean(stagedShow?.id);
  const { mode } = useAppMode();
  // Watch for receiver verification failures on the staged show. The
  // result drives a red X badge on the Receivers menu item and is also
  // consumed downstream by the Load Show gate in ShowControl.
  const verification = useShowReceiverVerification();

  // Loadout tab only makes sense when there's something staged. If the
  // user is on it and the staged show goes away, fall back to console.
  useEffect(() => {
    if (currTab === "loadout" && !hasStagedShow) setCurrTab("main");
  }, [currTab, hasStagedShow]);

  useEffect(() => { fetchInventory(); }, [fetchInventory]);
  useEffect(() => { fetchShows(); }, [fetchShows]);
  useEffect(() => { fetchSystemConfig(); }, [fetchSystemConfig]);

  // Re-stage the previously-staged show from localStorage once both
  // shows and inventory have populated. Idempotent: the action no-ops if
  // there's nothing persisted or if the rich object is already in sync.
  useEffect(() => {
    hydrateStagedShowFromId();
  }, [shows, inventoryById, hydrateStagedShowFromId]);

  const tabs = TABS.map((t) => {
    if (t.key === "loadout") return { ...t, hidden: !hasStagedShow };
    if (t.key === "receivers" && verification.hasError) {
      return {
        ...t,
        errorBadge:
          verification.summary
            ? `Show receiver issues: ${verification.summary}`
            : "Show receiver issues",
      };
    }
    return t;
  });

  const armedRail = mode.id === "armed" || mode.id === "live" || mode.id === "manual_fire";

  return (
    <AppShell
      armedRail={armedRail}
      topBar={
        <TopBar
          tabs={tabs}
          currentTab={currTab}
          onTabChange={setCurrTab}
          mode={mode}
        />
      }
      statusBar={<StatusBar />}
    >
      {currTab === "main"      && <ConsolePanel setCurrentTab={setCurrTab} />}
      {currTab === "inventory" && <InventoryManager />}
      {currTab === "editor"    && <ShowBuilder />}
      {currTab === "receivers" && <ReceiverDisplay setCurrentTab={setCurrTab} />}
      {currTab === "loadout"   && <ShowLoadout setCurrentTab={setCurrTab} />}
      {currTab === "manual"    && <ManualFiring />}
      {currTab === "setting"   && <SettingsPanel />}
    </AppShell>
  );
}

// Top-level chrome dispatcher. The mobile path is *physically* a
// different component tree (different shell, different panels) rather
// than CSS variations, so we mount one or the other based on the
// viewport. Mounting/unmounting either branch is cheap because each
// path owns its own data fetching effects -- never mounted in
// parallel, never double-fetching.
export default function MainNav() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileMainNav /> : <DesktopMainNav />;
}
