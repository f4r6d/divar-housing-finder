import {
  EXCLUDE_IDS_MAX, EXTRACT_SLICE, LEASE_STALE_MS
} from './constants.js';

// Lease token stored in system_state.workflow_running. Format: "run:<runId>:<epochMs>".
// "0" (or empty) means no chain owns the pipeline. A non-zero token whose timestamp is older
// than LEASE_STALE_MS is considered abandoned and may be taken over.
export const LEASE_FREE = '0';

export function formatLease(runId, timestampMs) {
  return `run:${runId}:${Math.floor(Number(timestampMs))}`;
}

export function parseLease(value) {
  if (!value || value === LEASE_FREE) return null;
  const match = /^run:(.+):(\d+)$/.exec(String(value));
  if (!match) return null;
  return { runId: match[1], timestamp: Number(match[2]) };
}

export function isLeaseActive(value, now = Date.now(), staleMs = LEASE_STALE_MS) {
  const lease = parseLease(value);
  return Boolean(lease) && lease.timestamp + staleMs > now;
}

// Entry points (cron, dashboard refresh, manual run) may start a new chain only when no chain
// currently holds an active lease.
export function canAcquireLease(value, now = Date.now(), staleMs = LEASE_STALE_MS) {
  return !isLeaseActive(value, now, staleMs);
}

// A child instance may renew the lease only if it belongs to the same run, or the previous lease
// was free/stale. This is what stops a stale instance from extending a chain it no longer owns.
export function canRenewLease(value, runId, now = Date.now(), staleMs = LEASE_STALE_MS) {
  const lease = parseLease(value);
  if (!lease) return true;
  if (lease.runId === runId) return true;
  return lease.timestamp + staleMs <= now;
}

// Sensitive writes (finalizing a manual run, releasing the lock) must prove they belong to the
// run that currently owns the lease.
export function ownsLease(value, runId) {
  const lease = parseLease(value);
  return Boolean(lease) && lease.runId === runId;
}

// Deterministic child instance id (URL-safe, <=100 chars, valid id charset). Re-running the
// chain-next step after a crash always yields the same id, so create() can be de-duplicated.
export function childId(runId, phase, seq = 0) {
  return `run-${runId}-${phase}-${seq}`.slice(0, 100);
}

// Given the status of the (possibly already-existing) child instance, decide what chain-next does.
export function childCreationDecision(status) {
  if (!status) return 'create';
  if (status === 'queued' || status === 'running' || status === 'complete') return 'reuse';
  if (status === 'errored' || status === 'terminated') return 'stop';
  return 'reuse';
}

// Pure transition. `progress` (merged with the phase patch) carries the fields the current phase
// produced; `payload` is the immutable incoming event payload.
export function nextPhase(payload, progress = {}) {
  switch (payload.phase) {
    case 'plan': {
      if (progress.terminal) return 'finalize';
      const queue = progress.queue ?? payload.queue;
      const scrapeRemaining = progress.scrapeRemaining ?? payload.scrapeRemaining ?? 0;
      return (queue?.length && scrapeRemaining > 0) ? 'scrape' : 'extract';
    }
    case 'scrape': {
      if (progress.terminal) return 'finalize';
      const queueLength = progress.queueLength ?? payload.queue?.length ?? 0;
      const scrapeRemaining = progress.scrapeRemaining ?? payload.scrapeRemaining ?? 0;
      return queueLength > 0 && scrapeRemaining > 0 ? 'scrape' : 'extract';
    }
    case 'extract':
      return progress.terminal ? 'finalize' : progress.quotaExhausted ? 'jev' : progress.filled ? 'extract' : 'jev';
    case 'jev':
      return progress.filled ? 'jev' : 'finalize';
    case 'finalize':
      return null;
    default:
      return null;
  }
}

export function extractSlice(remaining, slice = EXTRACT_SLICE) {
  return Math.max(0, Math.min(slice, Math.floor(Number(remaining) || 0)));
}

// Builds the successor payload or returns null when the chain is finished. `patch` lets a phase
// contribute durable fields (queue, scrapeRemaining, source, date, dailyLimit, neighborhoodId).
export function nextPayload(payload, progress = {}, patch = {}) {
  const next = nextPhase(payload, { ...progress, ...patch });
  if (!next) return null;
  const seq = next === payload.phase ? (payload.seq || 0) + 1 : 0;
  const merged = { ...payload, ...patch, phase: next, seq };
  if (next === 'extract') {
    merged.failedIds = unique([...(payload.failedIds || []), ...(progress.failedIds || patch.failedIds || [])])
      .slice(-EXCLUDE_IDS_MAX);
  } else {
    merged.failedIds = [];
  }
  return merged;
}

// A slice phase may chain a successor only when it made durable progress. Committing nothing means
// the next instance would select the very same rows (unextractable rows, or a slice of failures),
// which would loop forever; quota and subrequest exhaustion stop the chain by themselves.
export function hopFilled({ processed = 0, selected = 0, slice = 0, quotaExhausted = false, subrequest = false } = {}) {
  if (quotaExhausted || subrequest) return false;
  return Math.floor(Number(processed) || 0) > 0 && Math.floor(Number(selected) || 0) >= Math.floor(Number(slice) || 0);
}

// Backlog reporting: pending rows are split into the pre-existing backlog (scraped before this
// run) and rows scraped during this run. Never claims the whole backlog drained. Returns null when
// the chain has no recorded starting count, so callers omit the report instead of claiming zero left.
export function classifyBacklog({ pendingBeforeRun = null, scrapedThisRun = 0, processed = 0 } = {}) {
  if (pendingBeforeRun === null || pendingBeforeRun === undefined) return null;
  const backlogOld = Math.max(0, Math.floor(pendingBeforeRun) - Math.max(0, Math.floor(processed)));
  const remaining = Math.max(0, Math.floor(pendingBeforeRun) + Math.floor(scrapedThisRun) - Math.max(0, Math.floor(processed)));
  return {
    backlogOldRemaining: Math.min(backlogOld, remaining),
    newThisRunRemaining: Math.max(0, remaining - Math.min(backlogOld, remaining)),
    processed: Math.max(0, Math.floor(processed)),
    remaining
  };
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
