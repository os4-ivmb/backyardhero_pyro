import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { FaExplosion, FaGear, FaList } from "react-icons/fa6";
import { FiTarget, FiEdit, FiRadio, FiFilm } from "react-icons/fi";
import { MdAssignment, MdHome } from "react-icons/md";

import useAppStore from "@/store/useAppStore";
import useAppMode from "@/design/useAppMode";
import useIsMobile from "@/design/useIsMobile";
import useShowReceiverVerification from "@/util/useShowReceiverVerification";
import AppShell from "./shell/AppShell";
import TopBar from "./shell/TopBar";
import StatusBar from "./shell/StatusBar";

// Firing-path panels stay statically imported so the Console / Manual tabs
// are instantly interactive on first load.
import ManualFiring from "./manualFire/ManualFiring";
import ConsolePanel from "./console/ConsolePanel";

// W6: the heavy, non-firing tabs are code-split out of the first-load
// bundle. The Editor pulls in three / @react-three/fiber / leaflet, the
// receiver/loadout views pull in maps, and Inventory/Settings are large but
// rarely the operator's entry point. next/dynamic with ssr:false fetches
// each chunk only when its tab is first opened, keeping the ~1.7MB of 3D /
// map / waveform code off the critical firing screen.
const loading = () => (
  <div className="p-8 text-center text-fg-muted text-sm">Loading…</div>
);
const InventoryManager = dynamic(() => import("./inventory/InventoryManager"), { ssr: false, loading });
const SettingsPanel = dynamic(() => import("./settings/SettingsPanel"), { ssr: false, loading });
const ShowBuilder = dynamic(() => import("./builder/ShowBuilder"), { ssr: false, loading });
const ReceiverDisplay = dynamic(() => import("./receivers/ReceiverDisplay"), { ssr: false, loading });
const ShowLoadout = dynamic(() => import("./receivers/ShowLoadout"), { ssr: false, loading });
// Cloud-only show browser. On hardware boxes the Console tab already lists
// shows (ShowPicker); the cloud profile hides Console, so we surface the same
// picker as a dedicated "Shows" tab there.
const ShowPicker = dynamic(() => import("./console/ShowPicker"), { ssr: false, loading });

import MobileMainNav from "./mobile/MobileMainNav";

// ---------------------------------------------------------------------------
// MainNav is now a thin shell wrapper. All the per-tab logic moved to
// the panels themselves; chrome (header, mode badge, status footer) and
// mode-aware tab visibility live here. Panels are mounted lazily via the
// existing conditional-render pattern so heavy components (builder /
// loadout) don't run effects when their tab isn't active.
// ---------------------------------------------------------------------------

// `requiresHardware` tabs depend on the dongle/daemon/ws stack (live state,
// firing, flashing, GPIO). In the cloud profile (caps.hardware === false)
// they're hidden, collapsing the nav to the design-only surfaces
// (Editor / Inventory / Loadout). See Cloud Builder plan §3.1.
const TABS = [
  { key: "main",      label: "Console",   icon: <MdHome />,        alwaysVisible: true, requiresHardware: true },
  { key: "shows",     label: "Shows",     icon: <FiFilm />,        cloudOnly: true },
  { key: "receivers", label: "Receivers", icon: <FiRadio />,       requiresHardware: true },
  { key: "editor",    label: "Editor",    icon: <FiEdit /> },
  { key: "loadout",   label: "Loadout",   icon: <MdAssignment />,  alwaysVisible: true },
  { key: "inventory", label: "Inventory", icon: <FaList /> },
  { key: "manual",    label: "Manual",    icon: <FiTarget />,      alwaysVisible: true, requiresHardware: true },
  { key: "setting",   label: "Settings",  icon: <FaGear />,        requiresHardware: true },
];

function DesktopMainNav() {
  const {
    fetchInventory, fetchShows, fetchSystemConfig,
    stagedShow, shows, inventoryById, hydrateStagedShowFromId, systemConfig,
  } = useAppStore();
  const [currTab, setCurrTab] = useState("main");
  const hasStagedShow = Boolean(stagedShow?.id);
  const { mode } = useAppMode();
  // Deployment capabilities (from /api/system/config). Default to a hardware
  // profile until the config loads so the local box never flickers tabs;
  // the cloud build corrects this within the first config fetch.
  const caps = systemConfig?.caps || { hardware: true };
  const hardware = caps.hardware !== false;
  // Watch for receiver verification failures on the staged show. The
  // result drives a red X badge on the Receivers menu item and is also
  // consumed downstream by the Load Show gate in ShowControl.
  const verification = useShowReceiverVerification();

  // Loadout tab only makes sense when there's something staged. If the
  // user is on it and the staged show goes away, fall back to console.
  useEffect(() => {
    if (currTab === "loadout" && !hasStagedShow) setCurrTab("main");
  }, [currTab, hasStagedShow]);

  // Cloud profile: if the active tab requires hardware (Console / Receivers /
  // Manual / Settings) but this deployment has none, fall back to the Shows
  // browser so the operator lands on something useful (pick a show → Editor).
  useEffect(() => {
    if (hardware) return;
    const active = TABS.find((t) => t.key === currTab);
    if (active?.requiresHardware) setCurrTab("shows");
  }, [hardware, currTab]);

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
    if (t.requiresHardware && !hardware) return { ...t, hidden: true };
    if (t.cloudOnly && hardware) return { ...t, hidden: true };
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
      {currTab === "shows"     && (
        <ShowPicker
          onStaged={() => setCurrTab("editor")}
          title="Your shows"
          description="Pick a show to open it in the Editor."
          stageLabel="Open"
          emptyHint="No shows here yet. Build one in the Editor, or push shows up from a device via Settings → Cloud."
        />
      )}
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
