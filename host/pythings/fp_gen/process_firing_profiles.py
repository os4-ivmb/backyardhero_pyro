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
from datetime import datetime

try:
    import yt_dlp
    import librosa
    import numpy as np
    from scipy.signal import find_peaks
except ImportError as e:
    print(f"Error: Missing required dependency: {e}")
    print("Please install required packages: pip install yt-dlp librosa numpy scipy")
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


def get_log_path():
    """Get the path to the log file."""
    # Try different possible paths for log directory
    possible_log_dirs = [
        '/data/log',
        os.path.join(os.path.dirname(__file__), '../../../data/log'),
        os.path.join(os.path.dirname(__file__), '../../data/log'),
    ]
    
    for log_dir in possible_log_dirs:
        if os.path.exists(log_dir):
            return os.path.join(log_dir, 'firing_profiles.log')
    
    # If no log directory found, use default
    log_dir = '/data/log'
    os.makedirs(log_dir, exist_ok=True)
    return os.path.join(log_dir, 'firing_profiles.log')


def log_message(message, log_file=None):
    """Log a message with timestamp to both stdout and log file."""
    timestamp = datetime.now().strftime("[%Y-%m-%d %H:%M:%S]")
    log_line = f"{timestamp} {message}"
    print(log_line)
    
    if log_file:
        try:
            with open(log_file, 'a') as f:
                f.write(log_line + '\n')
        except Exception as e:
            print(f"Warning: Could not write to log file: {e}")


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


def get_inventory_items_with_youtube(db_path, reprocess_all=False, item_id=None):
    """Get all inventory items that have YouTube links and start times.
    
    Args:
        db_path: Path to the database
        reprocess_all: If True, include items with existing profiles
        item_id: If provided, only return the item with this ID
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    if item_id is not None:
        # Get specific item by ID
        query = """
            SELECT id, name, youtube_link, youtube_link_start_sec
            FROM inventory
            WHERE id = ?
            AND youtube_link IS NOT NULL 
            AND youtube_link != ''
            AND youtube_link_start_sec IS NOT NULL
        """
        cursor.execute(query, (item_id,))
    elif reprocess_all:
        # Get all items with YouTube links, regardless of existing profiles
        query = """
            SELECT id, name, youtube_link, youtube_link_start_sec
            FROM inventory
            WHERE youtube_link IS NOT NULL 
            AND youtube_link != ''
            AND youtube_link_start_sec IS NOT NULL
        """
        cursor.execute(query)
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


def detect_shots(audio_file, threshold_ratio=0.70, min_shot_duration_ms=50):
    """
    Detect shot timings from audio file with start and end times.
    Uses a threshold based on the loudest sound to exclude lift charges.
    
    Args:
        audio_file: Path to audio file
        threshold_ratio: Ratio of max amplitude to use as threshold (default 0.70)
                         Lower values = more sensitive (detects quieter sounds)
                         Higher values = less sensitive (only detects louder sounds)
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
                shots.append([start_ms, end_ms, None])  # Format: [start, end, color] where color is None initially
            
            in_shot = False
            shot_start_frame = None
    
    # Handle case where shot continues to end of audio
    if in_shot and shot_start_frame is not None:
        shot_duration_frames = len(amplitude) - shot_start_frame
        if shot_duration_frames >= min_shot_duration_frames:
            start_ms = int(librosa.frames_to_time(shot_start_frame, sr=sr, hop_length=hop_length) * 1000)
            end_ms = int(librosa.frames_to_time(len(amplitude) - 1, sr=sr, hop_length=hop_length) * 1000)
            shots.append([start_ms, end_ms, None])  # Format: [start, end, color] where color is None initially
    
    return shots


def detect_shots_noise_floor(audio_file, floor_percent=10.0, min_shot_duration_ms=50):
    """
    Detect shot timings using noise floor approach.
    Establishes a noise floor from troughs between peaks, then detects shots
    that exceed the floor by a certain percentage.
    
    Args:
        audio_file: Path to audio file
        floor_percent: Percentage above noise floor to use as threshold (default 10.0)
                      e.g., if floor is 40dB, 10% means threshold is 44dB
        min_shot_duration_ms: Minimum duration for a shot to be considered valid (default 50ms)
    
    Returns:
        List of [start_ms, end_ms] pairs for each shot
    """
    # Load audio file
    y, sr = librosa.load(audio_file, sr=None)
    
    # Calculate amplitude envelope (RMS energy)
    frame_length = 2048
    hop_length = 512
    rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]
    
    # Convert to amplitude (not energy)
    amplitude = np.sqrt(rms)
    
    # Find the noise floor using multiple approaches and take the most conservative (lowest) value
    
    # Approach 1: Use a low percentile of the entire amplitude distribution
    # This captures the quietest parts of the audio
    percentile_floor = np.percentile(amplitude, 5)  # 5th percentile - very quiet parts
    
    # Approach 2: Find local minima in quiet regions
    # First, identify regions that are below a threshold (likely quiet)
    quiet_threshold = np.percentile(amplitude, 25)  # 25th percentile as quiet threshold
    quiet_samples = amplitude[amplitude < quiet_threshold]
    
    # Approach 3: Find troughs between significant peaks
    # Use a higher prominence to find only major peaks (shots)
    peaks, peak_properties = find_peaks(amplitude, prominence=np.percentile(amplitude, 75))
    
    troughs = []
    if len(peaks) > 1:
        # For each pair of consecutive peaks, find the minimum between them
        for i in range(len(peaks) - 1):
            start_idx = peaks[i]
            end_idx = peaks[i + 1]
            segment = amplitude[start_idx:end_idx]
            if len(segment) > 0:
                min_idx = np.argmin(segment) + start_idx
                # Only include troughs that are in relatively quiet regions
                if amplitude[min_idx] < quiet_threshold:
                    troughs.append(amplitude[min_idx])
    
    # Approach 4: Use a rolling window to find the quietest periods
    # Find the minimum in each window, then take the median of those minima
    window_size = max(20, len(amplitude) // 100)  # Larger window to capture quiet periods
    window_minima = []
    for i in range(0, len(amplitude) - window_size, window_size // 2):  # Overlapping windows
        window = amplitude[i:i + window_size]
        window_minima.append(np.min(window))
    
    # Combine all approaches and use the lowest value (most conservative)
    candidate_floors = [percentile_floor]
    
    if len(quiet_samples) > 0:
        candidate_floors.append(np.median(quiet_samples))
    
    if len(troughs) > 0:
        candidate_floors.append(np.median(troughs))
    
    if len(window_minima) > 0:
        candidate_floors.append(np.median(window_minima))
    
    # Use the minimum (most conservative) floor value
    noise_floor = min(candidate_floors)
    
    # Ensure floor is not zero (avoid division issues)
    if noise_floor <= 0:
        noise_floor = np.percentile(amplitude, 5)
    
    # Calculate threshold: floor + (floor * floor_percent / 100)
    # e.g., if floor is 0.4 and floor_percent is 10%, threshold is 0.4 + (0.4 * 0.1) = 0.44
    threshold = noise_floor * (1 + floor_percent / 100.0)
    
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
                shots.append([start_ms, end_ms, None])
            
            in_shot = False
            shot_start_frame = None
    
    # Handle case where shot continues to end of audio
    if in_shot and shot_start_frame is not None:
        shot_duration_frames = len(amplitude) - shot_start_frame
        if shot_duration_frames >= min_shot_duration_frames:
            start_ms = int(librosa.frames_to_time(shot_start_frame, sr=sr, hop_length=hop_length) * 1000)
            end_ms = int(librosa.frames_to_time(len(amplitude) - 1, sr=sr, hop_length=hop_length) * 1000)
            shots.append([start_ms, end_ms, None])
    
    return shots


def merge_close_shots(shots, merge_threshold_ms=500):
    """
    Merge shots that are close together into a single shot.
    
    Args:
        shots: List of [start_ms, end_ms] or [start_ms, end_ms, color] for each shot
        merge_threshold_ms: Maximum gap between shots to merge them (default 500ms)
    
    Returns:
        List of merged [start_ms, end_ms, color] pairs (color may be None)
    """
    if not shots:
        return shots
    
    # Normalize shots to [start, end, color] format
    normalized_shots = []
    for shot in shots:
        if len(shot) >= 3:
            normalized_shots.append([shot[0], shot[1], shot[2] if len(shot) > 2 else None])
        else:
            normalized_shots.append([shot[0], shot[1], None])
    
    # Sort shots by start time (should already be sorted, but just in case)
    sorted_shots = sorted(normalized_shots, key=lambda x: x[0])
    
    merged_shots = []
    current_shot = sorted_shots[0].copy()  # [start, end, color]
    
    for next_shot in sorted_shots[1:]:
        next_start, next_end, next_color = next_shot
        
        # Calculate gap between current shot end and next shot start
        gap = next_start - current_shot[1]
        
        if gap <= merge_threshold_ms:
            # Merge: extend current shot to include next shot
            # Keep color from first shot, or use next shot's color if current has none
            current_shot[1] = max(current_shot[1], next_end)
            if current_shot[2] is None and next_color is not None:
                current_shot[2] = next_color
        else:
            # Gap is too large, save current shot and start a new one
            merged_shots.append(current_shot)
            current_shot = [next_start, next_end, next_color]
    
    # Don't forget the last shot
    merged_shots.append(current_shot)
    
    return merged_shots


def save_firing_profile(db_path, inventory_id, youtube_link, youtube_link_start_sec, shots):
    """Save or update a firing profile in the database.
    
    Args:
        shots: List of [start_ms, end_ms] or [start_ms, end_ms, color] pairs for each shot
               where color is optional (hex string like "#FF0000" or None)
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


def process_item(item, db_path, threshold_ratio=0.70, temp_dir=None, log_file=None, merge_threshold_ms=500, override_duration=False, detection_method='max_amplitude', floor_percent=10.0):
    """Process a single inventory item to extract firing profile."""
    inventory_id = item['id']
    name = item['name']
    youtube_link = item['youtube_link']
    youtube_link_start_sec = item['youtube_link_start_sec']
    
    log_message(f"Processing: {name} (ID: {inventory_id})", log_file)
    log_message(f"  YouTube: {youtube_link}", log_file)
    log_message(f"  Start: {youtube_link_start_sec}s", log_file)
    
    try:
        # Download audio
        log_message("  Downloading audio...", log_file)
        audio_file = download_audio_from_youtube(
            youtube_link, 
            youtube_link_start_sec,
            temp_dir=temp_dir
        )
        
        # Detect shots
        log_message("  Analyzing audio for shots...", log_file)
        if detection_method == 'noise_floor':
            log_message(f"  Using noise floor method (floor_percent: {floor_percent}%)", log_file)
            shots = detect_shots_noise_floor(audio_file, floor_percent=floor_percent)
        else:
            log_message(f"  Using max amplitude method (threshold_ratio: {threshold_ratio})", log_file)
            shots = detect_shots(audio_file, threshold_ratio=threshold_ratio)
        
        log_message(f"  Found {len(shots)} shots before merging", log_file)
        
        # Merge close shots
        if shots and merge_threshold_ms > 0:
            shots_before_merge = len(shots)
            shots = merge_close_shots(shots, merge_threshold_ms=merge_threshold_ms)
            if len(shots) < shots_before_merge:
                log_message(f"  Merged {shots_before_merge} shots into {len(shots)} shots (threshold: {merge_threshold_ms}ms)", log_file)
        
        log_message(f"  Final shot count: {len(shots)}", log_file)
        if shots:
            # Show first few shots with start/end times
            preview_shots = shots[:5]
            shot_preview = ", ".join([f"[{s[0]}-{s[1]}ms] ({s[1]-s[0]}ms)" for s in preview_shots])
            if len(shots) > 5:
                shot_preview += f" ... ({len(shots) - 5} more)"
            log_message(f"  Shot ranges: {shot_preview}", log_file)
        
        # Override duration if requested
        if override_duration and shots:
            # Duration is simply the end time of the last shot (assuming video starts at 0)
            last_shot_end = max(shot[1] for shot in shots)  # End time of last shot
            duration_seconds = round(last_shot_end / 1000.0, 1)  # Round to 0.1 seconds
            
            log_message(f"  Overriding duration: {duration_seconds:.1f}s (end of last shot at {last_shot_end}ms)", log_file)
            
            # Update inventory item duration in database
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE inventory SET duration = ? WHERE id = ?",
                (duration_seconds, inventory_id)
            )
            conn.commit()
            conn.close()
            
            log_message(f"  ✓ Updated inventory item duration to {duration_seconds:.1f}s", log_file)
        
        # Save to database
        save_firing_profile(
            db_path,
            inventory_id,
            youtube_link,
            youtube_link_start_sec,
            shots
        )
        
        log_message(f"  ✓ Saved firing profile to database", log_file)
        
        # Clean up audio file
        if os.path.exists(audio_file):
            os.remove(audio_file)
        
        return True
        
    except Exception as e:
        log_message(f"  ✗ Error processing {name}: {e}", log_file)
        import traceback
        traceback.print_exc()
        if log_file:
            try:
                with open(log_file, 'a') as f:
                    f.write(traceback.format_exc() + '\n')
            except:
                pass
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
        default=0.70,
        help='Ratio of max amplitude to use as threshold (default: 0.70). Only used with --detection-method=max_amplitude'
    )
    parser.add_argument(
        '--detection-method',
        type=str,
        choices=['max_amplitude', 'noise_floor'],
        default='max_amplitude',
        help='Shot detection method: max_amplitude (default) or noise_floor'
    )
    parser.add_argument(
        '--floor-percent',
        type=float,
        default=10.0,
        help='Percentage above noise floor for threshold (default: 10.0). Only used with --detection-method=noise_floor. e.g., if floor is 40dB, 10%% means threshold is 44dB'
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
    parser.add_argument(
        '--item-id',
        type=int,
        default=None,
        help='Process only a specific inventory item by ID (overrides --reprocess-all)'
    )
    parser.add_argument(
        '--merge-threshold-ms',
        type=int,
        default=500,
        help='Maximum gap between shots to merge them into a single shot (default: 500ms)'
    )
    parser.add_argument(
        '--override-duration',
        action='store_true',
        help='Override item duration based on time from first shot start to last shot end'
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
    
    # Get log file path
    log_file = get_log_path()
    
    log_message(f"=== Starting firing profile processing ===", log_file)
    log_message(f"Using database: {db_path}", log_file)
    log_message(f"Log file: {log_file}", log_file)
    log_message(f"Detection method: {args.detection_method}", log_file)
    if args.detection_method == 'max_amplitude':
        log_message(f"Threshold ratio: {args.threshold_ratio}", log_file)
    else:
        log_message(f"Floor percent: {args.floor_percent}%", log_file)
    log_message(f"Merge threshold: {args.merge_threshold_ms}ms", log_file)
    log_message(f"Override duration: {args.override_duration}", log_file)
    if args.item_id:
        log_message(f"Processing specific item ID: {args.item_id}", log_file)
    else:
        log_message(f"Reprocess all: {args.reprocess_all}", log_file)
    log_message("", log_file)
    
    # Get items to process
    items = get_inventory_items_with_youtube(
        db_path, 
        reprocess_all=args.reprocess_all or args.item_id is not None,
        item_id=args.item_id
    )
    
    if not items:
        log_message("No items to process.", log_file)
        return
    
    log_message(f"Found {len(items)} item(s) to process", log_file)
    log_message("", log_file)
    
    # Process each item
    success_count = 0
    for item in items:
        if process_item(item, db_path, args.threshold_ratio, args.temp_dir, log_file, args.merge_threshold_ms, args.override_duration, args.detection_method, args.floor_percent):
            success_count += 1
        log_message("", log_file)
    
    log_message(f"=== Completed: {success_count}/{len(items)} items processed successfully ===", log_file)


if __name__ == '__main__':
    main()

