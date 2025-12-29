#!/usr/bin/env python3
"""
Compare firing profiles to find similar timing patterns.
This script analyzes shot timestamps from all inventory items with firing profiles
and calculates similarity scores based on timing alignment.
"""

import sqlite3
import json
import os
import sys
from pathlib import Path
from typing import List, Tuple, Dict
from collections import defaultdict


def get_db_path():
    """Get the path to the SQLite database."""
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
    
    return '/data/backyardhero.db'


def load_firing_profiles(db_path: str, cake_only: bool = True) -> Dict[int, Dict]:
    """Load firing profiles from the database.
    
    Args:
        db_path: Path to database
        cake_only: If True, only load CAKE types (CAKE_200G, CAKE_500G, CAKE_FOUNTAIN)
    
    Returns:
        Dictionary mapping inventory_id to profile data including shot_timestamps
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    if cake_only:
        cursor.execute("""
            SELECT 
                fp.inventory_id,
                fp.shot_timestamps,
                i.name as item_name,
                i.type as item_type
            FROM inventoryFiringProfile fp
            JOIN inventory i ON fp.inventory_id = i.id
            WHERE i.type IN ('CAKE_200G', 'CAKE_500G', 'CAKE_FOUNTAIN')
        """)
    else:
        cursor.execute("""
            SELECT 
                fp.inventory_id,
                fp.shot_timestamps,
                i.name as item_name,
                i.type as item_type
            FROM inventoryFiringProfile fp
            JOIN inventory i ON fp.inventory_id = i.id
        """)
    
    profiles = {}
    for row in cursor.fetchall():
        try:
            shot_timestamps = json.loads(row['shot_timestamps'])
            # Normalize to [start, end, color] format
            normalized_shots = []
            for shot in shot_timestamps:
                if isinstance(shot, list) and len(shot) >= 2:
                    start_ms = shot[0]
                    end_ms = shot[1]
                    color = shot[2] if len(shot) > 2 else None
                    normalized_shots.append([start_ms, end_ms, color])
            
            profiles[row['inventory_id']] = {
                'inventory_id': row['inventory_id'],
                'name': row['item_name'],
                'type': row['item_type'],
                'shots': normalized_shots
            }
        except (json.JSONDecodeError, KeyError, IndexError) as e:
            print(f"Warning: Error parsing profile for inventory_id {row['inventory_id']}: {e}")
            continue
    
    conn.close()
    return profiles


def shots_to_intervals(shots: List[List]) -> List[Tuple[float, float]]:
    """Convert shot list to list of (start, end) tuples in seconds."""
    intervals = []
    for shot in shots:
        if len(shot) >= 2:
            start_s = shot[0] / 1000.0  # Convert ms to seconds
            end_s = shot[1] / 1000.0
            intervals.append((start_s, end_s))
    return intervals


def calculate_overlap(interval1: Tuple[float, float], interval2: Tuple[float, float]) -> float:
    """Calculate overlap between two intervals as a fraction of the shorter interval.
    
    Returns:
        Overlap ratio (0.0 to 1.0) representing how much of the shorter interval overlaps
    """
    start1, end1 = interval1
    start2, end2 = interval2
    
    # Calculate overlap
    overlap_start = max(start1, start2)
    overlap_end = min(end1, end2)
    
    if overlap_start >= overlap_end:
        return 0.0
    
    overlap_duration = overlap_end - overlap_start
    shorter_duration = min(end1 - start1, end2 - start2)
    
    if shorter_duration == 0:
        return 0.0
    
    return overlap_duration / shorter_duration


def find_best_alignment(shots1: List[List], shots2: List[List], 
                       max_offset_ms: int = 10000, 
                       tolerance_ms: int = 200) -> Tuple[float, int, Dict]:
    """Find the best time offset alignment between two shot sequences.
    
    Args:
        shots1: First shot sequence [[start_ms, end_ms, ...], ...]
        shots2: Second shot sequence [[start_ms, end_ms, ...], ...]
        max_offset_ms: Maximum time offset to try (in milliseconds)
        tolerance_ms: Time tolerance for matching shots (in milliseconds)
    
    Returns:
        Tuple of (similarity_score, best_offset_ms, match_details)
        similarity_score: 0.0 to 1.0
        best_offset_ms: Best time offset found
        match_details: Dictionary with alignment details
    """
    if not shots1 or not shots2:
        return (0.0, 0, {'matched_shots': 0, 'total_shots': 0, 'overlap_ratio': 0.0})
    
    intervals1 = shots_to_intervals(shots1)
    intervals2 = shots_to_intervals(shots2)
    
    best_score = 0.0
    best_offset = 0
    best_details = {}
    
    # Try different offsets
    # We'll try offsets from -max_offset to +max_offset in steps
    step_ms = max(50, tolerance_ms // 2)  # Step size for offset search
    offsets_to_try = list(range(-max_offset_ms, max_offset_ms + 1, step_ms))
    
    # Also try offset of 0
    if 0 not in offsets_to_try:
        offsets_to_try.append(0)
    offsets_to_try.sort()
    
    for offset_ms in offsets_to_try:
        offset_s = offset_ms / 1000.0
        
        # Shift intervals2 by offset
        shifted_intervals2 = [(start + offset_s, end + offset_s) for start, end in intervals2]
        
        # Match shots from intervals1 to shifted_intervals2
        matched_pairs = []
        used_indices2 = set()
        
        for i, (start1, end1) in enumerate(intervals1):
            best_match_idx = None
            best_overlap = 0.0
            
            for j, (start2, end2) in enumerate(shifted_intervals2):
                if j in used_indices2:
                    continue
                
                # Check if shots are within tolerance
                center1 = (start1 + end1) / 2.0
                center2 = (start2 + end2) / 2.0
                time_diff = abs(center1 - center2) * 1000  # Convert to ms
                
                if time_diff <= tolerance_ms:
                    overlap = calculate_overlap((start1, end1), (start2, end2))
                    if overlap > best_overlap:
                        best_overlap = overlap
                        best_match_idx = j
            
            if best_match_idx is not None and best_overlap > 0.3:  # Minimum overlap threshold
                matched_pairs.append((i, best_match_idx, best_overlap))
                used_indices2.add(best_match_idx)
        
        # Calculate similarity score
        # Score = (matched shots / total shots) * average_overlap
        total_shots = max(len(intervals1), len(shifted_intervals2))
        matched_count = len(matched_pairs)
        
        if total_shots == 0:
            continue
        
        avg_overlap = sum(overlap for _, _, overlap in matched_pairs) / matched_count if matched_pairs else 0.0
        match_ratio = matched_count / total_shots
        score = match_ratio * (0.7 + 0.3 * avg_overlap)  # Weighted combination
        
        if score > best_score:
            best_score = score
            best_offset = offset_ms
            best_details = {
                'matched_shots': matched_count,
                'total_shots': total_shots,
                'match_ratio': match_ratio,
                'avg_overlap': avg_overlap,
                'matched_pairs': len(matched_pairs)
            }
    
    return (best_score, best_offset, best_details)


def compare_all_profiles(profiles: Dict[int, Dict], 
                         output_file: str = 'firing_profile_similarities.txt') -> Dict[int, List[Dict]]:
    """Compare all firing profiles and find similar pairs.
    
    Args:
        profiles: Dictionary of inventory_id -> profile data
        output_file: Path to output file
    
    Returns:
        Dictionary mapping inventory_id to list of matches sorted by match percentage (descending)
    """
    # Store results grouped by cake
    results_by_cake = {id: [] for id in profiles.keys()}
    profile_ids = list(profiles.keys())
    
    print(f"Comparing {len(profile_ids)} cake firing profiles...")
    
    # Compare all pairs
    for i, id1 in enumerate(profile_ids):
        for id2 in profile_ids[i+1:]:
            profile1 = profiles[id1]
            profile2 = profiles[id2]
            
            shots1 = profile1['shots']
            shots2 = profile2['shots']
            
            if not shots1 or not shots2:
                continue
            
            similarity, offset_ms, details = find_best_alignment(shots1, shots2)
            
            match_data = {
                'other_id': id2,
                'other_name': profile2['name'],
                'match_percent': similarity * 100,
                'offset_ms': offset_ms
            }
            
            # Add to both cakes' results
            results_by_cake[id1].append(match_data)
            results_by_cake[id2].append({
                'other_id': id1,
                'other_name': profile1['name'],
                'match_percent': similarity * 100,
                'offset_ms': -offset_ms  # Reverse offset for the other direction
            })
    
    # Sort each cake's matches by match percentage (descending)
    for cake_id in results_by_cake:
        results_by_cake[cake_id].sort(key=lambda x: x['match_percent'], reverse=True)
    
    # Write to file grouped by cake
    with open(output_file, 'w') as f:
        # Sort cakes by their highest match percentage for better organization
        sorted_cakes = sorted(profile_ids, 
                            key=lambda id: results_by_cake[id][0]['match_percent'] if results_by_cake[id] else 0, 
                            reverse=True)
        
        for cake_id in sorted_cakes:
            profile = profiles[cake_id]
            matches = results_by_cake[cake_id]
            
            if not matches:
                continue
            
            f.write(f"\n[{cake_id}] {profile['name']}\n")
            for match in matches:
                f.write(f"  {match['match_percent']:.2f}% | {match['offset_ms']} ms | vs [{match['other_id']}] {match['other_name']}\n")
    
    print(f"\nResults written to: {output_file}")
    total_pairs = sum(len(matches) for matches in results_by_cake.values()) // 2
    print(f"Total pairs compared: {total_pairs}")
    
    return results_by_cake


def main():
    """Main function."""
    db_path = get_db_path()
    
    if not os.path.exists(db_path):
        print(f"Error: Database not found at {db_path}")
        sys.exit(1)
    
    print(f"Loading firing profiles from: {db_path}")
    profiles = load_firing_profiles(db_path, cake_only=True)
    
    if not profiles:
        print("No cake firing profiles found in database.")
        sys.exit(0)
    
    print(f"Loaded {len(profiles)} cake firing profiles")
    
    # Compare all profiles
    output_file = os.path.join(os.path.dirname(db_path), 'firing_profile_similarities.txt')
    if not os.path.exists(os.path.dirname(output_file)):
        output_file = 'firing_profile_similarities.txt'
    
    results_by_cake = compare_all_profiles(profiles, output_file=output_file)
    
    # Print summary
    print("\nSummary: Top matches per cake (showing first 3 cakes):")
    print("=" * 80)
    sorted_cakes = sorted(results_by_cake.keys(), 
                         key=lambda id: results_by_cake[id][0]['match_percent'] if results_by_cake[id] else 0, 
                         reverse=True)
    for cake_id in sorted_cakes[:3]:
        profile = profiles[cake_id]
        matches = results_by_cake[cake_id]
        if matches:
            print(f"\n[{cake_id}] {profile['name']}: {len(matches)} matches")
            for match in matches[:3]:
                print(f"  {match['match_percent']:.2f}% | {match['offset_ms']} ms | vs [{match['other_id']}] {match['other_name']}")


if __name__ == '__main__':
    main()

