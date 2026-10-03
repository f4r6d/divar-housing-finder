PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS districts (
  id INTEGER PRIMARY KEY,
  name_fa TEXT NOT NULL,
  name_en TEXT,
  slug TEXT UNIQUE
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
  size_m2 REAL,
  rooms INTEGER,
  neighborhood_id INTEGER,
  district_id INTEGER,
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
  FOREIGN KEY (district_id) REFERENCES districts(id)
);

CREATE INDEX IF NOT EXISTS idx_listings_district_id ON listings(district_id);
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
  ('daily_listing_limit', '30'),
  ('max_listings_per_hood', '2'),
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