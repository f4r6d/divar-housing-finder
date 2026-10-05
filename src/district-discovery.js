import { extractListingsFromApiResponse, fetchListingsPage } from './scraper.js';
import { neighborhoodFromText, regionForNeighborhood } from './tehran-region-map.js';
import { logError, logSuccess } from './utils.js';

const KENAR_URL = 'https://open-api.divar.ir/v1/open-platform/assets/district/tehran';

function normalizeDistricts(value) {
  const rows = Array.isArray(value)
    ? value
    : value?.districts || value?.results || value?.items || value?.data?.districts || value?.data?.results || value?.data || [];
  if (!Array.isArray(rows)) return [];

  const unique = new Map();
  for (const row of rows) {
    const slug = String(row?.slug || '').trim().toLowerCase();
    const nameFa = String(row?.name_fa || row?.display || row?.display_name || row?.name || row?.title || slug).trim();
    if (slug && nameFa && !unique.has(slug)) unique.set(slug, { slug, name_fa: nameFa });
  }
  return [...unique.values()];
}

export async function discoverDistrictsFromKenar(env) {
  try {
    const headers = env.KENAR_API_KEY ? { 'x-api-key': env.KENAR_API_KEY } : {};
    const response = await fetch(KENAR_URL, { headers });
    const raw = await response.text();
    if (response.status === 401 || response.status === 403) {
      await logError(env, 'district-discovery', KENAR_URL, `Kenar HTTP ${response.status}: ${raw.slice(0, 300)}`, response.status);
      return null;
    }
    if (!response.ok) {
      await logError(env, 'district-discovery', KENAR_URL, `Kenar HTTP ${response.status}: ${raw.slice(0, 300)}`, response.status);
      return null;
    }

    const districts = normalizeDistricts(JSON.parse(raw));
    await logSuccess(env, 'district-discovery', KENAR_URL, `Discovered ${districts.length} districts from Kenar`, response.status);
    return districts;
  } catch (error) {
    await logError(env, 'district-discovery', KENAR_URL, error);
    return null;
  }
}

export async function discoverDistrictsFromSearch(env) {
  const response = await fetchListingsPage(env, '1', 'residential-rent', 1, []);
  const listings = extractListingsFromApiResponse(response);
  const unique = new Map();
  for (const listing of listings) {
    if (listing.district_slug && listing.district_name_fa && !unique.has(listing.district_slug)) {
      unique.set(listing.district_slug, { slug: listing.district_slug, name_fa: listing.district_name_fa });
    }
  }
  return [...unique.values()];
}

export async function syncDistrictsToDb(env, districts) {
  const unique = normalizeDistricts(districts);
  const statements = unique.map((district) => env.DB.prepare(`
      INSERT INTO districts (slug, name_fa, city_slug, region_id, created_at)
      VALUES (?, ?, 'tehran', ?, datetime('now'))
      ON CONFLICT(slug) DO UPDATE SET name_fa = excluded.name_fa,
        region_id = COALESCE(excluded.region_id, districts.region_id)
    `).bind(district.slug, district.name_fa, regionForNeighborhood(district.name_fa, district.slug)));
  let added = 0;
  for (let offset = 0; offset < statements.length; offset += 100) {
    const results = await env.DB.batch(statements.slice(offset, offset + 100));
    added += results.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
  }
  return added;
}

export async function backfillRegionAssignments(env) {
  const marker = await env.DB.prepare("SELECT value FROM system_state WHERE key = 'district_region_backfill_v2'").first();
  if (marker?.value === 'done') return;

  const result = await env.DB.prepare('SELECT id, slug, name_fa FROM districts WHERE region_id IS NULL').all();
  const updates = (result.results || []).flatMap((district) => {
    const regionId = regionForNeighborhood(district.name_fa, district.slug);
    return regionId ? [env.DB.prepare('UPDATE districts SET region_id = ? WHERE id = ?').bind(regionId, district.id)] : [];
  });
  for (let offset = 0; offset < updates.length; offset += 100) {
    await env.DB.batch(updates.slice(offset, offset + 100));
  }
  const neighborhoods = await env.DB.prepare('SELECT slug, name_fa, region_id FROM districts WHERE region_id IS NOT NULL').all();
  const listings = await env.DB.prepare('SELECT id, title FROM listings WHERE region_id IS NULL').all();
  const listingUpdates = (listings.results || []).flatMap((listing) => {
    const match = neighborhoodFromText(listing.title, neighborhoods.results || []);
    return match ? [env.DB.prepare('UPDATE listings SET district_slug = ?, region_id = ? WHERE id = ?')
      .bind(match.slug, match.region_id, listing.id)] : [];
  });
  for (let offset = 0; offset < listingUpdates.length; offset += 100) {
    await env.DB.batch(listingUpdates.slice(offset, offset + 100));
  }
  await env.DB.prepare(`
    UPDATE listings SET region_id = (
      SELECT region_id FROM districts WHERE districts.slug = listings.district_slug
    )
    WHERE region_id IS NULL AND EXISTS (
      SELECT 1 FROM districts WHERE districts.slug = listings.district_slug AND region_id IS NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    INSERT INTO system_state (key, value, updated_at) VALUES ('district_region_backfill_v2', 'done', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = 'done', updated_at = datetime('now')
  `).run();
}