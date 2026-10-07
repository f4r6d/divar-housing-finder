import { WorkflowEntrypoint } from 'cloudflare:workers';
import { extractListingData } from './extractor.js';
import { evaluateListing } from './jev.js';
import { extractListingsFromApiResponse, fetchListingsPage } from './scraper.js';
import { refreshNeighborhoodsIfDue } from './neighborhood-discovery.js';
import { getSettings, isAiQuotaExhausted, logError, logSuccess } from './utils.js';
import { DAILY_LISTING_LIMIT_DEFAULT, DAILY_LISTING_LIMIT_MAX, DAILY_LISTING_LIMIT_MIN } from './constants.js';
import { depositEquivalentToman } from './rental-pricing.js';
import { isSharedHousingListing } from './listing-classification.js';
import { aiCallBudgets, neighborhoodTarget, tehranClock } from './quota.js';

function parsePositiveSetting(settings, key, fallback) {
  const value = Number(settings[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function getUsage(env, date) {
  await env.DB.prepare('INSERT OR IGNORE INTO daily_ai_usage (usage_date) VALUES (?)').bind(date).run();
  return env.DB.prepare('SELECT * FROM daily_ai_usage WHERE usage_date = ?').bind(date).first();
}

async function reserveAiCall(env, date, source, dailyLimit, hour) {
  const { auto_limit: automaticShare, manual_limit: manualShare } = aiCallBudgets(dailyLimit);
  const row = await env.DB.prepare(`
    UPDATE daily_ai_usage
    SET total_calls = total_calls + 1,
        auto_calls = auto_calls + CASE WHEN ? = 'auto' THEN 1 ELSE 0 END,
        manual_calls = manual_calls + CASE WHEN ? = 'manual' THEN 1 ELSE 0 END,
        updated_at = datetime('now')
    WHERE usage_date = ?
      AND total_calls < ?
      AND ((? = 'auto' AND auto_calls < CASE
        WHEN ? >= 22 AND manual_searches = 0 THEN ? ELSE ? END)
        OR (? = 'manual' AND manual_calls < ?))
    RETURNING total_calls
  `).bind(source, source, date, dailyLimit, source, hour, dailyLimit,
    automaticShare, source, manualShare).first();
  return Boolean(row);
}

async function scrapeNeighborhood(env, step, neighborhood, wanted, source, runId = null) {
  let inserted = 0;
  let fetched = 0;
  let searched = false;
  let failed = false;
  const maxPages = source === 'auto' ? 3 : Math.max(3, Math.ceil(wanted / 30) * 3);
  for (let pageNumber = 1; pageNumber <= maxPages && inserted < wanted; pageNumber += 1) {
    const response = await step.do(`search-${source}-${neighborhood.slug}-${pageNumber}`, () =>
      fetchListingsPage(env, '1', 'residential-rent', pageNumber, [neighborhood.slug]));
    if (!response) {
      failed = true;
      break;
    }
    searched = true;

    const candidates = extractListingsFromApiResponse(response);
    if (!candidates.length) break;
    fetched += candidates.length;
    const newListings = candidates.slice(0, wanted - inserted);
    for (const listing of newListings) {
      const isSharedHousing = isSharedHousingListing(listing.title, listing.description);
      const result = await env.DB.prepare(`
        INSERT OR IGNORE INTO listings
          (divar_token, url, title, description, image_url, neighborhood_id, scrape_source, extraction_done,
            fake_label, fake_reason, jev_done)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).bind(listing.token, `https://divar.ir/v/${encodeURIComponent(listing.token)}`,
        listing.title, listing.description, listing.image_url, neighborhood.id, source,
        isSharedHousing ? 'hamkhane' : 'unknown',
        isSharedHousing ? 'آگهی هم‌خانه است و اجارهٔ مستقل محسوب نمی‌شود.' : null,
        isSharedHousing ? 1 : 0).run();
      inserted += Number(result.meta?.changes || 0);
    }
    if (inserted < wanted && candidates.length >= 30) {
      await step.sleep(`page-spacing-${source}-${neighborhood.slug}-${pageNumber}`, '1 second');
    } else {
      break;
    }
  }

  if (searched) {
    await env.DB.prepare("UPDATE neighborhoods SET last_scraped_at = datetime('now') WHERE id = ?")
      .bind(neighborhood.id).run();
  }
  if (runId && searched) {
    await env.DB.prepare(`
      UPDATE manual_runs SET fetched_count = ?, status = ?, error = ?, finished_at = datetime('now') WHERE id = ?
    `).bind(inserted, failed ? 'failed' : inserted ? 'scraped' : 'complete',
      failed ? 'ادامهٔ دریافت از دیوار ناموفق بود.' : null, runId).run();
  }
  return { inserted, fetched, failed: failed || !searched };
}

async function extractPending(env, step, source, date, dailyLimit, maximum = DAILY_LISTING_LIMIT_MAX, neighborhoodId = null) {
  if (await isAiQuotaExhausted(env)) return { processed: 0, quota_locked: true };
  const usage = await getUsage(env, date);
  const { hour } = tehranClock();
  const sourceLimit = source === 'auto'
    ? aiCallBudgets(dailyLimit, usage, hour).auto_remaining
    : dailyLimit - Number(usage.total_calls || 0);
  if (sourceLimit <= 0) return { processed: 0, quota_locked: false };

  const rows = await step.do(`pending-${source}-${date}`, () => env.DB.prepare(`
    SELECT * FROM listings
    WHERE extraction_done = 0 AND scrape_source = ?
      AND (? IS NULL OR neighborhood_id = ?)
    ORDER BY scraped_at ASC LIMIT ?
  `).bind(source, neighborhoodId, neighborhoodId, Math.min(maximum, sourceLimit)).all());

  let processed = 0;
  let quotaLocked = false;
  for (const listing of rows.results || []) {
    const result = await step.do(`extract-${source}-${listing.id}`, async () => {
      if (!await reserveAiCall(env, date, source, dailyLimit, hour)) return { quota_locked: true };
      const data = await extractListingData(env, listing);
      if (!data) {
        await env.DB.prepare("UPDATE listings SET extraction_done = -1, updated_at = datetime('now') WHERE id = ?")
          .bind(listing.id).run();
        return { failed: true };
      }
      const isSharedHousing = isSharedHousingListing(listing.title, listing.description, data.property_type);
      await env.DB.prepare(`
        UPDATE listings SET
          price_toman = COALESCE(?, price_toman), rent_toman = ?, deposit_toman = ?,
          deposit_equivalent_toman = ?, rent_deposit_flexible = ?,
          size_m2 = COALESCE(?, size_m2), rooms = COALESCE(?, rooms),
          extracted_data = ?, extraction_done = 1,
          fake_label = CASE WHEN ? THEN 'hamkhane' ELSE fake_label END,
          fake_reason = CASE WHEN ? THEN 'آگهی هم‌خانه است و اجارهٔ مستقل محسوب نمی‌شود.' ELSE fake_reason END,
          jev_done = CASE WHEN ? THEN 1 ELSE jev_done END,
          updated_at = datetime('now')
        WHERE id = ?
      `).bind(data.price_toman ?? null, data.rent_toman ?? null, data.deposit_toman ?? null,
        depositEquivalentToman(data), data.rent_deposit_flexible === true ? 1 : 0,
        data.size_m2 ?? null, data.rooms ?? null, JSON.stringify(data),
        isSharedHousing ? 1 : 0, isSharedHousing ? 1 : 0, isSharedHousing ? 1 : 0, listing.id).run();
      return { failed: false };
    });
    if (result.quota_locked) {
      quotaLocked = true;
      break;
    }
    processed += 1;
    if (result.failed && await isAiQuotaExhausted(env)) {
      quotaLocked = true;
      break;
    }
    await step.sleep(`extract-spacing-${source}-${listing.id}`, '500 milliseconds');
  }
  return { processed, quota_locked: quotaLocked };
}

async function evaluatePending(env, step) {
  const rows = await step.do('jev-pending', () => env.DB.prepare(`
    SELECT * FROM listings WHERE extraction_done = 1 AND jev_done = 0 AND fake_label <> 'hamkhane'
    ORDER BY scraped_at DESC LIMIT 50
  `).all());
  for (const listing of rows.results || []) {
    await step.do(`jev-${listing.id}`, () => evaluateListing(env, listing));
    await step.sleep(`jev-spacing-${listing.id}`, '200 milliseconds');
  }
  return rows.results?.length || 0;
}

export class DivarScrapeWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event.payload || {};
    const now = tehranClock();
    try {
      const settings = await step.do('load-settings', () => getSettings(this.env));
      const dailyLimit = Math.max(DAILY_LISTING_LIMIT_MIN, Math.min(DAILY_LISTING_LIMIT_MAX,
        parsePositiveSetting(settings, 'daily_listing_limit', DAILY_LISTING_LIMIT_DEFAULT)));

      await step.do('refresh-neighborhoods', () => refreshNeighborhoodsIfDue(this.env));

      let source = payload.source === 'dashboard-refresh' ? 'auto' : 'auto';
      if (payload.manualRunId) {
        source = 'manual';
        const run = await step.do('load-manual-run', () => this.env.DB.prepare(`
          SELECT r.id AS run_id, r.requested_count, r.status, n.id AS neighborhood_id, n.slug, n.name_fa
          FROM manual_runs r JOIN neighborhoods n ON n.id = r.neighborhood_id
          WHERE r.id = ?
        `).bind(payload.manualRunId).first());
        if (!run) throw new Error(`Manual run ${payload.manualRunId} was not found`);

        await this.env.DB.prepare("UPDATE manual_runs SET status = 'running' WHERE id = ?")
          .bind(run.run_id).run();
        try {
          const usage = await getUsage(this.env, now.date);
          const remaining = aiCallBudgets(dailyLimit, usage).manual_remaining;
          const target = Math.min(Number(run.requested_count), remaining);
          const scraped = target > 0
            ? await scrapeNeighborhood(this.env, step, {
              id: run.neighborhood_id, slug: run.slug, name_fa: run.name_fa
            }, target, 'manual', run.run_id)
            : { failed: false };
          if (scraped.failed) throw new Error('دریافت آگهی از دیوار ناموفق بود.');
          else await this.env.DB.prepare("UPDATE manual_runs SET status = 'complete', finished_at = datetime('now') WHERE id = ?")
            .bind(run.run_id).run();
          const extracted = await extractPending(this.env, step, 'manual', now.date, dailyLimit, target || 1, run.neighborhood_id);
          if (extracted.quota_locked) await logError(this.env, 'workers-ai', null, 'سهمیهٔ پردازش هوش مصنوعی به پایان رسیده است.');
          await this.env.DB.prepare(`
            UPDATE manual_runs SET status = ?, finished_at = datetime('now') WHERE id = ?
          `).bind(extracted.quota_locked ? 'quota_exhausted' : 'complete', run.run_id).run();
        } catch (error) {
          await this.env.DB.prepare(`
            UPDATE manual_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?
          `).bind(String(error?.message || error).slice(0, 1000), run.run_id).run();
          throw error;
        }
      } else {
        const usage = await getUsage(this.env, now.date);
        const autoRemaining = aiCallBudgets(dailyLimit, usage, now.hour).auto_remaining;
        if (autoRemaining > 0 && !(await isAiQuotaExhausted(this.env))) {
          const selected = JSON.parse(settings.auto_neighborhoods || '[]');
          const neighborhoodsResult = selected.length ? await step.do('select-neighborhoods', () =>
            this.env.DB.prepare(`
              SELECT n.id, n.slug, n.name_fa, COUNT(CASE WHEN l.scraped_at >= datetime('now', '-7 days') THEN 1 END) AS recent_count
              FROM neighborhoods n LEFT JOIN listings l ON l.neighborhood_id = n.id
              WHERE n.city_slug = 'tehran' AND n.is_active = 1 AND n.slug IN (${selected.map(() => '?').join(',')})
              GROUP BY n.id ORDER BY recent_count ASC, n.last_scraped_at ASC
            `).bind(...selected).all()) : { results: [] };

          let scrapeRemaining = autoRemaining;
          const neighborhoods = neighborhoodsResult.results || [];
          for (let index = 0; index < neighborhoods.length; index += 1) {
            const neighborhood = neighborhoods[index];
            if (scrapeRemaining <= 0) break;
            const perNeighborhood = neighborhoodTarget(neighborhoods, index, scrapeRemaining);
            const result = await scrapeNeighborhood(this.env, step, neighborhood, perNeighborhood, 'auto');
            scrapeRemaining -= result.inserted;
            await step.sleep(`neighborhood-spacing-${neighborhood.slug}`, '1 second');
          }

          const extraction = await extractPending(this.env, step, 'auto', now.date, dailyLimit);
          if (extraction.quota_locked) await logError(this.env, 'workers-ai', null, 'سهمیهٔ پردازش هوش مصنوعی به پایان رسیده است.');
        }
      }

      const evaluated = await evaluatePending(this.env, step);
      await step.do('workflow-summary', () => logSuccess(this.env, 'system', null,
        `Workflow complete: source=${source}, evaluated=${evaluated}`, 200));
      return { source, evaluated };
    } finally {
      await this.env.DB.prepare(`
        INSERT INTO system_state (key, value, updated_at) VALUES ('workflow_running', '0', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
      `).run();
    }
  }
}
