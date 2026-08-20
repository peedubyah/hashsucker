# HashSucker AI Handover

Read all of `CODEX.md` first. Its architectural contract is binding; this file is the concise operational continuation record.

## Current Implementation (2026-08-20)

### Implemented Features

1. **Discovery cache read-through** — `StaleWhileRefresher` serves fresh cache hits, stale hits with background refresh, or triggers live discovery on miss
2. **Candidate cache** — SQLite-backed with `(infoHash, fileIndex)` identity, source provenance, provider observations separated
3. **Media associations** — `candidate_media` table with `mediaId`, `confidence`, `source`, `evidence` (JSON array)
4. **Ingestion boundary** — `ingestCandidates()` source-agnostic contract
5. **DMM hashlist adapter** — LZString decompression + JSON parsing (verified against real DMM data)
6. **Enrichment boundary** — `enrichCandidate()` creates media associations without mutating candidate identity
7. **Enrichment worker** — `runEnrichmentWorker()` processes unenriched candidates with per-candidate failure isolation
8. **Evidence tracking** — Media associations carry evidence arrays explaining WHY the association exists
9. **Release attributes boundary** — `release_attributes` table for filename-derived metadata (title, year, season, episode, resolution, codec, HDR, audio, language, release group)
   - Separate from candidates, candidate_media, and provider observations
   - Multiple parser sources per candidate (primary key: `(info_hash, file_index_key, source)`)
   - Stronger confidence wins conflicts per source
   - Evidence tags preserved for transparency
10. **Filename parser adapter** — regex-based PTN-style parser (`parser-adapter.js`)
    - Parses filenames into structured release attributes
    - Parser failures do NOT break ingestion
    - Low-confidence parses stored with confidence value
    - Evidence tags preserved for transparency
    - Does NOT create media associations or provider observations
11. **Attribute worker** — `runAttributeWorker()` processes candidates without release attributes, parsing filenames into structured evidence
12. **FTS5 search index** — `release_search` virtual table auto-populated via triggers on `release_attributes`
13. **Search engine** — `searchReleases()` FTS5-backed full-text search with structured filters (year, season, episode, resolution, source, codec, HDR, audio) and composite ranking
14. **Pure ranking module** — `rankHits()` consumes evidence (relevance, quality, confidence, identity, provider availability, episode match) without I/O or provider knowledge
15. **Ranking explainability** — `explainScore()` and `compareRanks()` generate human-readable ranking justifications
16. **Cinemeta enrichment source** — `enrichWithCinemeta()` resolves media identity via Cinemeta metadata API, producing candidate_media associations
17. **Confidence scoring module** — `computeConfidence()` with title match quality, year match, season/episode match bonuses
18. **DMM ingestion orchestrator** — `DMMIngestionRunner` fetches, decompresses, ingests, and optionally runs attribute parsing + media enrichment
19. **Persistent search server** — `DISCOVERY_DB` env var enables persistent SQLite storage; API endpoints for search, stats, DMM ingestion, and attribute parsing

### Current Invariants

- Candidate identity = `(infoHash, fileIndex)` — no fuzzy merge
- Provider observations separated from candidates
- Cache failures swallowed — live discovery remains authoritative
- Enrichment is additive — never removes existing associations
- Higher confidence wins on conflict (equal → latest wins)
- Unknown media identity is valid — candidate with no associations is still retrievable
- Ranking is pure — no I/O, no API calls, no provider-specific logic
- Unknown provider state = neutral (0.5), not a penalty

### Safe Extension Points

1. **New ingestion sources** — Add adapter in `src/lib/discovery/adapters/`, call `ingestCandidates()`
2. **New enrichment sources** — Implement `async (cache, candidate) => enrichment|null` function, pass to worker
3. **New provider observations** — Use `cache.recordProviderObservation()` — never store in candidates
4. **New cache queries** — Use `cache.queryCachedCandidates()` with `searchKey`, `maxAgeMs`, `withObservations`
5. **New media associations** — Use `cache.associateMedia()` or `enrichCandidate()`
6. **New filename parsers** — Implement parser, call `storeReleaseAttributes()` with source name
7. **Release attribute queries** — Use `getReleaseAttributesForCandidate()`, `getStrongestReleaseAttributes()`, `mergeReleaseAttributes()`
8. **New ranking components** — Add to `ranking.js` with weight adjustment (weights must sum to 1.0)
9. **New search endpoints** — Extend `server/app.js` with existing handler pattern

### Architecture Documents

- `docs/architecture.md` — Current pipeline, layer responsibilities, data ownership boundaries, contracts
- `docs/mvp-pipeline-consolidation.md` — Consolidated DMM → searchable pipeline report
- `docs/backend-api-state.md` — API contract, gaps, parser reprocessing semantics
- `docs/media-identity-enrichment-audit.md` — Cinemeta enrichment implementation plan
- `docs/decisions/001-discovery-cache.md` — Cache architecture decision record
- `handoff/movie-importer-bridge/` — Historical movie bridge (canonical importer is `torbox-importer/`)

## Known Decisions

1. **Filename parsing is first enrichment source** — highest value, no external deps
   - Custom regex-based parser (PTN has broken dependencies)
   - Source identifier: `ptn-regex`
2. **Confidence model: base + bonuses - penalties** — clamped to [0.0, 1.0]
3. **Ambiguous results (within 0.15) → return all** — mark as ambiguous
4. **Refuse when confidence < 0.5** — no forced associations
5. **Evidence tags are mandatory** — explain WHY for every association
6. **Higher confidence wins on conflict** — equal confidence → latest wins
7. **Unknown media identity is valid** — candidate with no associations is still retrievable
8. **Release attributes separate from candidates/media** — evidence, not identity
9. **Multiple parser sources per candidate** — primary key `(info_hash, file_index_key, source)`
10. **Release attributes don't create media associations** — filename parse is evidence only
11. **Ranking is pure** — no external I/O, no provider knowledge, no storage mutation
12. **Unknown provider = neutral** — prevents penalizing uncached releases
13. **Cinemeta first media enrichment** — no API key required, existing client
14. **FTS5 triggers for index sync** — automatic, no manual index management
15. **Attribute worker separate from enrichment worker** — filename parsing vs media identity resolution

## Resolved Questions

1. ~~**PTN vs GuessIt**~~ — **RESOLVED:** Custom regex parser (PTN has broken dependencies)
2. ~~**Search layer architecture**~~ — **RESOLVED:** SQLite FTS5 with auto-sync triggers
3. ~~**Ranking module design**~~ — **RESOLVED:** Pure function with evidence inputs, explainable output
4. ~~**Media enrichment source**~~ — **RESOLVED:** Cinemeta (first), TMDB/IMDb deferred
5. ~~**Parser reprocessing semantics**~~ — **RESOLVED:** Higher confidence wins, equal = latest wins
6. ~~**Provider hydration strategy**~~ — **RESOLVED:** Deferred (separate milestone)

## Verified Baseline

VERIFIED locally: `cd media-search && npm test` passes 350 tests, 0 failures.

Test coverage includes:
- Candidate identity and merge semantics
- Provider observation separation
- Cache read-through and stale-while-refresh
- Media association CRUD
- Ingestion boundary (DMM adapter)
- Enrichment boundary (evidence tracking)
- Enrichment worker (failure isolation, progress callbacks)
- Attribute worker (filename parsing → release_attributes)
- Search engine (FTS5, filters, ranking)
- Ranking module (pure function, component scoring, scenarios)
- Ranking transparency (explainScore, compareRanks, audit)
- Cinemeta enrichment (exact match, TV episode, ambiguous, failed lookup, idempotency)
- Confidence scoring (title match, year match, season/episode match)
- Server endpoints (search, stats, DMM ingest, attribute run)

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/search/internal` | Search DMM-ingested releases with ranking |
| GET | `/api/search/stats` | FTS5 index statistics |
| POST | `/api/ingest/dmm` | Trigger DMM hashlist sync |
| POST | `/api/attributes/run` | Trigger filename parsing |
| GET | `/health` | Health check |

### Search API Parameters

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Search query (auto-extracts filters) |
| `year` | number | Filter by year |
| `season` | number | Filter by season |
| `episode` | number | Filter by episode |
| `resolution` | string | Filter by resolution |
| `source` | string | Filter by source (BluRay, WEB-DL, etc.) |
| `codec` | string | Filter by codec (x264, x265) |
| `hdr` | 0/1 | Filter by HDR |
| `audio` | string | Filter by audio format |
| `limit` | number | Max results (default 50, max 100) |
| `offset` | number | Pagination offset |
| `providers` | true | Include provider observations |
| `media` | true | Include media associations |

## Repository State

- Branch: `main`
- 350 tests passing
- All implementation work committed and pushed
- Architecture documentation up to date

## Continuation Rule

Read `CODEX.md`, inspect the cited implementation, run tests, then continue from the current iteration list. Do not redo verified work unless verification shows it is broken.

## Next Milestones (Priority Order)

1. **Scheduling** — Automated DMM ingestion (every 6h) + attribute parsing + media enrichment
2. **Provider worker** — TorBox/RD cache status → `provider_observations`
3. **TMDB enrichment** — Fallback metadata provider for Cinemeta gaps
4. **API hardening** — Rate limiting, input validation, error handling
5. **Human override** — Manual correction of media associations

## File Map

### Core Boundaries
- `src/lib/discovery/cache.js` — SQLite cache + FTS5 schema
- `src/lib/discovery/ingest.js` — Ingestion boundary
- `src/lib/discovery/enrichment.js` — Media association APIs
- `src/lib/discovery/release-attributes.js` — Release attribute APIs

### Workers
- `src/lib/discovery/worker.js` — Media identity enrichment worker
- `src/lib/discovery/attribute-worker.js` — Filename parsing worker

### Search & Ranking
- `src/lib/discovery/search-engine.js` — FTS5 search engine
- `src/lib/discovery/ranking.js` — Pure ranking module
- `src/lib/discovery/ranking-explain.js` — Ranking transparency

### Enrichment Sources
- `src/lib/discovery/enrichment-sources/cinemeta.js` — Cinemeta media identity
- `src/lib/discovery/enrichment-sources/confidence.js` — Confidence scoring

### Source Adapters
- `src/lib/discovery/adapters/dmm.js` — DMM hashlist parser (canonical)
- `src/lib/discovery/parser-adapter.js` — Filename parser
- `src/lib/metadata/cinemeta.js` — Cinemeta metadata client

### Orchestration
- `src/lib/discovery/dmm-ingestion-runner.js` — DMM ingestion orchestrator
- `src/server/app.js` — HTTP API routes
- `src/server/index.js` — Server entry point

### Tests
- `test/cache.test.js` — 100+ tests (cache, enrichment, attributes)
- `test/search-engine.test.js` — 37+ tests (search, ranking)
- `test/ranking.test.js` — 29 tests (ranking purity, scenarios)
- `test/ranking-transparency.test.js` — 20 tests (explainability, audit)
- `test/enrichment-cinemeta.test.js` — 28 tests (Cinemeta enrichment)
- `test/attribute-worker.test.js` — 15 tests (attribute parsing)
- `test/dmm-ingestion.test.js` — 29 tests (DMM ingestion)
- `test/server.test.js` — 20+ tests (API endpoints)
