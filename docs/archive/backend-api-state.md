# HashSucker Backend API — Architecture State

> **ARCHIVED SNAPSHOT:** Superseded by [`../../HANDOFF.md`](../../HANDOFF.md) and the [2026-08-21 audit](../audit/8-21-audit.md). Do not treat this file as current architecture or deployment authority.

**Date:** 2026-08-20
**Status:** Historical implementation snapshot

---

## 1. Current Architecture State

### 1.1 Runtime Components

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ HTTP Server (src/server/index.js → app.js)                                  │
│  → createApp() → createRequestHandler()                                     │
│  → Routes: /api/search/internal, /api/search/stats, /api/ingest/dmm, etc.  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Discovery Cache (src/lib/discovery/cache.js)                               │
│  → SQLite with WAL mode                                                     │
│  → Persistent dbPath via DISCOVERY_DB env var (or in-memory for testing)    │
│  → Tables: candidates, candidate_media, release_attributes, provider_obs    │
│  → FTS5 virtual table: release_search (auto-synced via triggers)           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 API Endpoints

| Method | Path | Purpose | Status |
|--------|------|---------|--------|
| GET | `/api/search/internal` | Search DMM-ingested releases | ✅ Implemented |
| GET | `/api/search/stats` | FTS5 index statistics | ✅ Implemented |
| POST | `/api/ingest/dmm` | Trigger DMM hashlist sync | ✅ Implemented |
| POST | `/api/attributes/run` | Trigger filename parsing | ✅ Implemented |
| GET | `/health` | Health check | ✅ Implemented |

### 1.3 Search API Contract

**Endpoint:** `GET /api/search/internal`

**Input (query params):**
| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Search query (title, with auto-extracted filters) |
| `year` | number | Filter by year |
| `season` | number | Filter by season |
| `episode` | number | Filter by episode |
| `resolution` | string | Filter by resolution (1080p, 720p, etc.) |
| `source` | string | Filter by source (BluRay, WEB-DL, etc.) |
| `codec` | string | Filter by codec (x264, x265) |
| `hdr` | 0/1 | Filter by HDR |
| `audio` | string | Filter by audio format |
| `limit` | number | Max results (default 50, max 100) |
| `offset` | number | Pagination offset |
| `providers` | true | Include provider observations |
| `media` | true | Include media associations |

**Output:**
```json
{
  "results": [
    {
      "hash": "infoHash",
      "fileIndex": null,
      "filename": "release filename",
      "parsed": {
        "title": "parsed title",
        "year": 2024,
        "season": 5,
        "episode": 14,
        "resolution": "1080p",
        "source": "BluRay",
        "codec": "x264",
        "hdr": false,
        "audio": "AAC",
        "releaseGroup": "GROUP"
      },
      "confidence": 0.85,
      "score": 0.72,
      "relevance": 0.65,
      "quality": 0.8,
      "provider": 0.0,
      "providers": [],
      "media": []
    }
  ],
  "total": 42,
  "query": {
    "match": "\"Breaking\"* AND \"Bad\"*",
    "filters": {"season": 5, "episode": 14, "resolution": "1080p"},
    "titleQuery": "Breaking Bad"
  },
  "timings": {"totalMs": 3},
  "stats": {"indexed": 15000, "total": 15000}
}
```

---

## 2. Existing API/Search Capabilities

### 2.1 Search Engine (search-engine.js)
- **FTS5 full-text search** over `release_search` virtual table
- **Query parsing:** Auto-extracts year, season/episode, resolution, source from query text
- **Structured filtering:** year, season, episode, resolution, source, codec, HDR, audio
- **Composite ranking:** `relevance × 0.30 + confidence × 0.25 + quality × 0.25 + provider × 0.20`
- **Pagination:** limit + offset
- **Optional includes:** provider observations, media associations

### 2.2 Index Coverage
The FTS5 index contains:
- `title` — parsed release title
- `filename` — raw filename
- `resolution` — 1080p, 720p, etc.
- `source_type` — BluRay, WEB-DL, etc.
- `codec` — x264, x265
- `audio` — AAC, DTS, etc.
- `release_group` — release group name
- `language` — language code
- `media_type` — movie, episode, unknown

### 2.3 Ranking Factors
Implemented:
- FTS5 BM25 title relevance
- Year match (filter)
- Season/episode match (filter)
- Release quality (resolution + source tiers)
- Parser confidence
- Provider cache state (future)

Not yet implemented:
- User preference learning
- Popularity/seeders
- Recency boost

---

## 3. Remaining Gaps

### 3.1 Critical

| Gap | Impact | Priority |
|-----|--------|----------|
| **No scheduler** | DMM ingestion must be triggered manually | High |
| **No provider hydration** | Provider cache state always empty | High |
| **No media identity** | No `candidate_media` associations from filename | Medium |

### 3.2 Important

| Gap | Impact | Priority |
|-----|--------|----------|
| No rate limiting | API vulnerable to abuse | Medium |
| No input validation | Query params not sanitized | Medium |
| No pagination metadata | Client can't calculate page count | Low |
| No sorting options | Can't sort by size, date, etc. | Low |

### 3.3 Future

| Gap | Impact | Priority |
|-----|--------|----------|
| Torrentio/Comet integration | Live cache status | Future |
| Real-Debrid cache checks | Provider ranking signal | Future |
| Cinemeta/TMDB enrichment | Media identity | Future |
| TorBox library inspection | Provider observations | Future |

---

## 4. Proposed Minimal Changes

### 4.1 Current Implementation Status

The following have been implemented in this session:

✅ **Persistent database:** `searchCache` now uses `DISCOVERY_DB` env var for dbPath
✅ **Enhanced search filters:** codec, HDR, audio filters added
✅ **Media associations in results:** `includeMedia` param
✅ **fileIndex in results:** Always included
✅ **DMM ingest endpoint:** `POST /api/ingest/dmm`
✅ **Attribute run endpoint:** `POST /api/attributes/run`
✅ **Comprehensive tests:** 273 tests pass

### 4.2 Architecture Invariants Preserved

| Invariant | Status |
|-----------|--------|
| Candidate identity = (infoHash, fileIndex) | ✅ Never mutated |
| Release attributes = evidence only | ✅ No media associations created |
| Provider observations separate | ✅ Not created by attribute worker |
| Candidate_media separate | ✅ Not created by attribute worker |
| Parser failures isolated | ✅ Per-candidate failure isolation |
| Higher confidence wins | ✅ On parser re-run |
| Source attribution preserved | ✅ Parser source stored |

### 4.3 What Was NOT Changed

- FTS5 search engine (preserved, not replaced)
- Ranking formula (preserved, weights unchanged)
- Database schema (no migrations needed)
- Existing test behavior (all 267 prior tests pass)

---

## 5. Parser Reprocessing Semantics

### 5.1 Parser Version Representation

Parser versions are represented via the `source` field in `release_attributes`:
- `ptn-regex` — current custom regex parser (v1)
- Future: `ptn-regex-v2`, `guessit`, `parse-torrent-name`, etc.

Multiple parsers can contribute attributes to the same candidate (one row per source).

### 5.2 Intentional Reparse

To reparse with an improved parser:
1. Deploy new parser with a new `source` name (e.g., `ptn-regex-v2`)
2. Run `runAttributeWorker` with the new parser
3. New attributes are stored alongside old ones (different `source`)
4. `mergeReleaseAttributes()` picks highest confidence per field

To force-reparse with the same source:
- New confidence must be **strictly higher** than existing
- Equal confidence → latest wins (updates allowed)
- Lower confidence → skipped (preserves existing)

### 5.3 Stale Lower-Confidence Attributes

`storeReleaseAttributes()` conflict resolution:
```javascript
if (existing[0].confidence > normalizedConfidence) {
  return false;  // Existing is strictly stronger — preserve
}
// Otherwise update (equal or weaker)
```

This means:
- A confidence-0.6 parse won't overwrite a confidence-0.9 parse
- A confidence-0.9 parse WILL overwrite a confidence-0.6 parse
- Equal confidence → latest wins (allows correction of bad parses)

### 5.4 Source Attribution

Each `release_attributes` row stores:
- `source` — parser source identifier (e.g., `ptn-regex`)
- `confidence` — parser confidence
- `evidence` — JSON array of evidence tags
- `parsed_at` — timestamp

This is sufficient to track provenance and debug parsing decisions.

---

## 6. Provider Integration Assumptions (Conservative)

### 6.1 What We Know

- `provider_observations` table exists and works
- Search ranking consumes provider cache state
- Provider bonus: single=0.4, two=0.7, three+=1.0

### 6.2 What We Do NOT Know

- TorBox API rate limits (not tested)
- Real-Debrid cache check format (not tested)
- Torrentio/Comet result structure (not tested)
- Zurg folder structure relevance (not verified)

### 6.3 Conservative Claims

The system is ready to **accept** provider observations but does NOT yet:
- Fetch provider cache status
- Normalize provider result formats
- Handle provider API errors
- Implement provider-specific rate limiting

These require separate research and implementation tracks.

---

## 7. Next Milestones (Priority Order)

1. **Scheduler** — Automated DMM ingestion (every 6h) + attribute parsing
2. **Provider Worker** — TorBox/RD cache status → `provider_observations`
3. **Media Identity** — Wire Cinemeta/TMDB enrichment into `worker.js`
4. **API Hardening** — Rate limiting, input validation, error handling

---

## 8. Decision Record

### Persistent Database for Search Server

**Decision:** `searchCache` now accepts `dbPath` via `DISCOVERY_DB` env var or `dependencies.dbPath`. Defaults to in-memory for testing.

**Rationale:**
- In-memory cache always returned empty results in production
- No schema changes needed — just persistent storage
- Backward compatible (tests still use in-memory)

**Impact:** Zero test failures. Production now requires `DISCOVERY_DB=./data/discovery.db`.

### Search Result Enhancements

**Decision:** Added `fileIndex` to results, `includeMedia` param, and codec/HDR/audio filters.

**Rationale:**
- `fileIndex` needed for multi-file torrent support
- Media associations requested by API consumers
- Codec/HDR/audio are common filtering needs

**Impact:** Backward compatible (new fields are additive).
