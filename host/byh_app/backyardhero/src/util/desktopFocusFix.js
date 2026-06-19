// Desktop-only workaround for the Electron/Chromium bug where the web contents
// lose keyboard focus after a native window.confirm / alert / prompt on
// Windows: mouse clicks keep working, but you can't type into any input (or
// even focus one) until the window is re-focused or the app is restarted.
// See electron/electron #19977, #20821, #31917, #41603.
//
// The desktop preload exposes window.byhDesktop.fixDialogFocus(), which asks
// the main process to bounce the BrowserWindow focus (blur()+focus()) -- the
// only reliable fix (element.focus()/window.focus() do nothing). We wrap the
// three blocking dialogs so the focus bounce runs right after each one closes.
//
// No-op in the browser / cloud build (window.byhDesktop is undefined) and
// idempotent so React re-mounts / strict mode can't double-wrap.

let installed = false;

export function installDesktopDialogFocusFix() {
  if (installed) return;
  if (typeof window === "undefined") return;
  const fix = window.byhDesktop?.fixDialogFocus;
  if (typeof fix !== "function") return; // not the desktop app
  installed = true;

  for (const name of ["confirm", "alert", "prompt"]) {
    const original = window[name];
    if (typeof original !== "function") continue;
    window[name] = function patchedDialog(...args) {
      try {
        return original.apply(this, args);
      } finally {
        // Async, non-blocking: runs after the dialog returns so the caller
        // still gets the native (synchronous) result unchanged.
        try { fix(); } catch { /* best effort */ }
      }
    };
  }
}
