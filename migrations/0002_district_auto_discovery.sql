PRAGMA foreign_keys = ON;

ALTER TABLE districts ADD COLUMN city_slug TEXT NOT NULL DEFAULT 'tehran';
ALTER TABLE districts ADD COLUMN last_scraped_at TEXT;
ALTER TABLE districts ADD COLUMN listings_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE districts ADD COLUMN created_at TEXT;
ALTER TABLE listings ADD COLUMN district_slug TEXT;
CREATE INDEX IF NOT EXISTS idx_listings_district_slug ON listings(district_slug);

UPDATE listings SET district_id = NULL, neighborhood_id = NULL, district_slug = NULL;
DELETE FROM scrape_state;
DELETE FROM neighborhoods;
DELETE FROM districts;