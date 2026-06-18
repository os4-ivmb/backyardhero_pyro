import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ensureHardware } from '@/util/apiGuards';
import { COMMAND_DIR } from '@/util/paths';

// W1: This route used to write req.body verbatim into /tmp/d_cmd, making
// it an unauthenticated arbitrary-daemon-command proxy. We now enforce a
// strict server-side allowlist of command types with per-type schema
// validation. Unknown types (and the removed raw-SQL `db_query`) are
// rejected outright.
//
// NOTE: operator-session auth (gating fire/override/firmware behind a
// PIN) is tracked separately as Phase 2 security hardening (C4.2) and is
// intentionally NOT implemented here. This route's job is shape
// validation; it does not by itself make the surface authenticated.

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isBool = (v) => typeof v === 'boolean';
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Each validator returns null on success or an error string. `ok` is a
// shorthand for "no extra fields required".
const ok = () => null;

const VALIDATORS = {
  // Raw serial injection. Kept for diagnostics; at minimum require a
  // string payload so a malformed body can't reach the dongle.
  serial: (b) => (isStr(b.data) ? null : 'serial requires string "data"'),

  manual_fire: (b) => {
    if (!isObj(b.data)) return 'manual_fire requires object "data"';
    const { zone, target, kind } = b.data;
    if (zone === undefined || target === undefined) {
      return 'manual_fire data requires "zone" and "target"';
    }
    if (kind !== undefined && !isStr(kind)) return 'manual_fire "kind" must be a string';
    return null;
  },

  delegate_launch: (b) => (isBool(b.do_it) ? null : 'delegate_launch requires boolean "do_it"'),

  start_show: ok,
  stop_show: ok,
  pause_show: ok,
  stop_schedule: ok,
  unload_show: ok,
  abort_show_load: ok,
  reload_receivers: ok,
  ota_flash_abort: ok,
  dongle_flash_continue: ok,
  dongle_flash_abort: ok,

  schedule: (b) => (Array.isArray(b.schedule) ? null : 'schedule requires array "schedule"'),

  load_show: (b) => (b.id !== undefined && b.id !== null ? null : 'load_show requires "id"'),

  select_serial: (b) => {
    if (!isStr(b.device)) return 'select_serial requires string "device"';
    if (b.baud === undefined || isNaN(Number(b.baud))) return 'select_serial requires numeric "baud"';
    return null;
  },

  // Soft-reboot the dongle's ESP32-S2 over the serial link (firmware
  // acks then calls esp_restart). No payload beyond the type.
  reboot_dongle: ok,

  set_brightness: (b) => (isFiniteNumber(Number(b.brightness)) ? null : 'set_brightness requires numeric "brightness"'),
  set_receiver_timeout: (b) => (isFiniteNumber(Number(b.timeout_ms)) ? null : 'set_receiver_timeout requires numeric "timeout_ms"'),
  set_command_response_timeout: (b) => (isFiniteNumber(Number(b.timeout_ms)) ? null : 'set_command_response_timeout requires numeric "timeout_ms"'),
  set_clock_sync_interval: (b) => (isFiniteNumber(Number(b.interval_ms)) ? null : 'set_clock_sync_interval requires numeric "interval_ms"'),
  set_debug_mode: (b) => (isFiniteNumber(Number(b.debug_mode)) ? null : 'set_debug_mode requires numeric "debug_mode"'),
  set_fire_repeat: (b) => (isFiniteNumber(Number(b.repeat_ct)) ? null : 'set_fire_repeat requires numeric "repeat_ct"'),

  set_gpio_override: (b) => {
    if (!['arm', 'switch', 'manfire'].includes(b.key)) {
      return 'set_gpio_override "key" must be one of arm|switch|manfire';
    }
    if (b.active !== undefined && !isBool(b.active)) return 'set_gpio_override "active" must be boolean';
    if (b.on !== undefined && !isBool(b.on)) return 'set_gpio_override "on" must be boolean';
    return null;
  },

  retry_receiver: (b) => (isStr(b.ident) ? null : 'retry_receiver requires string "ident"'),

  fetch_receiver_config: (b) => {
    if (b.ident !== undefined && b.ident !== null && b.ident !== '' && !isStr(b.ident)) {
      return 'fetch_receiver_config "ident" must be a string when present';
    }
    if (b.fire_duration_ms !== undefined && b.fire_duration_ms !== null && isNaN(Number(b.fire_duration_ms))) {
      return 'fetch_receiver_config "fire_duration_ms" must be numeric when present';
    }
    return null;
  },

  set_rf_channel: (b) => {
    const ch = Number(b.channel);
    if (!isInt(ch) || ch < 0 || ch > 125) return 'set_rf_channel "channel" must be an int 0..125';
    return null;
  },

  ota_flash_start: (b) => {
    if (!isStr(b.ident)) return 'ota_flash_start requires string "ident"';
    if (!isStr(b.image_path)) return 'ota_flash_start requires string "image_path"';
    if (b.rate !== undefined && isNaN(Number(b.rate))) return 'ota_flash_start "rate" must be numeric when present';
    return null;
  },

  dongle_flash_start: (b) => {
    if (!['app', 'full'].includes(b.mode)) return 'dongle_flash_start "mode" must be app|full';
    if (!isObj(b.files) || Object.keys(b.files).length === 0) {
      return 'dongle_flash_start requires non-empty object "files"';
    }
    return null;
  },

  scan_radio: (b) => {
    for (const k of ['passes', 'ch_start', 'ch_end']) {
      if (b[k] !== undefined && isNaN(Number(b[k]))) return `scan_radio "${k}" must be numeric when present`;
    }
    return null;
  },
};

// Explicitly rejected command types (documented so the rejection is
// intentional, not an oversight). db_query was an arbitrary-SQL hole.
const REJECTED = new Set(['db_query']);

export default function handler(req, res) {
  if (!ensureHardware(res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const body = req.body;
  if (!isObj(body)) {
    return res.status(400).json({ error: 'Body must be a JSON object.' });
  }

  const type = body.type;
  if (!isStr(type)) {
    return res.status(400).json({ error: 'Command "type" is required.' });
  }

  if (REJECTED.has(type)) {
    return res.status(403).json({ error: `Command type "${type}" is not permitted.` });
  }

  const validate = VALIDATORS[type];
  if (!validate) {
    return res.status(400).json({ error: `Unknown command type "${type}".` });
  }

  const validationError = validate(body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const folderPath = COMMAND_DIR;
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // W5 race fix: same-millisecond commands used to collide on a
    // `${Date.now()}.json` name and silently overwrite each other. The
    // UUID suffix makes each command file unique; the daemon still
    // processes them in sorted (≈chronological) order.
    const fileName = `${Date.now()}-${crypto.randomUUID()}.json`;
    const filePath = path.join(folderPath, fileName);

    // W5(perf): stamp a correlation id so the client can confirm the
    // daemon actually consumed THIS command (it echoes the id back via
    // state.last_command_ack). A 200 here only proves the file was
    // written; the ack proves it was picked up. Honour a caller-supplied
    // cmd_id if present so the client can pre-generate one for its
    // pending-tracking before the request resolves.
    const cmdId = isStr(body.cmd_id) ? body.cmd_id : crypto.randomUUID();
    const payload = { ...body, cmd_id: cmdId };

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));

    return res.status(200).json({ message: 'Commanded successfully.', cmd_id: cmdId });
  } catch (error) {
    console.error('cmd_daemon write failed:', error);
    return res.status(500).json({ error: 'Failed to command.' });
  }
}
