#!/usr/bin/env python3
"""
Fetch all fireworks data from wikifireworks API and save to catalog.json
"""
import urllib.request
import urllib.parse
import ssl
import json
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Any

API_BASE_URL = "https://api.wikifireworks.com/api/solr/query"
PER_PAGE = 1000
OUTPUT_FILE = "data/catalog.json"


def fetch_page(page: int, per_page: int = PER_PAGE) -> Dict[str, Any]:
    """Fetch a single page of results from the API"""
    params = {
        "search": "",
        "name_search": "true",
        "order_by": "score",
        "order": "",
        "page": page,
        "per_page": per_page
    }
    
    try:
        # Build URL with query parameters
        query_string = urllib.parse.urlencode(params)
        url = f"{API_BASE_URL}?{query_string}"
        
        # Make request with SSL context
        req = urllib.request.Request(url)
        req.add_header('User-Agent', 'Mozilla/5.0')
        
        # Create unverified SSL context (for data gathering script)
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        with urllib.request.urlopen(req, timeout=30, context=ssl_context) as response:
            data = response.read().decode('utf-8')
            return json.loads(data)
    except Exception as e:
        print(f"Error fetching page {page}: {e}")
        return None


def main():
    print("Fetching initial page to get total count...")
    # First request to get total count and defaults
    first_page = fetch_page(1)
    
    if not first_page:
        print("Failed to fetch initial page")
        return
    
    total = first_page.get("total", 0)
    defaults = first_page.get("defaults", {})
    first_results = first_page.get("records", [])  # API uses "records" not "results"
    
    print(f"Total results: {total}")
    print(f"First page returned {len(first_results)} results")
    
    # Calculate number of pages needed
    total_pages = math.ceil(total / PER_PAGE)
    print(f"Need to fetch {total_pages} pages total")
    
    # Collect all results
    all_results = first_results.copy()
    
    # Fetch remaining pages in parallel
    if total_pages > 1:
        print(f"Fetching pages 2-{total_pages} in parallel...")
        pages_to_fetch = list(range(2, total_pages + 1))
        
        with ThreadPoolExecutor(max_workers=10) as executor:
            # Submit all page requests
            future_to_page = {
                executor.submit(fetch_page, page): page 
                for page in pages_to_fetch
            }
            
            # Collect results as they complete
            completed = 0
            for future in as_completed(future_to_page):
                page = future_to_page[future]
                try:
                    page_data = future.result()
                    if page_data:
                        page_results = page_data.get("records", [])  # API uses "records" not "results"
                        all_results.extend(page_results)
                        completed += 1
                        print(f"Completed page {page} ({completed}/{len(pages_to_fetch)}) - {len(page_results)} results")
                    else:
                        print(f"Warning: Page {page} returned no data")
                except Exception as e:
                    print(f"Error processing page {page}: {e}")
    
    print(f"\nTotal results collected: {len(all_results)}")
    
    # Create final catalog structure
    catalog = {
        "defaults": defaults,
        "records": all_results,  # Keep API naming convention
        "total": len(all_results),
        "metadata": {
            "total_api_count": total,
            "pages_fetched": total_pages,
            "per_page": PER_PAGE
        }
    }
    
    # Save to file
    print(f"Saving to {OUTPUT_FILE}...")
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
    
    print(f"Done! Saved {len(all_results)} records to {OUTPUT_FILE}")
    print(f"Categories (brands): {len(defaults.get('brands', []))} brands")


if __name__ == "__main__":
    main()

