# Stage 3 — Enrichment

Enrichment attaches knowledge to candidates. It writes **only**
`candidate_media` (association + provenance + resolution state) — never
identity, never observations.

## Attribute enrichment

`lib/discovery/release-attributes.js` (+ `attribute-worker.js`):
filename parsing via `parser-adapter.js:parseFilename` → title, year,
media type, season/episode/range, resolution, source type, codec, HDR,
audio, language, release group, confidence + evidence. Batch store with
validation and confidence-weighted merging.

## Identity enrichment

`lib/discovery/enrichment.js`: parser matches + Cinemeta sources
(`enrichment-sources/cinemeta.js`, 7-day metadata cache) scored by
`confidence.js` (title/year/resolution-state/season-episode match).
Supporting machinery: `confidence-projection.js` (incl. historical
availability/provider priors), `corpus-confidence-features.js`,
`identity-resolver.js`, `show-identity.js`, `corpus-identity.js`.

## Demand vs background

- **Demand path:** `searchMedia → enrichAndFinalize` (TorBox cache hints,
  cached-first sort) + request-time `ensureTorBoxFileIdentity`. Required
  for fulfillment.
- **Background path:** `worker.js`, `attribute-worker.js`,
  `identity-enrichment-worker.js` (queue `identity_enrichment_queue`,
  max 3 attempts), `idle-enrichment.js` (hourly, one bounded live query
  per quiet tick, human-demand-gated to seerr/web/plex-watchlist/
  operator sources, 1h→24h backoff, 24h zero-yield skip, 30d
  recent-request window). Optional intelligence; never acquisition;
  never blocks a request.

## Source references

- `media-search/src/lib/discovery/release-attributes.js`,
  `enrichment.js`, `confidence*.js`, `idle-enrichment.js`
