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

### Current Invariants

- Candidate identity = `(infoHash, fileIndex)` — no fuzzy merge
- Provider observations separated from candidates
- Cache failures swallowed — live discovery remains authoritative
- Enrichment is additive — never removes existing associations
- Higher confidence wins on conflict (equal → latest wins)
- Unknown media identity is valid — candidate with no associations is still retrievable

### Safe Extension Points

1. **New ingestion sources** — Add adapter in `src/lib/discovery/adapters/`, call `ingestCandidates()`
2. **New enrichment sources** — Implement `async (candidate) => enrichment|null` function, pass to worker
3. **New provider observations** — Use `cache.recordProviderObservation()` — never store in candidates
4. **New cache queries** — Use `cache.queryCachedCandidates()` with `searchKey`, `maxAgeMs`, `withObservations`
5. **New media associations** — Use `cache.associateMedia()` or `enrichCandidate()`

### Research Dependencies

**WINDOWS research agent** (parallel track):
- DMM hashlists — verified format, LZString + JSON
- Zurg public release — architecture investigation pending
- Zilean architecture — pending
- Enrichment source research — pending

**RIGHTMON implementation agent** (this track):
- Production code — `media-search/src/lib/discovery/`
- Tests — `media-search/test/cache.test.js` (150 tests, all passing)
- Contracts — `ingestCandidates()`, `enrichCandidate()`, `associateMedia()`

## Verified Baseline

VERIFIED locally: `cd media-search && npm test` passes 150 tests, 0 failures.

Test coverage includes:
- Candidate identity and merge semantics
- Provider observation separation
- Cache read-through and stale-while-refresh
- Media association CRUD
- Ingestion boundary (DMM adapter)
- Enrichment boundary (evidence tracking)
- Enrichment worker (failure isolation, progress callbacks)

## Repository State

- Branch: `main` (was `unify-media-search-importer`)
- 150 tests passing
- No commits yet for recent implementation work
- Ready for first architecture documentation commit

## Continuation Rule

Read `CODEX.md`, inspect the cited implementation, run tests, then continue from the current iteration list. Do not redo verified work unless verification shows it is broken.

## Architecture Documents

- `docs/architecture.md` — Current pipeline, layer responsibilities, data ownership boundaries, contracts
- `docs/decisions/001-discovery-cache.md` — Cache architecture decision record
- `handoff/movie-importer-bridge/` — Historical movie bridge (canonical importer is `torbox-importer/`)

## Next Work

1. Commit current implementation with architecture documentation
2. Push to origin/main for parallel agent visibility
3. Implement filename/title parser for enrichment (PTT-style)
4. Integrate enrichment worker with DMM ingestion pipeline
5. Add scheduler for periodic DMM sync (every 6 hours)
