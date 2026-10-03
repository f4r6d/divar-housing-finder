# Divar Housing Finder

A Cloudflare Workers application that samples public Tehran rental listings on Divar.ir, extracts structured rental details with Workers AI, and flags unusually low or potentially misleading prices. The admin dashboard and API are rendered/served by the Worker; the database is Cloudflare D1.

The project does not use the Divar API, browser automation, or npm dependencies at runtime. Scraping uses HTML requests and regular expressions, with a three-second pause between neighborhood pages. Neighborhood slugs are approximate seed values and should be verified before enabling scheduled collection.

## Features

- Persian, RTL dashboard with district charts, listing filters, request logs, and editable analysis settings.
- Durable Cloudflare Workflow for neighborhood sampling, extraction, evaluation, and log cleanup.
- At most two new listings per neighborhood in a workflow run, and a hard maximum of 30 Workers AI calls per UTC day.
- Workers AI extraction with a 24-hour quota lock after an allocation error.
- Optional TypeSafe Jev evaluation using `TYPESAFE_API_KEY`, with a local heuristic when no key is configured or the service is unavailable.
- D1 schema and seed data for all 22 Tehran districts and 110 main-neighborhood entries.

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

The cron trigger starts a workflow every six hours. Manual runs are available from the dashboard. Workflow scraping and AI work are bounded by the configured limits; editing `daily_listing_limit` cannot raise the AI limit above 30 per UTC day.

## Database Commands

- `npm run db:init-local` / `npm run db:seed-local`: initialize local D1.
- `npm run db:init` / `npm run db:seed`: initialize remote D1.
- `npm run db:console`: run the example read-only listing query against remote D1.

Run schema initialization before seeding. The SQL uses `IF NOT EXISTS` and `INSERT OR IGNORE`, so initialization and seeding can be repeated.

## API

- `GET /api/stats` — overall listing counts.
- `GET /api/districts` — counts, average prices, fake percentages, and latest neighborhood scrape times.
- `GET /api/listings?district=1&fake_label=suspicious&page=1` — filtered, paginated listings. `fake_label` also accepts `real`, `fake`, `unknown`, and `pending`.
- `GET /api/logs?service=scraper&limit=100` — request logs; optional `status=success` or `status=error`.
- `GET /api/settings` and `POST /api/settings` — read and update analysis settings.
- `GET /api/force-run` — start a workflow.
- `GET /api/retry/:id` and `POST /api/retry-all-failed` — retry failed extraction.
- `GET /api/reset-listings` — delete listings while preserving district and neighborhood seed data.

## Operational and Safety Notes

The dashboard intentionally has no authentication, as requested. Treat its deployed URL as private, do not expose it publicly, and understand that an unprotected URL is not access control. The reset endpoint is destructive and is also unauthenticated.

Divar may block automated requests or change its HTML at any time. A block/captcha or a response shorter than the configured minimum is logged and skipped. Seed slugs are estimates, not verified Divar routes. Confirm the site's applicable terms and local requirements before operating a scraper, and monitor request logs and Cloudflare usage. No listing data is guaranteed accurate; fake-price labels are signals for review, not a definitive claim about an advertiser.

## Project Structure

```text
src/                 Worker, workflow, scraper, extraction, and scoring modules
seed/                District and neighborhood SQL seed
schema.sql           D1 tables, indexes, and default settings
wrangler.jsonc       Worker, D1, AI, Workflow, and cron configuration
```
