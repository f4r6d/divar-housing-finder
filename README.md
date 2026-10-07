# Divar Housing Finder

A Cloudflare Worker that samples Tehran rental listings from Divar, extracts listing details with Workers AI, evaluates suspicious prices, and serves a Persian, right-to-left dashboard backed by Cloudflare D1.

The application models Divar neighborhoods directly. It has no municipal-region table, neighborhood-to-region map, or region filter. Automatic neighborhood refresh runs at most once every seven days; an explicit refresh is also available. These endpoints and their response formats can change without notice.

## Dashboard

- The overview shows the five neighborhoods with the most collected listings in the last 30 days.
- A searchable neighborhood selector shows analysis for one neighborhood; it is limited to neighborhoods with listings.
- Deposit is the primary comparison metric: the dashboard shows average and median deposit, median deposit per square meter, monthly rent, counts, and daily deposit trends. Prices are asking prices from listings, not verified contract prices.
- Neighborhood statistics include listing count, average and median deposit and rent, fake/suspicious counts, and last scrape time; the table is searchable, sortable, and paginated.
- Listing cards show extracted deposit, rent, size, room count, description, review status, and a link to Divar.
- Manual scraping accepts one neighborhood and a requested number of listings. The interface reports daily Workers AI call capacity and the manual share remaining.
- Automatic scraping only visits selected neighborhoods. Its default list includes central/south/north Jannat Abad, Shahin, Sardar-e-Jangal, and Ferdos.

## Daily schedule and AI capacity

Cloudflare cron expressions use UTC. `30 6,18 * * *` runs at 10:00 and 22:00 Tehran time (UTC+3:30). Automatic work gives greater weight to neighborhoods with fewer fresh listings and longer time since their last check. A neighborhood with fewer current ads does not hold up the rest; its unused capacity flows to the remaining selected neighborhoods. It checks current Divar results instead of backfilling old ads.

The daily limit is a count of Workers AI processing calls, not a count of model tokens or neurons. The current AI binding does not expose token/neuron usage to this application. The configured 500-call daily limit reserves 400 calls for automatic work and 100 for manual work. At 22:00, automation can use the unused manual reserve only if no manual search was started that Tehran day. Cloudflare's account-level neuron limit still applies; if Workers AI reports quota exhaustion, the existing quota lock stops subsequent AI calls for up to 24 hours.

## Database and migration

The new schema contains neighborhoods, listings, daily AI usage, manual-run status, settings, workflow state, and request logs. The old region hierarchy, mapping data, scrape state, and listings are removed by the rebuild migration.

**`0001_neighborhood_first_rebuild.sql` is destructive:** it drops the old listing and location tables and starts with an empty listings table. Back up a database before applying it. The migration seeds the six resolvable default Divar neighborhoods and default automatic selection. A separate entry for “بلوار فردوس” is not present in Divar's Tehran neighborhood list; the closest matching place is “فردوس”, which is already selected, so it is not duplicated.

`0002_daily_quota_and_listing_reclassification.sql` is non-destructive and should be run once on an existing database after deploying a release that supports 150 daily calls. It raises the saved daily setting to 150, recalculates deposit-equivalent amounts using 100 million toman deposit = 3 million toman monthly rent, identifies existing shared-room listings, and queues the remaining extracted listings for a fresh label evaluation.

`0003_retry_failed_extractions.sql` re-queues prior extraction failures for automatic retry; apply it once after the daily capacity is available.

`0004_increase_daily_quota_to_500.sql` sets the saved daily limit to 500 calls, split 400 automatic and 100 manual by the application. Workers AI's account-level neuron quota is separate and remains enforced by Cloudflare.

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

Configure the D1 database ID in `wrangler.jsonc`, authenticate Wrangler, then use `npm run deploy`. The optional `TYPESAFE_API_KEY` enables remote Jev evaluation; keep it as a Cloudflare secret.

## API

- `GET /api/analytics?days=30&neighborhood=<slug>` — overall and selected-neighborhood metrics, five most active neighborhoods, and daily deposit trend.
- `GET /api/neighborhoods?page=1&page_size=20&search=<text>&sort=count` — neighborhood statistics; `all=1` returns the full active list for selection controls.
- `GET /api/listings?page=1&page_size=20&neighborhood=<slug>&label=suspicious&search=<text>` — searchable, filtered, paginated listings.
- `POST /api/manual-runs` — start a manual search with `{ "neighborhood": "<slug>", "count": 10 }`.
- `GET /api/manual-runs/<id>` — inspect manual-run status.
- `GET /api/quota` — daily AI calls, automatic/manual budgets, and remaining capacity.
- `GET /api/settings` and `POST /api/settings` — read or update selected automatic neighborhoods and analysis thresholds.
- `GET /api/logs?limit=100` — recent service logs.
- `POST /api/discover-neighborhoods` — explicitly refresh the neighborhood list.

## Operational notes

The dashboard has no authentication. Keep its deployed URL private; an unprotected URL is not access control. Divar may block automated requests or change its internal endpoints. Check the applicable terms and local requirements before operating a scraper. Fake-price labels are review signals, not definitive claims about advertisers.
