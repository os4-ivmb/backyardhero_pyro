'use strict';

/**
 * Resolves the two kinds of paths the supervisor needs:
 *
 *   1. Bundled, read-only RESOURCES that ship inside the app
 *      (the Next standalone server, the embedded Python runtime, the Python
 *      service sources, the default config seed). In a packaged build these
 *      live under process.resourcesPath; in `npm start` dev they live in the
 *      repo working tree.
 *
 *   2. Writable per-user STATE/CONFIG/RUN dirs derived from Electron's
 *      app.getPath('userData'), which resolves natively per-OS:
 *        macOS   ~/Library/Application Support/Backyard Hero
 *        Windows %APPDATA%\Backyard Hero
 *        Linux   ~/.config/Backyard Hero
 *      These become BYH_DATA_DIR / BYH_CONFIG_DIR / BYH_RUN_DIR for every
 *      child process, which is how the DB + systemcfg.json end up in the user
 *      dir instead of the read-only app bundle.
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const isPackaged = app.isPackaged;

// In a packaged app, extraResources land in process.resourcesPath. In dev we
// build them into host/desktop/resources via scripts/build-resources.mjs.
const resourcesRoot = isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..', 'resources');

const isWin = process.platform === 'win32';

function pythonBin() {
  // python-build-standalone lays out a normal install tree.
  return isWin
    ? path.join(resourcesRoot, 'python', 'python.exe')
    : path.join(resourcesRoot, 'python', 'bin', 'python3');
}

const resources = {
  root: resourcesRoot,
  // Next.js standalone server entrypoint.
  nextServer: path.join(resourcesRoot, 'app', 'server.js'),
  nextDir: path.join(resourcesRoot, 'app'),
  python: pythonBin(),
  pythingsDir: path.join(resourcesRoot, 'pythings'),
  bridgeDir: path.join(resourcesRoot, 'bridge'),
  // Shared esptool helpers (devices/utils/dongle_flasher.py) the bridge's
  // flash_server imports for the UI-driven dongle flash. Exported to the
  // bridge as BYH_DEVICES_UTILS_DIR (no repo tree exists in the bundle).
  devicesUtilsDir: path.join(resourcesRoot, 'devices', 'utils'),
  defaultConfig: path.join(resourcesRoot, 'config', 'systemcfg.json'),
  // Build-time secrets/config baked by scripts/build-resources.mjs (NOT
  // committed -- resources/ is gitignored). Holds the shared bug-report
  // signing secret + cloud gateway URL the in-app support ticket uses.
  runtimeConfig: path.join(resourcesRoot, 'runtime-config.json'),
  // ffmpeg is optional (only the firing-profile audio feature needs it).
  ffmpeg: path.join(resourcesRoot, 'ffmpeg', isWin ? 'ffmpeg.exe' : 'ffmpeg'),
};

function userDirs() {
  const base = app.getPath('userData');
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  const runDir = path.join(base, 'run');
  const logDir = path.join(dataDir, 'log');
  for (const d of [dataDir, configDir, runDir, logDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return { base, dataDir, configDir, runDir, logDir };
}

module.exports = { isPackaged, isWin, resources, userDirs };
