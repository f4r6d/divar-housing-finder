import { logError, logSuccess } from './utils.js';

const PLACES_URL = 'https://map.divarcdn.com/places-web.json';

export async function discoverNeighborhoods(env) {
  try {
    const response = await fetch(PLACES_URL);
    if (!response.ok) throw new Error(`Divar places returned HTTP ${response.status}`);
    const places = await response.json();
    if (!Array.isArray(places)) throw new Error('Divar places response is not an array');

    const unique = new Map();
    for (const place of places) {
      if (String(place?.parent) !== '1' || String(place?.type) !== '4' || !place.id || !place.slug) continue;
      const slug = String(place.slug).trim().toLowerCase();
      const nameFa = String(place.name || place.name_fa || '').trim();
      if (slug && nameFa) unique.set(slug, { divar_id: String(place.id), slug, name_fa: nameFa });
    }
    if (!unique.size) throw new Error('Divar places response contained no Tehran neighborhoods');

    await logSuccess(env, 'neighborhood-discovery', PLACES_URL,
      `Discovered ${unique.size} Tehran neighborhoods`, response.status);
    return [...unique.values()];
  } catch (error) {
    await logError(env, 'neighborhood-discovery', PLACES_URL, error);
    return null;
  }
}

export async function syncNeighborhoodsToDb(env, neighborhoods) {
  const statements = neighborhoods.map((neighborhood) => env.DB.prepare(`
    INSERT INTO neighborhoods (divar_id, slug, name_fa, city_slug, is_active)
    VALUES (?, ?, ?, 'tehran', 1)
    ON CONFLICT(slug) DO UPDATE SET
      divar_id = excluded.divar_id,
      name_fa = excluded.name_fa,
      is_active = 1
  `).bind(neighborhood.divar_id, neighborhood.slug, neighborhood.name_fa));

  let changes = 0;
  for (let offset = 0; offset < statements.length; offset += 100) {
    const results = await env.DB.batch(statements.slice(offset, offset + 100));
    changes += results.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
  }
  return changes;
}

export async function refreshNeighborhoodsIfDue(env, force = false) {
  const lastRun = await env.DB.prepare(
    "SELECT value FROM system_state WHERE key = 'neighborhood_discovery_last_run'"
  ).first();
  if (!force && lastRun?.value && Date.parse(`${lastRun.value.replace(' ', 'T')}Z`) > Date.now() - 7 * 24 * 60 * 60 * 1000) {
    return { source: 'cached', count: 0 };
  }

  const neighborhoods = await discoverNeighborhoods(env);
  if (!neighborhoods?.length) return { source: 'divar-places', count: 0, failed: true };

  const count = await syncNeighborhoodsToDb(env, neighborhoods);
  await env.DB.prepare(`
    INSERT INTO system_state (key, value, updated_at) VALUES ('neighborhood_discovery_last_run', datetime('now'), datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run();
  return { source: 'divar-places', count, discovered: neighborhoods.length };
}
