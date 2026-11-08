import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAcquireLease, canRenewLease, childCreationDecision, childId, classifyBacklog,
  extractSlice, formatLease, hopFilled, isLeaseActive, nextPayload, nextPhase, ownsLease, parseLease
} from '../src/chain.js';
import { canReserveCall } from '../src/quota.js';
import { EXCLUDE_IDS_MAX, EXTRACT_SLICE, LEASE_STALE_MS } from '../src/constants.js';

const NOW = 1_780_000_000_000;

// Scenario 1 — replay of chain-next after the child was already created.
test('chain-next reuses an already-created child instead of recreating the chain', () => {
  assert.equal(childCreationDecision('queued'), 'reuse');
  assert.equal(childCreationDecision('running'), 'reuse');
  assert.equal(childCreationDecision('complete'), 'reuse');
  assert.equal(childCreationDecision(null), 'create');
  assert.equal(childCreationDecision('errored'), 'stop');
  assert.equal(childCreationDecision('terminated'), 'stop');
});

test('child instance ids are deterministic, URL-safe, and within 100 characters', () => {
  const runId = '3f2a1b6c-7d4e-4c9a-9b11-2a5f6e7d8c90';
  const first = childId(runId, 'extract', 3);
  const again = childId(runId, 'extract', 3);
  assert.equal(first, again);
  assert.ok(first.length <= 100);
  assert.match(first, /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
  assert.notEqual(childId(runId, 'extract', 4), first);
});

// Scenario 2 — concurrent cron and manual request.
test('entry points acquire a lease only when none is freshly held', () => {
  const other = formatLease('run-aaa', NOW);
  assert.equal(canAcquireLease(other, NOW, LEASE_STALE_MS), false);       // live chain -> reject
  assert.equal(canAcquireLease('0', NOW, LEASE_STALE_MS), true);          // idle -> allow
  assert.equal(canAcquireLease(formatLease('run-aaa', NOW - LEASE_STALE_MS - 1), NOW, LEASE_STALE_MS), true); // stale -> takeover
});

// Scenario 3 — lease expiry during a wait/retry.
test('a child can renew its own run lease but never a foreign live one', () => {
  const mine = formatLease('run-mine', NOW - 5 * 60 * 1000);
  const foreignFresh = formatLease('run-other', NOW - 1000);
  const foreignStale = formatLease('run-other', NOW - LEASE_STALE_MS - 1000);
  assert.equal(canRenewLease(mine, 'run-mine', NOW, LEASE_STALE_MS), true);
  assert.equal(canRenewLease(foreignFresh, 'run-mine', NOW, LEASE_STALE_MS), false);
  assert.equal(canRenewLease(foreignStale, 'run-mine', NOW, LEASE_STALE_MS), true); // abandoned -> adopt
  assert.equal(ownsLease(mine, 'run-mine'), true);
  assert.equal(ownsLease(foreignFresh, 'run-mine'), false);
  assert.equal(isLeaseActive(foreignStale, NOW, LEASE_STALE_MS), false);
  assert.deepEqual(parseLease('0'), null);
  assert.deepEqual(parseLease('true'), null); // legacy value treated as free
});

// Scenario 4 & 5 — crash windows around the AI call and the durable commit.
test('extract continues only while the slice fills and quota remains, carrying failures to skip', () => {
  const payload = { phase: 'extract', seq: 2, failedIds: [10, 11] };
  const drained = nextPayload(payload, { processed: 3, failedIds: [12], filled: false }, {});
  assert.equal(drained.phase, 'jev');
  assert.equal(drained.seq, 0);
  assert.deepEqual(drained.failedIds, []); // leaving extract clears the skip list

  const keepGoing = nextPayload(payload, { processed: 5, failedIds: [13], filled: true, quotaExhausted: false }, {});
  assert.equal(keepGoing.phase, 'extract');
  assert.equal(keepGoing.seq, 3);
  assert.deepEqual(keepGoing.failedIds, [10, 11, 13]); // accumulated & de-duplicated

  const dup = nextPayload(payload, { processed: 5, failedIds: [10, 13], filled: true }, {});
  assert.deepEqual(dup.failedIds, [10, 11, 13]);
});

test('quota exhaustion or an abort stops extraction', () => {
  const payload = { phase: 'extract', seq: 0 };
  assert.equal(nextPhase(payload, { filled: true, quotaExhausted: true }), 'jev');
  assert.equal(nextPhase(payload, { terminal: true }), 'finalize');
  assert.equal(nextPhase(payload, { abort: true }), 'jev');
});

// Scenario 6 — quota too small to drain the whole backlog this run.
test('extract slice is bounded by remaining quota', () => {
  assert.equal(extractSlice(0), 0);
  assert.equal(extractSlice(12), 12);
  assert.equal(extractSlice(999), EXTRACT_SLICE);
});

test('backlog reporting never claims a full drain and preserves the remainder', () => {
  const partial = classifyBacklog({ pendingBeforeRun: 395, scrapedThisRun: 40, processed: 100 });
  assert.ok(partial.remaining > 0);
  assert.equal(partial.remaining, 395 + 40 - 100);
  assert.equal(partial.backlogOldRemaining, 295);
  assert.equal(partial.newThisRunRemaining, 40);

  const drained = classifyBacklog({ pendingBeforeRun: 10, scrapedThisRun: 0, processed: 10 });
  assert.equal(drained.remaining, 0);
  assert.equal(drained.backlogOldRemaining, 0);

  // A chain that never recorded the starting count reports nothing rather than a clean queue.
  assert.equal(classifyBacklog({ scrapedThisRun: 40, processed: 100 }), null);
  assert.equal(classifyBacklog({ pendingBeforeRun: undefined }), null);
});

test('per-run counters ride forward on the chained payload', () => {
  const plan = { phase: 'plan', seq: 0, runId: 'r1' };
  const afterPlan = nextPayload(plan, { processed: 0 }, {
    queue: ['a', 'b'], scrapeRemaining: 400, source: 'auto', pendingBeforeRun: 395, scrapedThisRun: 0, processedThisRun: 0
  });
  assert.equal(afterPlan.phase, 'scrape');
  assert.equal(afterPlan.pendingBeforeRun, 395);

  const afterScrape = nextPayload(afterPlan, { inserted: 12, queueLength: 1 }, { queue: ['b'], scrapeRemaining: 383, scrapedThisRun: 12 });
  assert.equal(afterScrape.scrapedThisRun, 12);

  const afterFirstExtract = nextPayload({ ...afterScrape, phase: 'extract', seq: 0 }, { processed: 40, filled: true }, { processedThisRun: 40 });
  const afterSecondExtract = nextPayload(afterFirstExtract, { processed: 30, filled: true }, { processedThisRun: afterFirstExtract.processedThisRun + 30 });
  assert.equal(afterSecondExtract.processedThisRun, 70);

  const report = classifyBacklog({
    pendingBeforeRun: afterSecondExtract.pendingBeforeRun,
    scrapedThisRun: afterSecondExtract.scrapedThisRun,
    processed: afterSecondExtract.processedThisRun
  });
  assert.equal(report.remaining, 395 + 12 - 70);
  assert.equal(report.backlogOldRemaining, 325);
  assert.equal(report.newThisRunRemaining, 12);
});

// Phase transition table for the whole chain.
test('phase transitions flow plan -> scrape -> extract -> jev -> finalize', () => {
  assert.equal(nextPhase({ phase: 'plan', queue: ['a'], scrapeRemaining: 5 }, {}), 'scrape');
  assert.equal(nextPhase({ phase: 'plan', queue: [], scrapeRemaining: 5 }, {}), 'extract');
  assert.equal(nextPhase({ phase: 'scrape', queue: ['a', 'b'], scrapeRemaining: 40 }, { queueLength: 1, scrapeRemaining: 28 }), 'scrape');
  assert.equal(nextPhase({ phase: 'scrape', queue: ['a'] }, { queueLength: 0, scrapeRemaining: 20 }), 'extract');
  assert.equal(nextPhase({ phase: 'scrape', queue: ['a', 'b'] }, { queueLength: 2, scrapeRemaining: 0 }), 'extract');
  assert.equal(nextPhase({ phase: 'jev' }, { filled: true }), 'jev');
  assert.equal(nextPhase({ phase: 'jev' }, { filled: false }), 'finalize');
  assert.equal(nextPhase({ phase: 'finalize' }, {}), null);
});

test('scrape hop advances the hood queue and carries scrapeRemaining forward', () => {
  const payload = { phase: 'scrape', seq: 0, queue: ['a', 'b', 'c', 'd'], scrapeRemaining: 40 };
  const next = nextPayload(payload, { inserted: 12, queueLength: 2, filled: true }, { queue: ['c', 'd'], scrapeRemaining: 28 });
  assert.equal(next.phase, 'scrape');
  assert.equal(next.seq, 1);
  assert.deepEqual(next.queue, ['c', 'd']);
  assert.equal(next.scrapeRemaining, 28);
});

// A hop that committed nothing must never chain a successor, or the same rows are re-selected forever.
test('a slice with no durable progress ends the chain instead of looping', () => {
  assert.equal(hopFilled({ processed: 0, selected: 40, slice: 40 }), false);
  assert.equal(hopFilled({ processed: 40, selected: 40, slice: 40 }), true);
  assert.equal(hopFilled({ processed: 12, selected: 12, slice: 40 }), false);
  assert.equal(hopFilled({ processed: 40, selected: 40, slice: 40, quotaExhausted: true }), false);
  assert.equal(hopFilled({ processed: 40, selected: 40, slice: 40, subrequest: true }), false);

  const stalled = nextPayload({ phase: 'extract', seq: 4, failedIds: [1] }, { processed: 0, failedIds: [], filled: false }, {});
  assert.equal(stalled.phase, 'jev');
  assert.equal(nextPhase({ phase: 'jev' }, { processed: 0, filled: false }), 'finalize');
});

test('the extract skip list stays bounded to the newest entries', () => {
  const older = Array.from({ length: 600 }, (_, i) => i);
  const next = nextPayload({ phase: 'extract', seq: 1, failedIds: older }, { processed: 5, failedIds: [900, 901], filled: true }, {});
  assert.equal(next.failedIds.length, EXCLUDE_IDS_MAX);
  assert.deepEqual(next.failedIds.slice(-2), [900, 901]);
});

// Reservation accounting counts dispatched calls, independent of extraction success.
test('the daily reservation guard reflects consumed calls, not successful extractions', () => {
  const empty = { total_calls: 0, auto_calls: 0, manual_calls: 0, manual_searches: 0 };
  assert.equal(canReserveCall(empty, 500, 'auto', 10), true);
  // 400 dispatched automatic calls (even if many returned invalid JSON) exhaust the auto share.
  assert.equal(canReserveCall({ ...empty, total_calls: 400, auto_calls: 400 }, 500, 'auto', 10), false);
  assert.equal(canReserveCall({ ...empty, total_calls: 400, auto_calls: 400 }, 500, 'manual', 10), true);
  // After 22:00 with no manual searches the automatic share expands to the full daily limit.
  assert.equal(canReserveCall({ ...empty, total_calls: 400, auto_calls: 400 }, 500, 'auto', 22), true);
  // The total cap is the hard ceiling for both sources.
  assert.equal(canReserveCall({ total_calls: 500, auto_calls: 400, manual_calls: 100 }, 500, 'auto', 22), false);
});
