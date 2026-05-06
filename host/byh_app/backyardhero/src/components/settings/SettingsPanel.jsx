import React, { useState } from "react";
import {
  MdOutlineSettingsRemote,
  MdOutlineBugReport,
  MdOutlineRocketLaunch,
} from "react-icons/md";
import { Section, Card, CardHeader, cn } from "@/design";

import BrightnessSlider from "./BrightnessSlider";
import TransmitRepetitionCount from "./TransmitRepetitionCount";
import TxConfig from "./TxConfig";
import DaemonSettings from "./DaemonSettings";
import DebugModeToggle from "./DebugModeToggle";
import ProtocolConfig from "./ProtocolConfig";
import RFScanPanel from "./RFScanPanel";

// Settings page. Three top-level tabs:
//   Dongle    — physical box knobs: LEDs, retransmit count, serial
//               connection, debug-mode toggle. Anything that controls
//               the USB transmitter directly.
//   Debug     — diagnostics surface: RF spectrum scan + daemon timing
//               knobs (receiver / command / clock-sync timeouts). This
//               tab is "you only touch this if something is wrong."
//   Show      — pre-fire safety knobs that travel with the show
//               (minimum battery, continuity check). Was previously
//               "Firing handler config".

const TABS = [
  { key: "dongle", label: "Dongle", icon: <MdOutlineSettingsRemote /> },
  { key: "debug", label: "Debug", icon: <MdOutlineBugReport /> },
  { key: "show", label: "Show config", icon: <MdOutlineRocketLaunch /> },
];

const SUBTITLES = {
  dongle: "Brightness, serial connection, retransmit count, debug mode.",
  debug: "Spectrum diagnostics and daemon timing.",
  show: "Pre-fire safety checks that apply to every show.",
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
          {TABS.map((t) => {
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
        {tab === "debug" ? <DebugTab /> : null}
        {tab === "show" ? <ShowTab /> : null}
      </Section>
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
        title="Diagnostics"
        eyebrow="Logging"
        className="lg:col-span-2"
      >
        <DebugModeToggle />
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
    </div>
  );
}

function ShowTab() {
  return (
    <div className="grid grid-cols-1 gap-4">
      <SettingCard title="Pre-fire safety" eyebrow="Per-protocol checks">
        <ProtocolConfig />
      </SettingCard>
    </div>
  );
}
