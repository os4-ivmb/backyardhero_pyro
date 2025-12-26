#!/usr/bin/env python3
"""
Process YouTube videos to extract firing profiles for inventory items.
This script analyzes audio from YouTube videos to identify shot timings,
excluding lift charges by using a threshold based on the loudest sound.
"""

import sqlite3
import json
import argparse
import os
import tempfile
import subprocess
import sys
import shutil
from pathlib import Path

try:
    import yt_dlp
    import librosa
    import numpy as np
except ImportError as e:
    print(f"Error: Missing required dependency: {e}")
    print("Please install required packages: pip install yt-dlp librosa numpy")
    sys.exit(1)


def find_ffmpeg():
    """Find ffmpeg executable path."""
    # First try using shutil.which which is more reliable
    ffmpeg_path = shutil.which('ffmpeg')
    if ffmpeg_path:
        return ffmpeg_path
    
    # Also check common installation paths (especially for Homebrew on macOS)
    common_paths = [
        '/opt/homebrew/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/usr/bin/ffmpeg',
    ]
    
    for path in common_paths:
        if os.path.exists(path) and os.access(path, os.X_OK):
            return path
    
    return None


def check_ffmpeg_available():
    """Check if ffmpeg is available in the system PATH."""
    return find_ffmpeg() is not None


def get_db_path():
    """Get the path to the SQLite database."""
    # Try different possible paths
    possible_paths = [
        '/data/backyardhero.db',
        os.path.join(os.path.dirname(__file__), '../../../data/backyardhero.db'),
        os.path.join(os.path.dirname(__file__), '../../data/backyardhero.db'),
        os.path.join(os.path.dirname(__file__), '../data/backyardhero.db'),
        'backyardhero.db'
    ]
    
    for path in possible_paths:
        if os.path.exists(path):
            return path
    
    # If not found, use the default
    return '/data/backyardhero.db'


def ensure_firing_profile_table(db_path):
    """Create the inventoryFiringProfile table if it doesn't exist."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    create_table_sql = """
        CREATE TABLE IF NOT EXISTS inventoryFiringProfile (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inventory_id INTEGER NOT NULL,
            youtube_link TEXT NOT NULL,
            youtube_link_start_sec INTEGER NOT NULL,
            shot_timestamps TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE,
            UNIQUE(inventory_id)
        );
    """
    
    cursor.execute(create_table_sql)
    conn.commit()
    conn.close()


def get_inventory_items_with_youtube(db_path, reprocess_all=False):
    """Get all inventory items that have YouTube links and start times."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    if reprocess_all:
        # Get all items with YouTube links, regardless of existing profiles
        query = """
            SELECT id, name, youtube_link, youtube_link_start_sec
            FROM inventory
            WHERE youtube_link IS NOT NULL 
            AND youtube_link != ''
            AND youtube_link_start_sec IS NOT NULL
        """
    else:
        # Only get items that don't have a firing profile yet
        query = """
            SELECT i.id, i.name, i.youtube_link, i.youtube_link_start_sec
            FROM inventory i
            LEFT JOIN inventoryFiringProfile ifp ON i.id = ifp.inventory_id
            WHERE i.youtube_link IS NOT NULL 
            AND i.youtube_link != ''
            AND i.youtube_link_start_sec IS NOT NULL
            AND ifp.id IS NULL
        """
    
    cursor.execute(query)
    items = cursor.fetchall()
    conn.close()
    
    return items


def check_profile_exists(db_path, inventory_id):
    """Check if a firing profile already exists for an inventory item."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id FROM inventoryFiringProfile WHERE inventory_id = ?",
        (inventory_id,)
    )
    exists = cursor.fetchone() is not None
    conn.close()
    return exists


# Global variable to store ffmpeg path (set in main)
FFMPEG_PATH = 'ffmpeg'


def download_audio_from_youtube(youtube_url, start_sec, duration=None, temp_dir=None):
    """
    Download audio from YouTube video starting at start_sec.
    Returns the path to the downloaded audio file.
    """
    if temp_dir is None:
        temp_dir = tempfile.gettempdir()
    
    # Create a temporary file for the audio
    audio_file = os.path.join(temp_dir, f"audio_{os.getpid()}.wav")
    
    # Configure yt-dlp options
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': audio_file.replace('.wav', '.%(ext)s'),
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'wav',
            'preferredquality': '192',
        }],
        'quiet': True,
        'no_warnings': True,
    }
    
    # If we have a start time, we'll need to extract a segment
    # yt-dlp doesn't directly support start times, so we'll download and trim
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([youtube_url])
        
        # Find the actual downloaded file (yt-dlp may have changed extension)
        downloaded_file = None
        base_name = audio_file.replace('.wav', '')
        for ext in ['.wav', '.m4a', '.webm', '.mp3']:
            if os.path.exists(base_name + ext):
                downloaded_file = base_name + ext
                break
        
        if downloaded_file is None:
            raise FileNotFoundError("Downloaded audio file not found")
        
        # If we need to trim or convert, use ffmpeg
        # Always use a different output file to avoid conflicts
        needs_processing = (start_sec > 0 or duration or not downloaded_file.endswith('.wav'))
        
        if needs_processing:
            # Use a different filename for output to avoid conflicts
            final_audio_file = os.path.join(temp_dir, f"audio_{os.getpid()}_processed.wav")
            ffmpeg_cmd = [FFMPEG_PATH, '-y', '-i', downloaded_file]
            
            if start_sec > 0:
                ffmpeg_cmd.extend(['-ss', str(start_sec)])
            if duration:
                ffmpeg_cmd.extend(['-t', str(duration)])
            
            ffmpeg_cmd.extend(['-acodec', 'pcm_s16le', '-ar', '44100', final_audio_file])
            
            subprocess.run(ffmpeg_cmd, check=True, capture_output=True)
            
            # Clean up the original downloaded file
            if os.path.exists(downloaded_file):
                os.remove(downloaded_file)
            
            return final_audio_file
        else:
            # Already in the right format, no processing needed
            return downloaded_file
            
    except Exception as e:
        print(f"Error downloading audio: {e}")
        raise


def detect_shots(audio_file, threshold_ratio=0.85, min_shot_duration_ms=50):
    """
    Detect shot timings from audio file with start and end times.
    Uses a threshold based on the loudest sound to exclude lift charges.
    
    Args:
        audio_file: Path to audio file
        threshold_ratio: Ratio of max amplitude to use as threshold (default 0.85)
        min_shot_duration_ms: Minimum duration for a shot to be considered valid (default 50ms)
    
    Returns:
        List of [start_ms, end_ms] pairs for each shot
    """
    # Load audio file
    y, sr = librosa.load(audio_file, sr=None)
    
    # Calculate amplitude envelope (RMS energy)
    # Use a short window to capture sharp transients
    frame_length = 2048
    hop_length = 512
    rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
    
    # Convert to amplitude (not energy)
    amplitude = np.sqrt(rms)
    
    # Find the maximum amplitude (loudest sound)
    max_amplitude = np.max(amplitude)
    
    # Set threshold slightly below the maximum to exclude lift charges
    threshold = max_amplitude * threshold_ratio
    
    # Find when amplitude crosses threshold (start and end of shots)
    shots = []
    in_shot = False
    shot_start_frame = None
    min_shot_duration_frames = int((min_shot_duration_ms / 1000.0) * sr / hop_length)
    
    for i in range(len(amplitude)):
        above_threshold = amplitude[i] > threshold
        
        if above_threshold and not in_shot:
            # Shot starts: amplitude crosses above threshold
            in_shot = True
            shot_start_frame = i
        elif not above_threshold and in_shot:
            # Shot ends: amplitude crosses below threshold
            shot_duration_frames = i - shot_start_frame
            
            # Only include shots that meet minimum duration
            if shot_duration_frames >= min_shot_duration_frames:
                start_ms = int(librosa.frames_to_time(shot_start_frame, sr=sr, hop_length=hop_length) * 1000)
                end_ms = int(librosa.frames_to_time(i, sr=sr, hop_length=hop_length) * 1000)
                shots.append([start_ms, end_ms])
            
            in_shot = False
            shot_start_frame = None
    
    # Handle case where shot continues to end of audio
    if in_shot and shot_start_frame is not None:
        shot_duration_frames = len(amplitude) - shot_start_frame
        if shot_duration_frames >= min_shot_duration_frames:
            start_ms = int(librosa.frames_to_time(shot_start_frame, sr=sr, hop_length=hop_length) * 1000)
            end_ms = int(librosa.frames_to_time(len(amplitude) - 1, sr=sr, hop_length=hop_length) * 1000)
            shots.append([start_ms, end_ms])
    
    return shots


def save_firing_profile(db_path, inventory_id, youtube_link, youtube_link_start_sec, shots):
    """Save or update a firing profile in the database.
    
    Args:
        shots: List of [start_ms, end_ms] pairs for each shot
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Convert shots to JSON string (format: [[start1, end1], [start2, end2], ...])
    shot_timestamps_json = json.dumps(shots)
    
    # Check if profile exists
    cursor.execute(
        "SELECT id FROM inventoryFiringProfile WHERE inventory_id = ?",
        (inventory_id,)
    )
    existing = cursor.fetchone()
    
    if existing:
        # Update existing profile
        cursor.execute("""
            UPDATE inventoryFiringProfile
            SET youtube_link = ?, youtube_link_start_sec = ?, shot_timestamps = ?
            WHERE inventory_id = ?
        """, (youtube_link, youtube_link_start_sec, shot_timestamps_json, inventory_id))
    else:
        # Insert new profile
        cursor.execute("""
            INSERT INTO inventoryFiringProfile 
            (inventory_id, youtube_link, youtube_link_start_sec, shot_timestamps)
            VALUES (?, ?, ?, ?)
        """, (inventory_id, youtube_link, youtube_link_start_sec, shot_timestamps_json))
    
    conn.commit()
    conn.close()


def process_item(item, db_path, threshold_ratio=0.85, temp_dir=None):
    """Process a single inventory item to extract firing profile."""
    inventory_id = item['id']
    name = item['name']
    youtube_link = item['youtube_link']
    youtube_link_start_sec = item['youtube_link_start_sec']
    
    print(f"Processing: {name} (ID: {inventory_id})")
    print(f"  YouTube: {youtube_link}")
    print(f"  Start: {youtube_link_start_sec}s")
    
    try:
        # Download audio
        print("  Downloading audio...")
        audio_file = download_audio_from_youtube(
            youtube_link, 
            youtube_link_start_sec,
            temp_dir=temp_dir
        )
        
        # Detect shots
        print("  Analyzing audio for shots...")
        shots = detect_shots(audio_file, threshold_ratio=threshold_ratio)
        
        print(f"  Found {len(shots)} shots")
        if shots:
            # Show first few shots with start/end times
            preview_shots = shots[:5]
            shot_preview = ", ".join([f"[{s[0]}-{s[1]}ms]" for s in preview_shots])
            if len(shots) > 5:
                shot_preview += f" ... ({len(shots) - 5} more)"
            print(f"  Shot ranges: {shot_preview}")
        
        # Save to database
        save_firing_profile(
            db_path,
            inventory_id,
            youtube_link,
            youtube_link_start_sec,
            shots
        )
        
        print(f"  ✓ Saved firing profile to database")
        
        # Clean up audio file
        if os.path.exists(audio_file):
            os.remove(audio_file)
        
        return True
        
    except Exception as e:
        print(f"  ✗ Error processing {name}: {e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Process YouTube videos to extract firing profiles for inventory items'
    )
    parser.add_argument(
        '--reprocess-all',
        action='store_true',
        help='Reprocess all items, even those with existing profiles'
    )
    parser.add_argument(
        '--threshold-ratio',
        type=float,
        default=0.85,
        help='Threshold ratio for shot detection (default: 0.85, meaning 85%% of max amplitude)'
    )
    parser.add_argument(
        '--db-path',
        type=str,
        default=None,
        help='Path to SQLite database (default: auto-detect)'
    )
    parser.add_argument(
        '--temp-dir',
        type=str,
        default=None,
        help='Temporary directory for audio files (default: system temp)'
    )
    
    args = parser.parse_args()
    
    # Get database path
    db_path = args.db_path or get_db_path()
    
    if not os.path.exists(db_path):
        print(f"Error: Database not found at {db_path}")
        print("Please specify the correct path with --db-path")
        sys.exit(1)
    
    # Check for ffmpeg (required for audio processing)
    global FFMPEG_PATH
    ffmpeg_path = find_ffmpeg()
    if not ffmpeg_path:
        print("Error: ffmpeg is not installed or not found in PATH")
        print("")
        print("ffmpeg is required for audio processing. Please install it:")
        print("  macOS: brew install ffmpeg")
        print("  Linux: sudo apt-get install ffmpeg  (or use your package manager)")
        print("  Windows: Download from https://ffmpeg.org/download.html")
        print("")
        sys.exit(1)
    
    # Set the global ffmpeg path for use in download function
    FFMPEG_PATH = ffmpeg_path
    
    # Ensure the firing profile table exists
    ensure_firing_profile_table(db_path)
    
    print(f"Using database: {db_path}")
    print(f"Threshold ratio: {args.threshold_ratio}")
    print(f"Reprocess all: {args.reprocess_all}")
    print()
    
    # Get items to process
    items = get_inventory_items_with_youtube(db_path, reprocess_all=args.reprocess_all)
    
    if not items:
        print("No items to process.")
        return
    
    print(f"Found {len(items)} item(s) to process\n")
    
    # Process each item
    success_count = 0
    for item in items:
        if process_item(item, db_path, args.threshold_ratio, args.temp_dir):
            success_count += 1
        print()
    
    print(f"Completed: {success_count}/{len(items)} items processed successfully")


if __name__ == '__main__':
    main()

