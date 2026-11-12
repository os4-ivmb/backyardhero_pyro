// Which header input (5–8) fires the current sequence step. The binding
// lives in the browser; the daemon only reports debounced press edges.
//
// A press is accepted once per input per 400ms (see STEP_INPUT_LOCKOUT_S
// in the daemon), so contact bounce and a quick double-tap are one step.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "byh.stepHardwareInput";
const LISTEN_MS = 15_000;

function loadBound() {
  if (typeof window === "undefined") return null;
  const n = Number(window.localStorage.getItem(STORAGE_KEY));
  return n >= 5 && n <= 8 ? n : null;
}

let bound = loadBound();
let listening = false;
let listenError = null;
let listenTimer = null;
const listeners = new Set();
let pressHandler = null;
let state = { bound, listening, listenError };

function emit() {
  state = { bound, listening, listenError };
  for (const fn of listeners) fn();
}

export function useStepButtonBound() {
  return useSyncExternalStore(subscribeStepButton, getStepButton, getStepButton).bound;
}

export function subscribeStepButton(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getStepButton() {
  return state;
}

export function startStepButtonListen(armed) {
  if (armed) {
    listenError = "Turn the arm switch off to bind a button";
    listening = false;
    emit();
    return;
  }
  listening = true;
  listenError = null;
  emit();
  clearTimeout(listenTimer);
  listenTimer = setTimeout(() => {
    if (!listening) return;
    listening = false;
    listenError = "No button press on inputs 5–8";
    emit();
  }, LISTEN_MS);
}

export function cancelStepButtonListen(error) {
  clearTimeout(listenTimer);
  listening = false;
  if (error) listenError = error;
  emit();
}

export function clearStepButton() {
  clearTimeout(listenTimer);
  listening = false;
  bound = null;
  listenError = null;
  if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
  emit();
}

function bind(input) {
  clearTimeout(listenTimer);
  bound = input;
  listening = false;
  listenError = null;
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, String(input));
  emit();
}

export function setStepPressHandler(fn) {
  pressHandler = fn;
  return () => {
    if (pressHandler === fn) pressHandler = null;
  };
}

// One watcher (the status-strip control) calls this for each accepted edge.
export function noteStepPress(input, armed) {
  const n = Number(input);
  if (n < 5 || n > 8) return;
  if (listening) {
    if (armed) {
      listenError = "Turn the arm switch off to bind a button";
      emit();
      return;
    }
    bind(n);
    return;
  }
  if (bound === n) pressHandler?.();
}
