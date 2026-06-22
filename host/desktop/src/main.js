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
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, ipcMain } = require('electron');

const { isWin, resources, userDirs } = require('./paths');
const { Supervisor } = require('./supervisor');
const { detectDonglePort } = require('./serial');
const { initAutoUpdates } = require('./updater');

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
    // Native (non-Docker) build: the bridge + flash server are supervised
    // here on the same machine and bind 127.0.0.1. Point the daemon's
    // serial-bridge socket (:9000) and dongle-flash HTTP client (:9001) at
    // loopback. The Python defaults are the Docker-only host.docker.internal,
    // which on Windows resolves to a non-loopback interface the bridge never
    // listens on -> "connection refused" (WinError 10061).
    BYH_BRIDGE_HOST: '127.0.0.1',
    BYH_FLASH_HOST: '127.0.0.1',
    // The bridge's flash_server imports devices/utils/dongle_flasher.py. There
    // is no repo tree in the bundle, so point it at the copy shipped under
    // resources/devices/utils. Without this the flash server never binds :9001
    // and UI dongle flashing fails with WinError 10061 (connection refused).
    BYH_DEVICES_UTILS_DIR: resources.devicesUtilsDir,
    // Let the Next server surface the running host version + "this is the
    // desktop app" flag (drives the Settings version/update footer). The
    // actual self-update is handled by electron-updater in this process.
    BYH_HOST_VERSION: app.getVersion(),
    BYH_DESKTOP: '1',
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

// Builds a horizontal sprite sheet of spiky "burning ember" frames as an inline
// SVG data URI. Each frame jitters the spike lengths/rotation so cycling through
// them with a CSS steps() animation reads as a flickering, crackling fuse end.
function buildSparkSprite() {
  const frames = 5;
  const fw = 64;
  const fh = 64;
  const cx = fw / 2;
  const cy = fh / 2;
  const spikes = 11;

  // Deterministic LCG so the sprite is identical every run (no flashing diff).
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  let body = '';
  for (let f = 0; f < frames; f++) {
    const ox = f * fw;
    const pts = [];
    const phase = rnd() * Math.PI; // rotate the whole burst per frame
    for (let i = 0; i < spikes * 2; i++) {
      const ang = (i * Math.PI) / spikes - Math.PI / 2 + phase;
      const outer = i % 2 === 0;
      const r = outer ? 18 + rnd() * 12 : 7 + rnd() * 4;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      pts.push(`${(ox + x).toFixed(1)},${y.toFixed(1)}`);
    }
    body += `<polygon points="${pts.join(' ')}" fill="url(#g)"/>`;
    body += `<circle cx="${ox + cx}" cy="${cy}" r="${(6 + rnd() * 2).toFixed(1)}" fill="#fff7d6"/>`;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frames * fw}" height="${fh}" ` +
    `viewBox="0 0 ${frames * fw} ${fh}">` +
    `<defs><radialGradient id="g" cx="50%" cy="50%" r="50%">` +
    `<stop offset="0%" stop-color="#fff3b0"/>` +
    `<stop offset="38%" stop-color="#ffb013"/>` +
    `<stop offset="72%" stop-color="#ff5a00"/>` +
    `<stop offset="100%" stop-color="#c81e00"/>` +
    `</radialGradient></defs>${body}</svg>`;

  return { uri: `data:image/svg+xml,${encodeURIComponent(svg)}`, frames, fw, fh };
}

function buildLoadingHTML() {
  // Embed the logo as a base64 data URI so it renders without a file:// load
  // (the loading screen itself is a data: URL with no asset base). The CSS
  // filter recolors the artwork to solid white regardless of its source colors.
  let logoTag = '';
  let hasLogo = false;
  try {
    const logoPath = path.join(__dirname, 'assets', 'BYHv2Logo.png');
    const logoData = fs.readFileSync(logoPath).toString('base64');
    logoTag = `<img src="data:image/png;base64,${logoData}" alt="Backyard Hero" style="display:block;width:280px;max-width:62vw;height:auto;filter:brightness(0) invert(1)" />`;
    hasLogo = true;
  } catch {
    logoTag = '<h2>Backyard Hero</h2>';
  }

  let version = '';
  try {
    version = app.getVersion();
  } catch {
    version = '';
  }

  const spark = buildSparkSprite();
  const em = 30; // on-screen ember size (px); sprite frames are scaled to this

  // The fuse cord sits "inside" the logo, starting right off the star after
  // HERO. It burns left->right away from the star: the lit ember rides the
  // burn front and the consumed (left) section is clipped away to transparent,
  // so it reads as gone/burned. Both the clip and the ember share one
  // timing/loop, so it re-lights and burns down forever.
  const burnMs = 3200;
  const flickerMs = 360; // full cycle through all 5 ember frames

  // Geometry as % of the logo box (800x400) so it tracks the logo at any size:
  //   star tip ends ~40% across; star vertical center ~52% down.
  const fuseInner = '<div class="track"></div><div class="ember"></div>';
  const stage = hasLogo
    ? `<div class="logo">${logoTag}<div class="fuse">${fuseInner}</div></div>`
    : `${logoTag}<div class="fuse fuse--below">${fuseInner}</div>`;

  return `data:text/html,${encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{height:100%;margin:0}
      body{background:#0b0b0f;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center}
      .wrap{text-align:center}
      .logo{position:relative;display:inline-block;line-height:0}
      .status{margin-top:24px;font-size:18px;letter-spacing:0.5px}
      .ver{margin-top:8px;font-size:13px;color:#888}
      .fuse{position:absolute;left:40%;top:52%;width:57%;height:${em}px;transform:translateY(-50%)}
      .fuse--below{position:relative;left:auto;top:auto;transform:none;width:380px;max-width:72vw;margin:18px auto 0}
      .track{position:absolute;left:0;right:0;top:50%;height:7px;transform:translateY(-50%);
        border-radius:4px;overflow:hidden;
        background:repeating-linear-gradient(-45deg,#2e8b40 0 6px,#0b3d18 6px 12px);
        box-shadow:inset 0 0 0 1px rgba(0,0,0,0.3);
        animation:burn ${burnMs}ms linear infinite}
      .ember{position:absolute;top:50%;left:0;width:${em}px;height:${em}px;
        margin-left:-${em / 2}px;margin-top:-${em / 2}px;
        background-image:url('${spark.uri}');background-repeat:no-repeat;
        background-size:${spark.frames * em}px ${em}px;
        filter:drop-shadow(0 0 4px #ff7a18) drop-shadow(0 0 10px #ff3b00);
        animation:travel ${burnMs}ms linear infinite, flicker ${flickerMs}ms steps(${spark.frames}) infinite}
      @keyframes burn{from{clip-path:inset(0 0 0 0)}to{clip-path:inset(0 0 0 100%)}}
      @keyframes travel{from{left:0}to{left:100%}}
      @keyframes flicker{from{background-position-x:0}to{background-position-x:-${spark.frames * em}px}}
    </style></head><body><div class="wrap">
      ${stage}
      <p class="status">Starting up System</p>
      ${version ? `<p class="ver">v${version}</p>` : ''}
    </div></body></html>`
  )}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Backyard Hero',
    backgroundColor: '#0b0b0f',
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(buildLoadingHTML());
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(dirs) {
  // Tray assets live under src/assets so they're packed into the asar -- the
  // build/ buildResources dir (where icon.png lives for electron-builder) is
  // NOT bundled into the running app. Best-effort: if the icon can't load, skip
  // the tray rather than crash (the main window is the primary surface anyway).
  const iconPath = path.join(__dirname, 'assets', isWin ? 'tray.ico' : 'tray.png');
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

  // Work around the Electron/Chromium Windows bug where keyboard focus to the
  // web contents dies after a native confirm/alert/prompt (the renderer asks
  // for this via the preload's byhDesktop.fixDialogFocus). Bouncing the window
  // focus restores typing; element/window.focus() alone does not. Harmless on
  // macOS/Linux, where the dialogs don't break focus.
  ipcMain.on('byh:fix-dialog-focus', () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
      mainWindow.blur();
      mainWindow.focus();
    }
  });

  supervisor.startAll();

  // Background auto-updates. Reads/writes status + command files under the
  // same per-user dirs the services use, so the Settings footer can show
  // update state and trigger an install. Best-effort; only active in a
  // packaged build.
  try {
    // beforeInstall lets the updater stop our services before it hands off to
    // Squirrel/NSIS, so the quit proceeds cleanly (see before-quit below).
    initAutoUpdates(dirs, { beforeInstall: () => supervisor.stopAll() });
  } catch (err) {
    console.error('Auto-update init failed:', err.message);
  }

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

app.on('before-quit', (event) => {
  // If the services are already (being) torn down, let the quit run its normal
  // course. This is the second pass after our own cleanup, and it's also the
  // path the auto-updater takes (it stops the services first): we must NOT
  // hard-exit here, or electron-updater can't apply a pending update on quit
  // and Squirrel/NSIS can't relaunch into the new version -- which is exactly
  // why "Restart to update" appeared to do nothing.
  if (!supervisor || supervisor.shuttingDown) return;

  // First pass on a plain quit: stop the services, then re-issue the quit so
  // the normal will-quit/quit sequence (and any pending update install) runs.
  event.preventDefault();
  supervisor.stopAll().finally(() => app.quit());
});
