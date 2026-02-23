# Inventory Catalog Crawler

This script fetches all fireworks data from the BYH catalog and saves it to `/data/catalog.json`.

## Usage

```bash
python3 crawl_catalog.py
```

## Output

- **Catalog file**: `/data/catalog.json`
- **Progress file**: `/data/catalog_crawl_progress.json` (updated during crawl)

## Progress File Format

```json
{
  "status": "running|completed|error",
  "current": 5,
  "total": 50,
  "message": "Completed page 5/50...",
  "timestamp": 1234567890
}
```

## Requirements

No additional requirements beyond Python standard library.

