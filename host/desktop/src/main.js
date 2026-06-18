'use strict';

/**
 * Backyard Hero desktop entrypoint.
 *
 * Replaces the Docker + supervisord stack with a native Electron app that:
 *   - resolves writable per-user data/config/run dirs (paths.js),
 *   - seeds a default systemcfg.json on first run,
 *   - auto-detects the dongle's serial port (serial.js),
 *   - supervises the Next.js server + 3 Python services (supervisor.js),
 *   - waits for the UI to come up, then shows it in a window (and a tray).
 *
 * No Docker, no system Python, no manual COM config.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { app, BrowserWindow, Tray, Menu, shell, nativeImage } = require('electron');

const { isWin, resources, userDirs } = require('./paths');
const { Supervisor } = require('./supervisor');
const { detectDonglePort } = require('./serial');

const UI_PORT = 1776;
const UI_URL = `http://127.0.0.1:${UI_PORT}/`;

let mainWindow = null;
let tray = null;
let supervisor = null;

// Single-instance: a second launch should focus the existing window rather
// than spin up a second copy of the whole service stack on the same ports.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(main).catch((err) => {
    console.error('Fatal startup error:', err);
    app.quit();
  });
}

function seedConfigIfMissing(configDir) {
  const target = path.join(configDir, 'systemcfg.json');
  if (fs.existsSync(target)) return;
  try {
    fs.copyFileSync(resources.defaultConfig, target);
    console.log(`Seeded default systemcfg.json -> ${target}`);
  } catch (err) {
    console.error('Could not seed systemcfg.json:', err.message);
  }
}

function buildEnv(dirs, serialPort) {
  const ffmpegDir = path.dirname(resources.ffmpeg);
  const pathSep = isWin ? ';' : ':';
  const augmentedPath = fs.existsSync(ffmpegDir)
    ? `${ffmpegDir}${pathSep}${process.env.PATH || ''}`
    : process.env.PATH || '';

  return {
    ...process.env,
    PATH: augmentedPath,
    BYH_DATA_DIR: dirs.dataDir,
    BYH_CONFIG_DIR: dirs.configDir,
    BYH_RUN_DIR: dirs.runDir,
    SERIAL_PORT: serialPort || process.env.SERIAL_PORT || '',
    SERIAL_BAUD: '115200',
  };
}

function registerServices(dirs, baseEnv) {
  // Bridge first (owns the serial port; daemon connects to it on TCP 9000),
  // then ws + daemon, then the web app. stopAll() reverses this order.
  supervisor.register({
    name: 'bridge',
    command: resources.python,
    args: ['tcp_serial_bridge.py'],
    cwd: resources.bridgeDir,
    env: baseEnv,
  });

  supervisor.register({
    name: 'ws',
    command: resources.python,
    args: ['ws_server.py'],
    cwd: path.join(resources.pythingsDir, 'websock_server'),
    env: baseEnv,
  });

  supervisor.register({
    name: 'daemon',
    command: resources.python,
    args: ['pc_daemon.py'],
    cwd: path.join(resources.pythingsDir, 'pc_daemon'),
    env: baseEnv,
  });

  // The Next standalone server runs on Electron's own bundled Node via
  // ELECTRON_RUN_AS_NODE -- no separate node binary needed. PYTHON_PATH +
  // BYH_PYTHINGS_DIR let the on-demand firing-profile feature find the
  // bundled interpreter and its scripts.
  supervisor.register({
    name: 'app',
    command: process.execPath,
    args: [resources.nextServer],
    cwd: resources.nextDir,
    env: {
      ...baseEnv,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(UI_PORT),
      HOSTNAME: '127.0.0.1',
      PYTHON_PATH: resources.python,
      BYH_PYTHINGS_DIR: resources.pythingsDir,
    },
  });
}

function waitForUI(timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(UI_URL, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(3000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error('UI did not come up in time'));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Backyard Hero',
    backgroundColor: '#0b0b0f',
    show: false,
    webPreferences: { contextIsolation: true },
  });

  const loading = `data:text/html,${encodeURIComponent(
    '<body style="background:#0b0b0f;color:#eee;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>Backyard Hero</h2><p>Starting services…</p></div></body>'
  )}`;
  mainWindow.loadURL(loading);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(dirs) {
  // Tray is best-effort: if no icon ships in the build, skip it rather than
  // crash (the main window is the primary surface anyway).
  const iconPath = path.join(__dirname, '..', 'build', isWin ? 'tray.ico' : 'trayTemplate.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return;

  tray = new Tray(image);
  tray.setToolTip('Backyard Hero');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Backyard Hero', click: () => focusOrCreate() },
    { label: 'Open in browser', click: () => shell.openExternal(UI_URL) },
    { type: 'separator' },
    { label: 'Open logs folder', click: () => shell.openPath(dirs.logDir) },
    {
      label: 'Restart services',
      click: async () => {
        await supervisor.stopAll();
        supervisor.shuttingDown = false;
        supervisor.startAll();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => focusOrCreate());
}

function focusOrCreate() {
  if (!mainWindow) {
    createWindow();
    mainWindow.loadURL(UI_URL);
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

async function main() {
  const dirs = userDirs();
  seedConfigIfMissing(dirs.configDir);

  let serialPort = null;
  try {
    serialPort = await detectDonglePort(resources.python);
    console.log('Detected dongle port:', serialPort || '(none — will use config/UI value)');
  } catch (err) {
    console.error('Serial detection failed:', err.message);
  }

  const baseEnv = buildEnv(dirs, serialPort);

  supervisor = new Supervisor({ logDir: dirs.logDir });
  registerServices(dirs, baseEnv);

  createWindow();
  createTray(dirs);

  supervisor.startAll();

  try {
    await waitForUI();
    if (mainWindow) mainWindow.loadURL(UI_URL);
  } catch (err) {
    console.error(err.message);
    if (mainWindow) {
      mainWindow.loadURL(
        `data:text/html,${encodeURIComponent(
          `<body style="background:#0b0b0f;color:#eee;font-family:sans-serif;padding:40px"><h2>Backyard Hero failed to start</h2><p>${err.message}</p><p>Check the logs at:<br><code>${dirs.logDir}</code></p></body>`
        )}`
      );
    }
  }
}

app.on('window-all-closed', () => {
  // Keep running in the tray on macOS/Windows so services stay up; only fully
  // quit when the user explicitly chooses Quit. If there's no tray, quit.
  if (!tray) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) focusOrCreate();
});

app.on('before-quit', async (event) => {
  if (supervisor && !supervisor.shuttingDown) {
    event.preventDefault();
    await supervisor.stopAll();
    app.exit(0);
  }
});
