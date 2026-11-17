# Divar Housing Finder

**Live dashboard:** [divar-housing-finder.lizadfarshid.workers.dev](https://divar-housing-finder.lizadfarshid.workers.dev/) · **Persian documentation:** [DOCUMENTATION_FA.md](./DOCUMENTATION_FA.md)

A Cloudflare Worker that samples Tehran rental listings from Divar, extracts listing details with Workers AI, evaluates suspicious prices, and serves a Persian, right-to-left dashboard backed by Cloudflare D1.

Documentation aligned with application commit `b73f7ba` on November 17, 2026. The deployment remains compatible with **Cloudflare Workers Free**; no paid gateway, paid model fallback, or paid-only CPU/subrequest override is configured. Markdown sources are updated in this edition; the existing PDFs and screenshots have not been regenerated.

The application models Divar neighborhoods directly. It has no municipal-region table, neighborhood-to-region map, or region filter. Automatic neighborhood refresh runs at most once every seven days; an explicit refresh is also available. These endpoints and their response formats can change without notice.

## Dashboard

- The overview shows the five neighborhoods with the most collected listings in the last 30 days.
- A searchable neighborhood selector shows analysis for one neighborhood; it is limited to neighborhoods with listings.
- Deposit is the primary comparison metric: the dashboard shows average and median deposit, median deposit per square meter, monthly rent, counts, and daily deposit trends. Prices are asking prices from listings, not verified contract prices.
- Neighborhood statistics include listing count, average and median deposit and rent, fake/suspicious counts, and last scrape time; the table is searchable, sortable, and paginated.
- Listing cards show extracted deposit, rent, size, room count, description, review status, and a link to Divar.
- Listing filters distinguish pending extraction (`extraction_done = 0`) from failed/unextractable legacy records (`extraction_done = -1`). Shared housing is shown only with the `hamkhane` filter, not in the default listing count.
- Manual scraping accepts one neighborhood and a requested number of listings. Controls are disabled while a run/workflow is active, when the manual share is zero, or when the provider lock is active. Status polling retries after temporary network failures.
- Listing and neighborhood searches are debounced by 250 ms and discard stale responses. Opening listings from a neighborhood row sets the filter and resets pagination first.
- **Refresh statistics** starts an automatic workflow, polls its lease state every five seconds, and reloads the views after it ends. Cached headline counts can remain unchanged while processing is active.
- Automatic scraping only visits selected neighborhoods. Its default list includes central/south/north Jannat Abad, Shahin, Sardar-e-Jangal, and Ferdos.

## Daily schedule and AI capacity

Cloudflare cron expressions use UTC. `30 6,18 * * *` runs at 10:00 and 22:00 Tehran time (UTC+3:30). Automatic work gives greater weight to neighborhoods with fewer fresh listings and longer time since their last check. A neighborhood with fewer current ads does not hold up the rest; its unused capacity flows to the remaining selected neighborhoods. It checks current Divar results instead of backfilling old ads.

Automatic ingestion first subtracts the existing **automatic** extraction backlog from its remaining call budget: `scrapeRemaining = max(0, auto_remaining - pendingBeforeRun)`. When the backlog fills that budget, the run skips new ingestion and processes older pending automatic rows first. Existing listings are not deleted. Old manual pending rows are not part of this automatic queue.

`listingPagesFor(target)` computes a page budget of `min(20, max(3, ceil(target / 30) * 3))`. Manual runs use this budget, up to 20 pages; automatic runs additionally cap each neighborhood at four pages. A scrape instance visits at most eight neighborhoods and 32 pages. Empty results or reaching the insertion target end a search early. Existing tokens are removed **before** selecting enough candidates to fill the target; "fetched" counts newly inserted ads, not all returned results.

The manual flow checks its share and provider lock before accepting a run (429 if unavailable), and rejects a busy workflow with 409. The response reports `effective_count = min(requested, manual_remaining)`; planning rechecks available capacity. It records `MAX(listings.id)` as an `afterId` boundary and extracts only newer manual rows in that neighborhood, newest scrape time first. It does not consume an older manual backlog.

After scraping, status remains `scraped` until downstream processing and finalization. `finalizeManual` checks errors, quota exhaustion, and unfinished extraction/classification before using the count-based `manualRunOutcome` helper. `complete` requires all requested new rows to be extracted and classified; `partial` means fewer new rows were found but those rows finished processing; `empty` means a successful search found none. Scrape errors or unfinished analysis produce `failed`, and quota exhaustion produces `quota_exhausted`. Successful extractions still reach classification and the statistics-refresh step when quota runs out. A statistics-refresh failure is logged and nonfatal, so `complete` does not guarantee a fresh cache; check `stats_computed_at`.

Two independent budgets apply:

- **Application calls:** `daily_listing_limit` is configurable from 3 to 500. The code/schema default is 500 (400 automatic / 100 manual), but the last verified production setting on November 17, 2026 was **300 (240 automatic / 60 manual)** and was not increased. Read `/api/quota` for the current saved value. Both remaining shares are capped by the total remaining budget. At or after 22:00 Tehran, automation can use unused manual capacity only if `manual_searches = 0` that day.
- **Workers AI Neurons:** the Free allocation is **10,000 Neurons per account per day**, shared with local live-AI tests and other applications. It resets at **00:00 UTC (03:30 Tehran)**, independently of the application's Tehran-local date. Calls are not Neurons; the application does not aggregate or enforce Neuron usage, even when raw model responses contain usage metadata. A 300- or 500-call cap cannot guarantee staying within the Neuron allocation.

Each dispatch is reserved atomically against the actual Tehran date before calling AI, including attempts that fail or return invalid facts. Provider quota rejection stops dispatch immediately, even within a five-item commit chunk, and sets `ai_quota_until` to the next midnight UTC. Application-share exhaustion does **not** set that global provider lock. Expiration allows a later scheduled/on-demand run; it does not create a run at midnight. Free exhaustion is not bypassed by upgrading or switching to a paid model.

## Extraction model and pricing

`src/extractor.js` uses **`@cf/google/gemma-4-26b-a4b-it`**, replacing `@cf/qwen/qwen3-30b-a3b-fp8` ahead of its November 20, 2026 retirement. Requests use JSON object mode, `chat_template_kwargs: { enable_thinking: false }`, `max_completion_tokens: 768`, and `temperature: 0`. The title is limited to 300 characters and supplementary text to 4,000 characters. There is no model fallback.

The model extracts quoted amounts in toman, preserves unknown facts as `null`, treats full-deposit rent as zero, and selects the highest-deposit option when several specific payment options are listed. Only explicit permission for full conversion sets `convert_to_full_deposit = true`; negotiation alone does not. With known deposit/rent and `rent_deposit_flexible = true`, JavaScript computes `round(deposit + rent * 100 / 3)` and stores zero rent. For example, 100 million deposit plus 6 million rent becomes 300 million deposit. The separate deposit-equivalent metric enables comparison even when conversion is not offered; it does not imply the landlord accepts that payment arrangement.

Parsing supports direct fact objects, JSON strings, `response`, `output_text`, and `choices[0].message.content`. Truncated, refused, reasoning-only, empty, malformed, or incorrectly typed output is rejected. Invalid output stays pending and is logged; parsing never makes a replacement AI call. Recent failed IDs are skipped within the chain (bounded to 90), not permanently abandoned. Only a listing without extractable text is newly marked `-1` without an AI call. Legacy `-1` records remain separately filterable.

Six Persian live fixtures passed with the final Gemma prompt, using approximately 6.6–8.0 Neurons each. A bounded Qwen 3.8 27B comparison with an earlier prompt, low reasoning, and the same 768-token cap used approximately 110–238 Neurons per sample and had three assertion failures, including two truncated responses. This supports the chosen configuration for this workload, not a general model-quality ranking or a guaranteed listings-per-day capacity.

## Bounded workflow architecture

A logical run chains `plan → scrape → extract → jev → finalize` across separate Workflow instances. Extraction processes at most 40 rows per instance and commits at most five results per chunk; classification processes at most 40 rows per instance. Successful durable AI step results can be reused without repeating the call just to parse or commit them. A full slice continues only if it made durable progress; quota/subrequest failures stop further extraction for that chain, while completed rows can continue to classification/finalization.

Workflow concurrency is configured to one. A renewable lease in `system_state.workflow_running` has the form `run:<runId>:<epochMs>` and becomes stale after 30 minutes. Owner checks protect finalization/release; deterministic successor IDs avoid duplicate children. `chain_state` is an observability mirror, not the source of queue correctness. `jevPhase` selects all extracted, unclassified ordinary listings, not only the current manual run. Optional TypeSafe Jev evaluation requires its own key and service terms; without it, or on remote failure, local heuristics are used.

Official references (checked November 17, 2026): [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Gemma model](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/), [thinking configuration](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/), [model retirement](https://developers.cloudflare.com/changelog/post/2026-11-05-planned-model-deprecations/), [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). Compatibility does not guarantee every workload stays under every account quota.

## Database and migration

The schema contains neighborhoods, listings, daily AI usage, manual-run status, settings, system_state, and request logs, plus two precomputed analytics caches: `neighborhood_stats` (per neighborhood and window, with a synthetic `neighborhood_id = 0` city row) and `daily_stats`. The old region hierarchy, mapping data, scrape state, and listings are removed by the rebuild migration.

**`0001_neighborhood_first_rebuild.sql` is destructive:** it drops the old listing and location tables and starts with an empty listings table. Back up a database before applying it. The migration seeds the six resolvable default Divar neighborhoods and default automatic selection. A separate entry for “بلوار فردوس” is not present in Divar's Tehran neighborhood list; the closest matching place is “فردوس”, which is already selected, so it is not duplicated.

`0002_daily_quota_and_listing_reclassification.sql` is a historical data-changing migration: it sets the saved daily limit to 150, recalculates deposit-equivalent amounts, identifies shared-room listings, and queues other extracted listings for reevaluation. It is not a routine upgrade step for the current deployment.

`0003_retry_failed_extractions.sql` re-queues prior extraction failures without deleting listings. It can expand the backlog; apply only as an intentional maintenance action after reviewing its SQL and available quota.

`0004_increase_daily_quota_to_500.sql` explicitly overwrites the saved daily limit with 500. Do **not** rerun it as part of model replacement or routine deployment; preserving the production quota does not require it.

`0005_precomputed_stats.sql` adds the analytics tables and prepares their marker. Apply it once only if an older database lacks them. Finalization refreshes 30-day neighborhood/city statistics, a city-wide all-time listing count, and the city daily trend. `COALESCE` protects empty aggregate counts. Before the marker exists, or for other windows, readers use live SQL; selected-neighborhood daily trends and filtered listing queries also remain live. Cached headline counts are snapshots, not continuous progress counters:

```sh
npm run db:migrate-precomputed-stats
```

The cache reduces repeated full-window dashboard aggregation under D1's Free read allowance. It does not eliminate listing reads, classification queries, or the cost of rebuilding aggregates. Free D1 allowances include 5 million rows read/day, 100,000 rows written/day, and 5 GB total storage.

The backlog/quota fixes and Gemma migration require **no schema migration, database reset, or quota increase**. Preserve the existing data and saved settings.

For a new database:

```sh
npm run db:init
npm run db:seed
```

Use the corresponding `-local` commands for local D1. The current schema already includes the analytics tables. The rebuild migration is not part of new-database initialization or routine deployment; it is only for an intentional reset of an older database after backup.

## Development and deployment

Requirements: **Node.js 24 recommended** (verified with 24.11.0), npm, and Cloudflare Workers Free with D1, Workers AI, and Workflows. The tests use `node:sqlite` and `node:module.registerHooks`; Node 20 is insufficient, and Node 22 must be at least 22.15.0 for the hook API.

```sh
npm ci
npm test
npm run db:init-local
npm run db:seed-local
npm run dev
```

For a separate deployment, configure your D1 database ID in `wrangler.jsonc` and authenticate Wrangler. This project's normal production path is **push to `main` → automatic Cloudflare deployment**; `npm run deploy` is an explicit manual alternative, not an extra required step. Migrations are not run automatically. Keep any optional `TYPESAFE_API_KEY` as a Cloudflare secret; its external service billing is separate from Cloudflare Free.

`npm test` currently reports **56 passed, zero failed, one opt-in live test skipped** across five test files. Integration tests run the real router/workflow SQL against in-memory SQLite with mocked Cloudflare scheduling and external services; they do not consume live AI quota. Coverage includes backlog-first processing, duplicate-heavy pagination, manual-run isolation, provider reset timing, finalization after quota exhaustion, empty aggregates, parser formats/types, deterministic conversion, leases, and bounded workflow slices.

The `live Persian extraction fixtures` test is enabled only by `EXTRACTION_LIVE_URL`. It requires a deliberately created local verification endpoint at `127.0.0.1` that accepts `{ model, listing }` and returns `{ facts, raw, elapsed_ms }`; the ordinary app does not expose that endpoint. The temporary comparison worker was removed after verification. Live inference through Wrangler still uses the real account's Neurons. Do not enable it during ordinary tests or point it at the production app.

## Documentation

- `README.md` — Persian user guide, dashboard control reference, flow diagrams, and API notes.
- `DOCUMENTATION_FA.md` — Persian analysis and design document (business domain, data model, data dictionary, read/write analysis, verification, setup).
- `OOAD_MANUAL_FETCH_FA.md` — Persian manual-fetch analysis/design, state/sequence diagrams, implementation traceability, and remaining limitations. Its OO classes are conceptual, not additional JavaScript classes.
- `docs/screenshots/` — illustrative mock-data screenshots; they have not been recaptured for this edition and may show earlier quota values or controls.
- **Next publishing step:** regenerate `DOCUMENTATION_FA.pdf` with `npm run docs:pdf` and `OOAD_MANUAL_FETCH_FA.pdf` with `npm run docs:ooad-pdf` from the updated Markdown. The current PDFs predate this edition. The builder needs Chrome/Chromium (`CHROME_PATH` if needed) and downloads/caches rendering assets on first use.

## API

- `GET /api/analytics?days=30&neighborhood=<slug>` — overall and selected-neighborhood metrics, five most active neighborhoods, and daily deposit trend; cached responses include `stats_computed_at`.
- `GET /api/stats` — city-wide 30-day summary using the same `overall` shape as analytics.
- `GET /api/neighborhoods?page=1&page_size=20&search=<text>&sort=count` — neighborhood statistics; `all=1` returns the full active list for selection controls.
- `GET /api/listings?page=1&page_size=20&neighborhood=<slug>&label=suspicious&search=<text>` — searchable, filtered, paginated listings, with parsed `extracted_data`. Labels: `real`, `suspicious`, `fake`, `hamkhane`, `pending`, `failed`; `failed` is an extraction filter, not a stored fraud label.
- `POST /api/manual-runs` — start a manual search with `{ "neighborhood": "<slug>", "count": 10 }`; 202 returns `requested_count` and `effective_count`. Invalid JSON/non-object bodies or invalid counts return 400, unknown neighborhoods 404, busy workflows 409, and unavailable quota 429.
- `GET /api/manual-runs/<id>` — inspect manual-run status (`queued`, `running`, `scraped`, `complete`, `partial`, `empty`, `quota_exhausted`, `failed`) and its localized label.
- `GET /api/quota` — daily AI calls, automatic/manual budgets, `auto_remaining`, `manual_remaining`, `remaining`, provider-lock flag `quota_exhausted`, and active-lease flag `workflow_running`. A false provider-lock flag does not mean an application share remains available.
- `GET /api/settings` and `POST /api/settings` — read or update selected automatic neighborhoods and analysis thresholds (password required: `1311`).
- `GET /api/logs?limit=100` — recent service logs.
- `POST /api/discover-neighborhoods` — explicitly refresh the neighborhood list.
- `POST /api/refresh` — start the automatic workflow on demand (202), including backlog processing; returns 409 if busy. It can consume automatic AI quota and is not merely a cache-read endpoint.

`POST /api/settings` also rejects invalid JSON and non-object bodies with 400; an incorrect settings password returns 403.

## Operational notes

The dashboard has no authentication, and the deployed URL is published in this README. Anyone with the link can start manual runs and consume the daily AI quota; put the deployment behind Cloudflare Access or a similar gate if that is a concern. Divar may block automated requests or change its internal endpoints. Check the applicable terms and local requirements before operating a scraper. Fake-price labels are review signals, not definitive claims about advertisers.

