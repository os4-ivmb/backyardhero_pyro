import React, { useState, useMemo, useEffect } from "react";
import {
  MdOutlineSettingsRemote,
  MdOutlineBugReport,
  MdOutlineRocketLaunch,
  MdOutlineRouter,
  MdOutlineWifi,
  MdStorage,
  MdOutlineCloudSync,
} from "react-icons/md";
import { Section, Card, CardHeader, cn } from "@/design";
import useAppStore from "@/store/useAppStore";

import BrightnessSlider from "./BrightnessSlider";
import TransmitRepetitionCount from "./TransmitRepetitionCount";
import TxConfig from "./TxConfig";
import RebootDonglePanel from "./RebootDonglePanel";
import DaemonSettings from "./DaemonSettings";
import DebugModeToggle from "./DebugModeToggle";
import GpioOverridePanel from "./GpioOverridePanel";
import ProtocolConfig from "./ProtocolConfig";
import RFScanPanel from "./RFScanPanel";
import OtaFlashPanel from "./OtaFlashPanel";
import DongleFlashPanel from "./DongleFlashPanel";
import ReceiverConfigSettings from "./ReceiverConfigSettings";
import HostAudioSettings from "./HostAudioSettings";
import DefaultLocationSettings from "./DefaultLocationSettings";
import AccessPointSettings from "./AccessPointSettings";
import UpdateSettings from "./UpdateSettings";
import DataSettings from "./DataSettings";
import CloudSyncPanel from "./CloudSyncPanel";
import VersionFooter from "./VersionFooter";

// Settings page. Top-level tabs:
//   Dongle    — physical box knobs: LEDs, retransmit count, serial
//               connection, debug-mode toggle. Anything that controls
//               the USB transmitter directly.
//   Receivers — runtime config that lives on each receiver (FW v22+ /
//               dongle FW v16+): broadcast fire_duration_ms, refresh
//               every receiver's reported config, etc. Per-receiver
//               overrides happen on the Receivers admin page.
//   Debug     — diagnostics surface: RF spectrum scan + daemon timing
//               knobs (receiver / command / clock-sync timeouts). This
//               tab is "you only touch this if something is wrong."
//   Show      — pre-fire safety knobs that travel with the show
//               (minimum battery, continuity check). Was previously
//               "Firing handler config".
//   Data      — operator-owned SQLite database export / import for moving
//               between host devices.

// Tabs are rendered in this order, but `visible` can hide one based on the
// host environment (see buildVisibleTabs). The Network tab is the only
// Pi-specific surface today: WiFi AP config requires the host-side
// byh-ap-apply systemd service that install_pi.sh sets up, so showing
// the tab on a dev laptop or a non-Pi server would just dead-end.
const TABS = [
  { key: "dongle", label: "Dongle", icon: <MdOutlineSettingsRemote />, visible: () => true },
  { key: "receivers", label: "Receivers", icon: <MdOutlineRouter />, visible: () => true },
  { key: "network", label: "Network", icon: <MdOutlineWifi />, visible: (host) => !!host?.is_raspberry_pi },
  { key: "data", label: "Data", icon: <MdStorage />, visible: () => true },
  { key: "cloud", label: "Cloud", icon: <MdOutlineCloudSync />, visible: () => true },
  { key: "debug", label: "Debug", icon: <MdOutlineBugReport />, visible: () => true },
  { key: "show", label: "Show config", icon: <MdOutlineRocketLaunch />, visible: () => true },
];

const SUBTITLES = {
  dongle: "Brightness, serial connection, retransmit count, debug mode.",
  receivers: "Fleet-wide receiver runtime knobs (fire pulse width, etc.).",
  network: "WiFi access point + system update.",
  data: "Export or import your Backyard Hero database.",
  cloud: "Push inventory, receivers, and shows to your cloud editor.",
  debug: "Spectrum diagnostics and daemon timing.",
  show: "Audio output for this device, and pre-fire safety checks.",
};

function SettingCard({ title, eyebrow, className, children }) {
  return (
    <Card padding="md" className={cn("flex flex-col", className)}>
      {title || eyebrow ? (
        <CardHeader title={title} eyebrow={eyebrow} />
      ) : null}
      {children}
    </Card>
  );
}

export default function SettingsPanel() {
  const [tab, setTab] = useState("dongle");
  const host = useAppStore((s) => s.systemConfig?.host);

  // Filter tabs through `visible(host)` so Pi-only sections drop out
  // entirely on dev laptops. `host` is undefined until the first
  // fetchSystemConfig() resolves; treat that as "not a Pi" so we don't
  // briefly flash a tab that's about to disappear.
  const visibleTabs = useMemo(
    () => TABS.filter((t) => t.visible(host)),
    [host]
  );

  // If we're parked on a tab that just got hidden (e.g. user was on
  // Network when the systemConfig fetch came back saying "not a Pi"),
  // bounce back to the default rather than render an empty pane.
  useEffect(() => {
    if (!visibleTabs.some((t) => t.key === tab)) {
      setTab(visibleTabs[0]?.key ?? "dongle");
    }
  }, [visibleTabs, tab]);

  return (
    <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 py-6">
      <Section
        title="Settings"
        description={SUBTITLES[tab]}
      >
        {/* Tab strip — same underline-accent style as InventoryList /
            TopBar so the app feels coherent. */}
        <div
          role="tablist"
          aria-label="Settings sections"
          className="flex items-stretch gap-1 border-b border-border-subtle mb-5"
        >
          {visibleTabs.map((t) => {
            const active = t.key === tab;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.key)}
                className={cn(
                  "px-3 h-10 -mb-px border-b-2 inline-flex items-center gap-2 text-sm transition-colors",
                  active
                    ? "text-fg-primary border-accent font-semibold"
                    : "text-fg-muted border-transparent hover:text-fg-secondary"
                )}
              >
                <span className="text-base shrink-0">{t.icon}</span>
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        {tab === "dongle" ? <DongleTab /> : null}
        {tab === "receivers" ? <ReceiversTab /> : null}
        {tab === "network" ? <NetworkTab /> : null}
        {tab === "data" ? <DataTab /> : null}
        {tab === "cloud" ? <CloudTab /> : null}
        {tab === "debug" ? <DebugTab /> : null}
        {tab === "show" ? <ShowTab /> : null}

        {/* Always-visible footer: running Host + Dongle versions and update
            availability, independent of the selected tab. */}
        <VersionFooter />
      </Section>
    </div>
  );
}

function NetworkTab() {
  return (
    <div className="grid grid-cols-1 gap-4">
      <SettingCard
        title="WiFi access point"
        eyebrow="On-board hotspot"
      >
        <AccessPointSettings />
      </SettingCard>

      <SettingCard
        title="System update"
        eyebrow="GitHub + Docker Hub"
      >
        <UpdateSettings />
      </SettingCard>
    </div>
  );
}

function ReceiversTab() {
  return (
    <div className="grid grid-cols-1 gap-4">
      <SettingCard
        title="Receiver runtime config"
        eyebrow="Broadcast to all"
      >
        <ReceiverConfigSettings />
      </SettingCard>
    </div>
  );
}

function DataTab() {
  return (
    <div className="grid grid-cols-1 gap-4">
      <SettingCard title="Backup and transfer" eyebrow="Database">
        <DataSettings />
      </SettingCard>
    </div>
  );
}

function CloudTab() {
  return (
    <div className="grid grid-cols-1 gap-4">
      <SettingCard title="Cloud sync" eyebrow="Push to cloud editor">
        <CloudSyncPanel />
      </SettingCard>
    </div>
  );
}

function DongleTab() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <SettingCard title="Indicator LEDs" eyebrow="Display">
        <BrightnessSlider />
      </SettingCard>

      <SettingCard title="Retransmit" eyebrow="Reliability">
        <TransmitRepetitionCount />
      </SettingCard>

      <SettingCard
        title="Connection"
        eyebrow="Serial"
        className="lg:col-span-2"
      >
        <TxConfig />
      </SettingCard>

      <SettingCard
        title="Power"
        eyebrow="Reboot"
        className="lg:col-span-2"
      >
        <RebootDonglePanel />
      </SettingCard>

      <SettingCard
        title="Diagnostics"
        eyebrow="Logging"
        className="lg:col-span-2"
      >
        <DebugModeToggle />
      </SettingCard>

      <SettingCard
        title="Switch input overrides"
        eyebrow="Bench / service"
        className="lg:col-span-2"
      >
        <GpioOverridePanel />
      </SettingCard>
    </div>
  );
}

function DebugTab() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <SettingCard
        title="RF spectrum scan"
        eyebrow="Channel diagnostics"
      >
        <RFScanPanel />
      </SettingCard>

      <SettingCard
        title="Daemon timing"
        eyebrow="Network heartbeat"
      >
        <DaemonSettings />
      </SettingCard>

      <SettingCard
        title="OTA firmware flash"
        eyebrow="Receiver update"
        className="lg:col-span-2"
      >
        <OtaFlashPanel />
      </SettingCard>

      <SettingCard
        title="Dongle firmware update"
        eyebrow="Host-side flash"
        className="lg:col-span-2"
      >
        <DongleFlashPanel />
      </SettingCard>
    </div>
  );
}

function ShowTab() {
  // Host-device audio playback is a local-deployment capability (the box
  // streams bytes from its own fs audio store + plays through its own
  // output); it's meaningless in the cloud profile, so hide it there.
  const isCloud = useAppStore((s) => s.systemConfig?.caps?.profile) === "cloud";
  return (
    <div className="grid grid-cols-1 gap-4">
      {!isCloud ? (
        <SettingCard title="Show audio output" eyebrow="This device">
          <HostAudioSettings />
        </SettingCard>
      ) : null}

      <SettingCard title="Pre-fire safety" eyebrow="Per-protocol checks">
        <ProtocolConfig />
      </SettingCard>

      <SettingCard
        title="Default show location"
        eyebrow="Builder map starting view"
      >
        <DefaultLocationSettings />
      </SettingCard>
    </div>
  );
}
