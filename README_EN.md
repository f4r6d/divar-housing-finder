# Divar Housing Finder

**Live dashboard:** [divar-housing-finder.lizadfarshid.workers.dev](https://divar-housing-finder.lizadfarshid.workers.dev/) · **Persian documentation:** [DOCUMENTATION_FA.md](./DOCUMENTATION_FA.md)

A Cloudflare Worker that samples Tehran rental listings from Divar, extracts listing details with Workers AI, evaluates suspicious prices, and serves a Persian, right-to-left dashboard backed by Cloudflare D1.

The application models Divar neighborhoods directly. It has no municipal-region table, neighborhood-to-region map, or region filter. Automatic neighborhood refresh runs at most once every seven days; an explicit refresh is also available. These endpoints and their response formats can change without notice.

## Dashboard

- The overview shows the five neighborhoods with the most collected listings in the last 30 days.
- A searchable neighborhood selector shows analysis for one neighborhood; it is limited to neighborhoods with listings.
- Deposit is the primary comparison metric: the dashboard shows average and median deposit, median deposit per square meter, monthly rent, counts, and daily deposit trends. Prices are asking prices from listings, not verified contract prices.
- Neighborhood statistics include listing count, average and median deposit and rent, fake/suspicious counts, and last scrape time; the table is searchable, sortable, and paginated.
- Listing cards show extracted deposit, rent, size, room count, description, review status, and a link to Divar.
- Manual scraping accepts one neighborhood and a requested number of listings. The count input is capped by the manual share remaining today; the quota panel shows it, and when the share is zero the input and start button are disabled.
- Automatic scraping only visits selected neighborhoods. Its default list includes central/south/north Jannat Abad, Shahin, Sardar-e-Jangal, and Ferdos.

## Daily schedule and AI capacity

Cloudflare cron expressions use UTC. `30 6,18 * * *` runs at 10:00 and 22:00 Tehran time (UTC+3:30). Automatic work gives greater weight to neighborhoods with fewer fresh listings and longer time since their last check. A neighborhood with fewer current ads does not hold up the rest; its unused capacity flows to the remaining selected neighborhoods. It checks current Divar results instead of backfilling old ads.

Fetch depth follows the quota target instead of a fixed page count: `min(20, max(3, ceil(target / 30) * 3))` pages of 30 ads each. A target of 90 ads searches at least 9 pages; a 310-ad target searches 20 pages, the cap. Because `divar_token` is unique, rerunning a search mainly returns duplicates; "fetched" in the UI counts newly inserted ads only.

The manual flow checks the manual share before creating a run. If the share is zero, `POST /api/manual-runs` returns 429 and no workflow starts. Otherwise the effective target is `min(requested, manual_remaining)`, returned as `effective_count`, and the run finishes as `complete`, `partial`, `empty`, `quota_exhausted`, or `failed`. Manual extraction analyzes the newest ads first.

The daily limit is a count of Workers AI processing calls, not a count of model tokens or neurons. The current AI binding does not expose token/neuron usage to this application. The configured 500-call daily limit reserves 400 calls for automatic work and 100 for manual work. At 22:00, automation can use the unused manual reserve only if no manual search was started that Tehran day. Cloudflare's account-level neuron limit still applies; if Workers AI reports quota exhaustion, the existing quota lock stops subsequent AI calls for up to 24 hours.

## Database and migration

The schema contains neighborhoods, listings, daily AI usage, manual-run status, settings, system_state, and request logs, plus two precomputed analytics caches: `neighborhood_stats` (per neighborhood and window, with a synthetic `neighborhood_id = 0` city row) and `daily_stats`. The old region hierarchy, mapping data, scrape state, and listings are removed by the rebuild migration.

**`0001_neighborhood_first_rebuild.sql` is destructive:** it drops the old listing and location tables and starts with an empty listings table. Back up a database before applying it. The migration seeds the six resolvable default Divar neighborhoods and default automatic selection. A separate entry for “بلوار فردوس” is not present in Divar's Tehran neighborhood list; the closest matching place is “فردوس”, which is already selected, so it is not duplicated.

`0002_daily_quota_and_listing_reclassification.sql` is non-destructive and should be run once on an existing database after deploying a release that supports 150 daily calls. It raises the saved daily setting to 150, recalculates deposit-equivalent amounts using 100 million toman deposit = 3 million toman monthly rent, identifies existing shared-room listings, and queues the remaining extracted listings for a fresh label evaluation.

`0003_retry_failed_extractions.sql` re-queues prior extraction failures for automatic retry; apply it once after the daily capacity is available.

`0004_increase_daily_quota_to_500.sql` sets the saved daily limit to 500 calls, split 400 automatic and 100 manual by the application. Workers AI's account-level neuron quota is separate and remains enforced by Cloudflare.

`0005_precomputed_stats.sql` adds the `neighborhood_stats` and `daily_stats` cache tables plus the `stats_computed_at` marker. It is additive and safe on a live database. Once applied, the end-of-workflow `refresh-stats` step keeps the caches current; endpoints fall back to live SQL until the marker exists and for windows other than 30 days, so deploying without the migration does not break the dashboard. Apply it before the first deployment that depends on the cache:

```sh
npm run db:migrate-precomputed-stats
```

The cache exists because live dashboard queries repeatedly scanned the 30-day `listings` window and exceeded the D1 free-tier limit of 5,000,000 rows read per day (about 8.5M observed), which surfaced as `code 7500` and HTTP 500 responses. Cached reads now touch roughly 20 rows.

For an existing database:

```sh
npm run db:migrate-neighborhoods
```

To apply the non-destructive quota and reclassification update to an existing database:

```sh
npm run db:migrate-quota-and-labels
```

To queue previously failed extractions for automatic retry:

```sh
npm run db:retry-failed-extractions
```

To set the daily limit to 500 calls (400 automatic, 100 manual):

```sh
npm run db:increase-daily-quota
```

For a new database:

```sh
npm run db:init
npm run db:seed
```

Use the corresponding `-local` commands for local D1. Run the rebuild migration only once. Do not run it again after new data has been collected unless another reset is intended.

## Development and deployment

Requirements: Node.js 20 or newer, npm, and a Cloudflare account with Workers, D1, Workers AI, and Workflows.

```sh
npm install
npm test
npm run dev
```

Configure the D1 database ID in `wrangler.jsonc`, authenticate Wrangler, then use `npm run deploy`. The repository is connected to Cloudflare, so a push to the main branch also deploys automatically; migrations are not run automatically. The optional `TYPESAFE_API_KEY` enables remote Jev evaluation; keep it as a Cloudflare secret.

## Documentation

- `README.md` — Persian user guide, dashboard control reference, flow diagrams, and API notes.
- `DOCUMENTATION_FA.md` — Persian analysis and design document (business domain, data model, data dictionary, read/write analysis, verification, setup).
- `docs/screenshots/` — dashboard screenshots generated offline from the real dashboard HTML and mock data by `node scripts/capture-screenshots.js`.

## API

- `GET /api/analytics?days=30&neighborhood=<slug>` — overall and selected-neighborhood metrics, five most active neighborhoods, and daily deposit trend; cached responses include `stats_computed_at`.
- `GET /api/stats` — city-wide 30-day summary using the same `overall` shape as analytics.
- `GET /api/neighborhoods?page=1&page_size=20&search=<text>&sort=count` — neighborhood statistics; `all=1` returns the full active list for selection controls.
- `GET /api/listings?page=1&page_size=20&neighborhood=<slug>&label=suspicious&search=<text>` — searchable, filtered, paginated listings.
- `POST /api/manual-runs` — start a manual search with `{ "neighborhood": "<slug>", "count": 10 }`; returns `requested_count`, `effective_count`, and 429 when the manual share is zero or AI is locked.
- `GET /api/manual-runs/<id>` — inspect manual-run status (`queued`, `running`, `scraped`, `complete`, `partial`, `empty`, `quota_exhausted`, `failed`) and its localized label.
- `GET /api/quota` — daily AI calls, automatic/manual budgets, `auto_remaining`, `manual_remaining`, `remaining`, and the AI lock state.
- `GET /api/settings` and `POST /api/settings` — read or update selected automatic neighborhoods and analysis thresholds (password required: `1311`).
- `GET /api/logs?limit=100` — recent service logs.
- `POST /api/discover-neighborhoods` — explicitly refresh the neighborhood list.
- `POST /api/refresh` — start the automatic scraping workflow on demand.

## Operational notes

The dashboard has no authentication, and the deployed URL is published in this README. Anyone with the link can start manual runs and consume the daily AI quota; put the deployment behind Cloudflare Access or a similar gate if that is a concern. Divar may block automated requests or change its internal endpoints. Check the applicable terms and local requirements before operating a scraper. Fake-price labels are review signals, not definitive claims about advertisers.

