export const CACHE_WINDOW_DAYS = 30;
export const CITY_WIDE_ID = 0;

const SORT_COLUMNS = new Map([
  ['name', 'n.name_fa'],
  ['count', 'COALESCE(s.listing_count, 0)'],
  ['avg_deposit', 'COALESCE(s.avg_deposit, 0)'],
  ['median_deposit', 'COALESCE(s.median_deposit, 0)'],
  ['median_deposit_per_sqm', 'COALESCE(s.median_deposit_per_sqm, 0)'],
  ['fake_count', 'COALESCE(s.fake_count, 0)'],
  ['last_scraped_at', 'n.last_scraped_at']
]);

const STATS_COLUMNS = `
  neighborhood_id, window_days, listing_count, fake_count, suspicious_count, hamkhane_count, pending_count,
  avg_deposit, avg_rent, avg_deposit_per_sqm, median_deposit, median_rent, median_deposit_per_sqm, computed_at`;

const RECENT_SOURCE = `
  SELECT neighborhood_id, fake_label, extraction_done, deposit_toman, rent_toman, size_m2
  FROM listings
  WHERE scraped_at >= datetime('now', '-${CACHE_WINDOW_DAYS} days')`;

const AGGREGATE_FIELDS = `
  SUM(CASE WHEN fake_label <> 'hamkhane' THEN 1 ELSE 0 END) AS listing_count,
  SUM(CASE WHEN fake_label = 'fake' THEN 1 ELSE 0 END) AS fake_count,
  SUM(CASE WHEN fake_label = 'suspicious' THEN 1 ELSE 0 END) AS suspicious_count,
  SUM(CASE WHEN fake_label = 'hamkhane' THEN 1 ELSE 0 END) AS hamkhane_count,
  SUM(CASE WHEN fake_label <> 'hamkhane' AND extraction_done = 0 THEN 1 ELSE 0 END) AS pending_count,
  AVG(CASE WHEN fake_label <> 'hamkhane' AND deposit_toman > 0 THEN deposit_toman END) AS avg_deposit,
  AVG(CASE WHEN fake_label <> 'hamkhane' AND rent_toman > 0 THEN rent_toman END) AS avg_rent,
  AVG(CASE WHEN fake_label <> 'hamkhane' AND deposit_toman > 0 AND size_m2 > 0
    THEN deposit_toman * 1.0 / size_m2 END) AS avg_deposit_per_sqm`;

function perNeighborhoodSql() {
  return `
    INSERT INTO neighborhood_stats (${STATS_COLUMNS})
    WITH recent AS (${RECENT_SOURCE}),
    counts AS (
      SELECT neighborhood_id, ${AGGREGATE_FIELDS}
      FROM recent GROUP BY neighborhood_id
    ),
    deposit_medians AS (${medianCte('deposit_toman', 'deposit_toman > 0')}),
    rent_medians AS (${medianCte('rent_toman', 'rent_toman > 0')}),
    size_medians AS (${medianCte('deposit_toman * 1.0 / size_m2', 'deposit_toman > 0 AND size_m2 > 0')})
    SELECT counts.neighborhood_id, ${CACHE_WINDOW_DAYS}, counts.listing_count, counts.fake_count,
      counts.suspicious_count, counts.hamkhane_count, counts.pending_count, counts.avg_deposit,
      counts.avg_rent, counts.avg_deposit_per_sqm, deposit_medians.median_value, rent_medians.median_value,
      size_medians.median_value, datetime('now')
    FROM counts
    LEFT JOIN deposit_medians ON deposit_medians.neighborhood_id = counts.neighborhood_id
    LEFT JOIN rent_medians ON rent_medians.neighborhood_id = counts.neighborhood_id
    LEFT JOIN size_medians ON size_medians.neighborhood_id = counts.neighborhood_id`;
}

function cityWideSql() {
  return `
    INSERT INTO neighborhood_stats (${STATS_COLUMNS})
    WITH recent AS (${RECENT_SOURCE}),
    counts AS (SELECT ${AGGREGATE_FIELDS} FROM recent),
    deposit_medians AS (${medianCte('deposit_toman', 'deposit_toman > 0', false)}),
    rent_medians AS (${medianCte('rent_toman', 'rent_toman > 0', false)}),
    size_medians AS (${medianCte('deposit_toman * 1.0 / size_m2', 'deposit_toman > 0 AND size_m2 > 0', false)})
    SELECT ${CITY_WIDE_ID}, ${CACHE_WINDOW_DAYS}, counts.listing_count, counts.fake_count, counts.suspicious_count,
      counts.hamkhane_count, counts.pending_count, counts.avg_deposit, counts.avg_rent, counts.avg_deposit_per_sqm,
      deposit_medians.median_value, rent_medians.median_value, size_medians.median_value, datetime('now')
    FROM counts, deposit_medians, rent_medians, size_medians`;
}

function medianCte(expression, positiveCondition, partition = true) {
  const partitionBy = partition ? 'PARTITION BY neighborhood_id ' : '';
  const columns = partition ? 'neighborhood_id, ' : '';
  const groupBy = partition ? ' GROUP BY neighborhood_id' : '';
  return `
    SELECT ${columns}AVG(value) AS median_value FROM (
      SELECT ${columns}${expression} AS value,
        ROW_NUMBER() OVER (${partitionBy}ORDER BY ${expression}) AS row_number,
        COUNT(*) OVER (${partitionBy}) AS row_count
      FROM recent WHERE fake_label <> 'hamkhane' AND ${positiveCondition}
    ) WHERE row_number IN ((row_count + 1) / 2, (row_count + 2) / 2)${groupBy}`;
}

const LIVE_AGGREGATE_FIELDS = `
  SUM(CASE WHEN fake_label <> 'hamkhane' THEN 1 ELSE 0 END) AS count,
  SUM(CASE WHEN fake_label = 'fake' THEN 1 ELSE 0 END) AS fake_count,
  SUM(CASE WHEN fake_label = 'suspicious' THEN 1 ELSE 0 END) AS suspicious_count,
  SUM(CASE WHEN fake_label = 'hamkhane' THEN 1 ELSE 0 END) AS hamkhane_count,
  SUM(CASE WHEN fake_label <> 'hamkhane' AND extraction_done = 0 THEN 1 ELSE 0 END) AS pending,
  AVG(CASE WHEN fake_label <> 'hamkhane' AND deposit_toman > 0 THEN deposit_toman END) AS average_deposit,
  AVG(CASE WHEN fake_label <> 'hamkhane' AND rent_toman > 0 THEN rent_toman END) AS average_rent,
  AVG(CASE WHEN fake_label <> 'hamkhane' AND deposit_toman > 0 AND size_m2 > 0
    THEN deposit_toman * 1.0 / size_m2 END) AS average_deposit_per_sqm`;

export async function computeSummary(env, days, neighborhoodSlug = '') {
  const filter = neighborhoodSlug ? 'AND n.slug = ?' : '';
  const binds = neighborhoodSlug ? [neighborhoodSlug] : [];
  const row = await env.DB.prepare(`
    WITH recent AS (
      SELECT l.fake_label, l.extraction_done, l.deposit_toman, l.rent_toman, l.size_m2
      FROM listings l JOIN neighborhoods n ON n.id = l.neighborhood_id
      WHERE l.scraped_at >= datetime('now', '-${days} days') ${filter}
    ),
    aggregate AS (SELECT ${LIVE_AGGREGATE_FIELDS} FROM recent),
    deposit_medians AS (${medianCte('deposit_toman', 'deposit_toman > 0', false)}),
    rent_medians AS (${medianCte('rent_toman', 'rent_toman > 0', false)}),
    size_medians AS (${medianCte('deposit_toman * 1.0 / size_m2', 'deposit_toman > 0 AND size_m2 > 0', false)})
    SELECT aggregate.*,
      deposit_medians.median_value AS median_deposit,
      rent_medians.median_value AS median_rent,
      size_medians.median_value AS median_deposit_per_sqm
    FROM aggregate, deposit_medians, rent_medians, size_medians
  `).bind(...binds).first();
  return {
    count: Number(row?.count || 0),
    fake_count: Number(row?.fake_count || 0),
    suspicious_count: Number(row?.suspicious_count || 0),
    hamkhane_count: Number(row?.hamkhane_count || 0),
    pending: Number(row?.pending || 0),
    average_deposit: row?.average_deposit ?? null,
    average_rent: row?.average_rent ?? null,
    average_deposit_per_sqm: row?.average_deposit_per_sqm ?? null,
    median_deposit: row?.median_deposit ?? null,
    median_deposit_per_sqm: row?.median_deposit_per_sqm ?? null,
    median_rent: row?.median_rent ?? null,
    stats_computed_at: null
  };
}

export async function computeDaily(env, days, neighborhoodSlug = '') {
  const filter = neighborhoodSlug ? 'AND n.slug = ?' : '';
  const binds = neighborhoodSlug ? [neighborhoodSlug] : [];
  const result = await env.DB.prepare(`
    WITH recent AS (
      SELECT date(l.scraped_at) AS day, l.deposit_toman
      FROM listings l JOIN neighborhoods n ON n.id = l.neighborhood_id
      WHERE l.scraped_at >= datetime('now', '-${days} days') AND l.fake_label <> 'hamkhane' ${filter}
    ),
    ranked AS (
      SELECT day, deposit_toman,
        ROW_NUMBER() OVER (PARTITION BY day ORDER BY deposit_toman) AS row_number,
        COUNT(*) OVER (PARTITION BY day) AS row_count
      FROM recent WHERE deposit_toman > 0
    )
    SELECT day, AVG(deposit_toman) AS median_deposit
    FROM ranked WHERE row_number IN ((row_count + 1) / 2, (row_count + 2) / 2)
    GROUP BY day ORDER BY day
  `).bind(...binds).all();
  return (result.results || []).map((row) => ({ day: row.day, median_deposit: row.median_deposit }));
}

function allTimeSql() {
  return `
    INSERT INTO neighborhood_stats (neighborhood_id, window_days, listing_count, hamkhane_count, computed_at)
    SELECT ${CITY_WIDE_ID}, 0,
      SUM(CASE WHEN fake_label <> 'hamkhane' THEN 1 ELSE 0 END),
      SUM(CASE WHEN fake_label = 'hamkhane' THEN 1 ELSE 0 END),
      datetime('now')
    FROM listings`;
}

function dailySql() {
  return `
    INSERT INTO daily_stats (day, listing_count, median_deposit, computed_at)
    WITH recent AS (
      SELECT date(scraped_at) AS day, deposit_toman
      FROM listings
      WHERE scraped_at >= datetime('now', '-${CACHE_WINDOW_DAYS} days')
        AND fake_label <> 'hamkhane' AND deposit_toman > 0
    ),
    ranked AS (
      SELECT day, deposit_toman,
        ROW_NUMBER() OVER (PARTITION BY day ORDER BY deposit_toman) AS row_number,
        COUNT(*) OVER (PARTITION BY day) AS row_count
      FROM recent
    )
    SELECT day, MAX(row_count), AVG(deposit_toman), datetime('now')
    FROM ranked
    WHERE row_number IN ((row_count + 1) / 2, (row_count + 2) / 2)
    GROUP BY day`;
}

export async function refreshAggregates(env) {
  const statements = [
    env.DB.prepare(`DELETE FROM neighborhood_stats WHERE window_days = ${CACHE_WINDOW_DAYS}`),
    env.DB.prepare(perNeighborhoodSql()),
    env.DB.prepare(cityWideSql()),
    env.DB.prepare('DELETE FROM neighborhood_stats WHERE window_days = 0'),
    env.DB.prepare(allTimeSql()),
    env.DB.prepare('DELETE FROM daily_stats'),
    env.DB.prepare(dailySql()),
    env.DB.prepare(`
      INSERT INTO system_state (key, value, updated_at) VALUES ('stats_computed_at', datetime('now'), datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
  ];
  const results = await env.DB.batch(statements);
  return {
    neighborhoods: Number(results[1]?.meta?.changes || 0),
    days: Number(results[6]?.meta?.changes || 0)
  };
}

async function cacheReady(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM system_state WHERE key = 'stats_computed_at'").first();
    return row?.value || null;
  } catch {
    return null;
  }
}

export async function loadCachedNeighborhoodStats(env, {
  search = '', page = 1, pageSize = 20, sort = 'count', order = 'desc', all = false
} = {}) {
  const computedAt = await cacheReady(env);
  if (!computedAt) return null;
  const sortColumn = SORT_COLUMNS.get(sort) || SORT_COLUMNS.get('count');
  const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
  const filter = search ? 'WHERE n.is_active = 1 AND n.name_fa LIKE ?' : 'WHERE n.is_active = 1';
  const bindFilter = search ? [`%${search}%`] : [];
  const result = await env.DB.prepare(`
    SELECT n.id, n.slug, n.name_fa, n.last_scraped_at,
      COALESCE(s.listing_count, 0) AS count,
      COALESCE(s.fake_count, 0) AS fake_count,
      COALESCE(s.suspicious_count, 0) AS suspicious_count,
      COALESCE(s.hamkhane_count, 0) AS hamkhane_count,
      s.avg_deposit, s.avg_rent, s.avg_deposit_per_sqm,
      s.median_deposit_per_sqm, s.median_deposit, s.median_rent
    FROM neighborhoods n
    LEFT JOIN neighborhood_stats s
      ON s.neighborhood_id = n.id AND s.window_days = ${CACHE_WINDOW_DAYS}
    ${filter}
    ORDER BY ${sortColumn} ${sortOrder}, n.name_fa ASC
    ${all ? '' : 'LIMIT ? OFFSET ?'}
  `).bind(...bindFilter, ...(all ? [] : [pageSize, (page - 1) * pageSize])).all();
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM neighborhoods n ${filter}`)
    .bind(...bindFilter).first();
  return {
    neighborhoods: result.results || [],
    total: Number(countRow?.total || 0),
    computed_at: computedAt
  };
}

function summaryFromRow(row, computedAt) {
  return {
    count: Number(row.listing_count || 0),
    fake_count: Number(row.fake_count || 0),
    suspicious_count: Number(row.suspicious_count || 0),
    hamkhane_count: Number(row.hamkhane_count || 0),
    pending: Number(row.pending_count || 0),
    average_deposit: row.avg_deposit ?? null,
    average_rent: row.avg_rent ?? null,
    average_deposit_per_sqm: row.avg_deposit_per_sqm ?? null,
    median_deposit: row.median_deposit ?? null,
    median_deposit_per_sqm: row.median_deposit_per_sqm ?? null,
    median_rent: row.median_rent ?? null,
    stats_computed_at: computedAt
  };
}

export async function loadCachedSummary(env, neighborhoodSlug = '') {
  const computedAt = await cacheReady(env);
  if (!computedAt) return null;
  const row = neighborhoodSlug
    ? await env.DB.prepare(`
        SELECT s.* FROM neighborhood_stats s JOIN neighborhoods n ON n.id = s.neighborhood_id
        WHERE n.slug = ? AND s.window_days = ${CACHE_WINDOW_DAYS}
      `).bind(neighborhoodSlug).first()
    : await env.DB.prepare(`
        SELECT * FROM neighborhood_stats
        WHERE neighborhood_id = ${CITY_WIDE_ID} AND window_days = ${CACHE_WINDOW_DAYS}
      `).first();
  return row ? summaryFromRow(row, computedAt) : null;
}

export async function loadCachedDaily(env) {
  const computedAt = await cacheReady(env);
  if (!computedAt) return null;
  const result = await env.DB.prepare('SELECT day, median_deposit FROM daily_stats ORDER BY day').all();
  return (result.results || []).map((row) => ({ day: row.day, median_deposit: row.median_deposit }));
}

export async function loadCachedListingTotal(env) {
  const computedAt = await cacheReady(env);
  if (!computedAt) return null;
  const row = await env.DB.prepare(`
    SELECT listing_count FROM neighborhood_stats WHERE neighborhood_id = ${CITY_WIDE_ID} AND window_days = 0
  `).first();
  return row ? Number(row.listing_count || 0) : null;
}
