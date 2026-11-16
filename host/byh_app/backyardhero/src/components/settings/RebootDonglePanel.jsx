import React, { useCallback, useRef, useState } from "react";
import axios from "axios";
import { MdRestartAlt } from "react-icons/md";
import { Button } from "@/design";

// Soft-reboot the dongle's ESP32-S2 over the serial link. This is a true
// firmware restart (the dongle acks `C+ reboot` then calls esp_restart()),
// distinct from the StatusBar "Restart" affordance which only re-opens the
// host-side serial connection. The USB-CDC port drops and re-enumerates in
// ~2s; the bridge auto-reconnects and the daemon re-runs its clock/receiver
// sync, so there's nothing for the operator to do after clicking.
//
// We gate the action behind an inline confirm so a stray click mid-show
// can't bounce the transmitter.

const REBOOT_SETTLE_MS = 4000;

export default function RebootDonglePanel() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [doneAt, setDoneAt] = useState(0);
  const confirmTimerRef = useRef(null);

  const cancelConfirm = useCallback(() => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setConfirming(false);
  }, []);

  const arm = useCallback(() => {
    setError(null);
    setConfirming(true);
    // Auto-disarm so a forgotten confirm doesn't sit primed indefinitely.
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirming(false), 5000);
  }, []);

  const reboot = useCallback(async () => {
    cancelConfirm();
    setBusy(true);
    setError(null);
    try {
      await axios.post(
        "/api/system/cmd_daemon",
        { type: "reboot_dongle" },
        { headers: { "Content-Type": "application/json" } },
      );
      setDoneAt(Date.now());
      // Hold the "rebooting" state long enough to cover the dongle's
      // re-enumeration window so the operator gets honest feedback.
      setTimeout(() => setBusy(false), REBOOT_SETTLE_MS);
    } catch (err) {
      const msg =
        err?.response?.data?.error || err?.message || "Failed to send reboot command";
      setError(msg);
      setBusy(false);
    }
  }, [cancelConfirm]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-muted">
        Restart the dongle&apos;s ESP32-S2 over the serial link. The transmitter
        drops off USB and comes back automatically in a couple of seconds.
        Don&apos;t do this while a show is running.
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        {!confirming ? (
          <Button
            variant="warn"
            size="sm"
            leading={<MdRestartAlt className={busy ? "animate-spin" : undefined} />}
            onClick={arm}
            disabled={busy}
          >
            {busy ? "Rebooting…" : "Reboot dongle"}
          </Button>
        ) : (
          <>
            <Button variant="danger" size="sm" onClick={reboot} loading={busy}>
              Confirm reboot
            </Button>
            <Button variant="ghost" size="sm" onClick={cancelConfirm} disabled={busy}>
              Cancel
            </Button>
          </>
        )}
      </div>

      {error ? (
        <p className="text-sm text-danger-fg">{error}</p>
      ) : doneAt && !busy ? (
        <p className="text-sm text-fg-muted">Reboot command sent — dongle should be back online.</p>
      ) : null}
    </div>
  );
}
