INSERT INTO settings (key, value, updated_at)
VALUES ('daily_listing_limit', '500', datetime('now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
