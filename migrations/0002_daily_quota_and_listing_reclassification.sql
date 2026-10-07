INSERT INTO settings (key, value, updated_at)
VALUES ('daily_listing_limit', '150', datetime('now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

UPDATE listings
SET deposit_equivalent_toman = CASE
  WHEN COALESCE(deposit_toman, 0) > 0 OR COALESCE(rent_toman, 0) > 0
    THEN ROUND(COALESCE(deposit_toman, 0) + COALESCE(rent_toman, 0) * (100.0 / 3.0))
  ELSE price_toman
END;

UPDATE listings
SET fake_label = 'hamkhane',
    fake_reason = 'آگهی هم‌خانه است و اجارهٔ مستقل محسوب نمی‌شود.',
    jev_done = 1,
    updated_at = datetime('now')
WHERE (
  CASE WHEN json_valid(extracted_data)
    THEN lower(json_extract(extracted_data, '$.property_type'))
    ELSE ''
  END
) = 'room'
OR instr(
  replace(replace(replace(COALESCE(title, '') || COALESCE(description, ''), char(8204), ''), char(8205), ''), ' ', ''),
  'همخانه'
) > 0
OR instr(
  replace(replace(replace(COALESCE(title, '') || COALESCE(description, ''), char(8204), ''), char(8205), ''), ' ', ''),
  'هماتاقی'
) > 0
OR instr(
  replace(replace(replace(COALESCE(title, '') || COALESCE(description, ''), char(8204), ''), char(8205), ''), ' ', ''),
  'اتاقمشترک'
) > 0
OR instr(
  replace(replace(replace(COALESCE(title, '') || COALESCE(description, ''), char(8204), ''), char(8205), ''), ' ', ''),
  'واحدمشترک'
) > 0;

UPDATE listings
SET jev_done = 0,
    updated_at = datetime('now')
WHERE extraction_done = 1 AND fake_label <> 'hamkhane';
