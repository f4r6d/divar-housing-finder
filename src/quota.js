import { LISTINGS_PER_PAGE, MAX_PAGES_PER_NEIGHBORHOOD } from './constants.js';

export function tehranClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
}

export function aiCallBudgets(dailyLimit, usage = {}, hour = 10) {
  const automaticShare = Math.floor(dailyLimit * 4 / 5);
  const manualShare = dailyLimit - automaticShare;
  const lateAutomaticLimit = hour >= 22 && Number(usage.manual_searches || 0) === 0
    ? dailyLimit
    : automaticShare;
  const totalCalls = Number(usage.total_calls || 0);
  const autoCalls = Number(usage.auto_calls || 0);
  const manualCalls = Number(usage.manual_calls || 0);
  return {
    auto_limit: lateAutomaticLimit,
    manual_limit: manualShare,
    remaining: Math.max(0, dailyLimit - totalCalls),
    auto_remaining: Math.max(0, lateAutomaticLimit - autoCalls),
    manual_remaining: Math.max(0, Math.min(manualShare - manualCalls, dailyLimit - totalCalls))
  };
}

export function listingPagesFor(wanted, {
  perPage = LISTINGS_PER_PAGE,
  max = MAX_PAGES_PER_NEIGHBORHOOD,
  multiplier = 3
} = {}) {
  const requested = Math.max(0, Math.ceil(Number(wanted) || 0));
  return Math.min(max, Math.max(3, Math.ceil(requested / perPage) * multiplier));
}

export function manualRunOutcome({ requested, inserted, quotaLocked = false }) {
  if (quotaLocked) return 'quota_exhausted';
  if (inserted <= 0) return 'empty';
  if (inserted < requested) return 'partial';
  return 'complete';
}

export function neighborhoodTarget(neighborhoods, index, remaining) {
  if (!neighborhoods.length || remaining <= 0) return 0;
  const maxRecent = Math.max(...neighborhoods.map((item) => Number(item.recent_count || 0)));
  const weights = neighborhoods.map((item) => {
    const countWeight = (maxRecent + 1) / (Number(item.recent_count || 0) + 1);
    const lastScraped = item.last_scraped_at
      ? Date.parse(`${String(item.last_scraped_at).replace(' ', 'T')}Z`)
      : NaN;
    const ageDays = Number.isFinite(lastScraped)
      ? Math.max(0, (Date.now() - lastScraped) / 86_400_000)
      : 7;
    const freshnessWeight = 1 + Math.min(7, ageDays) / 7;
    return countWeight * freshnessWeight;
  });
  const weightLeft = weights.slice(index).reduce((sum, weight) => sum + weight, 0);
  const target = Math.ceil(remaining * weights[index] / weightLeft);
  return Math.min(remaining, Math.max(1, target));
}
