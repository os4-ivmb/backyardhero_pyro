import { promises as fs } from 'fs';
import fsSync from 'fs';
import crypto from 'crypto';
import { SYSTEM_CFG_PATH, SYSTEM_USER_CFG_PATH } from '@/util/paths';

/**
 * System configuration overlay.
 *
 * The on-disk config is split in two:
 *
 *   systemcfg.json        git-tracked base. Owns protocols / types / caps and
 *                         the *default* `system` block. Operators don't edit
 *                         it directly anymore.
 *   systemcfg.user.json   NOT git-tracked. Holds only the operator's overrides
 *                         (dongle port/baud, per-protocol safety knobs,
 *                         default_location). Written by the UI + install script.
 *
 * Every reader loads the base and deep-merges the user file on top, so the
 * user file always wins for the keys it declares while the base supplies the
 * rest. Writers extract just the user-editable subset and persist it to the
 * user file, leaving the git-tracked base untouched.
 */

// Top-level keys the operator is allowed to override via the UI. `protocols`
// is special-cased below (only the per-protocol `config` block is user-owned;
// labels/types stay in the base file).
const USER_OVERRIDE_KEYS = ['system', 'default_location'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Recursively merge `override` onto `base`. Objects merge key-by-key; anything
 * else (scalars, arrays) is replaced wholesale by the override value. Neither
 * input is mutated.
 */
export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(out[key]) && isPlainObject(value)) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Pull the user-editable subset out of a (possibly fully-merged) config object
 * so it can be persisted to systemcfg.user.json. Keeps `system`,
 * `default_location`, and each protocol's `config` block; drops everything
 * server-derived or base-owned (receivers, host, caps, types, labels, ...).
 */
export function extractUserOverrides(cfg) {
  const out = {};
  if (!isPlainObject(cfg)) return out;

  for (const key of USER_OVERRIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(cfg, key) && cfg[key] !== undefined) {
      out[key] = cfg[key];
    }
  }

  if (isPlainObject(cfg.protocols)) {
    const protocols = {};
    for (const [name, def] of Object.entries(cfg.protocols)) {
      if (isPlainObject(def) && def.config !== undefined) {
        protocols[name] = { config: def.config };
      }
    }
    if (Object.keys(protocols).length > 0) out.protocols = protocols;
  }

  return out;
}

function parseJsonOr(content, fallback) {
  try {
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

/** Async: read the base config and overlay the user file on top. */
export async function readMergedSystemConfig() {
  let base = {};
  try {
    base = parseJsonOr(await fs.readFile(SYSTEM_CFG_PATH, 'utf-8'), {});
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    const user = parseJsonOr(await fs.readFile(SYSTEM_USER_CFG_PATH, 'utf-8'), {});
    return deepMerge(base, user);
  } catch (err) {
    if (err.code === 'ENOENT') return base;
    throw err;
  }
}

/** Sync variant for the (sync) better-sqlite3 seed path. */
export function readMergedSystemConfigSync() {
  let base = {};
  if (fsSync.existsSync(SYSTEM_CFG_PATH)) {
    base = parseJsonOr(fsSync.readFileSync(SYSTEM_CFG_PATH, 'utf-8'), {});
  }
  if (fsSync.existsSync(SYSTEM_USER_CFG_PATH)) {
    const user = parseJsonOr(fsSync.readFileSync(SYSTEM_USER_CFG_PATH, 'utf-8'), {});
    return deepMerge(base, user);
  }
  return base;
}

/**
 * Persist the user-editable subset of `cfg` to systemcfg.user.json. The
 * git-tracked base file is never touched. Atomic (tmp + rename) so a mid-write
 * crash can't truncate the operator's overrides.
 */
export async function writeUserOverrides(cfg) {
  const overrides = extractUserOverrides(cfg);
  const tmpPath = `${SYSTEM_USER_CFG_PATH}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(overrides, null, 2), 'utf-8');
    await fs.rename(tmpPath, SYSTEM_USER_CFG_PATH);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* best effort */ }
    throw err;
  }
  return overrides;
}
