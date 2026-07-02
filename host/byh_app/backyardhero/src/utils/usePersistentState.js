import { useEffect, useRef, useState } from "react";

// useState that persists its value to localStorage under `key`. SSR-safe:
// falls back to `initial` when window/localStorage is unavailable or the
// stored value can't be parsed. Values are JSON-serialised, so primitives,
// arrays and plain objects all work.
//
// Pass `{ debounce: ms }` for values that change rapidly (e.g. wheel-zoom):
// the synchronous `localStorage.setItem` is coalesced so it runs once after
// the value settles instead of on every keystroke/frame. The latest value is
// always flushed on unmount so a pending debounced write is never lost.
//
// NOTE: there is no cross-tab sync — this hook does not listen for the
// `storage` event, so two editor tabs open at once stomp each other
// last-write-wins and neither sees the other's changes. That's acceptable for
// the single-operator console use we have today; add a `storage` listener here
// if multi-tab editing ever needs to stay in sync.
export default function usePersistentState(key, initial, options) {
  const debounceMs = options?.debounce ?? 0;
  const [value, setValue] = useState(() => {
    if (typeof window === "undefined") return initial;
    try {
      const raw = window.localStorage.getItem(key);
      return raw != null ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });

  // Mirror the latest key/value so the unmount flush can write them without
  // re-subscribing.
  const valueRef = useRef(value);
  valueRef.current = value;
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const write = () => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* ignore quota / privacy-mode errors */
      }
    };
    if (debounceMs <= 0) {
      write();
      return;
    }
    const id = window.setTimeout(write, debounceMs);
    return () => window.clearTimeout(id);
  }, [key, value, debounceMs]);

  // Flush the latest value on unmount so a debounced change in flight survives.
  useEffect(() => {
    if (typeof window === "undefined") return;
    return () => {
      try {
        window.localStorage.setItem(keyRef.current, JSON.stringify(valueRef.current));
      } catch {
        /* ignore */
      }
    };
  }, []);

  return [value, setValue];
}
