import { extractListingsFromApiResponse, fetchListingsPage } from './scraper.js';
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
      INSERT OR IGNORE INTO districts (slug, name_fa, city_slug, created_at)
      VALUES (?, ?, 'tehran', datetime('now'))
    `).bind(district.slug, district.name_fa));
  let added = 0;
  for (let offset = 0; offset < statements.length; offset += 100) {
    const results = await env.DB.batch(statements.slice(offset, offset + 100));
    added += results.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
  }
  return added;
}