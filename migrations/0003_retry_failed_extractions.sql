UPDATE listings
SET extraction_done = 0,
    scrape_source = 'auto',
    updated_at = datetime('now')
WHERE extraction_done = -1;
