CREATE TABLE regions (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 22),
  slug TEXT UNIQUE NOT NULL,
  name_fa TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO regions (id, slug, name_fa) VALUES
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

ALTER TABLE districts ADD COLUMN region_id INTEGER REFERENCES regions(id);
ALTER TABLE listings ADD COLUMN region_id INTEGER REFERENCES regions(id);
CREATE INDEX IF NOT EXISTS idx_listings_region_id ON listings(region_id);