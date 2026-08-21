# Pipeline

> **ARCHIVED PRE-CONSOLIDATION PIPELINE:** Non-authoritative. Use [`../pipeline.md`](../pipeline.md); several “actual current” claims below were disproven by code verification.

Historical description of data flows in HashSucker.

---

## 1. Title Search / Metadata Lookup

**Trigger:** User types in browser search box.

```
Browser → GET /api/search?q=Black+Mirror
         ↓
    media-search/src/server/app.js
         ↓
    src/lib/metadata/cinemeta.js → searchCatalog(query)
         ↓
    Cinemeta API (v3-cinemeta.strem.io)
         ↓
    Returns: [{ id, type, name, poster, year, description }]
```

**Notes:**
- Provider-agnostic: backend owns which metadata providers are queried
- Results cached in-memory for fast typeahead
- Query must be 2-120 characters
- Frontend should debounce input

---

## 2. Release Search

**Trigger:** User selects a media title and requests releases.

```
Browser → GET /api/search?type=series&mediaId=tt0944947:7:3
         ↓
    media-search/src/server/app.js
         ↓
    src/lib/discovery/search-engine.js → searchReleases()
         ↓
    ┌─────────────────────────────────────────────────────────┐
    │ FTS5 MATCH on release_search                            │
    │ + Structured filters (year, season, episode, resolution)│
    │ + Composite ranking: relevance × quality × confidence   │
    │ + Optional: provider observations, media associations   │
    └─────────────────────────────────────────────────────────┘
         ↓
    Returns: Ranked release candidates with parsed attributes
```

**Ranking formula:**
```
score = relevance × 0.30 + confidence × 0.25 + quality × 0.25 + provider × 0.20
```

**Notes:**
- DMM corpus is the primary release source
- Live discovery (Torrentio/Torznab) merged when `includeLive=true`
- Deduplication by infoHash (corpus takes precedence)

---

## 3. DMM Ingestion

**Trigger:** Manual via `POST /api/ingest/dmm` or scheduled (not yet implemented).

```
POST /api/ingest/dmm
         ↓
    media-search/src/server/app.js
         ↓
    src/lib/discovery/dmm-ingestion-runner.js → DMMIngestionRunner.run()
         ↓
    ┌─────────────────────────────────────────────────────────┐
    │ 1. listFragments() → GitHub API                         │
    │ 2. fetchFragment(url) → raw.githubusercontent.com       │
    │ 3. extractPayload(html) → LZString compressed string    │
    │ 4. decodeDmmPayload(compressed) → JSON string           │
    │ 5. streamParseDMM(json) → generator of records          │
    │ 6. transformDMMRecord(record) → HashSucker entry        │
    │ 7. ingestCandidates() → write to candidates table      │
    └─────────────────────────────────────────────────────────┘
         ↓
    Post-ingestion: runAttributeWorker → release_attributes → FTS5 index
```

**Notes:**
- Streaming JSON parser for memory efficiency
- Batch commits every 1000 records
- Per-record failure isolation
- Metrics: records processed, inserted, updated, failed, duplicates, duration

---

## 4. Release Parsing / FTS5 Indexing

**Trigger:** Post-ingestion (automatic) or manual via `POST /api/attributes/run`.

```
POST /api/attributes/run
         ↓
    src/lib/discovery/attribute-worker.js → runAttributeWorker()
         ↓
    ┌─────────────────────────────────────────────────────────┐
    │ getCandidatesWithoutAttributes()                        │
    │      ↓                                                  │
    │ parseFilename(filename) → structured attributes         │
    │      ↓                                                  │
    │ storeReleaseAttributes() → release_attributes table     │
    │      ↓                                                  │
    │ FTS5 triggers auto-update release_search                │
    └─────────────────────────────────────────────────────────┘
```

**Parser output fields:**
title, year, media_type, season, episode, episode_range, resolution, source_type, codec, hdr, audio, language, release_group

**Evidence tags:**
title_extracted, year_detected, season_episode_detected, episode_range_detected, resolution_detected, source_detected, codec_detected, hdr_detected, audio_detected, language_detected, release_group_detected

**Notes:**
- Parser failures do NOT break ingestion
- Low-confidence parses ARE stored (with confidence value)
- Multiple parser sources per candidate (higher confidence wins)

---

## 5. Enrichment

**Trigger:** Manual via enrichment worker (not yet scheduled).

```
runEnrichmentWorker()
         ↓
    getUnenrichedCandidates() → candidates without candidate_media
         ↓
    ┌─────────────────────────────────────────────────────────┐
    │ enrichWithCinemeta(cache, candidate)                    │
    │      ↓                                                  │
    │ getStrongestReleaseAttributes() → parsed title/year     │
    │      ↓                                                  │
    │ searchCatalog(parsedTitle) → Cinemeta results           │
    │      ↓                                                  │
    │ titleMatchQuality() + yearMatch() → confidence score   │
    │      ↓                                                  │
    │ If confidence ≥ 0.5 → create association               │
    └─────────────────────────────────────────────────────────┘
         ↓
    enrichCandidate() → writes to candidate_media
```

**Confidence scoring:**
```
base: 0.5
+ title exact match: +0.2
+ title starts with: +0.1
+ title includes: +0.05
+ year match: +0.1
+ season+episode match: +0.15
= clamped to [0.0, 1.0]
```

**Notes:**
- Enrichment is additive — never removes existing associations
- Higher confidence wins on conflict (equal → latest wins)
- Unknown matches remain unknown (no forced associations)
- Cinemeta is the first implemented enrichment source

---

## 6. Ranking

**Trigger:** During release search (synchronous).

```
searchReleases() → rankHits()
         ↓
    ┌─────────────────────────────────────────────────────────┐
    │ Pure function (no I/O, no API calls)                    │
    │                                                         │
    │ Inputs:                                                 │
    │   - relevance: FTS5 BM25 score                          │
    │   - quality: resolution + source tier                   │
    │   - confidence: parser confidence                       │
    │   - identity: media association confidence              │
    │   - provider: cache status (0.5 = unknown/neutral)      │
    │   - episodeMatch: season/episode match bonus            │
    │                                                         │
    │ Output:                                                 │
    │   score = weighted sum (weights sum to 1.0)             │
    └─────────────────────────────────────────────────────────┘
```

**Notes:**
- Ranking is explainable via `explainScore()` and `compareRanks()`
- Unknown provider = neutral (0.5), not penalty
- Weights must sum to 1.0

---

## 7. Request → Importer → Sonarr/Radarr Flow

**Trigger:** User selects a release and submits request in browser.

```
Browser → POST /api/requests
         ↓
    media-search/src/lib/requests/
         ↓
    ┌─────────────────────────────────────────────────────────┐
    │ Build request document:                                 │
    │   - intent: mediaType, scope, mediaId, season, episodes │
    │   - release: infoHash, title, filename, size, etc.      │
    └─────────────────────────────────────────────────────────┘
         ↓
    Write to /requests/incoming/{requestId}.json
         ↓
    ┌─────────────────────────────────────────────────────────┐
    │ torbox-importer/claim-request.sh                        │
    │   - Atomic claim (mv incoming → processing)             │
    └─────────────────────────────────────────────────────────┘
         ↓
    torbox-importer/scripts/worker.sh → process-request.sh
         ↓
    ┌─────────────────────────────────────────────────────────┐
    │ 1. validate-request.sh → verify request integrity       │
    │ 2. ensure-torbox-job.sh → create/reuse TorBox resource  │
    │ 3. inspect-job.sh → examine torrent contents            │
    │ 4. select-tv-files.sh → map intent to physical files    │
    │ 5. process-movie.sh / process-tv.sh → download & import │
    │ 6. settle-request.sh → move to done/failed              │
    └─────────────────────────────────────────────────────────┘
         ↓
    ┌─────────────────────────────────────────────────────────┐
    │ Sonarr/Radarr ManualImport                              │
    │   - Select correct series/episode/movie                 │
    │   - Import downloaded files                             │
    │   - Verify successful import                            │
    └─────────────────────────────────────────────────────────┘
         ↓
    Request moves to /requests/done or /requests/failed
```

**Notes:**
- The shared filesystem queue is the authoritative transport (not HTTP)
- Request identity is explicit — no inference from release title
- Episode intent controls file selection — no guessing
- Mixed requested/unrequested files must fail ambiguous

---

## API Endpoints Summary

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/search` | Cinemeta catalog search (titles) |
| GET | `/api/search?type=TYPE&mediaId=ID` | Release search (FTS5) |
| GET | `/api/releases` | Release search (alias) |
| POST | `/api/requests` | Submit request to importer |
| GET | `/api/requests/:id` | Get request status |
| POST | `/api/ingest/dmm` | Trigger DMM ingestion |
| POST | `/api/attributes/run` | Trigger filename parsing |
| GET | `/api/search/stats` | FTS5 index statistics |
| GET | `/health` | Health check |

**Full contract:** `media-search/src/api/API_CONTRACT.md`
