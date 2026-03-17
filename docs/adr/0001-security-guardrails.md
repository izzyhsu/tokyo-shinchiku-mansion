# ADR 0001 — Security Guardrails for Keys and Geocoding

- Status: Accepted
- Date: 2026-03-17
- Owner: Izzy / Erika

## Context
This project uses Google Maps browser and server keys. The original implementation exposed several avoidable risks:

- browser key could be misconfigured and abused
- server-side geocode endpoint could be used as a public proxy
- arbitrary `link` input created SSRF risk
- CORS was too open for API routes
- secret handling relied too much on discipline instead of code guardrails

This project is currently a personal tool, but security remains P0.

## Decision
We enforce the following guardrails:

1. Separate browser and server Google keys.
2. Never commit real keys to the repo.
3. Browser key must be restricted by allowed origins in Google Cloud.
4. Server key must never be returned to the client.
5. `/api/geocode` is rate-limited.
6. `/api/geocode` only accepts HTTPS `suumo.jp` listing URLs for scraping.
7. API CORS is restricted to explicit allowlisted origins via `ALLOWED_ORIGINS`.
8. Input lengths are normalized and bounded before use.
9. Public API base is configurable, but secrets stay server-side only.

## Consequences
### Positive
- lowers accidental key leakage risk
- reduces public proxy abuse risk
- reduces SSRF risk materially
- makes future security review repeatable

### Negative
- more environment setup is required
- local/testing origins must be configured explicitly when needed
- some convenience is intentionally sacrificed

## Required Environment Variables
- `GOOGLE_MAPS_KEY_BROWSER`
- `GOOGLE_MAPS_KEY_SERVER`
- `ALLOWED_ORIGINS` (comma-separated list, e.g. production origins)
- optional: `PUBLIC_API_BASE`
- optional: `GEOCODE_RATE_LIMIT_WINDOW_MS`
- optional: `GEOCODE_RATE_LIMIT_MAX`

## Guardrail Checklist
Before deploy or key rotation, verify:

- [ ] No real keys in repo, docs, screenshots, or sample files
- [ ] Browser key restricted to exact web origins
- [ ] Browser key restricted to Maps JavaScript API only
- [ ] Server key restricted to Geocoding + Places only
- [ ] Render env vars configured
- [ ] `ALLOWED_ORIGINS` matches actual frontend origins
- [ ] `/api/geocode` rejects non-SUUMO links
- [ ] `/api/geocode` is rate-limited
- [ ] No API route returns server secrets

## Future Validation
Any future change touching maps, scraping, CORS, or env handling must be checked against this ADR before merge.
