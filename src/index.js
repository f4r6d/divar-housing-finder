import { DivarScrapeWorkflow } from './workflow.js';
import { dashboardHtml } from './dashboard.js';
import { refreshNeighborhoodsIfDue } from './neighborhood-discovery.js';
import { getSettings, json, logError } from './utils.js';
import { DAILY_LISTING_LIMIT_MAX, DAILY_LISTING_LIMIT_MIN } from './constants.js';
import { aiCallBudgets, tehranClock } from './quota.js';

export { DivarScrapeWorkflow };

const LABELS = new Set(['real', 'suspicious', 'fake']);
const SERVICES = new Set(['scraper', 'neighborhood-discovery', 'workers-ai', 'jev', 'system']);
const SORT_COLUMNS = new Map([
  ['name', 'n.name_fa'],
  ['count', 'COALESCE(c.count, 0)'],
  ['avg_deposit', 'COALESCE(ps.avg_deposit, 0)'],
  ['median_deposit', 'COALESCE(dm.median_deposit, 0)'],
  ['median_deposit_per_sqm', 'COALESCE(sm.median_deposit_per_sqm, 0)'],
  ['fake_count', 'COALESCE(c.fake_count, 0)'],
  ['last_scraped_at', 'n.last_scraped_at']
]);

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function startWorkflow(env, params = {}) {
  if (!env.DIVAR_WORKFLOW) throw new Error('Workflow binding is not configured');
  const id = `divar-${Date.now()}-${crypto.randomUUID()}`;
  return env.DIVAR_WORKFLOW.create({ id, params });
}

function positiveInteger(value, fallback, maximum) {
  const number = Number.parseInt(value || '', 10);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function safeDays(value) {
  return positiveInteger(value, 30, 90);
}

async function loadNeighborhoodStats(env, { days = 30, search = '', page = 1, pageSize = 20, sort = 'count', order = 'desc', all = false } = {}) {
  const sortColumn = SORT_COLUMNS.get(sort) || SORT_COLUMNS.get('count');
  const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
  const offset = (page - 1) * pageSize;
  const filter = search ? 'WHERE n.is_active = 1 AND n.name_fa LIKE ?' : 'WHERE n.is_active = 1';
  const bindFilter = search ? [`%${search}%`] : [];
  const query = `
    WITH recent AS (
      SELECT * FROM listings WHERE scraped_at >= datetime('now', '-${days} days')
    ),
    deposits AS (
      SELECT neighborhood_id, deposit_toman,
        ROW_NUMBER() OVER (PARTITION BY neighborhood_id ORDER BY deposit_toman) AS row_number,
        COUNT(*) OVER (PARTITION BY neighborhood_id) AS row_count
      FROM recent WHERE deposit_toman > 0
    ),
    deposit_medians AS (
      SELECT neighborhood_id, AVG(deposit_toman) AS median_deposit FROM deposits
      WHERE row_number IN ((row_count + 1) / 2, (row_count + 2) / 2)
      GROUP BY neighborhood_id
    ),
    rents AS (
      SELECT neighborhood_id, rent_toman,
        ROW_NUMBER() OVER (PARTITION BY neighborhood_id ORDER BY rent_toman) AS row_number,
        COUNT(*) OVER (PARTITION BY neighborhood_id) AS row_count
      FROM recent WHERE rent_toman > 0
    ),
    rent_medians AS (
      SELECT neighborhood_id, AVG(rent_toman) AS median_rent FROM rents
      WHERE row_number IN ((row_count + 1) / 2, (row_count + 2) / 2)
      GROUP BY neighborhood_id
    ),
    deposit_per_sqm AS (
      SELECT neighborhood_id, deposit_toman * 1.0 / size_m2 AS value,
        ROW_NUMBER() OVER (PARTITION BY neighborhood_id ORDER BY deposit_toman * 1.0 / size_m2) AS row_number,
        COUNT(*) OVER (PARTITION BY neighborhood_id) AS row_count
      FROM recent WHERE deposit_toman > 0 AND size_m2 > 0
    ),
    deposit_per_sqm_medians AS (
      SELECT neighborhood_id, AVG(value) AS median_deposit_per_sqm FROM deposit_per_sqm
      WHERE row_number IN ((row_count + 1) / 2, (row_count + 2) / 2)
      GROUP BY neighborhood_id
    ),
    counts AS (
      SELECT neighborhood_id, COUNT(*) AS count,
        SUM(CASE WHEN fake_label = 'fake' THEN 1 ELSE 0 END) AS fake_count,
        SUM(CASE WHEN fake_label = 'suspicious' THEN 1 ELSE 0 END) AS suspicious_count
      FROM recent GROUP BY neighborhood_id
    ),
    price_stats AS (
      SELECT neighborhood_id, AVG(deposit_toman) AS avg_deposit, AVG(rent_toman) AS avg_rent,
        AVG(CASE WHEN deposit_toman > 0 AND size_m2 > 0 THEN deposit_toman * 1.0 / size_m2 END) AS avg_deposit_per_sqm
      FROM recent GROUP BY neighborhood_id
    )
    SELECT n.id, n.slug, n.name_fa, n.last_scraped_at,
      COALESCE(c.count, 0) AS count,
      COALESCE(c.fake_count, 0) AS fake_count,
      COALESCE(c.suspicious_count, 0) AS suspicious_count,
      ps.avg_deposit, ps.avg_rent, ps.avg_deposit_per_sqm,
      sm.median_deposit_per_sqm,
      dm.median_deposit, rm.median_rent
    FROM neighborhoods n
    LEFT JOIN counts c ON c.neighborhood_id = n.id
    LEFT JOIN deposit_medians dm ON dm.neighborhood_id = n.id
    LEFT JOIN rent_medians rm ON rm.neighborhood_id = n.id
    LEFT JOIN price_stats ps ON ps.neighborhood_id = n.id
    LEFT JOIN deposit_per_sqm_medians sm ON sm.neighborhood_id = n.id
    ${filter}
    ORDER BY ${sortColumn} ${sortOrder}, n.name_fa ASC
    ${all ? '' : 'LIMIT ? OFFSET ?'}
  `;
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM neighborhoods n ${filter}`)
    .bind(...bindFilter).first();
  const statement = env.DB.prepare(query);
  const result = all
    ? await statement.bind(...bindFilter).all()
    : await statement.bind(...bindFilter, pageSize, offset).all();
  return { neighborhoods: result.results || [], total: Number(countRow?.total || 0) };
}

async function getSummary(env, days, neighborhoodSlug = '') {
  const filter = neighborhoodSlug ? 'AND n.slug = ?' : '';
  const binds = neighborhoodSlug ? [neighborhoodSlug] : [];
  const aggregate = await env.DB.prepare(`
    SELECT COUNT(*) AS count,
      SUM(CASE WHEN l.fake_label = 'fake' THEN 1 ELSE 0 END) AS fake_count,
      SUM(CASE WHEN l.fake_label = 'suspicious' THEN 1 ELSE 0 END) AS suspicious_count,
      SUM(CASE WHEN l.extraction_done = 0 THEN 1 ELSE 0 END) AS pending
    FROM listings l JOIN neighborhoods n ON n.id = l.neighborhood_id
    WHERE l.scraped_at >= datetime('now', '-${days} days') ${filter}
  `).bind(...binds).first();
  const prices = await env.DB.prepare(`
    SELECT l.deposit_toman, l.rent_toman, l.size_m2
    FROM listings l JOIN neighborhoods n ON n.id = l.neighborhood_id
    WHERE l.scraped_at >= datetime('now', '-${days} days') ${filter}
  `).bind(...binds).all();
  const rows = prices.results || [];
  return {
    ...aggregate,
    count: Number(aggregate?.count || 0),
    fake_count: Number(aggregate?.fake_count || 0),
    suspicious_count: Number(aggregate?.suspicious_count || 0),
    pending: Number(aggregate?.pending || 0),
    average_deposit: average(rows.map((row) => Number(row.deposit_toman))),
    average_rent: average(rows.map((row) => Number(row.rent_toman))),
    average_deposit_per_sqm: average(rows.map((row) =>
      Number(row.deposit_toman) > 0 && Number(row.size_m2) > 0
        ? Number(row.deposit_toman) / Number(row.size_m2)
        : NaN)),
    median_deposit: median(rows.map((row) => Number(row.deposit_toman))),
    median_deposit_per_sqm: median(rows.map((row) =>
      Number(row.deposit_toman) > 0 && Number(row.size_m2) > 0
        ? Number(row.deposit_toman) / Number(row.size_m2)
        : NaN)),
    median_rent: median(rows.map((row) => Number(row.rent_toman)))
  };
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

async function getDailyTrend(env, days, neighborhoodSlug = '') {
  const filter = neighborhoodSlug ? 'AND n.slug = ?' : '';
  const binds = neighborhoodSlug ? [neighborhoodSlug] : [];
  const result = await env.DB.prepare(`
    SELECT date(l.scraped_at) AS day, l.deposit_toman
    FROM listings l JOIN neighborhoods n ON n.id = l.neighborhood_id
    WHERE l.scraped_at >= datetime('now', '-${days} days') ${filter}
    ORDER BY day
  `).bind(...binds).all();
  const byDay = new Map();
  for (const row of result.results || []) {
    if (!byDay.has(row.day)) byDay.set(row.day, []);
    if (Number(row.deposit_toman) > 0) byDay.get(row.day).push(Number(row.deposit_toman));
  }
  return [...byDay].map(([day, deposits]) => ({ day, median_deposit: median(deposits) }));
}

async function getQuota(env) {
  const settings = await getSettings(env);
  const limit = Math.max(DAILY_LISTING_LIMIT_MIN,
    Math.min(DAILY_LISTING_LIMIT_MAX, positiveInteger(settings.daily_listing_limit, 100, DAILY_LISTING_LIMIT_MAX)));
  const { date, hour } = tehranClock();
  await env.DB.prepare('INSERT OR IGNORE INTO daily_ai_usage (usage_date) VALUES (?)').bind(date).run();
  const usage = await env.DB.prepare('SELECT * FROM daily_ai_usage WHERE usage_date = ?').bind(date).first();
  const budgets = aiCallBudgets(limit, usage, hour);
  return {
    date,
    limit,
    used: Number(usage.total_calls || 0),
    auto_used: Number(usage.auto_calls || 0),
    manual_used: Number(usage.manual_calls || 0),
    auto_limit: budgets.auto_limit,
    manual_limit: budgets.manual_limit,
    manual_remaining: budgets.manual_remaining,
    remaining: budgets.remaining,
    manual_searches: Number(usage.manual_searches || 0),
    quota_exhausted: await env.DB.prepare("SELECT value FROM system_state WHERE key = 'ai_quota_until'").first()
      .then((row) => Number(row?.value || 0) > Date.now())
  };
}

async function getSettingsPayload(env) {
  const settings = await getSettings(env);
  return {
    fake_threshold: Number(settings.fake_threshold || 0.6),
    high_fake_threshold: Number(settings.high_fake_threshold || 0.8),
    daily_listing_limit: Math.max(DAILY_LISTING_LIMIT_MIN,
      positiveInteger(settings.daily_listing_limit, 100, DAILY_LISTING_LIMIT_MAX)),
    auto_neighborhoods: parseJson(settings.auto_neighborhoods, []),
    bait_keywords: parseJson(settings.bait_keywords, [])
  };
}

async function apiRoute(request, env, url) {
  const { pathname } = url;

  if (pathname === '/api/neighborhoods' && request.method === 'GET') {
    await refreshNeighborhoodsIfDue(env);
    const page = positiveInteger(url.searchParams.get('page'), 1, 100000);
    const pageSize = positiveInteger(url.searchParams.get('page_size'), 20, 100);
    const days = safeDays(url.searchParams.get('days'));
    const { neighborhoods, total } = await loadNeighborhoodStats(env, {
      days,
      search: String(url.searchParams.get('search') || '').trim().slice(0, 100),
      page,
      pageSize,
      sort: url.searchParams.get('sort') || 'count',
      order: url.searchParams.get('order') || 'desc',
      all: url.searchParams.get('all') === '1'
    });
    return json({ neighborhoods, page, page_size: pageSize, total, pages: Math.ceil(total / pageSize) });
  }

  if (pathname === '/api/analytics' && request.method === 'GET') {
    const days = safeDays(url.searchParams.get('days'));
    const neighborhoodSlug = String(url.searchParams.get('neighborhood') || '').slice(0, 100);
    const neighborhood = neighborhoodSlug
      ? await env.DB.prepare('SELECT slug, name_fa FROM neighborhoods WHERE slug = ? AND is_active = 1').bind(neighborhoodSlug).first()
      : null;
    if (neighborhoodSlug && !neighborhood) return json({ error: 'محله پیدا نشد.' }, 404);
    const top = await loadNeighborhoodStats(env, { days, page: 1, pageSize: 5, sort: 'count', order: 'desc' });
    const [overall, selected, daily] = await Promise.all([
      getSummary(env, days),
      neighborhood ? getSummary(env, days, neighborhood.slug) : getSummary(env, days),
      getDailyTrend(env, days, neighborhood?.slug || '')
    ]);
    return json({
      days,
      overall,
      selected: { ...selected, name_fa: neighborhood?.name_fa || 'همهٔ محله‌ها' },
      top_neighborhoods: top.neighborhoods.filter((item) => Number(item.count) > 0),
      daily
    });
  }

  if (pathname === '/api/stats' && request.method === 'GET') {
    return json(await getSummary(env, 30));
  }

  if (pathname === '/api/listings' && request.method === 'GET') {
    const page = positiveInteger(url.searchParams.get('page'), 1, 100000);
    const pageSize = positiveInteger(url.searchParams.get('page_size'), 20, 50);
    const clauses = [];
    const values = [];
    const search = String(url.searchParams.get('search') || '').trim().slice(0, 200);
    const neighborhood = String(url.searchParams.get('neighborhood') || '').trim();
    const label = url.searchParams.get('label');
    if (search) {
      clauses.push('(l.title LIKE ? OR l.description LIKE ?)');
      values.push(`%${search}%`, `%${search}%`);
    }
    if (neighborhood) {
      clauses.push('n.slug = ?');
      values.push(neighborhood);
    }
    if (label === 'pending') clauses.push('l.extraction_done = 0');
    else if (LABELS.has(label)) {
      clauses.push('l.fake_label = ?');
      values.push(label);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS total FROM listings l JOIN neighborhoods n ON n.id = l.neighborhood_id ${where}
    `).bind(...values).first();
    const result = await env.DB.prepare(`
      SELECT l.id, l.divar_token, l.url, l.title, l.price_toman, l.rent_toman, l.deposit_toman,
        l.deposit_equivalent_toman, l.rent_deposit_flexible, l.size_m2, l.rooms,
        l.description, l.image_url, l.extracted_data, l.fake_label, l.fake_score, l.fake_reason,
        l.extraction_done, l.scraped_at, n.slug AS neighborhood_slug, n.name_fa AS neighborhood_name
      FROM listings l JOIN neighborhoods n ON n.id = l.neighborhood_id
      ${where} ORDER BY l.scraped_at DESC LIMIT ? OFFSET ?
    `).bind(...values, pageSize, (page - 1) * pageSize).all();
    const listings = (result.results || []).map((listing) => ({
      ...listing,
      extracted_data: parseJson(listing.extracted_data, {})
    }));
    const total = Number(count?.total || 0);
    return json({ listings, page, page_size: pageSize, total, pages: Math.ceil(total / pageSize) });
  }

  if (pathname === '/api/quota' && request.method === 'GET') {
    return json(await getQuota(env));
  }

  if (pathname === '/api/refresh' && request.method === 'POST') {
    await startWorkflow(env, { source: 'dashboard-refresh' });
    return json({ ok: true, queued: true }, 202);
  }

  if (pathname === '/api/manual-runs' && request.method === 'POST') {
    let input;
    try { input = await request.json(); } catch { return json({ error: 'درخواست معتبر نیست.' }, 400); }
    const slug = String(input.neighborhood || '');
    const count = Number(input.count);
    if (!Number.isInteger(count) || count < 1 || count > DAILY_LISTING_LIMIT_MAX) {
      return json({ error: 'تعداد آگهی باید بین ۱ تا ۱۰۰ باشد.' }, 400);
    }
    const neighborhood = await env.DB.prepare(
      'SELECT id FROM neighborhoods WHERE slug = ? AND is_active = 1'
    ).bind(slug).first();
    if (!neighborhood) return json({ error: 'محله پیدا نشد.' }, 404);
    const id = crypto.randomUUID();
    const { date } = tehranClock();
    await env.DB.prepare('INSERT OR IGNORE INTO daily_ai_usage (usage_date) VALUES (?)').bind(date).run();
    await env.DB.batch([
      env.DB.prepare("UPDATE daily_ai_usage SET manual_searches = manual_searches + 1, updated_at = datetime('now') WHERE usage_date = ?")
        .bind(date),
      env.DB.prepare('INSERT INTO manual_runs (id, neighborhood_id, requested_count) VALUES (?, ?, ?)')
        .bind(id, neighborhood.id, count)
    ]);
    try {
      await startWorkflow(env, { manualRunId: id });
    } catch (error) {
      await env.DB.prepare("UPDATE manual_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?")
        .bind(String(error?.message || error).slice(0, 1000), id).run();
      throw error;
    }
    return json({ id, status: 'queued' }, 202);
  }

  const manualRunMatch = pathname.match(/^\/api\/manual-runs\/([a-f0-9-]{36})$/i);
  if (manualRunMatch && request.method === 'GET') {
    const run = await env.DB.prepare(`
      SELECT r.id, r.requested_count, r.fetched_count, r.status, r.error, r.started_at, r.finished_at,
        n.name_fa AS neighborhood_name
      FROM manual_runs r JOIN neighborhoods n ON n.id = r.neighborhood_id WHERE r.id = ?
    `).bind(manualRunMatch[1]).first();
    if (!run) return json({ error: 'درخواست پیدا نشد.' }, 404);
    const statusLabels = {
      queued: 'در صف', running: 'در حال اجرا', scraped: 'در حال تحلیل',
      complete: 'کامل', failed: 'ناموفق', quota_exhausted: 'سهمیهٔ هوش مصنوعی تمام شد'
    };
    return json({ ...run, status_fa: statusLabels[run.status] || run.status });
  }

  if (pathname === '/api/settings' && request.method === 'GET') {
    return json(await getSettingsPayload(env));
  }

  if (pathname === '/api/settings' && request.method === 'POST') {
    let input;
    try { input = await request.json(); } catch { return json({ error: 'درخواست معتبر نیست.' }, 400); }
    const dailyLimit = Number(input.daily_listing_limit);
    const fakeThreshold = Number(input.fake_threshold);
    const highThreshold = Number(input.high_fake_threshold);
    const selected = input.auto_neighborhoods;
    if (!Number.isInteger(dailyLimit) || dailyLimit < DAILY_LISTING_LIMIT_MIN || dailyLimit > DAILY_LISTING_LIMIT_MAX ||
        ![fakeThreshold, highThreshold].every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
        highThreshold < fakeThreshold || !Array.isArray(selected) || selected.length > 200) {
      return json({ error: 'مقادیر تنظیمات معتبر نیستند.' }, 400);
    }
    const unique = [...new Set(selected.map((value) => String(value)))];
    if (unique.length) {
      const found = await env.DB.prepare(`
        SELECT COUNT(*) AS count FROM neighborhoods WHERE is_active = 1 AND slug IN (${unique.map(() => '?').join(',')})
      `).bind(...unique).first();
      if (Number(found?.count || 0) !== unique.length) return json({ error: 'یکی از محله‌های انتخاب‌شده معتبر نیست.' }, 400);
    }
    const baitKeywords = Array.isArray(input.bait_keywords)
      ? input.bait_keywords.map((item) => String(item).trim()).filter(Boolean).slice(0, 100)
      : [];
    await env.DB.batch([
      ['daily_listing_limit', String(dailyLimit)],
      ['fake_threshold', String(fakeThreshold)],
      ['high_fake_threshold', String(highThreshold)],
      ['auto_neighborhoods', JSON.stringify(unique)],
      ['bait_keywords', JSON.stringify(baitKeywords)]
    ].map(([key, value]) => env.DB.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).bind(key, value)));
    return json({ ok: true });
  }

  if (pathname === '/api/logs' && request.method === 'GET') {
    const clauses = [];
    const values = [];
    const service = url.searchParams.get('service');
    const status = url.searchParams.get('status');
    if (SERVICES.has(service)) { clauses.push('service = ?'); values.push(service); }
    if (status === 'error') clauses.push('(status IS NULL OR status = 0 OR status >= 400 OR error IS NOT NULL)');
    else if (status === 'success') clauses.push('(status > 0 AND status < 400 AND error IS NULL)');
    const limit = positiveInteger(url.searchParams.get('limit'), 100, 200);
    const result = await env.DB.prepare(`
      SELECT * FROM request_logs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ?
    `).bind(...values, limit).all();
    return json(result.results || []);
  }

  if (pathname === '/api/discover-neighborhoods' && request.method === 'POST') {
    const result = await refreshNeighborhoodsIfDue(env, true);
    return json(result, result.failed ? 502 : 200);
  }

  return json({ error: 'مسیر پیدا نشد.' }, 404);
}

async function serveUI() {
  return html(dashboardHtml());
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return serveUI();
    if (url.pathname.startsWith('/api/')) {
      try {
        return await apiRoute(request, env, url);
      } catch (error) {
        await logError(env, 'system', url.pathname, error);
        return json({ error: 'خطای داخلی سرور رخ داد.' }, 500);
      }
    }
    return html('<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>یافت نشد</title><body><h1>صفحه پیدا نشد.</h1></body></html>', 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(startWorkflow(env, {
      source: 'scheduled',
      cron: event.cron || ''
    }).catch(async (error) => {
      await logError(env, 'system', 'scheduled', error);
    }));
  }
};
