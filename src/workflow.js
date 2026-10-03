import { WorkflowEntrypoint } from 'cloudflare:workers';
import { extractListingData } from './extractor.js';
import { evaluateListing } from './jev.js';
import { extractTokensFromApiResponse, fetchListingsPage } from './scraper.js';
import { getSettings, isAiQuotaExhausted, logError, logSuccess } from './utils.js';

const DIVAR_DISTRICT_IDS = ['992'];

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

async function scrapeDistrict(env, districtId, dailyRemaining) {
  const page = await fetchListingsPage(env, '1', 'residential-rent', 1, [districtId]);
  if (!page) return { district_id: districtId, inserted: 0 };
  const candidates = extractTokensFromApiResponse(page);
  if (candidates.length === 0 || dailyRemaining <= 0) return { district_id: districtId, inserted: 0 };

  const maxPerDistrict = Math.min(2, dailyRemaining);
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
        (divar_token, url, title, description, image_url, extraction_done)
      VALUES (?, ?, ?, ?, ?, 0)
    `).bind(listing.token, `https://divar.ir/v/${encodeURIComponent(listing.token)}`,
      listing.title, listing.description, listing.image_url).run();
    if (Number(write.meta?.changes || 0) > 0) inserted += 1;
  }
  return { district_id: districtId, found: candidates.length, inserted };
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
          size_m2 = COALESCE(?, size_m2), rooms = COALESCE(?, rooms),
          description = COALESCE(NULLIF(?, ''), description), extracted_data = ?,
          extraction_done = 1, updated_at = datetime('now')
        WHERE id = ?
      `).bind(data.price_toman ?? null, data.rent_toman ?? null, data.deposit_toman ?? null,
        data.size_m2 ?? null, data.rooms ?? null, data.description || '', JSON.stringify(data), listing.id).run();
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
      return { settings: await getSettings(this.env), districts: DIVAR_DISTRICT_IDS, retry: false };
    });

    if (!selection.retry) {
      const dailyLimit = Math.min(30, parseSetting(selection.settings, 'daily_listing_limit', 30));
      const dailyCount = await step.do('count-todays-scrapes', async () => this.env.DB.prepare("SELECT COUNT(*) AS count FROM listings WHERE date(scraped_at) = date('now')").first());
      let remaining = Math.max(0, dailyLimit - Number(dailyCount?.count || 0));
      for (let index = 0; index < selection.districts.length && remaining > 0; index += 1) {
        const districtId = selection.districts[index];
        const result = await step.do(`scrape-district-${districtId}`, async () => scrapeDistrict(this.env, districtId, remaining));
        remaining -= result.inserted;
        if (index < selection.districts.length - 1) await step.sleep(`rate-limit-${districtId}`, '2 seconds');
      }
    }

    const dailyLimit = Math.min(30, parseSetting(selection.settings, 'daily_listing_limit', 30));
    const extraction = await extractPending(this.env, step, dailyLimit, 10);
    const evaluated = await evaluatePending(this.env, step);
    await step.do('update-stats', async () => {
      const result = await this.env.DB.prepare(`
        SELECT d.id, d.name_fa, COUNT(l.id) AS total,
          AVG(CASE WHEN l.price_toman > 0 THEN l.price_toman END) AS avg_price,
          COALESCE(100.0 * SUM(CASE WHEN l.fake_label = 'fake' THEN 1 ELSE 0 END) / NULLIF(COUNT(l.id), 0), 0) AS fake_percent
        FROM districts d LEFT JOIN listings l ON l.district_id = d.id
        GROUP BY d.id ORDER BY d.id
      `).all();
      await this.env.DB.prepare(`
        INSERT INTO system_state (key, value, updated_at) VALUES ('district_aggregates', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
      `).bind(JSON.stringify(result.results || [])).run();
      return result.results || [];
    });
    await step.do('cleanup-logs', async () => this.env.DB.prepare("DELETE FROM request_logs WHERE created_at < datetime('now', '-48 hours')").run());
    await step.do('log-workflow-summary', async () => logSuccess(this.env, 'system', null,
      `Workflow complete: AI ${extraction.processed}, Jev ${evaluated}, quota locked ${extraction.quota_locked}`));
    return { extracted: extraction.processed, evaluated, quota_locked: extraction.quota_locked };
  }
}