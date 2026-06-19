import React from "react";
import axios from "axios";
import useStateAppStore from "@/store/useStateAppStore";
import useAppStore from "@/store/useAppStore";
import { Field, inputClass, selectClass } from "@/design";
import useDraft from "@/hooks/useDraft";
import SaveBar from "./SaveBar";

const PROTOCOLS = ["BKYD_TS_HYBRID"];
const DEFAULTS = { addr: "/dev/tty.usbmodem01", baud: 115200, protocol: PROTOCOLS[0] };

// RF frontend (the dongle) connection settings. Multi-field group so we
// use a draft hook + single Save button instead of inline submits per
// field. Hydrates from `fw_state.settings.rf` so the inputs reflect
// whatever the daemon is actually using right now.

export default function TxConfig() {
  const { stateData } = useStateAppStore();
  const { systemConfig, saveSystemConfig } = useAppStore();
  const rf = stateData?.fw_state?.settings?.rf || {};
  const upstream = {
    addr: rf.addr || DEFAULTS.addr,
    baud: rf.baud || DEFAULTS.baud,
    protocol: rf.protocol || DEFAULTS.protocol,
  };
  const draft = useDraft(upstream);

  const onSave = () =>
    draft.save(async (s) => {
      const baud = parseInt(s.baud, 10);
      // 1. Reconfigure the live daemon/bridge immediately so the dongle
      //    starts using the new port without a restart.
      await axios.post(
        "/api/system/cmd_daemon",
        {
          type: "select_serial",
          device: s.addr,
          baud,
          protocol: s.protocol,
        },
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
        },
      };
      await saveSystemConfig(next);
    });

  return (
    <div className="flex flex-col gap-4">
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
