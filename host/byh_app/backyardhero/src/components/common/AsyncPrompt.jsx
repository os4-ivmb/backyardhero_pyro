// Promise-based, in-app replacement for window.prompt().
//
// Why this exists: Chromium-in-Electron refuses to display prompt() (it
// returns null and logs "prompt() is and will not be supported."), so any
// native prompt() silently does nothing in the packaged desktop app even
// though it works in a browser. confirm()/alert() still work, which is why
// only the text-input dialogs (e.g. the show launch/auth code) broke.
//
// Usage (anywhere, including outside React):
//   const code = await asyncPrompt({ title, message, type: "password" });
//   if (code === null) { /* user cancelled */ }
//
// A single <AsyncPromptHost /> must be mounted once at the app root.

import { useEffect, useRef, useState } from "react";

// Module-level bridge so asyncPrompt() can be called from plain handlers
// (no context/provider plumbing at every call site). The host registers
// `pushRequest` on mount; requests fired before mount are buffered.
let pushRequest = null;
const pendingBeforeMount = [];
let requestCounter = 0;

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
  return new Promise((resolve) => {
    const req = {
      id: ++requestCounter,
      title: opts.title || "",
      message: opts.message || "",
      defaultValue: opts.defaultValue ?? "",
      placeholder: opts.placeholder || "",
      okLabel: opts.okLabel || "OK",
      cancelLabel: opts.cancelLabel || "Cancel",
      type: opts.type === "password" ? "password" : "text",
      resolve,
    };
    if (pushRequest) pushRequest(req);
    else pendingBeforeMount.push(req);
  });
}

export function AsyncPromptHost() {
  const [queue, setQueue] = useState([]);
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

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

  // Reset the field + focus the input whenever a new request becomes active.
  useEffect(() => {
    if (!current) return;
    setValue(current.defaultValue || "");
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select?.();
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

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish(null);
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          finish(value);
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
          <input
            ref={inputRef}
            type={current.type}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                finish(null);
              }
            }}
            placeholder={current.placeholder}
            className="mt-3 w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-700 px-5 py-3">
          <button
            type="button"
            onClick={() => finish(null)}
            className="rounded px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800"
          >
            {current.cancelLabel}
          </button>
          <button
            type="submit"
            className="rounded bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-700"
          >
            {current.okLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export default AsyncPromptHost;
