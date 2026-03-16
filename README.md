# Tokyo Shinchiku Mansion

A small Tokyo mansion-hunting dashboard that combines:

- **新築** listings from SUUMO RSS
- **中古** listings from a local JSON file
- a Google Map with geocoded property markers
- favorites, hidden items, and lightweight notes stored in the browser

## What it does

- Fetches and parses SUUMO RSS listing feeds
- Extracts station / walk time / total units / price from RSS descriptions
- Geocodes listings through a server-side Google API fallback chain:
  1. scrape listing address
  2. geocode the address
  3. Google Places text search by title
  4. station fallback
- Merges new-build and second-hand properties into one UI
- Lets you:
  - filter by prefecture / type / favorites
  - sort by title / station / walk / units / date
  - favorite listings
  - hide listings
  - add short notes per listing

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

Supported variable names:

```bash
GOOGLE_MAPS_KEY_BROWSER=...
GOOGLE_MAPS_KEY_SERVER=...
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

## Data files

- `public/data/chuko.json` — manually curated second-hand listings
- `geocache.json` — persistent geocode cache

## Security notes

The app now uses **separate Google keys**:

- **browser key** for Maps JavaScript only
- **server key** for Geocoding / Places only

Recommended restrictions:

### Browser key

- restrict by **HTTP referrer**
- enable only the APIs needed for browser Maps

### Server key

- restrict by **API scope**
  - Geocoding API
  - Places API
- restrict by server/application settings as tightly as your host allows

## Tests

Run parser tests:

```bash
npm test
```

## Deployment

`render.yaml` expects two env vars in Render:

- `GOOGLE_MAPS_KEY_BROWSER`
- `GOOGLE_MAPS_KEY_SERVER`
