// Diagnostics collector for in-app support tickets.
//
// Runs server-side (Next API route only) so it can read the local SQLite DB,
// the daemon state file, and the log files under the per-user data dir. The
// browser modal never sees the filesystem; it just sends the operator-entered
// fields + the staged show id, and this module assembles the machine snapshot
// that gets forwarded to the cloud gateway's /api/app-reports endpoint.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import {
  DATA_DIR,
  RUN_DIR,
  LOG_DIR,
  STATE_FILE_PATH,
  LAST_SCAN_FILE_PATH,
  HOST_UPDATE_STATUS_PATH,
  CURSOR_FILE,
  FIRING_FILE,
  COMMAND_DIR,
} from '@/util/paths';
import { getHostInfo } from '@/util/host';
import { getRepo } from '@/data';
import { readMergedSystemConfigSync } from '@/util/systemcfg';

// Supervisor service logs (see desktop/src/supervisor.js) + the daemon error
// log written by pc_daemon.py. We grab the tail of each one.
const LOG_FILES = ['app.log', 'daemon.log', 'ws.log', 'bridge.log', 'daemon.err'];

// A receiver is "connected" if the dongle heard from it within this window.
// Mirrors the 10s rule in components/receivers/ReceiverDisplay.jsx.
const CONNECTED_WINDOW_MS = 10000;

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, error: err?.message || String(err) };
  }
}

function readTextSafe(filePath) {
  try {
    return { ok: true, value: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, error: err?.message || String(err) };
  }
}

// Read the last `maxLines` lines of a (potentially large) log file without
// slurping the whole thing: read at most `maxBytes` from the end.
function readTailLines(filePath, maxLines = 100, maxBytes = 512 * 1024) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      // We may have sliced mid-line; drop the first partial line.
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    const lines = text.split(/\r?\n/);
    // Trailing newline produces an empty final element; drop it.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-maxLines);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return [`<error reading ${path.basename(filePath)}: ${err?.message || err}>`];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function safeStr(value, max = 200) {
  if (value == null) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

// Coarse, non-PII device fingerprint so multiple reports from the same machine
// can be correlated without shipping the hostname verbatim.
function deviceId() {
  try {
    const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${os.userInfo().username}`;
    return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function buildReceivers(dbReceivers, stateReceivers) {
  const now = Date.now();
  const byId = new Map();

  for (const r of dbReceivers || []) {
    byId.set(r.id, {
      id: r.id,
      label: r.label ?? r.id,
      type: r.type ?? null,
      enabled: r.enabled === true || r.enabled === 1,
      fw_version: r.fw_version ?? null,
      board_version: r.board_version ?? null,
      cues_available: r.cues_available ?? null,
      configuration_version: r.configuration_version ?? null,
      connected: false,
      last_seen_ms_ago: null,
      source: 'db',
    });
  }

  // Merge live state (status.lmt = last message time from the dongle).
  for (const [id, live] of Object.entries(stateReceivers || {})) {
    const entry = byId.get(id) || {
      id,
      label: live?.label ?? id,
      type: live?.type ?? null,
      enabled: live?.enabled === true,
      fw_version: null,
      board_version: null,
      cues_available: null,
      configuration_version: live?.configuration_version ?? null,
      connected: false,
      last_seen_ms_ago: null,
      source: 'state-only',
    };
    const lmt = live?.status?.lmt;
    if (typeof lmt === 'number') {
      const delta = now - lmt;
      entry.last_seen_ms_ago = delta;
      entry.connected = delta <= CONNECTED_WINDOW_MS;
    }
    byId.set(id, entry);
  }

  return Array.from(byId.values());
}

/**
 * Assemble the full diagnostics + logs payload for a support ticket.
 *
 * @param {object} opts
 * @param {number|string|null} opts.stagedShowId  Show id the operator currently
 *        has staged in the UI (from useAppStore). Its full DB row is dumped.
 * @param {object} req  The API request (passed through to getRepo).
 */
export async function collectDiagnostics({ stagedShowId = null, req } = {}) {
  const host = (() => {
    try { return getHostInfo(); } catch { return {}; }
  })();

  // --- daemon state file ---------------------------------------------------
  const stateRead = readJsonSafe(STATE_FILE_PATH);
  const daemonState = stateRead.ok ? stateRead.value : null;

  // --- receivers (DB + live) ----------------------------------------------
  let dbReceivers = [];
  let shows = [];
  try {
    const repo = await getRepo(req);
    try { dbReceivers = await repo.receivers.list(); } catch (e) { dbReceivers = [{ error: e?.message }]; }
    try { shows = await repo.shows.list(); } catch (e) { shows = [{ error: e?.message }]; }
  } catch (e) {
    dbReceivers = [{ error: `repo unavailable: ${e?.message}` }];
  }

  const receivers = buildReceivers(
    Array.isArray(dbReceivers) ? dbReceivers : [],
    daemonState?.receivers || {},
  );

  // --- show data -----------------------------------------------------------
  const showList = Array.isArray(shows) ? shows : [];
  const findShow = (id) => {
    if (id == null) return null;
    return showList.find((s) => String(s.id) === String(id)) || null;
  };
  const stagedShow = findShow(stagedShowId);
  const loadedShowId = daemonState?.loaded_show_id ?? null;
  const loadedShow = findShow(loadedShowId);

  // --- system config (merged base + user overrides) ------------------------
  let systemConfig = null;
  try { systemConfig = readMergedSystemConfigSync(); } catch (e) { systemConfig = { error: e?.message }; }

  // --- other state files ---------------------------------------------------
  const showStateMarker = readTextSafe(path.join(DATA_DIR, 'byh_show_state'));
  const lastScan = readJsonSafe(LAST_SCAN_FILE_PATH);
  const hostUpdate = readJsonSafe(HOST_UPDATE_STATUS_PATH);
  const fwCursor = readTextSafe(CURSOR_FILE);
  const fwFiring = readJsonSafe(FIRING_FILE);

  let pendingCommands = [];
  try {
    pendingCommands = fs.readdirSync(COMMAND_DIR).filter((f) => f.endsWith('.json'));
  } catch { pendingCommands = []; }

  // --- logs ----------------------------------------------------------------
  const logs = {};
  for (const name of LOG_FILES) {
    const tail = readTailLines(path.join(LOG_DIR, name), 100);
    if (tail) logs[name] = tail;
  }

  // --- summary fields (lifted out for the table/columns) -------------------
  const appVersion = host?.app_version ?? process.env.BYH_HOST_VERSION ?? null;
  const dongleVersion =
    daemonState?.dongle_fw_version != null ? String(daemonState.dongle_fw_version) : null;
  const osInfo = safeStr(`${os.platform()} ${os.release()} (${os.arch()})`);

  const diagnostics = {
    collected_at: new Date().toISOString(),
    host: {
      app_version: appVersion,
      is_desktop: host?.is_desktop ?? null,
      is_raspberry_pi: host?.is_raspberry_pi ?? null,
      model: host?.model ?? null,
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      node: process.version,
    },
    dongle: {
      fw_version: dongleVersion,
      device_found: daemonState?.device_found ?? null,
      device_running: daemonState?.device_running ?? null,
      device_address: daemonState?.device_address ?? null,
      device_is_transmitting: daemonState?.device_is_transmitting ?? null,
      device_is_armed: daemonState?.device_is_armed ?? null,
      active_protocol: daemonState?.active_protocol ?? null,
    },
    receivers,
    show: {
      staged_show_id: stagedShowId ?? null,
      loaded_show_id: loadedShowId,
      show_loaded: daemonState?.show_loaded ?? null,
      show_running: daemonState?.show_running ?? null,
      staged_show: stagedShow,
      loaded_show: loadedShow,
      show_count: showList.length,
    },
    daemon_state: stateRead.ok ? daemonState : { error: stateRead.error, missing: stateRead.missing || false },
    state_files: {
      byh_show_state: showStateMarker.ok ? showStateMarker.value.trim() : null,
      last_scan: lastScan.ok ? lastScan.value : (lastScan.missing ? null : { error: lastScan.error }),
      host_update: hostUpdate.ok ? hostUpdate.value : (hostUpdate.missing ? null : { error: hostUpdate.error }),
      fw_cursor: fwCursor.ok ? fwCursor.value.trim() : null,
      fw_firing: fwFiring.ok ? fwFiring.value : (fwFiring.missing ? null : { error: fwFiring.error }),
      pending_daemon_commands: pendingCommands,
    },
    system_config: systemConfig,
  };

  return {
    summary: {
      app_version: appVersion,
      dongle_version: dongleVersion,
      os_info: osInfo,
      device_id: deviceId(),
    },
    diagnostics,
    logs,
  };
}
