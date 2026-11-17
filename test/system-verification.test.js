import test from 'node:test';
import assert from 'node:assert/strict';
import { aiCallBudgets, neighborhoodTarget, tehranClock } from '../src/quota.js';
import { depositEquivalentToman, RENT_TO_DEPOSIT_MULTIPLIER } from '../src/rental-pricing.js';
import { isSharedHousingListing } from '../src/listing-classification.js';
import { extractListingsFromApiResponse } from '../src/scraper.js';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { refreshAggregates, computeSummary } from '../src/stats.js';
import { MODEL, MAX_COMPLETION_TOKENS, callExtractionModel, parseExtractionResult } from '../src/extractor.js';
import { EXTRACT_SLICE, JEV_SLICE, SCRAPE_PAGES_PER_INSTANCE, EXCLUDE_IDS_MAX } from '../src/constants.js';

// Run the real router and workflow SQL against SQLite; only Cloudflare's host classes,
// durable step scheduling, and external services are replaced.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') {
      return { url: 'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx, env) { this.env = env; } }', shortCircuit: true };
    }
    if (specifier === 'cloudflare:workflows') {
      return { url: 'data:text/javascript,export class NonRetryableError extends Error {}', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});
const { default: worker, DivarScrapeWorkflow } = await import('../src/index.js');

function integrationHarness(t, { limit = 50, ai, search } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-17T06:30:00Z') });
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const clock = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  sqlite.prepare("INSERT INTO system_state (key,value) VALUES ('neighborhood_discovery_last_run',?)").run(clock());
  sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'daily_listing_limit'").run(String(limit));
  sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'auto_neighborhoods'").run('["central-janat-abad"]');
  function prepare(sql) {
    let values = [];
    return {
      bind(...params) { values = params; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      execute() {
        const statement = sqlite.prepare(sql);
        if (statement.columns().length) {
          const results = statement.all(...values);
          return { results, meta: { changes: results.length } };
        }
        const result = statement.run(...values);
        return { results: [], meta: { changes: Number(result.changes) } };
      },
      async run() { return this.execute(); }
    };
  }
  const queue = [];
  const instances = new Map();
  const phases = [];
  const aiCalls = [];
  const searches = [];
  const env = {
    DB: {
      prepare,
      async batch(statements) {
        sqlite.exec('BEGIN');
        try {
          const results = statements.map(statement => statement.execute());
          sqlite.exec('COMMIT');
          return results;
        } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      }
    },
    AI: {
      async run(model, input) {
        aiCalls.push({ model, input });
        if (ai) return ai(aiCalls.length, input);
        return { response: { deposit_toman: 500_000_000, rent_toman: 3_000_000, size_m2: 75, rooms: 2, property_type: 'apartment' } };
      }
    },
    DIVAR_WORKFLOW: {
      async create({ id, params }) { instances.set(id, 'queued'); queue.push({ instanceId: id, payload: params }); return { id }; },
      async get(id) { if (!instances.has(id)) throw new Error('Not found'); return { status: async () => ({ status: instances.get(id) }) }; }
    }
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://api.divar.ir/v8/postlist/w/search');
    const body = JSON.parse(options.body);
    searches.push(body);
    return new Response(JSON.stringify(search ? search(body, searches.length) : { list_widgets: [] }));
  });
  let serial = 0;
  function listing({ source = 'auto', done = 0, label = 'unknown', title = 'Rental apartment', token, hood = 1 } = {}) {
    return Number(sqlite.prepare(`INSERT INTO listings
      (divar_token,url,title,description,neighborhood_id,scrape_source,extraction_done,fake_label,scraped_at)
      VALUES (?, 'https://divar.ir/v/test', ?, 'Rental listing', ?, ?, ?, ?, ?)`)
      .run(token || `fixture-${++serial}`, title, hood, source, done, label, clock()).lastInsertRowid);
  }
  async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await worker.fetch(new Request(`https://test.invalid${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    }), env);
    return { status: response.status, data: await response.json() };
  }
  async function drain() {
    while (queue.length) {
      assert.ok(phases.length < 100, 'workflow must terminate');
      const event = queue.shift();
      const steps = [];
      const output = await new DivarScrapeWorkflow({}, env).run(event, {
        async do(name, callback) { const result = await callback(); steps.push({ name, result }); return result; },
        async sleep() {}
      });
      phases.push({ phase: event.payload.phase, output, steps });
      instances.set(event.instanceId, 'complete');
      assert.ok(!output.failed, JSON.stringify(steps.filter(step => step.name === 'record-failure')));
    }
  }
  return { env, sqlite, request, drain, listing, queue, aiCalls, searches, phases };
}

function searchPage(tokens) {
  return { list_widgets: tokens.map(token => ({ widget_type: 'POST_ROW', data: {
    token, title: 'Rental apartment', top_description_text: 'ودیعه: ۵۰۰,۰۰۰,۰۰۰ تومان',
    middle_description_text: 'اجاره: ۳,۰۰۰,۰۰۰ تومان'
  } })) };
}

test('Verification: Tehran Clock matches UTC+3:30 schedule boundaries', () => {
  // Morning run: 06:30 UTC -> 10:00 Tehran
  const morningUtc = new Date('2026-11-04T06:30:00.000Z');
  const morningTehran = tehranClock(morningUtc);
  assert.equal(morningTehran.hour, 10, '06:30 UTC must be 10:00 Tehran');
  assert.equal(morningTehran.date, '2026-11-04');

  // Night run: 18:30 UTC -> 22:00 Tehran
  const nightUtc = new Date('2026-11-04T18:30:00.000Z');
  const nightTehran = tehranClock(nightUtc);
  assert.equal(nightTehran.hour, 22, '18:30 UTC must be 22:00 (10 PM) Tehran');
  assert.equal(nightTehran.date, '2026-11-04');
});

test('Verification: 500 Daily Quota splits 80% auto (400) and 20% manual (100)', () => {
  const budgets = aiCallBudgets(500, { total_calls: 0, auto_calls: 0, manual_calls: 0, manual_searches: 0 }, 10);
  assert.equal(budgets.auto_limit, 400);
  assert.equal(budgets.manual_limit, 100);
  assert.equal(budgets.remaining, 500);
  assert.equal(budgets.auto_remaining, 400);
  assert.equal(budgets.manual_remaining, 100);
});

test('Verification: Night run (hour >= 22) claims unused manual quota only if manual_searches == 0', () => {
  // Case A: No manual search occurred -> auto limit expands to full 500
  const budgetsUnused = aiCallBudgets(500, { total_calls: 350, auto_calls: 350, manual_calls: 0, manual_searches: 0 }, 22);
  assert.equal(budgetsUnused.auto_limit, 500);
  assert.equal(budgetsUnused.auto_remaining, 150);

  // Case B: A manual search occurred -> auto limit remains capped at 400
  const budgetsUsed = aiCallBudgets(500, { total_calls: 350, auto_calls: 350, manual_calls: 0, manual_searches: 1 }, 22);
  assert.equal(budgetsUsed.auto_limit, 400);
  assert.equal(budgetsUsed.auto_remaining, 50);
});

test('Verification: Rental formula converts rent to deposit equivalent with 100/3 ratio', () => {
  assert.equal(RENT_TO_DEPOSIT_MULTIPLIER, 100 / 3);
  // 3 million monthly rent = 100 million deposit equivalent
  const listingWithRent = { deposit_toman: 0, rent_toman: 3_000_000 };
  assert.equal(depositEquivalentToman(listingWithRent), 100_000_000);

  // 100M deposit + 6M rent = 100M + 200M = 300M equivalent
  const combined = { deposit_toman: 100_000_000, rent_toman: 6_000_000 };
  assert.equal(depositEquivalentToman(combined), 300_000_000);
});

test('Verification: Shared housing detection handles Persian zero-width non-joiner & variants', () => {
  assert.equal(isSharedHousingListing('هم‌خانه خانم نیازمندیم', ''), true);
  assert.equal(isSharedHousingListing('همخانه آقا دانشجو', ''), true);
  assert.equal(isSharedHousingListing('یک نفر هماتاقی در ونک', ''), true);
  assert.equal(isSharedHousingListing('اجاره اتاق مشترک', ''), true);
  assert.equal(isSharedHousingListing('اجاره آپارتمان کامل', '', 'room'), true);
  assert.equal(isSharedHousingListing('اجاره آپارتمان ۸۰ متری شیک', ''), false);
});

test('Verification: Divar API postlist extraction handles empty and malformed payloads gracefully', () => {
  assert.deepEqual(extractListingsFromApiResponse(null), []);
  assert.deepEqual(extractListingsFromApiResponse({}), []);
  assert.deepEqual(extractListingsFromApiResponse({ list_widgets: [] }), []);

  const mockResponse = {
    list_widgets: [
      {
        widget_type: 'POST_ROW',
        data: {
          token: 'test_token_123',
          title: 'آپارتمان ۷۰ متری فردوس',
          top_description_text: 'ودیعه: ۵۰۰,۰۰۰,۰۰۰ تومان',
          middle_description_text: 'اجاره: ۱۵,۰۰۰,۰۰۰ تومان',
          bottom_description_text: 'فردوس غرب',
          action: {
            payload: {
              web_info: {
                district_persian: 'فردوس'
              }
            }
          }
        }
      }
    ]
  };

  const results = extractListingsFromApiResponse(mockResponse);
  assert.equal(results.length, 1);
  assert.equal(results[0].token, 'test_token_123');
  assert.equal(results[0].deposit_toman, 500_000_000);
  assert.equal(results[0].rent_toman, 15_000_000);
  assert.equal(results[0].neighborhood, 'فردوس');
});

test('automatic refresh drains existing backlog before fetching more listings', async t => {
  const h = integrationHarness(t, { search: () => searchPage(['new-1', 'new-2']) });
  for (let i = 0; i < 60; i++) h.listing();
  assert.equal((await h.request('/api/refresh', {})).status, 202);
  assert.equal((await h.request('/api/refresh', {})).status, 409);
  await h.drain();
  assert.equal(h.searches.length, 0);
  assert.equal(h.aiCalls.length, 40);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM listings WHERE extraction_done = 0').get().n, 20);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM listings WHERE jev_done = 1').get().n, 40);
  assert.equal((await h.request('/api/stats')).data.pending, 20);
  assert.equal(h.sqlite.prepare("SELECT value FROM system_state WHERE key = 'workflow_running'").get().value, '0');
});

test('provider quota rejection stops immediately and unlocks at midnight UTC', async t => {
  const h = integrationHarness(t, { ai: () => { throw new Error('4006: daily free allocation exceeded'); } });
  for (let i = 0; i < 50; i++) h.listing();
  await h.request('/api/refresh', {});
  await h.drain();
  assert.equal(h.aiCalls.length, 1);
  const until = h.sqlite.prepare("SELECT value FROM system_state WHERE key = 'ai_quota_until'").get().value;
  assert.equal(Number(until), Date.parse('2026-11-18T00:00:00Z'));
  assert.equal((await h.request('/api/quota')).data.quota_exhausted, true);
  assert.ok(h.sqlite.prepare("SELECT error FROM request_logs WHERE service = 'workers-ai' AND error LIKE '%4006%'").get());
  assert.equal(h.phases.at(-1).phase, 'finalize');
  t.mock.timers.setTime(Date.parse('2026-11-18T00:00:00Z'));
  assert.equal((await h.request('/api/quota')).data.quota_exhausted, false);
});

test('manual run inserts fresh candidates after duplicates and only analyzes its own new rows', async t => {
  const h = integrationHarness(t, { search: () => searchPage(['duplicate', 'fresh']) });
  const existing = h.listing({ token: 'duplicate', source: 'manual' });
  const run = await h.request('/api/manual-runs', { neighborhood: 'central-janat-abad', count: 1 });
  assert.equal(run.status, 202);
  await h.drain();
  const status = (await h.request('/api/manual-runs/' + run.data.id)).data;
  assert.equal(status.status, 'complete');
  assert.equal(status.fetched_count, 1);
  assert.ok(status.finished_at);
  assert.equal(h.aiCalls.length, 1);
  assert.equal(h.sqlite.prepare('SELECT extraction_done FROM listings WHERE id = ?').get(existing).extraction_done, 0);
});

test('failed first search produces a failed manual run instead of an empty success', async t => {
  const h = integrationHarness(t, { search: () => { throw new Error('Upstream unavailable'); } });
  const run = await h.request('/api/manual-runs', { neighborhood: 'central-janat-abad', count: 1 });
  await h.drain();
  const status = (await h.request('/api/manual-runs/' + run.data.id)).data;
  assert.equal(status.status, 'failed');
  assert.ok(status.error);
  assert.ok(status.finished_at);
  assert.equal(h.aiCalls.length, 0);
});

test('manual quota exhaustion still classifies successful rows and refreshes aggregates', async t => {
  const h = integrationHarness(t, { limit: 10, search: () => searchPage(['one', 'two']), ai: count => {
    if (count === 2) throw new Error('4006 daily free allocation exceeded');
    return { response: { size_m2: 75, deposit_toman: 500_000_000 } };
  } });
  const run = await h.request('/api/manual-runs', { neighborhood: 'central-janat-abad', count: 2 });
  await h.drain();
  assert.equal((await h.request('/api/manual-runs/' + run.data.id)).data.status, 'quota_exhausted');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM listings WHERE jev_done = 1').get().n, 1);
  assert.equal((await h.request('/api/stats')).data.count, 2);
  assert.equal(h.phases.at(-1).phase, 'finalize');
});

test('manual source quota does not set a global provider lock or exceed its share', async t => {
  const h = integrationHarness(t, { limit: 10 });
  for (let i = 0; i < 4; i++) h.listing({ source: 'manual' });
  await h.request('/api/refresh', {});
  h.queue[0].payload = { ...h.queue[0].payload, phase: 'extract', source: 'manual', date: '2026-11-17', dailyLimit: 10 };
  await h.drain();
  assert.equal(h.aiCalls.length, 2);
  assert.equal((await h.request('/api/quota')).data.quota_exhausted, false);
  assert.equal((await h.request('/api/quota')).data.auto_remaining, 8);
});

test('AI call accounting uses the actual Tehran date after midnight during a chain', async t => {
  const h = integrationHarness(t);
  h.listing(); h.listing();
  await h.request('/api/refresh', {});
  h.queue[0].payload = { ...h.queue[0].payload, phase: 'extract', source: 'auto', date: '2026-11-16', dailyLimit: 50 };
  await h.drain();
  assert.equal((await h.request('/api/quota')).data.used, 2);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM daily_ai_usage WHERE usage_date = '2026-11-16'").get().n, 0);
});

test('empty databases can refresh all aggregate tables', async t => {
  const h = integrationHarness(t);
  await refreshAggregates(h.env);
  assert.equal((await h.request('/api/stats')).data.count, 0);
  assert.equal((await h.request('/api/listings')).data.total, 0);
});

test('failed legacy analyses have an explicit filter separate from pending', async t => {
  const h = integrationHarness(t);
  h.listing({ done: -1 }); h.listing(); h.listing({ done: 1, label: 'real' });
  const failed = await h.request('/api/listings?label=failed');
  assert.equal(failed.data.total, 1);
  assert.equal(failed.data.listings[0].extraction_done, -1);
  assert.equal((await h.request('/api/listings?label=pending')).data.total, 1);
});

test('JSON request validation returns client errors for null and array payloads', async t => {
  const h = integrationHarness(t);
  for (const path of ['/api/manual-runs', '/api/settings']) {
    for (const body of [null, [], 5]) assert.equal((await h.request(path, body)).status, 400);
  }
});

test('settings, analytics, listing filters, logs and scheduled execution work together', async t => {
  const h = integrationHarness(t);
  h.listing();
  const settings = (await h.request('/api/settings')).data;
  assert.equal((await h.request('/api/settings', { ...settings, settings_password: 'invalid' })).status, 403);
  assert.equal((await h.request('/api/settings', { ...settings, fake_threshold: 0, high_fake_threshold: 0, settings_password: '1311' })).status, 200);
  assert.equal((await h.request('/api/settings')).data.fake_threshold, 0);
  assert.equal((await h.request('/api/analytics?neighborhood=not-a-place')).status, 404);
  assert.equal((await h.request('/api/manual-runs', { neighborhood: 'not-a-place', count: 1 })).status, 404);
  const pending = [];
  await worker.scheduled({ cron: '30 6,18 * * *' }, h.env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  await h.drain();
  const analytics = (await h.request('/api/analytics')).data;
  assert.equal(analytics.overall.count, 1);
  assert.equal(analytics.overall.pending, 0);
  assert.equal((await h.request('/api/listings?label=fake')).data.total, 1);
  const live = await computeSummary(h.env, 30);
  assert.equal(analytics.overall.median_deposit, live.median_deposit);
  assert.equal((await h.request('/api/logs?service=system&status=error')).data.length, 0);
});

test('AI extraction parser rejects non-object results and accepts valid object envelopes', () => {
  for (const value of ['[]', '42', 'true', '{"deposit_toman":"not money"}', { error: 'upstream error' }]) {
    assert.equal(parseExtractionResult(value), null);
  }
  assert.equal(parseExtractionResult({ response: { deposit_toman: 500_000_000 } }).deposit_toman, 500_000_000);
});

test('extraction uses one bounded, non-thinking request to a Free-compatible replacement', async () => {
  const calls = [];
  const response = { choices: [{ message: { content: '{"size_m2":75}' }, finish_reason: 'stop' }] };
  const env = { AI: { async run(...args) { calls.push(args); return response; } } };
  assert.equal(await callExtractionModel(env, { title: 'x'.repeat(1000), description: 'y'.repeat(10000) }), response);
  assert.equal(MODEL, '@cf/google/gemma-4-26b-a4b-it');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2, 'no paid gateway options');
  const [model, input] = calls[0];
  assert.equal(model, MODEL);
  assert.equal(input.max_completion_tokens, MAX_COMPLETION_TOKENS);
  assert.equal(MAX_COMPLETION_TOKENS, 768);
  assert.deepEqual(input.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(input.response_format, { type: 'json_object' });
  assert.equal(input.temperature, 0);
  assert.ok(input.messages[1].content.length < 5500, 'bound listing text and title');
  await assert.rejects(callExtractionModel({}, {}), /binding is unavailable/);
});

function completion(content, finish_reason = 'stop', extra = {}) {
  return { object: 'chat.completion', choices: [{ message: { content, ...extra }, finish_reason }] };
}

test('parser supports Cloudflare chat completions and legacy response formats', () => {
  const facts = { deposit_toman: 500_000_000, rent_toman: 0, size_m2: 75, rooms: null, rent_deposit_flexible: false };
  const text = JSON.stringify(facts);
  for (const raw of [facts, text, { response: facts }, { response: text }, { output_text: text },
    completion(text), { response: completion(text) }, completion('  ```json\n' + text + '\n```  ')]) {
    assert.deepEqual(parseExtractionResult(raw), facts);
  }
});

test('parser rejects reasoning-only, refused and truncated chat completions', () => {
  for (const raw of [completion(null, 'length', { reasoning: '{"size_m2":75}' }),
    completion('{"size_m2":75}', 'length'), completion('{"size_m2":75}', 'content_filter'),
    completion('{"size_m2":75}', 'stop', { refusal: 'Refused' }), completion('{"size_m2":'),
    completion(''), { choices: [] }, { choices: null }]) {
    assert.equal(parseExtractionResult(raw), null);
  }
});

test('parser rejects invalid fact types without coercing AI output into database fields', () => {
  for (const fields of [{ rent_deposit_flexible: 'false' }, { has_bait_signals: 1 },
    { description: {} }, { property_type: 'unknown' }, { suspicious_phrases: 'phrase' },
    { suspicious_phrases: [42] }, { size_m2: Infinity }, { size_m2: -1 }]) {
    assert.equal(parseExtractionResult({ size_m2: 75, ...fields }), null);
  }
});

test('explicit full-deposit conversion uses deterministic arithmetic on quoted amounts', () => {
  const quoted = { deposit_toman: 100_000_000, rent_toman: 6_000_000,
    rent_deposit_flexible: true, convert_to_full_deposit: true };
  const converted = parseExtractionResult(completion(JSON.stringify(quoted)));
  assert.equal(converted.deposit_toman, 300_000_000);
  assert.equal(converted.rent_toman, 0);
  assert.equal(quoted.rent_toman, 6_000_000, 'raw model output must not be mutated');
  assert.deepEqual(parseExtractionResult(converted), converted, 'conversion is idempotent');
  assert.equal(parseExtractionResult({ ...quoted, deposit_toman: 0 }).deposit_toman, 200_000_000);
  assert.equal(parseExtractionResult({ ...quoted, deposit_toman: 0, rent_toman: 0 }).deposit_toman, 0);
  for (const changed of [{ rent_deposit_flexible: false }, { deposit_toman: null },
    { rent_toman: null }, { convert_to_full_deposit: 'true' }, { rent_toman: Number.MAX_VALUE }]) {
    assert.equal(parseExtractionResult({ ...quoted, ...changed }), null);
  }
  const negotiable = { ...quoted, convert_to_full_deposit: false };
  assert.deepEqual(parseExtractionResult(negotiable), negotiable);
});

test('chat-completion extraction reaches classification and cached statistics', async t => {
  const h = integrationHarness(t, { ai: () => completion(JSON.stringify({
    size_m2: 75, deposit_toman: 500_000_000, rent_toman: 3_000_000, property_type: 'apartment'
  })) });
  h.listing();
  await h.request('/api/refresh', {});
  await h.drain();
  assert.equal(h.aiCalls.length, 1);
  const row = h.sqlite.prepare('SELECT extraction_done, jev_done, deposit_toman FROM listings').get();
  assert.equal(row.extraction_done, 1);
  assert.equal(row.jev_done, 1);
  assert.equal(row.deposit_toman, 500_000_000);
  assert.equal((await h.request('/api/stats')).data.pending, 0);
});

test('workflow slices and deployment settings retain Free-plan-compatible limits', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(EXTRACT_SLICE <= 40 && JEV_SLICE <= 40 && SCRAPE_PAGES_PER_INSTANCE <= 32);
  assert.ok(EXCLUDE_IDS_MAX + 4 <= 100);
  assert.equal(config.workflows[0].concurrency.limit, 1);
  assert.equal(config.limits, undefined, 'no paid-only CPU or subrequest overrides');
  assert.deepEqual(config.ai, { binding: 'AI' });
});

// Opt-in only: a local verification endpoint backed by the real Workers AI binding.
// Never runs during npm test; live inference consumes the account's free Neuron allocation.
test('live Persian extraction fixtures', { skip: !process.env.EXTRACTION_LIVE_URL }, async t => {
  const url = new URL(process.env.EXTRACTION_LIVE_URL);
  assert.equal(url.hostname, '127.0.0.1', 'live tests must use an explicitly started local verification endpoint');
  const fixtures = [
    { title: 'آپارتمان ۷۵ متری', description: 'ودیعه ۵۰۰ میلیون تومان، اجاره ۳ میلیون تومان، دو خواب',
      expected: { deposit_toman: 500_000_000, rent_toman: 3_000_000, size_m2: 75, rooms: 2, rent_deposit_flexible: false } },
    { title: 'آپارتمان ٦٧ متری', description: 'ودیعه: ١,٥٠٠,٠٠٠,٠٠٠ تومان | رهن کامل',
      expected: { deposit_toman: 1_500_000_000, rent_toman: 0, size_m2: 67, rooms: null, rent_deposit_flexible: false } },
    { title: 'آپارتمان ۸۰ متری دو خواب', description: 'ودیعه ۱۰۰ میلیون تومان، اجاره ۶ میلیون تومان. قابل تبدیل کامل به رهن با نرخ هر سه میلیون اجاره معادل صد میلیون ودیعه.',
      expected: { deposit_toman: 300_000_000, rent_toman: 0, size_m2: 80, rooms: 2, rent_deposit_flexible: true } },
    { title: 'آپارتمان ۹۰ متری', description: 'فقط دو حالت: ۴۰۰ میلیون ودیعه و ۱۲ میلیون اجاره، یا ۷۰۰ میلیون ودیعه و ۳ میلیون اجاره. تبدیل دیگری نداریم.',
      expected: { deposit_toman: 700_000_000, rent_toman: 3_000_000, size_m2: 90 } },
    { title: 'آپارتمان اجاره‌ای', description: 'قیمت، تعداد اتاق و متراژ اعلام نشده است.',
      expected: { deposit_toman: null, rent_toman: null, size_m2: null, rooms: null, rent_deposit_flexible: false } },
    { title: 'هم‌خانه خانم', description: 'اجاره اتاق مشترک. ودیعه ۵۰ میلیون تومان و اجاره ۱۰ میلیون تومان.',
      expected: { deposit_toman: 50_000_000, rent_toman: 10_000_000, property_type: 'room', rent_deposit_flexible: false } }
  ];
  for (const [i, fixture] of fixtures.entries()) {
    const model = process.env.EXTRACTION_COMPARE_QWEN ? '@cf/qwen/qwen3.8-27b' : MODEL;
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, listing: { title: fixture.title, description: fixture.description } }),
      signal: AbortSignal.timeout(90_000) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    await t.test(`fixture ${i + 1}`, () => {
      t.diagnostic(JSON.stringify({ model, fixture: i + 1, ms: result.elapsed_ms,
        usage: result.raw?.usage, finish: result.raw?.choices?.[0]?.finish_reason, facts: result.facts }));
      assert.ok(result.facts, 'complete, valid extraction JSON required');
      for (const [field, value] of Object.entries(fixture.expected)) assert.equal(result.facts[field], value, field);
    });
  }
});

test('manual runs can search past four duplicate-heavy pages', async t => {
  const h = integrationHarness(t, { limit: 500, search: body => searchPage(Array.from({ length: 30 }, (_, i) => `page-${body.pagination_data.page}-${i}`)) });
  for (let page = 1; page <= 4; page++) for (let i = 0; i < 30; i++) h.listing({ token: `page-${page}-${i}` });
  const run = await h.request('/api/manual-runs', { neighborhood: 'central-janat-abad', count: 100 });
  await h.drain();
  assert.equal((await h.request('/api/manual-runs/' + run.data.id)).data.status, 'complete');
  assert.equal(h.aiCalls.length, 100);
  assert.ok(h.searches.length > 4);
});

test('manual run with invalid extraction does not claim complete', async t => {
  const h = integrationHarness(t, { search: () => searchPage(['bad-json']), ai: () => '[]' });
  const run = await h.request('/api/manual-runs', { neighborhood: 'central-janat-abad', count: 1 });
  await h.drain();
  const status = (await h.request('/api/manual-runs/' + run.data.id)).data;
  assert.equal(status.status, 'failed');
  assert.equal(status.fetched_count, 1);
  assert.ok(status.error);
});

