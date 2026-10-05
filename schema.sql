PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS regions (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 22),
  slug TEXT UNIQUE NOT NULL,
  name_fa TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO regions (id, slug, name_fa) VALUES
  (1, 'tehran-region-1', 'منطقه ۱'), (2, 'tehran-region-2', 'منطقه ۲'),
  (3, 'tehran-region-3', 'منطقه ۳'), (4, 'tehran-region-4', 'منطقه ۴'),
  (5, 'tehran-region-5', 'منطقه ۵'), (6, 'tehran-region-6', 'منطقه ۶'),
  (7, 'tehran-region-7', 'منطقه ۷'), (8, 'tehran-region-8', 'منطقه ۸'),
  (9, 'tehran-region-9', 'منطقه ۹'), (10, 'tehran-region-10', 'منطقه ۱۰'),
  (11, 'tehran-region-11', 'منطقه ۱۱'), (12, 'tehran-region-12', 'منطقه ۱۲'),
  (13, 'tehran-region-13', 'منطقه ۱۳'), (14, 'tehran-region-14', 'منطقه ۱۴'),
  (15, 'tehran-region-15', 'منطقه ۱۵'), (16, 'tehran-region-16', 'منطقه ۱۶'),
  (17, 'tehran-region-17', 'منطقه ۱۷'), (18, 'tehran-region-18', 'منطقه ۱۸'),
  (19, 'tehran-region-19', 'منطقه ۱۹'), (20, 'tehran-region-20', 'منطقه ۲۰'),
  (21, 'tehran-region-21', 'منطقه ۲۱'), (22, 'tehran-region-22', 'منطقه ۲۲');

CREATE TABLE IF NOT EXISTS districts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name_fa TEXT NOT NULL,
  city_slug TEXT DEFAULT 'tehran',
  region_id INTEGER,
  last_scraped_at TEXT,
  listings_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (region_id) REFERENCES regions(id)
);

CREATE TABLE IF NOT EXISTS neighborhoods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  district_id INTEGER,
  name_fa TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (district_id) REFERENCES districts(id)
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  divar_token TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  price_toman INTEGER,
  rent_toman INTEGER,
  deposit_toman INTEGER,
  deposit_equivalent_toman INTEGER,
  rent_deposit_flexible INTEGER NOT NULL DEFAULT 0,
  size_m2 REAL,
  rooms INTEGER,
  neighborhood_id INTEGER,
  district_id INTEGER,
  district_slug TEXT,
  region_id INTEGER,
  description TEXT,
  image_url TEXT,
  extracted_data TEXT,
  extraction_done INTEGER DEFAULT 0,
  jev_result TEXT,
  jev_score REAL DEFAULT 0,
  jev_done INTEGER DEFAULT 0,
  fake_label TEXT DEFAULT 'unknown',
  fake_score REAL DEFAULT 0,
  fake_reason TEXT,
  scraped_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id),
  FOREIGN KEY (district_id) REFERENCES districts(id),
  FOREIGN KEY (region_id) REFERENCES regions(id)
);

CREATE INDEX IF NOT EXISTS idx_listings_district_id ON listings(district_id);
CREATE INDEX IF NOT EXISTS idx_listings_district_slug ON listings(district_slug);
CREATE INDEX IF NOT EXISTS idx_listings_region_id ON listings(region_id);
CREATE INDEX IF NOT EXISTS idx_listings_neighborhood_id ON listings(neighborhood_id);
CREATE INDEX IF NOT EXISTS idx_listings_extraction_done ON listings(extraction_done);
CREATE INDEX IF NOT EXISTS idx_listings_jev_done ON listings(jev_done);
CREATE INDEX IF NOT EXISTS idx_listings_fake_label ON listings(fake_label);
CREATE INDEX IF NOT EXISTS idx_listings_divar_token ON listings(divar_token);

CREATE TABLE IF NOT EXISTS scrape_state (
  neighborhood_id INTEGER PRIMARY KEY,
  last_scraped_at TEXT,
  total_scraped INTEGER DEFAULT 0,
  consecutive_empty INTEGER DEFAULT 0,
  FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('fake_threshold', '0.6'),
  ('high_fake_threshold', '0.8'),
  ('daily_listing_limit', '100'),
  ('max_listings_per_hood', '5'),
  ('jev_weights', '{"price_vs_district_avg":0.40,"price_vs_size_ratio":0.25,"description_mismatch":0.20,"suspicious_keywords":0.15}'),
  ('bait_keywords', '["قیمت توافقی","زیر قیمت","فوری","فرصت استثنایی","فقط امروز"]');

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO system_state (key, value) VALUES
  ('cron_running', '0'),
  ('last_cleanup', '0');

CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  url TEXT,
  status INTEGER,
  error TEXT,
  response_snippet TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC);