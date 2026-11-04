-- Precomputed aggregates so dashboard reads stop scanning the listings table.
-- neighborhood_id = 0 holds city-wide rows; window_days = 0 holds all-time totals.
-- The tables are filled by src/stats.js during the scrape workflow; until the first
-- run finishes the API falls back to live queries.

CREATE TABLE IF NOT EXISTS neighborhood_stats (
  neighborhood_id INTEGER NOT NULL,
  window_days INTEGER NOT NULL,
  listing_count INTEGER NOT NULL DEFAULT 0,
  fake_count INTEGER NOT NULL DEFAULT 0,
  suspicious_count INTEGER NOT NULL DEFAULT 0,
  hamkhane_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  avg_deposit REAL,
  avg_rent REAL,
  avg_deposit_per_sqm REAL,
  median_deposit REAL,
  median_rent REAL,
  median_deposit_per_sqm REAL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (neighborhood_id, window_days)
);

CREATE TABLE IF NOT EXISTS daily_stats (
  day TEXT PRIMARY KEY,
  listing_count INTEGER NOT NULL DEFAULT 0,
  median_deposit REAL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
