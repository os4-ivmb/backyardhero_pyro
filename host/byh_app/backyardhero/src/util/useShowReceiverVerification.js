import { useMemo } from "react";
import useAppStore from "@/store/useAppStore";
import {
  verifyShowReceivers,
  deriveShowReceiversFromLegacy,
  summarizeVerificationErrors,
} from "./showReceivers";

// Single source of truth for "does the currently-staged show pass receiver
// verification?". Consumed by the Receivers menu badge, the Load Show
// banner, the Receivers page tile rendering, and ShowControl's load gate.
//
// Returns:
//   { showReceivers, results, hasError, hasWarning, summary, isLegacy }
//
// hasError -> hard issues (missing/disabled) that block load.
// hasWarning -> soft issues (insufficient cue count) that the operator
//               may intentionally accept; surfaced on the Receivers
//               page card but not on the menu badge or the load gate.
//
// `isLegacy` means the staged show had no persisted `show_receivers` blob
// (pre-migration). We back-fill from items[] + receiver_labels so the
// verification doesn't silently flip to "all green" for shows that haven't
// been edited since the column was added — operators still get warned if a
// referenced receiver has gone missing or been disabled. They'll fix it
// either way the moment they re-save the show through the new editor.
export default function useShowReceiverVerification() {
  const stagedShow = useAppStore((s) => s.stagedShow);
  const dbReceivers = useAppStore((s) => s.receivers);
  const systemReceivers = useAppStore((s) => s.systemConfig?.receivers);
  const activeReceivers =
    dbReceivers && Object.keys(dbReceivers).length > 0
      ? dbReceivers
      : systemReceivers;

  return useMemo(() => {
    const hasStagedShow = stagedShow && stagedShow.id != null;
    if (!hasStagedShow) {
      return {
        hasStagedShow: false,
        showReceivers: [],
        results: [],
        hasError: false,
        hasWarning: false,
        summary: null,
        isLegacy: false,
      };
    }

    let showReceivers = Array.isArray(stagedShow.showReceivers)
      ? stagedShow.showReceivers
      : null;
    let isLegacy = false;
    if (!showReceivers || showReceivers.length === 0) {
      // Build a synthetic list from the show's items + legacy receiver_labels
      // so the verifier has something concrete to evaluate against. This is
      // purely in-memory; persistence happens only when the user explicitly
      // saves from the editor.
      const items = Array.isArray(stagedShow.items) ? stagedShow.items : [];
      let labels = {};
      if (stagedShow.receiverLabels && typeof stagedShow.receiverLabels === "object") {
        labels = stagedShow.receiverLabels;
      } else if (stagedShow.receiver_labels) {
        try { labels = JSON.parse(stagedShow.receiver_labels) || {}; }
        catch { labels = {}; }
      }
      showReceivers = deriveShowReceiversFromLegacy({
        items,
        receiverLabels: labels,
        dbReceivers: activeReceivers,
      });
      isLegacy = true;
    }

    const verification = verifyShowReceivers(showReceivers, activeReceivers);
    return {
      hasStagedShow: true,
      showReceivers,
      results: verification.results,
      hasError: verification.hasError,
      hasWarning: verification.hasWarning,
      summary: summarizeVerificationErrors(verification),
      isLegacy,
    };
  }, [stagedShow, activeReceivers]);
}
