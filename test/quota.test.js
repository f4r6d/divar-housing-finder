import test from 'node:test';
import assert from 'node:assert/strict';
import { aiCallBudgets, neighborhoodTarget, tehranClock } from '../src/quota.js';

test('reserves four fifths of the daily calls for automatic processing', () => {
  assert.deepEqual(aiCallBudgets(100, { total_calls: 20, auto_calls: 20, manual_calls: 0 }), {
    auto_limit: 80,
    manual_limit: 20,
    remaining: 80,
    auto_remaining: 60,
    manual_remaining: 20
  });
});

test('only releases the manual reserve to automation after 10pm when unused', () => {
  assert.equal(aiCallBudgets(500, { auto_calls: 400, manual_searches: 0 }, 22).auto_remaining, 100);
  assert.equal(aiCallBudgets(500, { auto_calls: 400, manual_searches: 1 }, 22).auto_remaining, 0);
});

test('reports the manual share and remaining capacity separately', () => {
  const budgets = aiCallBudgets(100, {
    total_calls: 90,
    auto_calls: 80,
    manual_calls: 10,
    manual_searches: 1
  }, 14);
  assert.equal(budgets.manual_remaining, 10);
  assert.equal(budgets.remaining, 10);
  assert.equal(budgets.auto_remaining, 0);
});

test('reserves 400 automatic and 100 manual calls from a 500-call daily limit', () => {
  assert.deepEqual(aiCallBudgets(500, {
    total_calls: 134,
    auto_calls: 100,
    manual_calls: 34
  }), {
    auto_limit: 400,
    manual_limit: 100,
    remaining: 366,
    auto_remaining: 300,
    manual_remaining: 66
  });
});

test('uses Tehran local date and hour for schedule boundaries', () => {
  assert.deepEqual(tehranClock(new Date('2026-10-06T06:30:00.000Z')), {
    date: '2026-10-06',
    hour: 10
  });
  assert.equal(tehranClock(new Date('2026-10-06T18:30:00.000Z')).hour, 22);
});

test('prioritizes neighborhoods with fewer recent listings and reassigns unused capacity', () => {
  const neighborhoods = [
    { recent_count: 2, last_scraped_at: null },
    { recent_count: 20, last_scraped_at: null }
  ];
  const firstTarget = neighborhoodTarget(neighborhoods, 0, 60);
  const secondTarget = neighborhoodTarget(neighborhoods, 1, 60 - firstTarget);
  assert.ok(firstTarget > secondTarget);
  assert.equal(neighborhoodTarget(neighborhoods, 1, 1), 1);
});
