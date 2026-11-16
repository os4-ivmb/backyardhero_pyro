import React, { useEffect, useRef, useSyncExternalStore } from "react";
import useStateAppStore from "@/store/useStateAppStore";
import useAppMode from "@/design/useAppMode";
import { Button } from "@/design";
import {
  cancelStepButtonListen,
  clearStepButton,
  getStepButton,
  noteStepPress,
  startStepButtonListen,
  subscribeStepButton,
} from "@/util/stepHardwareButton";

// Shown on the sequence show's status strip. Bind waits for one of header
// inputs 5–8 to change, and only while the arm switch is off. After that,
// a press of the bound input fires the current step (the sequence console
// registers that handler).
export default function HardwareStepButton() {
  const hw = useSyncExternalStore(subscribeStepButton, getStepButton, getStepButton);
  const { isArmed } = useAppMode();
  const seq = useStateAppStore((s) => s.stateData?.fw_state?.gpio?.stepPress?.seq ?? 0);
  const input = useStateAppStore((s) => s.stateData?.fw_state?.gpio?.stepPress?.input ?? null);
  const inputsKnown = useStateAppStore((s) => Array.isArray(s.stateData?.fw_state?.gpio?.inputs));
  const seen = useRef(null);
  const armedRef = useRef(isArmed);
  armedRef.current = isArmed;

  useEffect(() => {
    if (seen.current == null) {
      seen.current = seq;
      return;
    }
    if (seq === seen.current) return;
    seen.current = seq;
    if (input == null) return;
    noteStepPress(input, armedRef.current);
  }, [seq, input]);

  useEffect(() => {
    if (isArmed && hw.listening) {
      cancelStepButtonListen("Binding cancelled — the arm switch is on");
    }
  }, [isArmed, hw.listening]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {hw.listening ? (
        <>
          <span className="text-sm text-fg-secondary">Press a button on inputs 5–8</span>
          <Button size="xs" variant="outline" onClick={() => cancelStepButtonListen()}>Cancel</Button>
        </>
      ) : hw.bound ? (
        <>
          <span className="text-sm text-fg-secondary">Input {hw.bound} fires the step</span>
          <Button size="xs" variant="outline" disabled={isArmed} onClick={() => startStepButtonListen(isArmed)}>
            Rebind
          </Button>
          <Button size="xs" variant="ghost" onClick={clearStepButton}>Clear</Button>
        </>
      ) : (
        <Button size="xs" variant="outline" disabled={isArmed} onClick={() => startStepButtonListen(isArmed)}>
          Bind hardware button
        </Button>
      )}
      {isArmed && !hw.listening ? (
        <span className="text-xs text-fg-muted">Turn the arm switch off to bind a button</span>
      ) : null}
      {hw.listening && !inputsKnown ? (
        <span className="text-xs text-fg-muted">Waiting for the dongle to report those inputs</span>
      ) : null}
      {hw.listenError ? (
        <span className="text-xs text-warn-fg">{hw.listenError}</span>
      ) : null}
    </div>
  );
}
