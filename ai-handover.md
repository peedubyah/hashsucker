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

**WINDOWS research agent** (parallel track, branch `research/ingestion-contract`):
- DMM hashlists — verified format, LZString + JSON
- Zurg public release — architecture investigation complete (ZURG-ENRICHMENT.md)
- Zilean architecture — pending
- Enrichment source research — complete (ENRICHMENT-CONTRACT.md, ENRICHMENT-SOURCES.md)

**RIGHTMON implementation agent** (this track):
- Production code — `media-search/src/lib/discovery/`
- Tests — `media-search/test/cache.test.js` (150 tests, all passing)
- Contracts — `ingestCandidates()`, `enrichCandidate()`, `associateMedia()`

## Research Branch Status

### ENRICHMENT-CONTRACT.md (v1.0.0, DRAFT)

Filename-to-media-identity resolution contract:
- **Input:** `{ infoHash, fileIndex, filename }`
- **Output:** parsed tokens + media type + associations with confidence
- **Confidence model:** base scores + bonuses/penalties, clamped to [0.0, 1.0]
- **Refuse association when:** no title, < 3 chars, ambiguous (spread < 0.15), sample/proof
- **Evidence tags:** `title_exact_match`, `year_match`, `movie_pattern`, etc.

### ENRICHMENT-SOURCES.md (v2.0.0, DRAFT)

Prioritized enrichment source roadmap:
1. **Filename parsing (GuessIt/PTN)** — confidence 0.6-0.85 — **NEXT MILESTONE**
2. **Sonarr/Radarr Parse API** — confidence up to 0.95
3. **Cinemeta metadata resolution**
4. **TMDB/IMDb matching**
5. **Torrent metadata extraction**
6. **Debrid library file inspection**

### ZURG-ENRICHMENT.md (v2.0.0, DRAFT)

Zurg architectural lessons:
- Zurg is a Real-Debrid media server with persistent state
- Folder structure: `Movies/Title (Year)/` or `TV Shows/Title/Season X/`
- Without infoHash, Zurg data is low-confidence (0.45-0.70)
- Zurg provides corroborating evidence, not primary

## Known Decisions

1. **Filename parsing is first enrichment source** — highest value, no external deps
2. **Confidence model: base + bonuses - penalties** — clamped to [0.0, 1.0]
3. **Ambiguous results (within 0.15) → return all** — mark as ambiguous
4. **Refuse when confidence < 0.5** — no forced associations
5. **Evidence tags are mandatory** — explain WHY for every association
6. **Higher confidence wins on conflict** — equal confidence → latest wins
7. **Unknown media identity is valid** — candidate with no associations is still retrievable

## Unresolved Questions

1. **PTN vs GuessIt** — which parser library to use (or custom)?
2. **External API rate limits** — Cinemeta/TMDB throttling strategy
3. **Ambiguous result handling** — store all or store none?
4. **Zurg integration depth** — real-time scan or periodic sync?
5. **Zilean architecture** — still pending research
6. **Human override contract** — how to manually correct associations?

## Next Recommended Milestone

**Implement filename parsing enrichment (Source 1):**
- Parse filenames into structured tokens (title, year, season, episode, quality, source, codec, release group)
- Classify media type (movie, series, unknown)
- Create `candidate_media` associations with confidence + evidence
- Integrate with `runEnrichmentWorker()`
- Target: 0.6-0.85 confidence for well-formed filenames

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
