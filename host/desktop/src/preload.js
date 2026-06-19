'use strict';

// Minimal, locked-down bridge for the renderer (the Next web app loaded over
// http://127.0.0.1). The only thing exposed is a focus-fix trigger that works
// around a long-standing Electron/Chromium bug on Windows: after a native
// window.confirm / window.alert / window.prompt the web contents lose keyboard
// focus -- mouse clicks still work, but you can't type into any input until
// the window is re-focused (or the app is restarted). See electron/electron
// issues #19977, #20821, #31917, #41603. The proven workaround is to bounce
// the BrowserWindow focus (blur()+focus()) in the main process after the
// dialog closes; element.focus()/window.focus() alone do NOT fix it.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('byhDesktop', {
  fixDialogFocus: () => ipcRenderer.send('byh:fix-dialog-focus'),
});
