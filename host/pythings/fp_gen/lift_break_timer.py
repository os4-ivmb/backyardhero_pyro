#!/usr/bin/env python3
"""
Lift-to-break timer for aerial shells (mortars), from audio only.

Give it a YouTube link (or a local audio/video file) and the time of the
first lift. It finds every sharp sound onset after that, pairs each lift with
the break that follows it, and proposes a lift_delay (cue fire -> break) for
the inventory item.

Pairing works like a queue: a lift opens a timer, and the next onset that lands
inside the expected lift->break window closes the oldest open timer. If two
lifts are in the air, the first break closes the first lift. An onset that
closes no timer is treated as a new lift. The expected window starts from the
locked first lift's own lift->break gap, then is refined from the median of
the matched pairs (a few passes).

Usage:
    python lift_break_timer.py "https://www.youtube.com/watch?v=aJpEEcgbp8g" --start 8.9
    python lift_break_timer.py clip.wav --start 8.9 --end 31
    python lift_break_timer.py URL --start 8.9 --item-id 42 --write   # save lift_delay

Note on sound delay: both the lift and the break reach the camera late, and
most of that delay cancels out. What remains is the extra path to the burst:
(sqrt(d^2 + h^2) - d) / 343 s, where d is the camera-to-rack distance and h is
the break height. That is never more than h / 343 (about 0.2 s for a 60 m
break), and shrinks as the camera moves farther away.
"""

import argparse
import os
import sqlite3
import statistics
import subprocess
import sys
import tempfile

try:
    import librosa
    import numpy as np
    from scipy.ndimage import median_filter
    from scipy.signal import find_peaks
    import yt_dlp
except ImportError as e:
    print(f"Error: Missing required dependency: {e}")
    print("Install with: pip install -r requirements.txt")
    sys.exit(1)

SR = 22050
HOP = 110  # 5 ms frames


# --------------------------------------------------------------------------- audio

def load_audio(source, start, end, tmp_dir):
    """Return mono float audio for [start-1s, end] and the time offset of sample 0."""
    path = source
    if source.startswith(("http://", "https://")):
        out = os.path.join(tmp_dir, "audio.%(ext)s")
        opts = {"format": "bestaudio/best", "outtmpl": out, "quiet": True, "no_warnings": True, "noprogress": True}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(source, download=True)
            path = ydl.prepare_filename(info)
    # Keep 1 s of pre-roll so the lift at `start` has context for onset detection.
    t0 = max(0.0, start - 1.0)
    cmd = ["ffmpeg", "-v", "error", "-y", "-ss", str(t0), "-i", path]
    if end:
        cmd += ["-t", str(end - t0)]
    wav = os.path.join(tmp_dir, "clip.wav")
    cmd += ["-vn", "-ac", "1", "-ar", str(SR), wav]
    subprocess.run(cmd, check=True)
    y, _ = librosa.load(wav, sr=SR, mono=True)
    return y, t0


def detect_onsets(y, t0, sensitivity=1.0, min_gap=0.25):
    """
    Find sharp, loud onsets (lift thumps, breaks). Returns list of (time_s, strength).

    A peak counts when spectral flux spikes well above its local background AND
    the level steps up afterwards. The step test throws out single crackle pops
    inside a sustained effect, which spike the flux but don't raise the level.
    """
    flux = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    # Level in the 2-6 kHz band. YouTube audio is heavily compressed, so the
    # broadband level barely moves when a break lands on top of the last
    # shell's crackle, but this band still jumps clearly.
    spec = np.abs(librosa.stft(y, n_fft=1024, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=1024)
    band = spec[(freqs >= 2000) & (freqs <= 6000)].mean(axis=0)
    db = 20 * np.log10(band + 1e-9)
    n = min(len(flux), len(db))
    flux, db = flux[:n], db[:n]

    fps = SR / HOP
    # Local background: rolling median of flux over 3 s.
    win = int(3 * fps) | 1
    bg = median_filter(flux, size=win, mode="nearest")
    norm = flux / (bg + 1e-6)

    peaks, _ = find_peaks(norm, height=3.0 / sensitivity, distance=int(min_gap * fps))
    pre, post = int(0.25 * fps), int(0.2 * fps)
    out = []
    for p in peaks:
        before = db[max(0, p - pre):max(1, p - int(0.03 * fps))]
        after = db[p:p + post]
        if len(after) == 0 or len(before) == 0:
            continue
        step = np.mean(after) - np.mean(before)
        if step >= 6.0 / sensitivity:
            out.append((t0 + p / fps, float(norm[p]), float(step)))
    return out


# --------------------------------------------------------------------------- pairing

MIN_DELAY, MAX_DELAY = 0.5, 8.0  # plausible lift->break range (s)


def _queue_pair(times, delay, tol):
    """One pass of queue pairing at a fixed expected delay."""
    pending, pairs, unmatched = [], [], []
    for t in times:
        # Expire lifts whose break window has passed.
        while pending and t - pending[0] > delay + tol:
            unmatched.append(pending.pop(0))
        # Close the oldest open lift whose window this sound falls in.
        hit = next((p for p in pending if abs((t - p) - delay) <= tol), None)
        if hit is not None:
            pending.remove(hit)
            pairs.append((hit, t))
        else:
            pending.append(t)
    return pairs, unmatched + pending


def _refine(times, delay, tol_frac, tol_min, passes=5):
    """Pair, re-centre the delay on the median of the pairs, and repeat."""
    pairs, unmatched = [], times
    for _ in range(passes):
        pairs, unmatched = _queue_pair(times, delay, max(tol_min, delay * tol_frac))
        if not pairs:
            break
        new = statistics.median(b - l for l, b in pairs)
        if abs(new - delay) < 0.005:
            break
        delay = new
    return pairs, unmatched, delay


def _score(pairs):
    """More pairs is better, but every 0.1 s of spread costs a pair. A real
    lift delay repeats tightly; a long, loose seed can "pair" almost anything."""
    gaps = [b - l for l, b in pairs]
    return len(pairs) - (statistics.pstdev(gaps) / 0.1 if gaps else 0)


def pair_lifts(onsets, first_lift, expected=None, tol_frac=0.25, tol_min=0.25):
    """
    Queue-pair lifts with breaks. Returns (pairs, unmatched_onsets, delay_used).
    pairs = [(lift_t, break_t)].

    The seed delay is the gap after the locked first lift (or --expected). That
    single gap can be wrong, e.g. when an ignition pop just before the real lift
    gets locked, so every other plausible onset gap is also tried as a seed.
    The seed with the best score wins (see _score); ties go to the locked-lift seed.
    """
    times = [t for t, *_ in onsets if t >= first_lift - 0.15]
    if len(times) < 2:
        return [], times, None

    if expected:
        return _refine(times, expected, tol_frac, tol_min)

    locked = _refine(times, times[1] - times[0], tol_frac, tol_min)
    best = locked
    seeds = sorted({round(b - a, 2) for i, a in enumerate(times) for b in times[i + 1:]
                    if MIN_DELAY <= b - a <= MAX_DELAY})
    for seed in seeds:
        cand = _refine(times, seed, tol_frac, tol_min)
        if _score(cand[0]) > _score(best[0]):
            best = cand
    return best


# --------------------------------------------------------------------------- db

def write_lift_delay(db_path, item_id, value):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("SELECT name, type, lift_delay FROM inventory WHERE id = ?", (item_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise SystemExit(f"No inventory item with id {item_id}")
    name, typ, old = row
    if typ != "AERIAL_SHELL":
        print(f"  warning: item {item_id} ({name}) is type {typ}, not AERIAL_SHELL")
    cur.execute("UPDATE inventory SET lift_delay = ? WHERE id = ?", (value, item_id))
    conn.commit()
    conn.close()
    print(f"  Saved lift_delay {old} -> {value} for '{name}' (id {item_id})")


# --------------------------------------------------------------------------- json

def run_json(args):
    """Analyse and print a single JSON object. Never writes to the DB."""
    import json
    try:
        with tempfile.TemporaryDirectory() as tmp:
            y, t0 = load_audio(args.source, args.start, args.end, tmp)
        onsets = [o for o in detect_onsets(y, t0, sensitivity=args.sensitivity)
                  if o[0] >= args.start - 0.15]
        pairs, unmatched, _ = pair_lifts(onsets, args.start, args.expected,
                                         tol_frac=args.tolerance)
    except Exception as e:  # report, don't traceback, so the app can show it
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return 1
    if not pairs:
        print(json.dumps({
            "ok": False,
            "error": "No lift/break pairs found. Check the start time is at the first lift.",
            "onsets": [round(t, 3) for t, *_ in onsets],
        }))
        return 1
    gaps = [b - l for l, b in pairs]
    med = statistics.median(gaps)
    print(json.dumps({
        "ok": True,
        "proposed": round(round(med / args.round_to) * args.round_to, 3),
        "mean": round(statistics.mean(gaps), 3),
        "median": round(med, 3),
        "stdev": round(statistics.stdev(gaps), 3) if len(gaps) > 1 else 0.0,
        "min": round(min(gaps), 3),
        "max": round(max(gaps), 3),
        "pairs": [{"lift": round(l, 3), "break": round(b, 3), "delay": round(b - l, 3)}
                  for l, b in pairs],
        "unpaired": [round(t, 3) for t in unmatched],
        "start": args.start,
    }))
    return 0


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="Measure mortar lift->break time from audio.")
    ap.add_argument("source", help="YouTube URL or local audio/video file")
    ap.add_argument("--start", type=float, required=True,
                    help="Time (s) of the first lift; the first onset here is locked as a lift")
    ap.add_argument("--end", type=float, default=None, help="Stop analysing at this time (s)")
    ap.add_argument("--expected", type=float, default=None,
                    help="Seed lift->break guess in s (default: gap after the locked lift)")
    ap.add_argument("--sensitivity", type=float, default=1.0,
                    help=">1 finds quieter onsets, <1 is stricter (default 1.0)")
    ap.add_argument("--tolerance", type=float, default=0.25,
                    help="Allowed deviation from the delay, as a fraction (default 0.25)")
    ap.add_argument("--round", type=float, default=0.05, dest="round_to",
                    help="Round the proposed delay to this step in s (default 0.05)")
    ap.add_argument("--verbose", "-v", action="store_true", help="List every onset")
    ap.add_argument("--item-id", type=int, help="Inventory item to save lift_delay to")
    ap.add_argument("--write", action="store_true", help="Actually write lift_delay (needs --item-id)")
    ap.add_argument("--db-path", default=None)
    ap.add_argument("--json", action="store_true",
                    help="Print one JSON object to stdout instead of the report (used by the app)")
    args = ap.parse_args()

    if args.json:
        sys.exit(run_json(args))

    with tempfile.TemporaryDirectory() as tmp:
        print("Loading audio...")
        y, t0 = load_audio(args.source, args.start, args.end, tmp)

    onsets = detect_onsets(y, t0, sensitivity=args.sensitivity)
    onsets = [o for o in onsets if o[0] >= args.start - 0.15]
    if args.verbose:
        print("\nOnsets (time, flux ratio, level step dB):")
        for t, s, st in onsets:
            print(f"  {t:7.2f}s  {s:5.1f}  +{st:4.1f}dB")

    pairs, unmatched, delay = pair_lifts(onsets, args.start, args.expected, tol_frac=args.tolerance)
    if not pairs:
        print("\nNo lift->break pairs found. Try --sensitivity 1.5, a different --start, or --expected.")
        sys.exit(1)

    gaps = [b - l for l, b in pairs]
    print(f"\n{'#':>3}  {'lift':>8}  {'break':>8}  {'delay':>6}")
    for i, (l, b) in enumerate(pairs, 1):
        print(f"{i:>3}  {l:7.2f}s  {b:7.2f}s  {b - l:5.2f}s")
    if unmatched:
        print(f"\nUnpaired onsets (buried lift or break, or noise): "
              + ", ".join(f"{t:.2f}s" for t in unmatched))

    mean = statistics.mean(gaps)
    med = statistics.median(gaps)
    sd = statistics.stdev(gaps) if len(gaps) > 1 else 0.0
    proposed = round(round(med / args.round_to) * args.round_to, 3)
    print(f"\nPairs: {len(pairs)}   mean {mean:.2f}s   median {med:.2f}s   "
          f"stdev {sd:.2f}s   range {min(gaps):.2f}-{max(gaps):.2f}s")
    print(f"Proposed lift_delay: {proposed:.2f}s")
    print("(Measured from sound: breaks are heard slightly late, so the true delay "
          "is usually a little shorter.)")

    if args.item_id is not None:
        if not args.write:
            print(f"\nDry run: add --write to save lift_delay={proposed:.2f} to item {args.item_id}")
        else:
            from process_firing_profiles import get_db_path
            write_lift_delay(args.db_path or get_db_path(), args.item_id, proposed)


if __name__ == "__main__":
    main()
