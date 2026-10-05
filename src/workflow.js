import { WorkflowEntrypoint } from 'cloudflare:workers';
import { extractListingData } from './extractor.js';
import { evaluateListing } from './jev.js';
import { extractListingsFromApiResponse, fetchListingsPage } from './scraper.js';
import { backfillRegionAssignments, discoverDistrictsFromKenar, discoverDistrictsFromSearch, syncDistrictsToDb } from './district-discovery.js';
import { getSettings, isAiQuotaExhausted, logError, logSuccess } from './utils.js';
import { DAILY_LISTING_LIMIT_MAX, DISTRICTS_PER_RUN, LISTINGS_PER_DISTRICT_MAX } from './constants.js';
import { depositEquivalentToman } from './rental-pricing.js';

function parseSetting(settings, key, fallback) {
  const value = Number(settings[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function reserveDailyAiCall(env, limit) {
  const key = `ai_calls_${new Date().toISOString().slice(0, 10)}`;
  await env.DB.prepare('INSERT OR IGNORE INTO system_state (key, value) VALUES (?, ?)').bind(key, '0').run();
  const row = await env.DB.prepare(`
    UPDATE system_state SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now')
    WHERE key = ? AND CAST(value AS INTEGER) < ? RETURNING value
  `).bind(key, limit).first();
  return Boolean(row);
}

async function scrapeDistrict(env, district, dailyRemaining, maxPerDistrict) {
  const page = await fetchListingsPage(env, '1', 'residential-rent', 1, [district.slug]);
  if (!page) return { district_slug: district.slug, inserted: 0 };
  const candidates = extractListingsFromApiResponse(page);
  if (candidates.length === 0 || dailyRemaining <= 0) {
    await env.DB.prepare(`
      UPDATE districts SET last_scraped_at = datetime('now'),
        listings_count = (SELECT COUNT(*) FROM listings WHERE district_slug = ?)
      WHERE slug = ?
    `).bind(district.slug, district.slug).run();
    return { district_slug: district.slug, inserted: 0 };
  }

  maxPerDistrict = Math.min(maxPerDistrict, dailyRemaining);
  const tokenList = candidates.map((listing) => listing.token);
  const existing = await env.DB.prepare(`
    SELECT divar_token FROM listings WHERE divar_token IN (${tokenList.map(() => '?').join(',')})
  `).bind(...tokenList).all();
  const knownTokens = new Set((existing.results || []).map((row) => row.divar_token));
  const newListings = candidates.filter((listing) => !knownTokens.has(listing.token)).slice(0, maxPerDistrict);
  let inserted = 0;
  for (const listing of newListings) {
    const write = await env.DB.prepare(`
      INSERT OR IGNORE INTO listings
        (divar_token, url, title, description, image_url, district_id, district_slug, region_id, extraction_done)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(listing.token, `https://divar.ir/v/${encodeURIComponent(listing.token)}`,
      listing.title, listing.description, listing.image_url, district.id, district.slug, district.region_id).run();
    if (Number(write.meta?.changes || 0) > 0) inserted += 1;
  }
  await env.DB.prepare(`
    UPDATE districts SET last_scraped_at = datetime('now'),
      listings_count = (SELECT COUNT(*) FROM listings WHERE district_slug = ?)
    WHERE slug = ?
  `).bind(district.slug, district.slug).run();
  return { district_slug: district.slug, found: candidates.length, inserted };
}

async function extractPending(env, step, dailyLimit, maximum = 10) {
  if (await isAiQuotaExhausted(env)) return { processed: 0, quota_locked: true };
  const today = new Date().toISOString().slice(0, 10);
  const alreadyProcessed = await env.DB.prepare("SELECT COUNT(*) AS count FROM listings WHERE date(scraped_at) = ? AND extraction_done != 0")
    .bind(today).first();
  const remaining = Math.max(0, dailyLimit - Number(alreadyProcessed?.count || 0));
  const rows = await step.do('extract-pending', async () => env.DB.prepare(`
    SELECT * FROM listings WHERE extraction_done = 0
    ORDER BY scraped_at ASC LIMIT ?
  `).bind(Math.min(maximum, remaining)).all());
  let processed = 0;
  for (const listing of rows.results || []) {
    const result = await step.do(`extract-listing-${listing.id}`, async () => {
      if (!await reserveDailyAiCall(env, dailyLimit)) return { quota_locked: true };
      const data = await extractListingData(env, listing);
      if (!data) {
        await env.DB.prepare("UPDATE listings SET extraction_done = -1, updated_at = datetime('now') WHERE id = ?").bind(listing.id).run();
        return { failed: true };
      }
      await env.DB.prepare(`
        UPDATE listings SET
          price_toman = COALESCE(?, price_toman), rent_toman = ?, deposit_toman = ?,
          deposit_equivalent_toman = ?, rent_deposit_flexible = ?,
          size_m2 = COALESCE(?, size_m2), rooms = COALESCE(?, rooms),
          extracted_data = ?, extraction_done = 1, updated_at = datetime('now')
        WHERE id = ?
      `).bind(data.price_toman ?? null, data.rent_toman ?? null, data.deposit_toman ?? null,
        depositEquivalentToman(data), data.rent_deposit_flexible === true ? 1 : 0,
        data.size_m2 ?? null, data.rooms ?? null, JSON.stringify(data), listing.id).run();
      return { failed: false };
    });
    if (result.quota_locked) break;
    processed += 1;
    await step.sleep(`extract-spacing-${listing.id}`, '500 milliseconds');
  }
  return { processed, quota_locked: false };
}

async function evaluatePending(env, step) {
  const rows = await step.do('jev-evaluate', async () => env.DB.prepare(`
    SELECT * FROM listings WHERE extraction_done = 1 AND jev_done = 0
    ORDER BY scraped_at ASC LIMIT 20
  `).all());
  for (const listing of rows.results || []) {
    await step.do(`jev-listing-${listing.id}`, async () => evaluateListing(env, listing));
    await step.sleep(`jev-spacing-${listing.id}`, '200 milliseconds');
  }
  return rows.results?.length || 0;
}

export class DivarScrapeWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event.payload || {};
    await step.do('sync-districts', async () => {
      await backfillRegionAssignments(this.env);
      const lastRun = await this.env.DB.prepare("SELECT value FROM system_state WHERE key = 'district_discovery_last_run'").first();
      if (lastRun?.value && Date.parse(lastRun.value) > Date.now() - 7 * 24 * 60 * 60 * 1000) {
        return { source: 'cached', count: 0 };
      }

      let districts = await discoverDistrictsFromKenar(this.env);
      let source = 'kenar';
      if (districts === null) {
        districts = await discoverDistrictsFromSearch(this.env);
        source = 'search';
      }
      const count = await syncDistrictsToDb(this.env, districts || []);
      if (districts?.length) {
        await this.env.DB.prepare(`
          INSERT INTO system_state (key, value, updated_at) VALUES ('district_discovery_last_run', datetime('now'), datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
        `).run();
      }
      return { source, count, discovered: districts?.length || 0 };
    });

    const selection = await step.do('select-districts', async () => {
      if (payload.retryListingId) {
        await this.env.DB.prepare('UPDATE listings SET extraction_done = 0, jev_done = 0 WHERE id = ? AND extraction_done = -1')
          .bind(Number(payload.retryListingId)).run();
        return { settings: await getSettings(this.env), districts: [], retry: true };
      }
      if (payload.retryAllFailed) {
        await this.env.DB.prepare('UPDATE listings SET extraction_done = 0, jev_done = 0 WHERE extraction_done = -1').run();
        return { settings: await getSettings(this.env), districts: [], retry: true };
      }
      const districts = await this.env.DB.prepare(`
        SELECT id, slug, name_fa, region_id FROM districts
        WHERE city_slug = 'tehran' AND (last_scraped_at IS NULL OR last_scraped_at < datetime('now', '-12 hours'))
        ORDER BY last_scraped_at ASC LIMIT ${DISTRICTS_PER_RUN}
      `).all();
      return { settings: await getSettings(this.env), districts: districts.results || [], retry: false };
    });

    if (!selection.retry) {
      const dailyLimit = Math.min(DAILY_LISTING_LIMIT_MAX, parseSetting(selection.settings, 'daily_listing_limit', DAILY_LISTING_LIMIT_MAX));
      const maxPerDistrict = Math.min(LISTINGS_PER_DISTRICT_MAX, parseSetting(selection.settings, 'max_listings_per_hood', LISTINGS_PER_DISTRICT_MAX));
      const dailyCount = await step.do('count-todays-scrapes', async () => this.env.DB.prepare("SELECT COUNT(*) AS count FROM listings WHERE date(scraped_at) = date('now')").first());
      let remaining = Math.max(0, dailyLimit - Number(dailyCount?.count || 0));
      for (let index = 0; index < selection.districts.length && remaining > 0; index += 1) {
        const district = selection.districts[index];
        const result = await step.do(`scrape-district-${district.slug}`, async () => scrapeDistrict(this.env, district, remaining, maxPerDistrict));
        remaining -= result.inserted;
        if (index < selection.districts.length - 1) await step.sleep(`rate-limit-${district.slug}`, '3 seconds');
      }
    }

    const dailyLimit = Math.min(DAILY_LISTING_LIMIT_MAX, parseSetting(selection.settings, 'daily_listing_limit', DAILY_LISTING_LIMIT_MAX));
    const extraction = await extractPending(this.env, step, dailyLimit, 30);
    const evaluated = await evaluatePending(this.env, step);
    await step.do('update-stats', async () => {
      await this.env.DB.prepare(`
        UPDATE districts SET listings_count = (
          SELECT COUNT(*) FROM listings WHERE listings.district_slug = districts.slug
        )
      `).run();
      return true;
    });
    await step.do('cleanup-logs', async () => this.env.DB.prepare("DELETE FROM request_logs WHERE created_at < datetime('now', '-48 hours')").run());
    await step.do('log-workflow-summary', async () => logSuccess(this.env, 'system', null,
      `Workflow complete: AI ${extraction.processed}, Jev ${evaluated}, quota locked ${extraction.quota_locked}`));
    return { extracted: extraction.processed, evaluated, quota_locked: extraction.quota_locked };
  }
}