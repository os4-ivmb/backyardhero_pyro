"""Shared system-config loader for the PC daemon + protocol handler.

The on-disk config is split in two:

  systemcfg.json        git-tracked base. Owns protocols / types / caps and the
                        *default* `system` block.
  systemcfg.user.json   NOT git-tracked. Holds the operator's overrides (dongle
                        port/baud, per-protocol safety knobs, default_location),
                        written by the UI + install script.

`load_system_config()` reads the base and deep-merges the user file on top, so
the user file always wins for the keys it declares while the base supplies the
rest. Mirrors util/systemcfg.js on the Next.js side.
"""

import json
import os

_CONFIG_DIR = os.environ.get("BYH_CONFIG_DIR", "/config")
BASE_CFG_PATH = os.path.join(_CONFIG_DIR, "systemcfg.json")
USER_CFG_PATH = os.path.join(_CONFIG_DIR, "systemcfg.user.json")


def _deep_merge(base, override):
    """Recursively merge ``override`` onto ``base`` (override wins). Returns a
    new dict; inputs are not mutated. Non-dict values replace wholesale."""
    if not isinstance(base, dict) or not isinstance(override, dict):
        return override
    out = dict(base)
    for key, value in override.items():
        if isinstance(out.get(key), dict) and isinstance(value, dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _read_json(path):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def load_system_config():
    """Return the merged config (base systemcfg.json + systemcfg.user.json).

    Never raises: a missing or malformed file degrades to an empty dict for
    that layer, matching the daemon's existing tolerant load behaviour.
    """
    base = _read_json(BASE_CFG_PATH)
    user = _read_json(USER_CFG_PATH)
    if not isinstance(base, dict):
        base = {}
    if not isinstance(user, dict):
        user = {}
    return _deep_merge(base, user)
