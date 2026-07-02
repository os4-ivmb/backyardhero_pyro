#!/usr/bin/env python3
"""Host-device audio player for BackyardHero pyromusical shows.

Plays a loaded show's soundtrack out of THIS device's own audio output,
scheduled off the same show-start-time (`sst`) the firing daemon broadcasts,
so the music lines up with the fireworks exactly the way the browser console
does today.

Architecture (kept deliberately decoupled from the firing daemon):

  * State  -> we connect to the SAME WebSocket the browser console consumes
              (ws://127.0.0.1:8090) and watch `fw_state.proto_handler_status`,
              `fw_state.sst`, and `fw_state.loaded_show_id`.
  * Tracks -> the show's track list lives in the SQLite `Show.audio_file`
              column (JSON). We read it directly, the same DB the daemon
              loads shows from.
  * Bytes  -> each track is streamed from the app's own range-serve route
              (/api/shows/audio/<file>), so "where does the file live on disk"
              stays the app's problem, not ours. Cloud/absolute URLs are used
              as-is.
  * Output -> ffplay (ffmpeg). If the host has no audio device (e.g. the dev
              container) ffplay just exits non-zero; we log it and carry on.
              This process never crashes on a playback failure, so supervisord
              never sees a crash-loop.

Enablement + timing knobs live in systemcfg (`system.hostAudio`), edited from
the app's Settings screen:

  system.hostAudio = { "enabled": bool, "deviceLatencyMs": number }

`deviceLatencyMs` is a per-device trim: how many ms EARLIER than the ideal
play instant to launch ffplay, to hide the player's own startup latency
(analogous to the browser's per-show audio sync offset, but device-specific).
"""

import asyncio
import json
import os
import sqlite3
import time

import websockets

# --- Paths / endpoints ------------------------------------------------------
# Mirror the daemon's env contract (see pc_daemon.py / paths.js).
_DATA_DIR = os.environ.get("BYH_DATA_DIR", "/data")
_CONFIG_DIR = os.environ.get("BYH_CONFIG_DIR", "/config")
DB_PATH = os.path.join(_DATA_DIR, "backyardhero.db")
SYSTEM_CFG_PATH = os.path.join(_CONFIG_DIR, "systemcfg.json")
SYSTEM_USER_CFG_PATH = os.path.join(_CONFIG_DIR, "systemcfg.user.json")

# The app + websocket both run on this same host under supervisord.
APP_URL = os.environ.get("BYH_APP_URL", "http://127.0.0.1:1776").rstrip("/")
WS_URL = os.environ.get("BYH_WS_URL", "ws://127.0.0.1:8090")

# proto_handler_status values during which a show is arming/counting/running.
# Leaving this set (STOPPED / ABORTED / None / unload) tears playback down.
RUNNING_STATES = {"START_PENDING", "START_CONFIRMED", "STARTED"}


def log(msg):
    # -u (unbuffered) is set in the supervisord command so this is live.
    print(f"[audio_player] {msg}", flush=True)


# --- Config -----------------------------------------------------------------
def _read_json(path):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except (ValueError, OSError) as e:
        log(f"config read failed ({path}): {e}")
        return {}


def read_host_audio_config():
    """Merged `system.hostAudio` (base <- user override), matching the app's
    readMergedSystemConfig() overlay for the keys we care about.

    Returns { enabled: bool, deviceLatencyMs: float }.
    """
    base = _read_json(SYSTEM_CFG_PATH)
    user = _read_json(SYSTEM_USER_CFG_PATH)
    ha = {}
    for src in (base, user):
        sysblk = src.get("system") if isinstance(src, dict) else None
        if isinstance(sysblk, dict) and isinstance(sysblk.get("hostAudio"), dict):
            ha.update(sysblk["hostAudio"])
    latency = ha.get("deviceLatencyMs", 0)
    try:
        latency = float(latency)
    except (TypeError, ValueError):
        latency = 0.0
    device_id = ha.get("deviceId")
    if not isinstance(device_id, str) or not device_id.strip():
        device_id = "default"
    return {
        "enabled": bool(ha.get("enabled", False)),
        "deviceLatencyMs": latency,
        "deviceId": device_id.strip(),
    }


# --- Track manifest ---------------------------------------------------------
def _coerce_tracks(raw):
    """Extract a list of {url, ...} track dicts from whatever shape the
    audio_file column holds. Mirrors normalizeAudioTracks() in audioTracks.js:
    accepts the new {tracks:[...]} blob, a bare array, or a single legacy
    track object."""
    if not raw:
        return []
    if isinstance(raw, list):
        return [t for t in raw if isinstance(t, dict) and t.get("url")]
    if isinstance(raw, dict):
        if isinstance(raw.get("tracks"), list):
            return [t for t in raw["tracks"] if isinstance(t, dict) and t.get("url")]
        if raw.get("url"):
            return [raw]
    return []


def load_manifest(show_id):
    """Read the show's audio tracks + show-level offset from the DB.

    Returns { urls: [str], audioOffsetMs: float } with urls already resolved
    to absolute (app-served or cloud) URLs, or None if the show has no audio.
    """
    try:
        with sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True) as conn:
            row = conn.execute(
                "SELECT audio_file FROM Show WHERE id = ?", (show_id,)
            ).fetchone()
    except sqlite3.Error as e:
        log(f"DB read failed for show {show_id}: {e}")
        return None
    if not row or not row[0]:
        return None
    try:
        raw = json.loads(row[0])
    except (TypeError, ValueError):
        return None

    tracks = _coerce_tracks(raw)
    if not tracks:
        return None

    offset = 0.0
    if isinstance(raw, dict):
        for key in ("audioOffsetMs", "playbackOffsetMs"):
            if isinstance(raw.get(key), (int, float)):
                offset = float(raw[key])
                break

    urls = []
    for t in tracks:
        u = t.get("url")
        if not u:
            continue
        urls.append(u if u.startswith("http") else f"{APP_URL}{u}")
    if not urls:
        return None
    return {"urls": urls, "audioOffsetMs": offset}


# --- Playback ---------------------------------------------------------------
class AudioPlayer:
    def __init__(self):
        self._task = None            # asyncio.Task running the scheduled show
        self._proc = None            # current ffplay subprocess
        self._scheduled_sst = None   # sst we've already armed a run for
        self._stop = asyncio.Event()

    def is_active(self):
        return self._task is not None and not self._task.done()

    async def arm(self, sst, show_id):
        """Schedule a full-show playback keyed to `sst` (ms wall-clock)."""
        if self._scheduled_sst == sst and self.is_active():
            return  # already armed for this exact start
        cfg = read_host_audio_config()
        if not cfg["enabled"]:
            return
        manifest = load_manifest(show_id)
        if not manifest:
            log(f"show {show_id} has no audio tracks; nothing to play")
            return
        await self.stop()  # clear any prior run before arming a fresh one
        self._scheduled_sst = sst
        self._stop.clear()
        self._task = asyncio.create_task(
            self._run(sst, manifest, cfg["deviceLatencyMs"], cfg["deviceId"])
        )

    async def start_now(self, show_id):
        """Fallback path: we joined a show already in STARTED (e.g. process
        restart mid-show). Play from the head immediately, best-effort."""
        cfg = read_host_audio_config()
        if not cfg["enabled"] or self.is_active():
            return
        manifest = load_manifest(show_id)
        if not manifest:
            return
        log(f"joining running show {show_id} mid-flight; starting audio now")
        self._scheduled_sst = None
        self._stop.clear()
        self._task = asyncio.create_task(
            self._run(None, manifest, 0.0, cfg["deviceId"])
        )

    async def stop(self):
        self._scheduled_sst = None
        self._stop.set()
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        self._proc = None

    async def _run(self, sst, manifest, device_latency_ms, device_id="default"):
        try:
            if sst is not None:
                # Ideal audible instant = sst shifted by the show-level sync
                # offset (positive = music ahead of cue 0 => start earlier).
                # Then launch `device_latency_ms` earlier still to mask the
                # player's own startup lag.
                launch_at = (
                    sst - manifest["audioOffsetMs"] - device_latency_ms
                ) / 1000.0
                delay = launch_at - time.time()
                if delay > 0:
                    log(f"audio armed; launching in {delay:.2f}s")
                    try:
                        await asyncio.wait_for(self._stop.wait(), timeout=delay)
                        return  # stop fired during the countdown -> abort
                    except asyncio.TimeoutError:
                        pass
                else:
                    log(f"audio armed late by {-delay:.2f}s; launching now")

            for idx, url in enumerate(manifest["urls"]):
                if self._stop.is_set():
                    return
                log(f"playing track {idx + 1}/{len(manifest['urls'])} "
                    f"-> {device_id}")
                await self._play_one(url, device_id)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # never let a playback error kill the process
            log(f"playback error: {e}")

    def _spawn_args(self, url, device_id):
        """Command for playing one track.

        `default` -> ffplay on the system default output (simple, format-
        agnostic). A specific ALSA device -> ffmpeg decoding to that device
        via the alsa output muxer (ffplay can't target an output device, but
        ffmpeg can, and ALSA paces it in real time)."""
        if device_id and device_id != "default":
            return [
                "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin",
                "-i", url, "-vn", "-f", "alsa", device_id,
            ]
        return [
            "ffplay", "-nodisp", "-autoexit", "-hide_banner",
            "-loglevel", "warning", "-infbuf", url,
        ]

    async def _play_one(self, url, device_id="default"):
        args = self._spawn_args(url, device_id)
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            log(f"{args[0]} not found on PATH; cannot play audio on this device")
            self._stop.set()
            return
        _out, err = await self._proc.communicate()
        if self._stop.is_set():
            return
        # ffplay exits 0 even when it can't open the audio device OR the
        # network source (it just prints to stderr), so the return code tells
        # us nothing -- inspect stderr for the failure markers instead. Covers
        # both the ffplay/SDL and the ffmpeg/ALSA wordings.
        detail = (err or b"").decode(errors="replace").strip()
        low = detail.lower()
        no_device_markers = (
            "audio open failed", "could not initialize sdl",
            "no available audio device", "couldn't open audio device",
            "cannot open audio device", "no such device",
            "cannot open slave", "device or resource busy",
        )
        if any(m in low for m in no_device_markers):
            # Fundamental: the chosen output can't be opened. Stop the run so
            # we don't blaze through the remaining tracks, and say so once.
            log(f"cannot open audio output '{device_id}'; skipping playback "
                f"({detail[:160]})")
            self._stop.set()
            return
        if self._proc.returncode != 0 or "error" in low or "refused" in low \
                or "failed" in low or "404" in low:
            log(f"track playback problem: {detail[:200] or '(no detail)'}")


# --- WebSocket state loop ---------------------------------------------------
async def consume(player):
    prev_status = None
    # The reconnecting `async for connection in connect(...)` idiom re-attaches
    # automatically if the ws server bounces; we iterate each connection's
    # frames inside.
    async for connection in websockets.connect(
        WS_URL, ping_interval=20, ping_timeout=20, max_size=2 ** 22,
    ):
        async for frame in connection:
            try:
                data = json.loads(frame)
            except (ValueError, TypeError):
                continue
            if data.get("_hb"):
                continue  # heartbeat, no fw_state
            fw = data.get("fw_state") or {}
            status = fw.get("proto_handler_status")
            sst = fw.get("sst")
            show_id = fw.get("loaded_show_id")

            if status == "START_CONFIRMED" and isinstance(sst, (int, float)) \
                    and sst > 0 and show_id is not None:
                await player.arm(sst, show_id)
            elif status == "STARTED" and prev_status != "STARTED" \
                    and not player.is_active() and show_id is not None:
                # Fallback: STARTED without our having armed at START_CONFIRMED
                # (missed the window / joined mid-show).
                await player.start_now(show_id)
            elif status not in RUNNING_STATES and player.is_active():
                log(f"status {status}; stopping audio")
                await player.stop()

            prev_status = status


async def main():
    log(f"starting; ws={WS_URL} app={APP_URL} db={DB_PATH}")
    cfg = read_host_audio_config()
    log(f"host audio {'ENABLED' if cfg['enabled'] else 'disabled'} "
        f"(device latency {cfg['deviceLatencyMs']:.0f}ms)")
    player = AudioPlayer()
    # Reconnect forever: the ws server may restart independently under
    # supervisord, and this process should just re-attach.
    while True:
        try:
            await consume(player)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log(f"ws connection lost ({e}); retrying in 2s")
        await player.stop()
        await asyncio.sleep(2)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
