# Firing Profile Generator

This tool processes YouTube videos to extract firing profiles for inventory items (200g/500g cakes).

## Setup

1. Activate the virtual environment:
   ```bash
   source venv/bin/activate
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Usage

```bash
# Activate the virtual environment first
source venv/bin/activate

# Process all items without profiles
python process_firing_profiles.py

# Reprocess all items (even those with existing profiles)
python process_firing_profiles.py --reprocess-all

# Adjust threshold ratio (default 0.85 = 85% of max amplitude)
python process_firing_profiles.py --threshold-ratio 0.9

# Specify custom database path
python process_firing_profiles.py --db-path /path/to/backyardhero.db
```

## Requirements

- Python 3.x
- ffmpeg (for audio processing)
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt-get install ffmpeg` (or use your package manager)
  - Windows: Download from https://ffmpeg.org/download.html
- Virtual environment dependencies (see requirements.txt)

The script will check for ffmpeg at startup and provide installation instructions if it's not found.


## Lift-to-break timer (aerial shells / mortars)

`lift_break_timer.py` measures how long a mortar takes from lift to break,
using the video's sound only, and proposes a `lift_delay` for the item.

```bash
python lift_break_timer.py "https://www.youtube.com/watch?v=aJpEEcgbp8g" --start 8.9
python lift_break_timer.py URL --start 8.9 --item-id 42          # dry run
python lift_break_timer.py URL --start 8.9 --item-id 42 --write  # save lift_delay
```

- `--start` must be at or just before the **first lift** (not a break).
- Each lift opens a timer, and the next matching sound closes the oldest open
  one. The expected gap starts from the first lift's gap and is refined to
  the median of all matched pairs.
- A lift buried under the previous shell's crackle leaves its break listed as
  "unpaired" and out of the average.
- `-v` lists every detected onset. `--sensitivity 1.5` finds quieter onsets.
  `--expected 2.0` seeds the delay if the automatic one goes wrong.
- Sound delay mostly cancels, because the lift and the break both travel to
  the camera. Only the break's extra distance remains:
  `(sqrt(d² + h²) − d) / 343` s, at most `h / 343` (≈0.2 s for a 60 m break).
  It's smallest when the camera is far from the rack.
