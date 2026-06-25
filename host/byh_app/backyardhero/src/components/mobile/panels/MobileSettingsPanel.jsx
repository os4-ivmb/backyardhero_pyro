import React, { useEffect, useMemo, useState } from "react";
import {
  MdOutlineSettingsRemote, MdOutlineBugReport, MdOutlineRocketLaunch,
  MdOutlineRouter, MdOutlineWifi, MdStorage, MdArrowBack,
} from "react-icons/md";

import { Section, Card, CardHeader, Button, cn } from "@/design";
import useAppStore from "@/store/useAppStore";
import SupportTicketModal from "../../support/SupportTicketModal";

import BrightnessSlider from "../../settings/BrightnessSlider";
import TransmitRepetitionCount from "../../settings/TransmitRepetitionCount";
import TxConfig from "../../settings/TxConfig";
import DaemonSettings from "../../settings/DaemonSettings";
import DebugModeToggle from "../../settings/DebugModeToggle";
import ProtocolConfig from "../../settings/ProtocolConfig";
import RFScanPanel from "../../settings/RFScanPanel";
import OtaFlashPanel from "../../settings/OtaFlashPanel";
import DongleFlashPanel from "../../settings/DongleFlashPanel";
import ReceiverConfigSettings from "../../settings/ReceiverConfigSettings";
import DefaultLocationSettings from "../../settings/DefaultLocationSettings";
import AccessPointSettings from "../../settings/AccessPointSettings";
import UpdateSettings from "../../settings/UpdateSettings";
import DataSettings from "../../settings/DataSettings";

// ---------------------------------------------------------------------------
// MobileSettingsPanel -- mobile chrome around the existing desktop
// settings sub-components.
//
// The desktop SettingsPanel uses a 6-tab strip + a 2-column grid. We
// keep the same sub-component map so behaviour stays identical, but
// swap the strip for a list-of-sections drilldown:
//
//   * Section list (tap to enter)
//   * In-section: stacked cards, single column, mobile-friendly back button.
//
// All sub-components reuse the desktop implementations -- they're already
// laid out as form-style controls that fit a phone width without
// modification.
// ---------------------------------------------------------------------------

const SECTIONS = [
  {
    key: "dongle",
    label: "Dongle",
    description: "Brightness, retransmit, serial connection, debug mode.",
    icon: <MdOutlineSettingsRemote />,
    visible: () => true,
  },
  {
    key: "receivers",
    label: "Receivers",
    description: "Fleet-wide runtime config (fire pulse width, etc.).",
    icon: <MdOutlineRouter />,
    visible: () => true,
  },
  {
    key: "network",
    label: "Network",
    description: "WiFi access point + system update.",
    icon: <MdOutlineWifi />,
    visible: (host) => !!host?.is_raspberry_pi,
  },
  {
    key: "data",
    label: "Data",
    description: "Export or import the database.",
    icon: <MdStorage />,
    visible: () => true,
  },
  {
    key: "debug",
    label: "Debug",
    description: "Spectrum scan, daemon timing, OTA / dongle flash.",
    icon: <MdOutlineBugReport />,
    visible: () => true,
  },
  {
    key: "show",
    label: "Show config",
    description: "Pre-fire safety + default location.",
    icon: <MdOutlineRocketLaunch />,
    visible: () => true,
  },
];

function SettingCard({ title, eyebrow, children }) {
  return (
    <Card padding="md" className="flex flex-col">
      {title || eyebrow ? <CardHeader title={title} eyebrow={eyebrow} /> : null}
      {children}
    </Card>
  );
}

function DongleSection() {
  return (
    <div className="flex flex-col gap-3">
      <SettingCard title="Indicator LEDs" eyebrow="Display">
        <BrightnessSlider />
      </SettingCard>
      <SettingCard title="Retransmit" eyebrow="Reliability">
        <TransmitRepetitionCount />
      </SettingCard>
      <SettingCard title="Connection" eyebrow="Serial">
        <TxConfig />
      </SettingCard>
      <SettingCard title="Diagnostics" eyebrow="Logging">
        <DebugModeToggle />
      </SettingCard>
    </div>
  );
}

function ReceiversSection() {
  return (
    <SettingCard title="Receiver runtime config" eyebrow="Broadcast to all">
      <ReceiverConfigSettings />
    </SettingCard>
  );
}

function NetworkSection() {
  return (
    <div className="flex flex-col gap-3">
      <SettingCard title="WiFi access point" eyebrow="On-board hotspot">
        <AccessPointSettings />
      </SettingCard>
      <SettingCard title="System update" eyebrow="GitHub + Docker Hub">
        <UpdateSettings />
      </SettingCard>
    </div>
  );
}

function DataSection() {
  return (
    <SettingCard title="Backup and transfer" eyebrow="Database">
      <DataSettings />
    </SettingCard>
  );
}

function DebugSection() {
  return (
    <div className="flex flex-col gap-3">
      <SettingCard title="RF spectrum scan" eyebrow="Channel diagnostics">
        <RFScanPanel />
      </SettingCard>
      <SettingCard title="Daemon timing" eyebrow="Network heartbeat">
        <DaemonSettings />
      </SettingCard>
      <SettingCard title="OTA firmware flash" eyebrow="Receiver update">
        <OtaFlashPanel />
      </SettingCard>
      <SettingCard title="Dongle firmware update" eyebrow="Host-side flash">
        <DongleFlashPanel />
      </SettingCard>
    </div>
  );
}

function ShowSection() {
  return (
    <div className="flex flex-col gap-3">
      <SettingCard title="Pre-fire safety" eyebrow="Per-protocol checks">
        <ProtocolConfig />
      </SettingCard>
      <SettingCard title="Default show location" eyebrow="Builder map">
        <DefaultLocationSettings />
      </SettingCard>
    </div>
  );
}

const SECTION_RENDERERS = {
  dongle: DongleSection,
  receivers: ReceiversSection,
  network: NetworkSection,
  data: DataSection,
  debug: DebugSection,
  show: ShowSection,
};

export default function MobileSettingsPanel() {
  const host = useAppStore((s) => s.systemConfig?.host);
  const [active, setActive] = useState(null);
  const [supportOpen, setSupportOpen] = useState(false);

  const visibleSections = useMemo(
    () => SECTIONS.filter((s) => s.visible(host)),
    [host]
  );

  // Bounce out of a hidden section if the host info changes mid-session.
  useEffect(() => {
    if (active && !visibleSections.some((s) => s.key === active)) {
      setActive(null);
    }
  }, [visibleSections, active]);

  if (!active) {
    return (
      <div className="px-3 py-4">
        <Section
          title="Settings"
          description="Tap a section to drill in."
        >
          <ul className="flex flex-col gap-2">
            {visibleSections.map((s) => (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => setActive(s.key)}
                  className={cn(
                    "w-full text-left rounded-md border bg-surface-1 px-4 py-3",
                    "border-border-subtle hover:border-border-strong active:bg-surface-2",
                    "flex items-center gap-3 transition-colors"
                  )}
                >
                  <span className="text-2xl text-fg-secondary shrink-0">
                    {s.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-fg-primary">
                      {s.label}
                    </span>
                    <span className="block text-xs text-fg-muted truncate">
                      {s.description}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>

        <div className="mt-4">
          <Button
            variant="outline"
            size="md"
            leading={<MdOutlineBugReport />}
            onClick={() => setSupportOpen(true)}
            className="w-full"
          >
            Report a problem
          </Button>
        </div>

        <SupportTicketModal
          isOpen={supportOpen}
          onClose={() => setSupportOpen(false)}
        />
      </div>
    );
  }

  const Section_ = SECTION_RENDERERS[active];
  const meta = visibleSections.find((s) => s.key === active);

  return (
    <div className="px-3 py-3 space-y-3">
      <button
        type="button"
        onClick={() => setActive(null)}
        className="inline-flex items-center gap-1 text-fg-secondary text-sm hover:text-fg-primary"
      >
        <MdArrowBack /> Settings
      </button>
      <Section
        title={meta?.label || "Settings"}
        description={meta?.description}
      >
        {Section_ ? <Section_ /> : null}
      </Section>
    </div>
  );
}
