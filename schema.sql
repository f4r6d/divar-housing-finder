PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS neighborhoods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  divar_id TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  name_fa TEXT NOT NULL,
  city_slug TEXT NOT NULL DEFAULT 'tehran',
  is_active INTEGER NOT NULL DEFAULT 1,
  last_scraped_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO neighborhoods (divar_id, slug, name_fa) VALUES
  ('146', 'central-janat-abad', 'جنت‌آباد مرکزی'),
  ('148', 'south-janat-abad', 'جنت‌آباد جنوبی'),
  ('145', 'north-janat-abad', 'جنت‌آباد شمالی'),
  ('147', 'shahin', 'شاهین'),
  ('4312', 'sardar-e-jangal', 'سردارجنگل'),
  ('170', 'kooy-e-ferdos', 'فردوس');

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
  neighborhood_id INTEGER NOT NULL,
  description TEXT,
  image_url TEXT,
  extracted_data TEXT,
  extraction_done INTEGER NOT NULL DEFAULT 0,
  jev_result TEXT,
  jev_score REAL DEFAULT 0,
  jev_done INTEGER NOT NULL DEFAULT 0,
  fake_label TEXT NOT NULL DEFAULT 'unknown',
  fake_score REAL DEFAULT 0,
  fake_reason TEXT,
  scrape_source TEXT NOT NULL DEFAULT 'auto',
  scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (neighborhood_id) REFERENCES neighborhoods(id)
);

CREATE INDEX IF NOT EXISTS idx_listings_neighborhood_scraped
  ON listings(neighborhood_id, scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_extraction_source
  ON listings(extraction_done, scrape_source, scraped_at);
CREATE INDEX IF NOT EXISTS idx_listings_fake_label ON listings(fake_label);
CREATE INDEX IF NOT EXISTS idx_listings_divar_token ON listings(divar_token);

CREATE TABLE IF NOT EXISTS daily_ai_usage (
  usage_date TEXT PRIMARY KEY,
  total_calls INTEGER NOT NULL DEFAULT 0,
  auto_calls INTEGER NOT NULL DEFAULT 0,
  manual_calls INTEGER NOT NULL DEFAULT 0,
  manual_searches INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS manual_runs (
  id TEXT PRIMARY KEY,
  neighborhood_id INTEGER NOT NULL,
  requested_count INTEGER NOT NULL,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
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
  ('daily_listing_limit', '500'),
  ('auto_neighborhoods', '["central-janat-abad","south-janat-abad","north-janat-abad","shahin","sardar-e-jangal","kooy-e-ferdos"]'),
  ('jev_weights', '{"price_vs_neighborhood_avg":0.40,"price_vs_size_ratio":0.25,"description_mismatch":0.20,"suspicious_keywords":0.15}'),
  ('bait_keywords', '["قیمت توافقی","زیر قیمت","فوری","فرصت استثنایی","فقط امروز"]');

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

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
