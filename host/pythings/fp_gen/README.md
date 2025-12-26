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

