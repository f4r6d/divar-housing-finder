import { getSettings, logError, logSuccess } from './utils.js';
import { depositEquivalentToman } from './rental-pricing.js';

const DEFAULT_WEIGHTS = {
  price_vs_district_avg: 0.4,
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
  return numeric(listing.deposit_equivalent_toman || depositEquivalentToman(listing));
}

async function getDistrictStats(env, listing, supplied) {
  if (supplied?.avg_price || supplied?.avg_price_per_sqm) return supplied;
  const row = await env.DB.prepare(`
        SELECT AVG(COALESCE(NULLIF(deposit_equivalent_toman, 0), deposit_toman + COALESCE(rent_toman, 0) * 30, price_toman)) AS avg_price,
          AVG(CASE WHEN size_m2 > 0 THEN COALESCE(NULLIF(deposit_equivalent_toman, 0), deposit_toman + COALESCE(rent_toman, 0) * 30, price_toman) / size_m2 END) AS avg_price_per_sqm
    FROM listings
        WHERE ((? IS NOT NULL AND region_id = ?) OR (? IS NULL AND district_id = ?))
          AND extraction_done = 1
          AND COALESCE(NULLIF(deposit_equivalent_toman, 0), deposit_toman + COALESCE(rent_toman, 0) * 30, price_toman) > 0
      `).bind(listing.region_id ?? null, listing.region_id ?? null, listing.region_id ?? null, listing.district_id).first();
  return row || {};
}

async function heuristicResult(env, listing, districtStats, settings) {
  const price = listingNormalizedPrice(listing);
  const size = numeric(listing.size_m2);
  const pricePerSqm = price > 0 && size > 0 ? price / size : 0;
  const districtPricePerSqm = numeric(districtStats.avg_price_per_sqm);
  const ratio = districtPricePerSqm > 0 && pricePerSqm > 0 ? pricePerSqm / districtPricePerSqm : 1;
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
      ? `نسبت اجاره هر متر به میانگین منطقه ${Math.round(ratio * 100)}٪ است.`
      : matched.length ? `عبارت‌های نیازمند بررسی: ${matched.join('، ')}` : 'برآورد بر اساس میانگین اجاره منطقه انجام شد.',
    details: { method: 'heuristic', price_per_sqm: pricePerSqm, district_avg_price_per_sqm: districtPricePerSqm, ratio, matched_keywords: matched }
  };
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export async function evaluateListing(env, listing, suppliedDistrictStats) {
  const settings = await getSettings(env);
  const districtStats = await getDistrictStats(env, listing, suppliedDistrictStats);
  const price = listingNormalizedPrice(listing);
  const size = numeric(listing.size_m2);
  const pricePerSqm = price > 0 && size > 0 ? price / size : 0;
  const districtAverage = numeric(districtStats.avg_price);
  const districtAveragePerSqm = numeric(districtStats.avg_price_per_sqm);
  const priceDeviationFactor = districtAverage > 0 ? clamp((districtAverage - price) / districtAverage) : 0;
  const sqmRatioFactor = districtAveragePerSqm > 0 ? clamp((districtAveragePerSqm - pricePerSqm) / districtAveragePerSqm) : 0;

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
          state: JSON.stringify({ title: listing.title, description: listing.description, price_toman: listing.price_toman, rent_toman: listing.rent_toman, deposit_toman: listing.deposit_toman, size_m2: size, rooms: listing.rooms, price_per_sqm: pricePerSqm, district_avg_price: districtAverage, district_avg_price_per_sqm: districtAveragePerSqm }),
          questions: {
            is_price_realistic: { type: 'noul', instructions: 'Judge the Tehran rental listing using its deposit-equivalent price (deposit plus monthly rent multiplied by 30), normalized per square meter against the district average. Return 1 if realistic, 0 if clearly implausibly low or bait.' },
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
    const weights = { ...DEFAULT_WEIGHTS, ...safeJson(settings.jev_weights, {}) };
    const mismatch = 1 - getNoul(remoteResult, 'description_matches_price', 0.5);
    const bait = getNoul(remoteResult, 'has_bait_signals', 0);
    score = clamp(
      priceDeviationFactor * numeric(weights.price_vs_district_avg, DEFAULT_WEIGHTS.price_vs_district_avg) +
      sqmRatioFactor * numeric(weights.price_vs_size_ratio, DEFAULT_WEIGHTS.price_vs_size_ratio) +
      mismatch * numeric(weights.description_mismatch, DEFAULT_WEIGHTS.description_mismatch) +
      bait * numeric(weights.suspicious_keywords, DEFAULT_WEIGHTS.suspicious_keywords)
    );
    reason = `انحراف قیمت: ${Math.round(priceDeviationFactor * 100)}٪، نسبت متری: ${Math.round(sqmRatioFactor * 100)}٪، نشانه‌های فریب: ${Math.round(bait * 100)}٪`;
    details = { method: 'typesafe-jev', response: remoteResult, price_per_sqm: pricePerSqm, district_avg_price: districtAverage, district_avg_price_per_sqm: districtAveragePerSqm };
  } else {
    const fallback = await heuristicResult(env, listing, districtStats, settings);
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