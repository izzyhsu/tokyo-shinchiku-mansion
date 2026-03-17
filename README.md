# Tokyo Shinchiku Mansion

A small Tokyo mansion-hunting dashboard focused on decision support for one user.

## What it does

- Fetches and parses SUUMO RSS listing feeds
- Extracts station / walk time / total units / price from RSS descriptions
- Merges new-build and second-hand properties into one UI
- Supports favorites, hidden items, and lightweight notes stored in the browser
- Geocodes listings with a guarded server-side fallback chain:
  1. scrape allowed SUUMO listing address
  2. geocode the address
  3. Google Places text search by title
  4. station fallback

## Local development

### Requirements

- Node.js 20+
- Google Maps browser key
- Google Maps server key

### Install

```bash
npm install
```

### Configure env

Create a local `.env` from `.env.example`.

Required variables:

```bash
GOOGLE_MAPS_KEY_BROWSER=...
GOOGLE_MAPS_KEY_SERVER=...
ALLOWED_ORIGINS=http://localhost:3001
```

Optional:

```bash
PUBLIC_API_BASE=...
GEOCODE_RATE_LIMIT_WINDOW_MS=60000
GEOCODE_RATE_LIMIT_MAX=30
```

Legacy fallback names are also supported in code:

```bash
GOOGLE_MAPS_BROWSER_KEY=...
GOOGLE_MAPS_SERVER_KEY=...
```

### Run

```bash
npm run dev
```

Open:

- <http://localhost:3001>

## Security

Security is P0 for this project.

### Key rules

- Use separate browser and server Google keys
- Never commit real keys to the repo
- Restrict browser key by exact web origins
- Restrict browser key to Maps JavaScript API only
- Restrict server key to Geocoding + Places only
- Never expose server key to the browser

### API guardrails

- `/api/geocode` is rate-limited
- `/api/geocode` only accepts HTTPS `suumo.jp` listing URLs for scraping
- API CORS is allowlist-based via `ALLOWED_ORIGINS`
- input is normalized and bounded before use

See: `docs/adr/0001-security-guardrails.md`

## Data files

- `public/data/chuko.json` — manually curated second-hand listings
- `geocache.json` — persistent geocode cache

## Tests

Run parser tests:

```bash
npm test
```

## Deployment

Render should provide these environment variables:

- `GOOGLE_MAPS_KEY_BROWSER`
- `GOOGLE_MAPS_KEY_SERVER`
- `ALLOWED_ORIGINS`
- optional: `PUBLIC_API_BASE`
- optional: `GEOCODE_RATE_LIMIT_WINDOW_MS`
- optional: `GEOCODE_RATE_LIMIT_MAX`
