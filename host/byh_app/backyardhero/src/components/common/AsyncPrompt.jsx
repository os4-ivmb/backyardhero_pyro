// Promise-based, in-app replacements for the native window.prompt / confirm /
// alert dialogs, rendered as React modals.
//
// Why this exists:
//   - Chromium-in-Electron refuses to display prompt() (it returns null and
//     logs "prompt() is and will not be supported."), so native prompt() does
//     nothing in the packaged desktop app.
//   - On macOS, native confirm()/alert() briefly tear down and recreate the
//     whole BrowserWindow when dismissed (the window visibly closes and
//     reopens), and on Windows they break keyboard focus until the window is
//     re-focused (see desktopFocusFix.js).
//
// Routing every blocking dialog through these in-app modals avoids all of the
// above and gives a consistent look across the desktop and cloud builds.
//
// Usage (anywhere, including outside React, e.g. plain event handlers):
//   const code = await asyncPrompt({ title, message, type: "password" });
//   if (code === null) { /* user cancelled */ }
//
//   if (await asyncConfirm("Delete this track?")) { /* ... */ }
//
//   await asyncAlert("Saved successfully!");
//
// A single <AsyncPromptHost /> must be mounted once at the app root.

import { useEffect, useRef, useState } from "react";

// Module-level bridge so the async* helpers can be called from plain handlers
// (no context/provider plumbing at every call site). The host registers
// `pushRequest` on mount; requests fired before mount are buffered.
let pushRequest = null;
const pendingBeforeMount = [];
let requestCounter = 0;

function enqueue(req) {
  return new Promise((resolve) => {
    const full = { id: ++requestCounter, ...req, resolve };
    if (pushRequest) pushRequest(full);
    else pendingBeforeMount.push(full);
  });
}

/**
 * Show a modal text prompt. Resolves to the entered string on OK/Enter, or
 * `null` if the user cancels (Esc / Cancel / backdrop). Mirrors the contract
 * of window.prompt() closely enough to be a drop-in for our call sites.
 *
 * @param {string|object} options - a message string, or
 *   { title, message, defaultValue, placeholder, okLabel, cancelLabel, type }
 * @returns {Promise<string|null>}
 */
export function asyncPrompt(options = {}) {
  const opts = typeof options === "string" ? { message: options } : options;
  return enqueue({
    kind: "prompt",
    title: opts.title || "",
    message: opts.message || "",
    defaultValue: opts.defaultValue ?? "",
    placeholder: opts.placeholder || "",
    okLabel: opts.okLabel || "OK",
    cancelLabel: opts.cancelLabel || "Cancel",
    type: opts.type === "password" ? "password" : "text",
  });
}

/**
 * Show a modal confirmation. Resolves to `true` on OK and `false` on
 * Cancel / Esc / backdrop. Drop-in for window.confirm().
 *
 * @param {string|object} options - a message string, or
 *   { title, message, okLabel, cancelLabel, destructive }
 * @returns {Promise<boolean>}
 */
export function asyncConfirm(options = {}) {
  const opts = typeof options === "string" ? { message: options } : options;
  return enqueue({
    kind: "confirm",
    title: opts.title || "",
    message: opts.message || "",
    okLabel: opts.okLabel || "OK",
    cancelLabel: opts.cancelLabel || "Cancel",
    destructive: !!opts.destructive,
  });
}

/**
 * Show a modal alert with a single dismiss button. Resolves (to `undefined`)
 * once dismissed. Drop-in for window.alert().
 *
 * @param {string|object} options - a message string, or
 *   { title, message, okLabel }
 * @returns {Promise<void>}
 */
export function asyncAlert(options = {}) {
  const opts = typeof options === "string" ? { message: options } : options;
  return enqueue({
    kind: "alert",
    title: opts.title || "",
    message: opts.message || "",
    okLabel: opts.okLabel || "OK",
  });
}

export function AsyncPromptHost() {
  const [queue, setQueue] = useState([]);
  const [value, setValue] = useState("");
  const inputRef = useRef(null);
  const okRef = useRef(null);

  useEffect(() => {
    pushRequest = (req) => setQueue((q) => [...q, req]);
    if (pendingBeforeMount.length) {
      const buffered = pendingBeforeMount.splice(0);
      setQueue((q) => [...q, ...buffered]);
    }
    return () => {
      pushRequest = null;
    };
  }, []);

  const current = queue[0] || null;

  // Reset the field + move focus whenever a new request becomes active.
  useEffect(() => {
    if (!current) return;
    setValue(current.defaultValue || "");
    const t = setTimeout(() => {
      if (current.kind === "prompt") {
        inputRef.current?.focus();
        inputRef.current?.select?.();
      } else {
        okRef.current?.focus();
      }
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  if (!current) return null;

  const finish = (result) => {
    try {
      current.resolve(result);
    } finally {
      setQueue((q) => q.slice(1));
    }
  };

  // The cancel/dismiss result depends on the dialog kind: null for prompt
  // (no string entered), false for confirm, undefined for alert.
  const cancelResult =
    current.kind === "prompt" ? null : current.kind === "confirm" ? false : undefined;

  const isPrompt = current.kind === "prompt";
  const hasCancel = current.kind !== "alert";

  const okClasses = current.destructive
    ? "rounded bg-red-600 px-4 py-1.5 text-sm text-white hover:bg-red-700"
    : "rounded bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-700";

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish(cancelResult);
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          finish(isPrompt ? value : true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            finish(cancelResult);
          }
        }}
        className="w-full max-w-sm rounded-lg border border-gray-700 bg-gray-900 shadow-xl"
      >
        <div className="px-5 pt-4 pb-3">
          {current.title ? (
            <h2 className="text-base font-semibold text-white">{current.title}</h2>
          ) : null}
          {current.message ? (
            <p className="mt-1 text-sm text-gray-300 whitespace-pre-line">
              {current.message}
            </p>
          ) : null}
          {isPrompt ? (
            <input
              ref={inputRef}
              type={current.type}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={current.placeholder}
              className="mt-3 w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
            />
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-700 px-5 py-3">
          {hasCancel ? (
            <button
              type="button"
              onClick={() => finish(cancelResult)}
              className="rounded px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800"
            >
              {current.cancelLabel}
            </button>
          ) : null}
          <button ref={okRef} type="submit" className={okClasses}>
            {current.okLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export default AsyncPromptHost;
