import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { callExtractionModel, classifyExtractionError, hasExtractableText, parseExtractionResult } from './extractor.js';
import { evaluateListing } from './jev.js';
import { extractListingsFromApiResponse, fetchListingsPage } from './scraper.js';
import { refreshNeighborhoodsIfDue } from './neighborhood-discovery.js';
import {
  getSettings, isAiQuotaExhausted, logError, logSuccess,
  ownsWorkflowLease, releaseWorkflowLease, renewWorkflowLease, writeChainState
} from './utils.js';
import {
  DAILY_LISTING_LIMIT_DEFAULT, DAILY_LISTING_LIMIT_MAX, DAILY_LISTING_LIMIT_MIN,
  EXCLUDE_IDS_MAX, EXTRACT_CHUNK, EXTRACT_SLICE, JEV_SLICE, LEASE_STALE_MS, LISTINGS_PER_PAGE,
  SCRAPE_HOODS_PER_INSTANCE, SCRAPE_PAGES_PER_INSTANCE
} from './constants.js';
import { depositEquivalentToman } from './rental-pricing.js';
import { isSharedHousingListing } from './listing-classification.js';
import { aiCallBudgets, listingPagesFor, manualRunOutcome, neighborhoodTarget, tehranClock } from './quota.js';
import { refreshAggregates } from './stats.js';
import { childCreationDecision, childId, classifyBacklog, extractSlice, hopFilled, nextPayload } from './chain.js';

const PAGES_PER_HOOD = Math.max(2, Math.floor(SCRAPE_PAGES_PER_INSTANCE / SCRAPE_HOODS_PER_INSTANCE));

function parsePositiveSetting(settings, key, fallback) {
  const value = Number(settings[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function getUsage(env, date) {
  await env.DB.prepare('INSERT OR IGNORE INTO daily_ai_usage (usage_date) VALUES (?)').bind(date).run();
  return env.DB.prepare('SELECT * FROM daily_ai_usage WHERE usage_date = ?').bind(date).first();
}

// Rows the extract chain can select right now. Recorded once per chain so the closing report can
// tell the pre-existing backlog apart from listings scraped during the same run.
async function countPending(env, source) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM listings WHERE extraction_done = 0 AND scrape_source = ?')
    .bind(source).first();
  return Number(row?.total || 0);
}

// Atomic daily-quota reservation. Increments the real call counter BEFORE the model runs, so every
// dispatched call (including one whose response later proves to be invalid) is counted exactly once
// under the hard daily cap. Returns false when the source share or total cap is exhausted.
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

function isDuplicateInstanceError(error) {
  const message = String(error?.message || error);
  return /already|exists|in use|duplicate|10405/i.test(message);
}

// ---- scrape ----
async function scrapeHoods(env, step, payload) {
  const queue = payload.queue || [];
  const hoods = queue.slice(0, SCRAPE_HOODS_PER_INSTANCE);
  let remaining = payload.scrapeRemaining || 0;
  let inserted = 0;
  let searchedPages = 0;
  let consumed = 0;
  for (let index = 0; index < hoods.length; index += 1) {
    if (remaining <= 0) break;
    if (searchedPages >= SCRAPE_PAGES_PER_INSTANCE) break;
    const hood = hoods[index];
    const target = Math.min(remaining, neighborhoodTarget(hoods, index, remaining));
    const pageCap = Math.min(listingPagesFor(target), PAGES_PER_HOOD, SCRAPE_PAGES_PER_INSTANCE - searchedPages);
    const result = await scrapeOneHood(env, step, hood, target, payload.source, payload.manualRunId || null, pageCap);
    searchedPages += result.pages;
    inserted += result.inserted;
    remaining -= result.inserted;
    consumed += 1;
    if (result.failed) {
      await logError(env, 'scraper', `scrape-${hood.slug}`, 'ادامهٔ دریافت از دیوار ناموفق بود.');
    }
    if (consumed < hoods.length && remaining > 0 && searchedPages < SCRAPE_PAGES_PER_INSTANCE) {
      await step.sleep(`hood-spacing-${hood.slug}`, '1 second');
    }
  }
  const nextQueue = queue.slice(consumed);
  return {
    results: { inserted, processed: consumed, filled: nextQueue.length > 0, queueLength: nextQueue.length },
    patch: {
      queue: nextQueue,
      scrapeRemaining: Math.max(0, remaining),
      scrapedThisRun: Number(payload.scrapedThisRun || 0) + inserted
    }
  };
}

async function scrapeOneHood(env, step, hood, wanted, source, runId, pageCap) {
  const district = /^\d+$/.test(String(hood.divar_id || '')) ? String(hood.divar_id) : hood.slug;
  const maxPages = Math.max(1, pageCap);
  let inserted = 0;
  let pages = 0;
  let failed = false;
  let searched = false;
  for (let pageNumber = 1; pageNumber <= maxPages && inserted < wanted; pageNumber += 1) {
    const response = await step.do(`search-${source}-${hood.slug}-${pageNumber}`, () =>
      fetchListingsPage(env, '1', 'residential-rent', pageNumber, [district]));
    pages += 1;
    if (!response) { failed = true; break; }
    searched = true;
    const candidates = extractListingsFromApiResponse(response);
    if (!candidates.length) break;
    const newListings = candidates.slice(0, wanted - inserted);
    inserted += await step.do(`insert-${source}-${hood.slug}-${pageNumber}`, async () => {
      const statements = newListings.map((listing) => {
        const isSharedHousing = isSharedHousingListing(listing.title, listing.description);
        return env.DB.prepare(`
          INSERT OR IGNORE INTO listings
            (divar_token, url, title, description, image_url, neighborhood_id, scrape_source, extraction_done,
              fake_label, fake_reason, jev_done)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        `).bind(listing.token, `https://divar.ir/v/${encodeURIComponent(listing.token)}`,
          listing.title, listing.description, listing.image_url, hood.id, source,
          isSharedHousing ? 'hamkhane' : 'unknown',
          isSharedHousing ? 'آگهی هم‌خانه است و اجارهٔ مستقل محسوب نمی‌شود.' : null,
          isSharedHousing ? 1 : 0);
      });
      if (!statements.length) return 0;
      const results = await env.DB.batch(statements);
      return results.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0);
    });
    if (inserted < wanted && candidates.length >= LISTINGS_PER_PAGE && pageNumber < maxPages) {
      await step.sleep(`page-spacing-${source}-${hood.slug}-${pageNumber}`, '1 second');
    }
  }
  if (searched) {
    const status = failed ? 'failed' : inserted ? 'scraped' : 'empty';
    const error = failed ? 'ادامهٔ دریافت از دیوار ناموفق بود.' : null;
    await step.do(`finish-scrape-${source}-${hood.slug}`, async () => {
      const statements = [
        env.DB.prepare("UPDATE neighborhoods SET last_scraped_at = datetime('now') WHERE id = ?").bind(hood.id)
      ];
      if (runId) {
        statements.push(env.DB.prepare(`
          UPDATE manual_runs SET fetched_count = ?, status = ?, error = ? WHERE id = ?
        `).bind(inserted, status, error, runId));
      }
      await env.DB.batch(statements);
    });
  }
  return { inserted, pages, failed: failed || !searched };
}

// ---- extract ----
async function extractSliceIds(env, source, neighborhoodId, slice, excludeIds, order) {
  const exclusions = (excludeIds || []).slice(-EXCLUDE_IDS_MAX);
  const rows = await env.DB.prepare(`
    SELECT id, title, description FROM listings
    WHERE extraction_done = 0 AND scrape_source = ?
      AND (? IS NULL OR neighborhood_id = ?)
      ${exclusions.length ? `AND id NOT IN (${exclusions.map(() => '?').join(',')})` : ''}
    ORDER BY scraped_at ${order === 'DESC' ? 'DESC' : 'ASC'} LIMIT ?
  `).bind(source, neighborhoodId, neighborhoodId, ...exclusions, slice).all();
  return rows.results || [];
}

async function runAiStep(env, listing, date, source, dailyLimit, hour) {
  if (!hasExtractableText(listing)) return { id: listing.id, reserved: false, skip: true };
  const reserved = await reserveAiCall(env, date, source, dailyLimit, hour);
  if (!reserved) return { id: listing.id, reserved: false, quotaExhausted: true };
  try {
    const raw = await callExtractionModel(env, listing);
    return { id: listing.id, reserved: true, ok: true, raw };
  } catch (error) {
    return { id: listing.id, reserved: true, ok: false, error: classifyExtractionError(error) };
  }
}

async function commitChunk(env, meta, results) {
  const statements = [];
  const failedIds = [];
  let processed = 0;
  let quotaExhausted = false;
  let subrequest = false;
  for (const result of results) {
    if (result.quotaExhausted) { quotaExhausted = true; continue; }
    if (result.skip) continue;
    if (!result.ok) {
      if (result.error === 'quota_exhausted') { quotaExhausted = true; continue; }
      if (result.error === 'subrequest_limit') { subrequest = true; continue; }
      failedIds.push(result.id);
      continue;
    }
    const data = parseExtractionResult(result.raw);
    if (!data) { failedIds.push(result.id); continue; }
    const listing = meta.get(String(result.id)) || {};
    const isSharedHousing = isSharedHousingListing(listing.title, listing.description, data.property_type);
    statements.push(env.DB.prepare(`
      UPDATE listings SET
        price_toman = COALESCE(?, price_toman), rent_toman = ?, deposit_toman = ?,
        deposit_equivalent_toman = ?, rent_deposit_flexible = ?,
        size_m2 = COALESCE(?, size_m2), rooms = COALESCE(?, rooms),
        extracted_data = ?, extraction_done = 1,
        fake_label = CASE WHEN ? THEN 'hamkhane' ELSE fake_label END,
        fake_reason = CASE WHEN ? THEN 'آگهی هم‌خانه است و اجارهٔ مستقل محسوب نمی‌شود.' ELSE fake_reason END,
        jev_done = CASE WHEN ? THEN 1 ELSE jev_done END,
        updated_at = datetime('now')
      WHERE id = ? AND extraction_done = 0
    `).bind(data.price_toman ?? null, data.rent_toman ?? null, data.deposit_toman ?? null,
      depositEquivalentToman(data), data.rent_deposit_flexible === true ? 1 : 0,
      data.size_m2 ?? null, data.rooms ?? null, JSON.stringify(data),
      isSharedHousing ? 1 : 0, isSharedHousing ? 1 : 0, isSharedHousing ? 1 : 0, result.id));
    processed += 1;
  }
  if (subrequest) {
    statements.push(env.DB.prepare(
      'INSERT INTO request_logs (service, url, status, error, response_snippet) VALUES (?, ?, ?, ?, ?)'
    ).bind('system', 'extract', 0, 'محدودیت ساب‌ریکوئست پلن Free در این instance.', ''));
    await env.DB.batch(statements);
    return { processed, failedIds, quotaExhausted, subrequest };
  }
  if (quotaExhausted) {
    const until = String(Date.now() + 24 * 60 * 60 * 1000);
    statements.push(env.DB.prepare(`
      INSERT INTO system_state (key, value, updated_at) VALUES ('ai_quota_until', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).bind(until));
  }
  statements.push(env.DB.prepare(
    'INSERT INTO request_logs (service, url, status, error, response_snippet) VALUES (?, ?, ?, NULL, ?)'
  ).bind('workers-ai', 'extract-chunk', 200, `Committed chunk: processed=${processed} failed=${failedIds.length}`));
  await env.DB.batch(statements);
  return { processed, failedIds, quotaExhausted, subrequest };
}

async function extractPhase(env, step, payload) {
  const { source, date, dailyLimit, neighborhoodId = null, order = 'ASC' } = payload;
  const usage = await step.do('extract-usage', () => getUsage(env, date));
  const exhausted = await step.do('extract-quota-check', () => isAiQuotaExhausted(env));
  if (exhausted) return { results: { processed: 0, quotaExhausted: true, filled: false }, patch: {} };

  const hour = tehranClock().hour;
  const remaining = source === 'auto'
    ? aiCallBudgets(dailyLimit, usage, hour).auto_remaining
    : dailyLimit - Number(usage.total_calls || 0);
  const slice = extractSlice(remaining, EXTRACT_SLICE);
  if (slice <= 0) return { results: { processed: 0, quotaExhausted: true, filled: false }, patch: {} };

  const excludeIds = payload.failedIds || [];
  const selected = await step.do('extract-select', () => extractSliceIds(env, source, neighborhoodId, slice, excludeIds, order));
  if (!selected.length) return { results: { processed: 0, quotaExhausted: false, filled: false }, patch: {} };

  const meta = new Map(selected.map((listing) => [String(listing.id), { title: listing.title, description: listing.description }]));
  let processed = 0;
  const failedIds = [];
  let quotaExhausted = false;
  let subrequest = false;
  for (let start = 0; start < selected.length; start += EXTRACT_CHUNK) {
    const items = selected.slice(start, start + EXTRACT_CHUNK);
    const aiResults = [];
    for (let offset = 0; offset < items.length; offset += 1) {
      const listing = items[offset];
      aiResults.push(await step.do(`ai-${start + offset}-${listing.id}`, () =>
        runAiStep(env, listing, date, source, dailyLimit, hour)));
      await step.sleep(`ai-pace-${listing.id}`, '500 milliseconds');
    }
    const commit = await step.do(`commit-${start}`, () => commitChunk(env, meta, aiResults));
    processed += commit.processed;
    failedIds.push(...commit.failedIds);
    if (commit.subrequest) { subrequest = true; break; }
    if (commit.quotaExhausted) { quotaExhausted = true; break; }
  }

  const results = {
    processed,
    failedIds,
    quotaExhausted,
    subrequest,
    filled: hopFilled({ processed, selected: selected.length, slice, quotaExhausted, subrequest })
  };
  const patch = { processedThisRun: Number(payload.processedThisRun || 0) + processed };
  if (subrequest) { results.terminal = true; results.abort = true; }
  if (source === 'manual' && payload.manualRunId && quotaExhausted) {
    await step.do('manual-quota-lock', () => markManualQuotaLocked(env, payload.runId, payload.manualRunId));
    results.terminal = true;
  }
  return { results, patch };
}

async function markManualQuotaLocked(env, runId, manualRunId) {
  if (!await ownsWorkflowLease(env, runId)) return;
  await env.DB.prepare(`
    UPDATE manual_runs SET status = 'quota_exhausted', error = ?, finished_at = datetime('now') WHERE id = ?
  `).bind('سهمیهٔ پردازش هوش مصنوعی به پایان رسیده است.', manualRunId).run();
}

// ---- jev ----
async function jevPhase(env, step, payload) {
  const rows = await step.do('jev-select', () => env.DB.prepare(`
    SELECT * FROM listings WHERE extraction_done = 1 AND jev_done = 0 AND fake_label <> 'hamkhane'
    ORDER BY scraped_at ASC LIMIT ?
  `).bind(JEV_SLICE).all());
  const items = rows.results || [];
  let processed = 0;
  const failedIds = [];
  for (const listing of items) {
    const outcome = await step.do(`jev-${listing.id}`, async () => {
      try { return await evaluateListing(env, listing); }
      catch (error) { return { jevError: String(error?.message || error) }; }
    });
    if (outcome && outcome.jevError) failedIds.push(listing.id); else processed += 1;
    await step.sleep(`jev-pace-${listing.id}`, '200 milliseconds');
  }
  if (failedIds.length) {
    await step.do('log-jev-failures', () => logError(env, 'system', `jev-${payload.runId || 'run'}`,
      `${failedIds.length} JEV evaluation(s) failed this slice.`, 0));
  }
  return { results: { processed, failedIds, filled: hopFilled({ processed, selected: items.length, slice: JEV_SLICE }) }, patch: {} };
}

// ---- plan ----
async function planPhase(env, step, payload, settings) {
  const now = tehranClock();
  const dailyLimit = Math.max(DAILY_LISTING_LIMIT_MIN, Math.min(DAILY_LISTING_LIMIT_MAX,
    parsePositiveSetting(settings, 'daily_listing_limit', DAILY_LISTING_LIMIT_DEFAULT)));
  await step.do('refresh-neighborhoods', () => refreshNeighborhoodsIfDue(env));
  const usage = await step.do('plan-usage', () => getUsage(env, now.date));

  if (payload.manualRunId) {
    const run = await step.do('load-manual-run', () => env.DB.prepare(`
      SELECT r.id AS run_id, r.requested_count, r.status, n.id AS neighborhood_id, n.slug, n.name_fa, n.divar_id
      FROM manual_runs r JOIN neighborhoods n ON n.id = r.neighborhood_id WHERE r.id = ?
    `).bind(payload.manualRunId).first());
    if (!run) throw new NonRetryableError(`Manual run ${payload.manualRunId} was not found`);
    const remaining = aiCallBudgets(dailyLimit, usage).manual_remaining;
    if (remaining <= 0) {
      await step.do('mark-manual-quota', () => env.DB.prepare(`
        UPDATE manual_runs SET status = 'quota_exhausted', error = ?, finished_at = datetime('now') WHERE id = ?
      `).bind('سهمیهٔ دریافت دستی امروز تمام شده است. فردا دوباره تلاش کنید.', run.run_id).run());
      return { results: { terminal: true }, patch: {} };
    }
    await step.do('manual-running', () => env.DB.prepare("UPDATE manual_runs SET status = 'running' WHERE id = ?").bind(run.run_id).run());
    const queue = [{ id: run.neighborhood_id, slug: run.slug, divar_id: run.divar_id, recent_count: 0, last_scraped_at: null }];
    const pendingBeforeRun = await step.do('pending-before-run', () => countPending(env, 'manual'));
    return {
      results: { processed: 0 },
      patch: {
        queue, scrapeRemaining: Math.min(Number(run.requested_count), remaining),
        source: 'manual', date: now.date, dailyLimit, neighborhoodId: run.neighborhood_id, order: 'DESC',
        manualRunId: run.run_id, runId: payload.runId,
        pendingBeforeRun, scrapedThisRun: 0, processedThisRun: 0
      }
    };
  }

  const budgets = aiCallBudgets(dailyLimit, usage, now.hour);
  const autoRemaining = budgets.auto_remaining;
  const quotaLocked = await step.do('plan-quota-check', () => isAiQuotaExhausted(env));
  const selected = JSON.parse(settings.auto_neighborhoods || '[]');
  let queue = [];
  if (autoRemaining > 0 && !quotaLocked && selected.length) {
    const result = await step.do('select-neighborhoods', () => env.DB.prepare(`
      SELECT n.id, n.slug, n.name_fa, n.divar_id, n.last_scraped_at,
        COUNT(CASE WHEN l.scraped_at >= datetime('now', '-7 days') THEN 1 END) AS recent_count
      FROM neighborhoods n LEFT JOIN listings l ON l.neighborhood_id = n.id
      WHERE n.city_slug = 'tehran' AND n.is_active = 1 AND n.slug IN (${selected.map(() => '?').join(',')})
      GROUP BY n.id ORDER BY recent_count ASC, n.last_scraped_at ASC
    `).bind(...selected).all());
    queue = (result.results || []).map((row) => ({
      id: row.id, slug: row.slug, divar_id: row.divar_id, recent_count: row.recent_count, last_scraped_at: row.last_scraped_at
    }));
  }
  const pendingBeforeRun = await step.do('pending-before-run', () => countPending(env, 'auto'));
  return {
    results: { processed: 0 },
    patch: {
      queue, scrapeRemaining: autoRemaining, source: 'auto', date: now.date, dailyLimit, runId: payload.runId,
      pendingBeforeRun, scrapedThisRun: 0, processedThisRun: 0
    }
  };
}

// ---- finalize ----
async function finalizePhase(env, step, payload) {
  await step.do('refresh-stats', async () => {
    try {
      const stats = await refreshAggregates(env);
      await logSuccess(env, 'system', null, `Stats refreshed: neighborhoods=${stats.neighborhoods}, days=${stats.days}`, 200);
    } catch (error) {
      await logError(env, 'system', 'refresh-stats', error);
    }
  });
  if (payload.manualRunId) {
    await step.do('manual-finalize', () => finalizeManual(env, payload.runId, payload.manualRunId));
  }
  const backlog = classifyBacklog({
    pendingBeforeRun: payload.pendingBeforeRun,
    scrapedThisRun: payload.scrapedThisRun,
    processed: payload.processedThisRun
  });
  const summary = `Workflow chain complete: source=${payload.source || 'auto'}, run=${payload.runId || 'n/a'}`;
  await step.do('final-summary', () => logSuccess(env, 'system', null, backlog
    ? `${summary} · backlog processed=${backlog.processed}, older remaining=${backlog.backlogOldRemaining}, new remaining=${backlog.newThisRunRemaining}, total remaining=${backlog.remaining}`
    : summary, 200));
  return { results: { terminal: true }, patch: {} };
}

async function finalizeManual(env, runId, manualRunId) {
  if (!await ownsWorkflowLease(env, runId)) return;
  const run = await env.DB.prepare('SELECT requested_count, fetched_count, status FROM manual_runs WHERE id = ?')
    .bind(manualRunId).first();
  if (!run || ['quota_exhausted', 'failed'].includes(run.status)) return;
  const status = manualRunOutcome({
    requested: Number(run.requested_count || 0),
    inserted: Number(run.fetched_count || 0),
    quotaLocked: false
  });
  await env.DB.prepare("UPDATE manual_runs SET status = ?, finished_at = datetime('now') WHERE id = ?")
    .bind(status, manualRunId).run();
}

export class DivarScrapeWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event.payload || {};
    const phase = payload.phase || 'plan';
    const runId = payload.runId;
    let owned = false;
    let results = {};
    let patch = {};
    let failed = false;
    try {
      owned = await step.do('renew-lease', () => renewWorkflowLease(this.env, runId, LEASE_STALE_MS));
      await step.do('chain-state', () => writeChainState(this.env, { runId, phase, seq: payload.seq || 0, instanceId: event.instanceId }));
      if (!owned) {
        results = { terminal: true };
      } else if (phase === 'plan') {
        const settings = await step.do('load-settings', () => getSettings(this.env));
        ({ results, patch } = await planPhase(this.env, step, { ...payload, runId }, settings));
      } else if (phase === 'scrape') {
        ({ results, patch } = await scrapeHoods(this.env, step, payload));
      } else if (phase === 'extract') {
        ({ results, patch } = await extractPhase(this.env, step, payload));
      } else if (phase === 'jev') {
        ({ results, patch } = await jevPhase(this.env, step, payload));
      } else if (phase === 'finalize') {
        ({ results, patch } = await finalizePhase(this.env, step, payload));
      } else {
        results = { terminal: true };
      }
    } catch (error) {
      failed = true;
      if (phase !== 'plan' || payload.manualRunId) {
        await step.do('record-failure', () => logError(this.env, 'system', `chain-${phase}`, error));
      }
      if (payload.manualRunId && phase !== 'finalize') {
        await step.do('manual-failed', () => finalizeManualFailure(this.env, runId, payload.manualRunId, error));
      }
      results = { terminal: true };
      patch = {};
    }

    if (failed || results.terminal || results.abort) {
      if (owned) await step.do('release-lease', () => releaseWorkflowLease(this.env, runId));
      return { phase, failed, ...results };
    }

    const next = nextPayload(payload, results, patch);
    if (!next) {
      if (owned) await step.do('release-lease', () => releaseWorkflowLease(this.env, runId));
      return { phase, ...results };
    }

    const chained = await step.do('chain-next', () => this.linkChild(runId, next));
    if (chained && chained.stopped && owned) {
      await step.do('release-lease', () => releaseWorkflowLease(this.env, runId));
    }
    return { phase, ...results, next: next.phase, chained };
  }

  async linkChild(runId, next) {
    const id = childId(runId, next.phase, next.seq);
    let existing = null;
    try {
      const instance = await this.env.DIVAR_WORKFLOW.get(id);
      existing = (await instance.status()).status;
    } catch {
      existing = null;
    }
    const decision = childCreationDecision(existing);
    if (decision === 'reuse') return { id, reused: true, status: existing };
    if (decision === 'stop') return { id, stopped: true, status: existing };
    try {
      await this.env.DIVAR_WORKFLOW.create({ id, params: next });
      return { id, created: true };
    } catch (error) {
      if (isDuplicateInstanceError(error)) {
        let status = null;
        try { status = (await (await this.env.DIVAR_WORKFLOW.get(id)).status()).status; } catch { status = 'queued'; }
        return { id, reused: true, status };
      }
      throw error;
    }
  }
}

async function finalizeManualFailure(env, runId, manualRunId, error) {
  if (!await ownsWorkflowLease(env, runId)) return;
  await env.DB.prepare(`
    UPDATE manual_runs SET status = 'failed', error = ?, finished_at = datetime('now')
    WHERE id = ? AND status NOT IN ('complete', 'partial', 'empty', 'quota_exhausted')
  `).bind(String(error?.message || error).slice(0, 1000), manualRunId).run();
}
