'use strict';

/**
 * Background auto-updater for the desktop bundle.
 *
 * electron-updater pulls latest.yml / latest-mac.yml from the generic feed
 * configured in electron-builder.yml (https://backyard-hero.com/download/desktop/),
 * which is the same static path the publish job rsyncs the installers + feed
 * files to. On Windows (NSIS) it downloads the new installer in the background
 * and applies it on quit; on macOS the same flow works once the app is signed
 * + notarized.
 *
 * The Next.js UI runs as a separate process (loaded over HTTP), so it can't
 * use Electron IPC. We bridge two ways through the shared per-user dirs the
 * supervisor already hands every child:
 *
 *   - We WRITE a small status file (dataDir/host_update.json) the
 *     /api/system/host_update route reads, so the Settings footer can show
 *     "checking / update available / downloaded".
 *   - We POLL a command file (runDir/host_update_cmd.json) the same route
 *     writes, so the footer's "Check for updates" / "Restart & install"
 *     buttons can drive the updater.
 *
 * Everything here is best-effort: the updater only runs in a packaged build
 * (a dev `npm start` has no app-update.yml / feed), and any failure just
 * lands in the status file as phase:"error" rather than disrupting the app.
 */

const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (err) {
  // Dependency missing (e.g. a dev tree that skipped `npm ci`). Degrade to a
  // no-op rather than crashing the whole app on startup.
  console.error('electron-updater not available:', err.message);
}

// Re-check cadence once the app is up. Mirrors the 6h TTL the firmware-latest
// resolver uses -- updates are infrequent and the manual button forces a check.
const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000;
// Small delay after launch so the update check doesn't compete with the
// service stack coming up.
const INITIAL_CHECK_MS = 15 * 1000;
// How often we look for a UI-issued command (check / install).
const CMD_POLL_MS = 2000;

let statusPath = null;
let cmdPath = null;
let cmdTimer = null;
let lastStatus = { phase: 'idle' };

function writeStatus(patch) {
  lastStatus = {
    ...lastStatus,
    ...patch,
    running: app.getVersion(),
    checked_at: Date.now(),
  };
  if (!statusPath) return;
  try {
    const tmp = `${statusPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(lastStatus, null, 2));
    fs.renameSync(tmp, statusPath);
  } catch (err) {
    console.error('updater: could not write status file:', err.message);
  }
}

function bindEvents() {
  autoUpdater.on('checking-for-update', () => writeStatus({ phase: 'checking', error: null }));

  autoUpdater.on('update-available', (info) => {
    writeStatus({
      phase: 'downloading',
      available_version: info?.version || null,
      progress_pct: 0,
      error: null,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    writeStatus({
      phase: 'up-to-date',
      available_version: info?.version || null,
      progress_pct: null,
      error: null,
    });
  });

  autoUpdater.on('download-progress', (p) => {
    writeStatus({ phase: 'downloading', progress_pct: Math.round(p?.percent ?? 0) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    writeStatus({
      phase: 'downloaded',
      available_version: info?.version || null,
      progress_pct: 100,
      error: null,
    });
    promptInstall(info?.version);
  });

  autoUpdater.on('error', (err) => {
    writeStatus({ phase: 'error', error: (err && err.message) || String(err) });
  });
}

function promptInstall(version) {
  // Offer an immediate restart, but never force it -- the operator may be
  // mid-show. If they decline, electron-updater applies the update on the
  // next quit (autoInstallOnAppQuit) and the footer keeps showing "ready".
  dialog
    .showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Backyard Hero ${version ? `v${version} ` : ''}is ready to install.`,
      detail: 'Restart to apply it now, or it will install automatically the next time you quit.',
    })
    .then(({ response }) => {
      if (response === 0) quitAndInstall();
    })
    .catch(() => {});
}

function quitAndInstall() {
  try {
    // isSilent=false (show the installer UI on Windows), isForceRunAfter=true
    // (relaunch the app once the update lands).
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    writeStatus({ phase: 'error', error: `install failed: ${err.message}` });
  }
}

function checkForUpdates() {
  if (!autoUpdater) return;
  autoUpdater.checkForUpdates().catch((err) => {
    writeStatus({ phase: 'error', error: (err && err.message) || String(err) });
  });
}

function pollCommands() {
  if (!cmdPath) return;
  let cmd = null;
  try {
    if (!fs.existsSync(cmdPath)) return;
    cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf-8'));
  } catch {
    // Half-written file: leave it for the next tick.
    return;
  } finally {
    // Consume the command regardless so we don't loop on a bad file.
    try {
      if (fs.existsSync(cmdPath)) fs.unlinkSync(cmdPath);
    } catch {
      /* best effort */
    }
  }
  if (!cmd) return;
  if (cmd.action === 'check') checkForUpdates();
  else if (cmd.action === 'install') quitAndInstall();
}

/**
 * Wire up auto-updates. `dirs` is the supervisor's resolved per-user dirs
 * ({ dataDir, runDir, ... }) so the status/command files land where the Next
 * server (same BYH_DATA_DIR / BYH_RUN_DIR) can read/write them.
 */
function initAutoUpdates(dirs) {
  statusPath = path.join(dirs.dataDir, 'host_update.json');
  cmdPath = path.join(dirs.runDir, 'host_update_cmd.json');

  // Command polling works even when the updater itself can't run (so the UI
  // button gives feedback rather than hanging), but the actual check is gated
  // on a packaged build below.
  if (cmdTimer) clearInterval(cmdTimer);
  cmdTimer = setInterval(pollCommands, CMD_POLL_MS);

  if (!autoUpdater) {
    writeStatus({ phase: 'unsupported', error: 'electron-updater unavailable' });
    return;
  }
  if (!app.isPackaged) {
    // Dev runs have no embedded feed config; checking would just error.
    writeStatus({ phase: 'dev', error: null });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  bindEvents();
  writeStatus({ phase: 'idle', error: null });

  setTimeout(checkForUpdates, INITIAL_CHECK_MS);
  setInterval(checkForUpdates, PERIODIC_CHECK_MS);
}

module.exports = { initAutoUpdates, checkForUpdates, quitAndInstall };
