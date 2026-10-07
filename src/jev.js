import { getSettings, logError, logSuccess } from './utils.js';
import { depositEquivalentToman } from './rental-pricing.js';

const DEFAULT_WEIGHTS = {
  price_vs_neighborhood_avg: 0.4,
  price_vs_size_ratio: 0.25,
  description_mismatch: 0.2,
  suspicious_keywords: 0.15
};

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getNoul(result, key, fallback = 0) {
  const value = result?.[key]?.noul ?? result?.answers?.[key]?.noul ?? result?.[key];
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value === undefined || value === null ? fallback : clamp(value);
}

function listingNormalizedPrice(listing) {
  return numeric(depositEquivalentToman(listing) || listing.deposit_equivalent_toman || listing.price_toman);
}

async function getNeighborhoodStats(env, listing, supplied) {
  if (supplied?.avg_price || supplied?.avg_price_per_sqm) return supplied;
  const row = await env.DB.prepare(`
    SELECT AVG(CASE
        WHEN COALESCE(deposit_toman, 0) > 0 OR COALESCE(rent_toman, 0) > 0
          THEN COALESCE(deposit_toman, 0) + COALESCE(rent_toman, 0) * (100.0 / 3.0)
        ELSE COALESCE(NULLIF(deposit_equivalent_toman, 0), price_toman)
      END) AS avg_price,
      AVG(CASE WHEN size_m2 > 0 THEN
        CASE
          WHEN COALESCE(deposit_toman, 0) > 0 OR COALESCE(rent_toman, 0) > 0
            THEN (COALESCE(deposit_toman, 0) + COALESCE(rent_toman, 0) * (100.0 / 3.0)) / size_m2
          ELSE COALESCE(NULLIF(deposit_equivalent_toman, 0), price_toman) / size_m2
        END
      END) AS avg_price_per_sqm
    FROM listings
    WHERE neighborhood_id = ? AND extraction_done = 1
      AND fake_label <> 'hamkhane'
      AND (COALESCE(deposit_toman, 0) > 0 OR COALESCE(rent_toman, 0) > 0
        OR COALESCE(NULLIF(deposit_equivalent_toman, 0), price_toman) > 0)
  `).bind(listing.neighborhood_id).first();
  return row || {};
}

async function heuristicResult(env, listing, neighborhoodStats, settings) {
  const price = listingNormalizedPrice(listing);
  const size = numeric(listing.size_m2);
  const pricePerSqm = price > 0 && size > 0 ? price / size : 0;
  const neighborhoodPricePerSqm = numeric(neighborhoodStats.avg_price_per_sqm);
  const ratio = neighborhoodPricePerSqm > 0 && pricePerSqm > 0 ? pricePerSqm / neighborhoodPricePerSqm : 1;
  let score = ratio < 0.4 ? 0.9 : ratio < 0.6 ? 0.65 : ratio < 0.75 ? 0.4 : 0.15;
  const baitKeywords = safeJson(settings.bait_keywords, []);
  const matched = baitKeywords.filter((keyword) => `${listing.title || ''} ${listing.description || ''}`.includes(keyword));
  if (matched.length) score = Math.max(score, Math.min(0.95, 0.45 + matched.length * 0.1));
  const label = score >= numeric(settings.high_fake_threshold, 0.8)
    ? 'fake'
    : score >= numeric(settings.fake_threshold, 0.6) ? 'suspicious' : 'real';
  return {
    score,
    label,
    reason: ratio < 0.6
      ? `نسبت ودیعهٔ هر متر به میانگین محله ${Math.round(ratio * 100)}٪ است.`
      : matched.length ? `عبارت‌های نیازمند بررسی: ${matched.join('، ')}` : 'برآورد بر اساس میانگین ودیعهٔ محله انجام شد.',
    details: { method: 'heuristic', price_per_sqm: pricePerSqm, neighborhood_avg_price_per_sqm: neighborhoodPricePerSqm, ratio, matched_keywords: matched }
  };
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export async function evaluateListing(env, listing, suppliedNeighborhoodStats) {
  const settings = await getSettings(env);
  const neighborhoodStats = await getNeighborhoodStats(env, listing, suppliedNeighborhoodStats);
  const price = listingNormalizedPrice(listing);
  const size = numeric(listing.size_m2);
  const pricePerSqm = price > 0 && size > 0 ? price / size : 0;
  const neighborhoodAverage = numeric(neighborhoodStats.avg_price);
  const neighborhoodAveragePerSqm = numeric(neighborhoodStats.avg_price_per_sqm);
  const priceDeviationFactor = neighborhoodAverage > 0 ? clamp((neighborhoodAverage - price) / neighborhoodAverage) : 0;
  const sqmRatioFactor = neighborhoodAveragePerSqm > 0 ? clamp((neighborhoodAveragePerSqm - pricePerSqm) / neighborhoodAveragePerSqm) : 0;

  let remoteResult = null;
  let usedJev = false;
  if (env.TYPESAFE_API_KEY) {
    const url = 'https://api.typesafe.ai/v1/systemone';
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'jev-1.13.0',
          state: JSON.stringify({ title: listing.title, description: listing.description, price_toman: listing.price_toman, rent_toman: listing.rent_toman, deposit_toman: listing.deposit_toman, size_m2: size, rooms: listing.rooms, price_per_sqm: pricePerSqm,           neighborhood_avg_deposit_equivalent: neighborhoodAverage, neighborhood_avg_equivalent_per_sqm: neighborhoodAveragePerSqm }),
          questions: {
            is_price_realistic: { type: 'noul', instructions: 'Judge the Tehran rental listing by its deposit-equivalent value: deposit plus monthly rent multiplied by 100/3 (100 million toman deposit is equivalent to 3 million toman monthly rent). Compare that equivalent per square meter with the same-neighborhood average equivalent. Return 1 if realistic, 0 if clearly implausibly low or bait.' },
            has_bait_signals: { type: 'noul', instructions: 'Return 1 if this listing contains deceptive bait-price or urgency signals, otherwise 0.' },
            description_matches_price: { type: 'noul', instructions: 'Return 1 if the description supports the stated rental price, otherwise 0.' }
          }
        })
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`TypeSafe Jev returned ${response.status}: ${text.slice(0, 500)}`);
      remoteResult = JSON.parse(text);
      usedJev = true;
      await logSuccess(env, 'jev', url, `Evaluated listing ${listing.id}`, response.status);
    } catch (error) {
      await logError(env, 'jev', url, error);
    }
  }

  let score;
  let reason;
  let details;
  if (usedJev) {
    const storedWeights = safeJson(settings.jev_weights, {});
    const weights = {
      ...DEFAULT_WEIGHTS,
      ...storedWeights,
      price_vs_neighborhood_avg: storedWeights.price_vs_neighborhood_avg ??
        storedWeights.price_vs_district_avg ?? DEFAULT_WEIGHTS.price_vs_neighborhood_avg
    };
    const mismatch = 1 - getNoul(remoteResult, 'description_matches_price', 0.5);
    const bait = getNoul(remoteResult, 'has_bait_signals', 0);
    score = clamp(
      priceDeviationFactor * numeric(
        weights.price_vs_neighborhood_avg,
        DEFAULT_WEIGHTS.price_vs_neighborhood_avg
      ) +
      sqmRatioFactor * numeric(weights.price_vs_size_ratio, DEFAULT_WEIGHTS.price_vs_size_ratio) +
      mismatch * numeric(weights.description_mismatch, DEFAULT_WEIGHTS.description_mismatch) +
      bait * numeric(weights.suspicious_keywords, DEFAULT_WEIGHTS.suspicious_keywords)
    );
    reason = `انحراف قیمت: ${Math.round(priceDeviationFactor * 100)}٪، نسبت متری: ${Math.round(sqmRatioFactor * 100)}٪، نشانه‌های فریب: ${Math.round(bait * 100)}٪`;
    details = {
      method: 'typesafe-jev', response: remoteResult, price_per_sqm: pricePerSqm,
      neighborhood_avg_deposit_equivalent: neighborhoodAverage,
      neighborhood_avg_equivalent_per_sqm: neighborhoodAveragePerSqm
    };
  } else {
    const fallback = await heuristicResult(env, listing, neighborhoodStats, settings);
    score = fallback.score;
    reason = fallback.reason;
    details = fallback.details;
  }

  const label = score >= numeric(settings.high_fake_threshold, 0.8)
    ? 'fake'
    : score >= numeric(settings.fake_threshold, 0.6) ? 'suspicious' : 'real';
  const result = { score, label, reason, details };
  await env.DB.prepare(`
    UPDATE listings SET jev_result = ?, jev_score = ?, jev_done = 1,
      fake_label = ?, fake_score = ?, fake_reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(JSON.stringify(details), score, label, score, reason, listing.id).run();
  return result;
}