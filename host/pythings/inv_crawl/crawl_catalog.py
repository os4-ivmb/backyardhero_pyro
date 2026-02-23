#!/usr/bin/env python3
"""
Fetch catalog data from backyard-hero.com and save to catalog.json
Outputs to /data/catalog.json and writes progress to /data/catalog_crawl_progress.json
"""
import urllib.request
import ssl
import json
import math
from typing import Dict, Any

CATALOG_URL = "https://backyard-hero.com/catalog.json"
OUTPUT_FILE = "/data/catalog.json"
PROGRESS_FILE = "/data/catalog_crawl_progress.json"



def write_progress(status: str, current: int = 0, total: int = 0, message: str = ""):
    """Write progress to file"""
    progress = {
        "status": status,  # "running", "completed", "error"
        "current": current,
        "total": total,
        "message": message,
        "timestamp": math.floor(__import__('time').time())
    }
    try:
        with open(PROGRESS_FILE, 'w', encoding='utf-8') as f:
            json.dump(progress, f)
    except Exception as e:
        print(f"Warning: Could not write progress file: {e}")


def fetch_catalog() -> Dict[str, Any]:
    """Fetch catalog from backyard-hero.com"""
    try:
        # Create SSL context
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        req = urllib.request.Request(CATALOG_URL)
        req.add_header('User-Agent', 'Mozilla/5.0')
        
        with urllib.request.urlopen(req, timeout=30, context=ssl_context) as response:
            data = response.read().decode('utf-8')
            return json.loads(data)
    except Exception as e:
        print(f"Error fetching catalog: {e}")
        return None


def main():
    write_progress("running", 0, 0, "Starting catalog fetch from backyard-hero.com...")
    print("Fetching catalog from backyard-hero.com...")
    
    catalog_data = fetch_catalog()
    
    if not catalog_data:
        error_msg = "Failed to fetch catalog from backyard-hero.com"
        print(error_msg)
        write_progress("error", 0, 0, error_msg)
        return
    
    records = catalog_data.get("records", [])
    total = len(records)
    
    print(f"Fetched catalog with {total} records")
    write_progress("running", 1, 1, f"Fetched {total} records from backyard-hero.com...")
    
    # Save to file (catalog is already in the correct format)
    print(f"Saving to {OUTPUT_FILE}...")
    write_progress("running", 1, 1, f"Saving {total} records to {OUTPUT_FILE}...")
    
    try:
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            json.dump(catalog_data, f, indent=2, ensure_ascii=False)
        
        success_msg = f"Done! Saved {total} records to {OUTPUT_FILE}"
        print(success_msg)
        write_progress("completed", 1, 1, success_msg)
    except Exception as e:
        error_msg = f"Error saving catalog: {e}"
        print(error_msg)
        write_progress("error", 1, 1, error_msg)


if __name__ == "__main__":
    main()

