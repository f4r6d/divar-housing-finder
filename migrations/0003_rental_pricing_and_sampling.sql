ALTER TABLE listings ADD COLUMN deposit_equivalent_toman INTEGER;
ALTER TABLE listings ADD COLUMN rent_deposit_flexible INTEGER NOT NULL DEFAULT 0;

UPDATE listings
SET deposit_equivalent_toman = CASE
  WHEN COALESCE(deposit_toman, 0) > 0 OR COALESCE(rent_toman, 0) > 0
    THEN COALESCE(deposit_toman, 0) + COALESCE(rent_toman, 0) * 30
  ELSE price_toman
END;

UPDATE settings SET value = '100', updated_at = datetime('now')
WHERE key = 'daily_listing_limit' AND value = '30';
UPDATE settings SET value = '5', updated_at = datetime('now')
WHERE key = 'max_listings_per_hood' AND value = '2';