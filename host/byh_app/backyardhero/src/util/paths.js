import path from 'path';

/**
 * Central runtime-path resolver.
 *
 * Historically every path was hardcoded to the container layout (`/data`,
 * `/config`, `/tmp/...`) because the app only ever ran inside the Docker
 * image with those bind-mounts. The desktop bundle (Electron, on
 * macOS/Windows/Linux) has no such mounts -- it stores mutable state under
 * the per-user app-data directory instead.
 *
 * To support both without forking the code, every location is now derived
 * from three base dirs, each overridable via an environment variable:
 *
 *   BYH_DATA_DIR    persistent state  (SQLite DB, show state, logs)   default /data
 *   BYH_CONFIG_DIR  user config       (systemcfg.json)                default /config
 *   BYH_RUN_DIR     ephemeral IPC     (command dropbox, OTA staging,  default /tmp
 *                                      cursor/firing markers, sockets)
 *
 * The defaults reproduce the exact pre-existing container paths, so the
 * Docker image and the Raspberry Pi systemd deployment are byte-for-byte
 * unchanged. The Electron supervisor sets all three to writable dirs under
 * app.getPath('userData') before spawning the Next server + Python services,
 * so every process agrees on the same locations.
 */

export const DATA_DIR = process.env.BYH_DATA_DIR || '/data';
export const CONFIG_DIR = process.env.BYH_CONFIG_DIR || '/config';
export const RUN_DIR = process.env.BYH_RUN_DIR || '/tmp';

// --- Persistent state (DATA_DIR) -------------------------------------------
export const DB_PATH = path.join(DATA_DIR, 'backyardhero.db');
export const STATE_FILE_PATH = path.join(DATA_DIR, 'state');
export const LAST_SCAN_FILE_PATH = path.join(DATA_DIR, 'last_scan.json');
export const LOG_DIR = path.join(DATA_DIR, 'log');
// Desktop auto-updater status, written by the Electron main process
// (src/updater.js) so the Settings version footer can read it.
export const HOST_UPDATE_STATUS_PATH = path.join(DATA_DIR, 'host_update.json');

// --- User config (CONFIG_DIR) ----------------------------------------------
// systemcfg.json is the git-tracked base config (protocols/types/caps plus
// default system block). systemcfg.user.json holds the operator's overrides
// (dongle port/baud, protocol safety knobs, default_location). It is NOT
// git-tracked and is written only by the UI / install script. Every reader
// loads the base and overlays the user file on top -- see util/systemcfg.js
// (JS) and pythings/pc_daemon/config_loader.py (Python).
export const SYSTEM_CFG_PATH = path.join(CONFIG_DIR, 'systemcfg.json');
export const SYSTEM_USER_CFG_PATH = path.join(CONFIG_DIR, 'systemcfg.user.json');

// --- Ephemeral IPC (RUN_DIR) -----------------------------------------------
// The daemon polls COMMAND_DIR for one-shot command files dropped by the API;
// the bridge reads firmware blobs the API stages under STAGING_DIR. Both must
// resolve to the SAME path on the API side and the Python side, which is why
// they are env-derived rather than hardcoded.
export const COMMAND_DIR = path.join(RUN_DIR, 'd_cmd');
export const STAGING_DIR = path.join(RUN_DIR, 'ota_staging');
export const CURSOR_FILE = path.join(RUN_DIR, 'fw_cursor');
export const FIRING_FILE = path.join(RUN_DIR, 'fw_firing');
export const STATE_SOCKET_PATH = path.join(RUN_DIR, 'byh_state.sock');
// One-shot command file the Settings footer drops for the Electron updater
// (src/updater.js polls + consumes it): { action: "check" | "install" }.
export const HOST_UPDATE_CMD_PATH = path.join(RUN_DIR, 'host_update_cmd.json');
