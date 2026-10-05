# Divar Housing Finder

A Cloudflare Workers application that samples public Tehran rental listings on Divar.ir, extracts structured rental details with Workers AI, and flags unusually low or potentially misleading prices. The admin dashboard and API are rendered/served by the Worker; the database is Cloudflare D1.

The project does not use Divar's official listing API, browser automation, or npm dependencies at runtime. District metadata is discovered from the Kenar district endpoint when available, with listing-search discovery as a fallback. Scraping uses Divar's JSON search endpoint with a three-second pause between districts. These endpoints and their response formats may change without notice.

## Features

- Persian, RTL dashboard with district charts, listing filters, request logs, and editable analysis settings.
- Hierarchical Tehran dashboard with 22 municipal regions and expandable neighborhood reports.
- Automatic Tehran district discovery, weekly refresh, and slug-based dashboard/listing links.
- Durable Cloudflare Workflow for district-based sampling, extraction, evaluation, and log cleanup.
- Up to five new listings per district per run, and a configurable maximum of 100 Workers AI calls per UTC day.
- Rental comparisons use deposit-equivalent value: deposit plus monthly rent multiplied by 30. This is a modeling assumption based on a common market convention, not a fixed legal rate; actual conversion terms vary by listing and location.
- Listings retain Divar's neighborhood and are linked to a municipal region when the neighborhood has an unambiguous crosswalk; unresolved places are reported separately rather than guessed.
- Workers AI extraction with a 24-hour quota lock after an allocation error.
- Optional TypeSafe Jev evaluation using `TYPESAFE_API_KEY`, with a local heuristic when no key is configured or the service is unavailable.
- D1 district records are populated from discovery; the seed file intentionally contains no manual districts.

## Prerequisites

- Node.js 20 or newer and npm.
- A Cloudflare account with Workers, D1, Workers AI, and Workflows enabled for the account.
- Wrangler 4, installed from the project dependencies.

## Local Development

Local dev requires `wrangler login` because Workers AI must run remotely. Workers AI has no local emulator, so do not use `wrangler dev --local` with this project.

1. Install the development dependency:

	```sh
	npm install
	```

2. Create a Cloudflare D1 database and copy its ID into `wrangler.jsonc`:

	```sh
	npx wrangler d1 create divar-housing-db
	```

	Replace the placeholder `database_id` with the returned UUID. Set `WORKER_URL` to the Worker hostname you will use after deployment.

3. Initialize and seed local D1, then start the Worker:

	```sh
	npm run db:init-local
	npm run db:seed-local
	npm run dev
	```

	Wrangler prints the local development URL. The local D1 database is separate from the remote database.

## Remote Setup and Deployment

After configuring the real D1 ID and authenticating Wrangler:

```sh
npx wrangler login
npm run db:init
npm run db:seed
npx wrangler secret put TYPESAFE_API_KEY
npm run deploy
```

The TypeSafe secret is optional. Do not place it in `wrangler.jsonc`, source files, or version control. Workers AI is configured as a binding and requires no API key. Configure GitHub-to-Cloudflare deployment in the Cloudflare dashboard if you want pushes to deploy automatically.

For an existing database, inspect its columns before applying a migration: `districts.city_slug` and `listings.district_slug` mean the district migration is already applied; `listings.deposit_equivalent_toman` means the pricing migration is already applied; `regions` and `districts.region_id` mean the region hierarchy migration is already applied. The project migration scripts execute SQL files directly and do not maintain Wrangler's `d1_migrations` history, so `wrangler d1 migrations list` can report already-applied migrations as pending. Do not rerun `0002_district_auto_discovery.sql` when its columns exist: it clears district/neighborhood records and unlinks listings. Apply only missing migrations. The pricing migration backfills existing listings using the 30:1 conversion assumption and updates the default sampling limits. The hierarchy migration is additive; after it is applied, the first dashboard request or workflow backfills unambiguous neighborhood-to-region assignments from stored place names and explicit neighborhood mentions in listing titles only. Descriptions are not used for recovery because they can contain agency addresses. Ambiguous or multi-place listings stay unmapped. Use the matching `-local` commands for local D1. If the Kenar endpoint requires authentication, set `KENAR_API_KEY` with `npx wrangler secret put KENAR_API_KEY`; the search API fallback requires no key.

The cron trigger starts a workflow every six hours. District discovery refreshes weekly, and up to ten districts not scraped in the last 12 hours are selected per run. Manual runs are available from the dashboard. Workflow scraping and AI work are bounded by the configured limits; the dashboard allows up to 100 listings per UTC day and five listings per district per run. For convertible listings, extraction prefers the option with the highest deposit when the listing explicitly permits changing the deposit/rent split.

## Database Commands

- `npm run db:init-local` / `npm run db:seed-local`: initialize local D1.
- `npm run db:init` / `npm run db:seed`: initialize remote D1.
- `npm run db:migrate-local` / `npm run db:migrate`: add district slug metadata to a database only when those columns are absent; this migration clears legacy district and neighborhood records.
- `npm run db:migrate-pricing-local` / `npm run db:migrate-pricing`: add deposit-equivalent pricing and update default sampling limits only when the new pricing column is absent.
- `npm run db:migrate-regions-local` / `npm run db:migrate-regions`: add the 22-region parent table and region links; run once after the district and pricing migrations and before deploying the hierarchy code.
- `npm run db:console`: run the example read-only listing query against remote D1.

For a new database, run schema initialization and seeding. The seed contains only a no-op statement; the `/api/discover-districts` endpoint and workflow populate districts automatically. Existing databases need the one-time migration instead of rerunning initialization.

## API

- `GET /api/stats` — overall listing counts.
- `GET /api/districts` — counts, average prices, fake percentages, and latest neighborhood scrape times.
- `GET /api/districts/:regionSlug/neighborhoods` — neighborhood-level reports within one Tehran municipal region.
- `GET /api/unmapped-neighborhoods` — places that lack an unambiguous region mapping, with their listing counts.
- `GET /api/listings?district=tehran-region-1&neighborhood=niavaran&fake_label=suspicious&page=1` — filtered, paginated listings. `fake_label` also accepts `real`, `fake`, `unknown`, and `pending`.
- `GET /api/logs?service=scraper&limit=100` — request logs; optional `status=success` or `status=error`.
- `GET /api/settings` and `POST /api/settings` — read and update analysis settings.
- `GET /api/discover-districts` — discover district slugs/names, fall back from Kenar to search, and sync to D1.
- `GET /api/test-api` — test an unfiltered Tehran search and return sample listings and a response preview.
- `GET /api/force-run` — start a workflow.
- `GET /api/retry/:id` and `POST /api/retry-all-failed` — retry failed extraction.
- `GET /api/reset-listings` — delete listings while preserving district and neighborhood seed data.

## Operational and Safety Notes

The dashboard intentionally has no authentication, as requested. Treat its deployed URL as private, do not expose it publicly, and understand that an unprotected URL is not access control. The reset endpoint is destructive and is also unauthenticated.

Divar may block automated requests or change its internal JSON/Kenar endpoints at any time. HTTP and parsing errors are recorded in request logs. Search-based district fallback derives slugs from returned location data when the response does not include a slug, so verify newly discovered results before relying on them. Confirm the site's applicable terms and local requirements before operating a scraper, and monitor request logs and Cloudflare usage. No listing data is guaranteed accurate; fake-price labels are signals for review, not a definitive claim about an advertiser.

Neighborhood-to-region assignments are based on the [Tehran districts/neighborhoods GeoJSON](https://github.com/mjalalimanesh/tehran-districts-neighborhoods-map-geojson), whose README references `map.tehran.ir`. Its 377 mapped neighborhood polygons do not cover every Divar place, and some names occur in multiple regions; those places remain visibly unmapped until a verified alias is added.

## Project Structure

```text
src/                 Worker, workflow, discovery, scraper, extraction, and scoring modules
seed/                Empty district seed (discovery populates D1)
migrations/          One-time migration for existing D1 databases
schema.sql           D1 tables, indexes, and default settings
wrangler.jsonc       Worker, D1, AI, Workflow, and cron configuration
```
