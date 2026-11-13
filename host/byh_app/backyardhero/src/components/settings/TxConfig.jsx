import React from "react";
import axios from "axios";
import useStateAppStore from "@/store/useStateAppStore";
import useAppStore from "@/store/useAppStore";
import { Field, SegmentedControl, cn, inputClass, selectClass } from "@/design";
import useDraft from "@/hooks/useDraft";
import SaveBar from "./SaveBar";
import {
  DONGLE_DEFAULTS,
  DONGLE_LINK_USB,
  DONGLE_LINK_WIRELESS,
  isHubHost,
  selectSerialPayload,
} from "@/util/dongleLink";

const PROTOCOLS = ["BKYD_TS_HYBRID"];
const LINK_OPTIONS = [
  { value: DONGLE_LINK_USB, label: "USB" },
  { value: DONGLE_LINK_WIRELESS, label: "Wireless" },
];

// RF frontend (the dongle) connection settings. Multi-field group so we
// use a draft hook + single Save button instead of inline submits per
// field. Hydrates from `fw_state.settings.rf` so the inputs reflect
// whatever the daemon is actually using right now.
//
// Connection type picks the transport:
//   USB      — the hard-wired serial port (unchanged).
//   Wireless — the laptop is joined to an Omni hub's Wi-Fi. The bridge
//              opens ws://<host>/ws and carries the same dongle lines.
// Receiver OTA is not available on the wireless link.

export default function TxConfig() {
  const { stateData } = useStateAppStore();
  const { systemConfig, saveSystemConfig } = useAppStore();
  const rf = stateData?.fw_state?.settings?.rf || {};
  const sys = systemConfig?.system || {};
  const upstream = {
    link: rf.link || sys.dongle_link || DONGLE_DEFAULTS.link,
    hubHost: rf.hub_host || sys.dongle_hub_host || DONGLE_DEFAULTS.hubHost,
    addr: rf.addr || sys.dongle_port || DONGLE_DEFAULTS.addr,
    baud: rf.baud || sys.dongle_baud || DONGLE_DEFAULTS.baud,
    protocol: rf.protocol || sys.dongle_protocol || DONGLE_DEFAULTS.protocol,
  };
  const draft = useDraft(upstream);
  const wireless = draft.state.link === DONGLE_LINK_WIRELESS;
  const appliedWireless = upstream.link === DONGLE_LINK_WIRELESS;
  const linkError = rf.link_error || null;
  const linked = !!stateData?.fw_state?.device_running;

  const onSave = () =>
    draft.save(async (s) => {
      const link = s.link === DONGLE_LINK_WIRELESS ? DONGLE_LINK_WIRELESS : DONGLE_LINK_USB;
      const hubHost = String(s.hubHost || "").trim();
      if (link === DONGLE_LINK_WIRELESS && !isHubHost(hubHost)) {
        throw new Error("Enter the hub's IP address, usually 192.17.76.1.");
      }
      const baud = parseInt(s.baud, 10);
      // 1. Reconfigure the live daemon/bridge immediately so the dongle
      //    starts using the new link without a restart.
      await axios.post(
        "/api/system/cmd_daemon",
        selectSerialPayload({
          addr: s.addr,
          baud,
          protocol: s.protocol,
          link,
          hubHost,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
      // 2. Persist into the operator's systemcfg.user.json so the choice
      //    survives a restart. Without this the daemon/bridge re-read the
      //    git-tracked base on boot and revert to the default port. Merge
      //    into the existing config so we don't drop other system fields /
      //    overrides (the API extracts just the user-owned subset).
      const next = {
        ...systemConfig,
        system: {
          ...(systemConfig?.system || {}),
          dongle_port: s.addr,
          dongle_baud: baud,
          dongle_protocol: s.protocol,
          dongle_link: link,
          dongle_hub_host: hubHost || DONGLE_DEFAULTS.hubHost,
        },
      };
      await saveSystemConfig(next);
    });

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Connection type"
        htmlFor="rf-link"
        hint={
          wireless
            ? "The laptop must be joined to the hub Wi-Fi. Dongle traffic goes over the hub WebSocket instead of USB. Receiver OTA is not available on this link."
            : "Hard-wired USB serial. Choose Wireless to use a hub dongle on Wi-Fi."
        }
      >
        <SegmentedControl
          id="rf-link"
          label="Connection type"
          value={wireless ? DONGLE_LINK_WIRELESS : DONGLE_LINK_USB}
          onChange={(link) => draft.set("link", link)}
          options={LINK_OPTIONS}
          className="w-fit self-start"
        />
      </Field>

      {!draft.dirty && appliedWireless ? (
        <p
          className={cn(
            "text-xs leading-snug",
            linkError ? "text-danger-fg" : "text-fg-muted",
          )}
        >
          {linkError
            ? linkError
            : linked
              ? `Linked to the hub at ${upstream.hubHost}.`
              : `Looking for the hub at ${upstream.hubHost}…`}
        </p>
      ) : null}

      <Field
        label="Protocol"
        htmlFor="rf-protocol"
        hint="Default protocol used when a show doesn't pin one. Only one is currently supported."
      >
        <div className="relative">
          <select
            id="rf-protocol"
            value={draft.state.protocol}
            onChange={(e) => draft.set("protocol", e.target.value)}
            className={selectClass}
          >
            {PROTOCOLS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </Field>

      {wireless ? (
        <Field
          label="Hub address"
          htmlFor="rf-hub-host"
          hint="The hub's Wi-Fi address. A stock hub is 192.17.76.1."
        >
          <input
            id="rf-hub-host"
            type="text"
            value={draft.state.hubHost}
            onChange={(e) => draft.set("hubHost", e.target.value)}
            className={inputClass + " font-mono"}
            spellCheck={false}
            autoComplete="off"
            placeholder={DONGLE_DEFAULTS.hubHost}
          />
        </Field>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
          <Field
            label="Serial device"
            htmlFor="rf-addr"
            hint="Where the dongle is mounted. Look for a /dev/tty… path."
          >
            <input
              id="rf-addr"
              type="text"
              value={draft.state.addr}
              onChange={(e) => draft.set("addr", e.target.value)}
              className={inputClass + " font-mono"}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Field
            label="Baud"
            htmlFor="rf-baud"
            hint="Match the dongle's firmware."
          >
            <input
              id="rf-baud"
              type="number"
              value={draft.state.baud}
              onChange={(e) => draft.set("baud", e.target.value)}
              className={inputClass + " num tabular-nums"}
            />
          </Field>
        </div>
      )}

      <SaveBar
        dirty={draft.dirty}
        saving={draft.saving}
        error={draft.error}
        savedAt={draft.savedAt}
        onSave={onSave}
        onReset={draft.reset}
        saveLabel="Apply"
      />
    </div>
  );
}
