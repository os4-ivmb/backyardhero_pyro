import React, { useEffect, useState } from "react";
import { FaList, FaGear } from "react-icons/fa6";
import { FiTarget, FiEdit, FiRadio } from "react-icons/fi";
import { MdAssignment, MdHome } from "react-icons/md";

import useAppStore from "@/store/useAppStore";
import useAppMode from "@/design/useAppMode";
import useShowReceiverVerification from "@/util/useShowReceiverVerification";

import MobileShell from "./MobileShell";
import MobileTopBar from "./MobileTopBar";
import MobileBottomNav from "./MobileBottomNav";
import MobileStatusBar from "./MobileStatusBar";

import MobileConsolePanel from "./panels/MobileConsolePanel";
import MobileInventoryManager from "./panels/MobileInventoryManager";
import MobileManualFiring from "./panels/MobileManualFiring";
import MobileReceiverDisplay from "./panels/MobileReceiverDisplay";
import MobileShowLoadout from "./panels/MobileShowLoadout";
import MobileSettingsPanel from "./panels/MobileSettingsPanel";
import MobileShowBuilderPlaceholder from "./panels/MobileShowBuilderPlaceholder";

// Mobile-only twin of `MainNav.jsx`. Owns the same fetch lifecycle and
// staged-show hydration so behaviour is identical across the desktop /
// mobile split. The visual surface is entirely different: mobile uses
// a bottom tab bar with a +More sheet plus a collapsible status sheet
// just above it.
//
// Tab order is tuned for the mobile firing-night use case: Console
// first (the live show lives there), Manual fire second, Receivers
// third, Loadout fourth (only when a show is staged). The +More sheet
// holds Inventory, Editor, and Settings; Editor on mobile is just a
// "use a tablet" placeholder so it's intentionally tucked away.
const TABS = [
  { key: "main",      label: "Console",   icon: <MdHome />,        alwaysVisible: true },
  { key: "manual",    label: "Manual",    icon: <FiTarget />,      alwaysVisible: true },
  { key: "receivers", label: "Receivers", icon: <FiRadio /> },
  { key: "loadout",   label: "Loadout",   icon: <MdAssignment />,  alwaysVisible: true },
  { key: "inventory", label: "Inventory", icon: <FaList /> },
  { key: "editor",    label: "Editor",    icon: <FiEdit /> },
  { key: "setting",   label: "Settings",  icon: <FaGear /> },
];

export default function MobileMainNav() {
  const {
    fetchInventory, fetchShows, fetchSystemConfig,
    stagedShow, shows, inventoryById, hydrateStagedShowFromId,
  } = useAppStore();
  const [currTab, setCurrTab] = useState("main");
  const hasStagedShow = Boolean(stagedShow?.id);
  const { mode } = useAppMode();
  const verification = useShowReceiverVerification();

  useEffect(() => {
    if (currTab === "loadout" && !hasStagedShow) setCurrTab("main");
  }, [currTab, hasStagedShow]);

  useEffect(() => { fetchInventory(); }, [fetchInventory]);
  useEffect(() => { fetchShows(); }, [fetchShows]);
  useEffect(() => { fetchSystemConfig(); }, [fetchSystemConfig]);

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
    <MobileShell
      armedRail={armedRail}
      topBar={<MobileTopBar mode={mode} />}
      bottomNav={
        <MobileBottomNav
          tabs={tabs}
          currentTab={currTab}
          onTabChange={setCurrTab}
        />
      }
      statusBar={<MobileStatusBar />}
    >
      {currTab === "main"      && <MobileConsolePanel setCurrentTab={setCurrTab} />}
      {currTab === "inventory" && <MobileInventoryManager />}
      {currTab === "editor"    && <MobileShowBuilderPlaceholder />}
      {currTab === "receivers" && <MobileReceiverDisplay setCurrentTab={setCurrTab} />}
      {currTab === "loadout"   && <MobileShowLoadout setCurrentTab={setCurrTab} />}
      {currTab === "manual"    && <MobileManualFiring />}
      {currTab === "setting"   && <MobileSettingsPanel />}
    </MobileShell>
  );
}
