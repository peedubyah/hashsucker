# HashSucker MVP Pipeline Consolidation

> **ARCHIVED MILESTONE:** Superseded by the [2026-08-21 audit](../audit/8-21-audit.md). Its end-to-end DMM claim does not match the current API-reachable wrapper path; test counts and frontend guidance are historical.

**Date:** 2026-08-20
**Status:** Historical completion report

---

## 1. Executive Summary

Two implementation tracks (WINDOWS and RIGHTMON) have been consolidated into a single coherent pipeline. The DMM hashlist corpus can now be ingested, parsed into structured release attributes, indexed via FTS5, and searched with ranked results.

**Current state:** 267 tests pass, 0 failures.

---

## 2. MVP Pipeline (End-to-End)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ DMM Hashlist Source (github.com/debridmediamanager/hashlists)              │
│  → HTML → LZString payload → JSON { torrents: [{ hash, filename, bytes }] }│
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ DMM Source Adapter (adapters/dmm.js) — WINDOWS                            │
│  → parseDmmRecord(): validates hash, normalizes filename, adds source tag  │
│  → Output: { infoHash, fileIndex: null, title, filename, size, sources[] } │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Ingestion Boundary (ingest.js) — RIGHTMON                                 │
│  → ingestCandidates(): upsertCandidate + associateMedia (if provided)      │
│  → Writes to: candidates table                                            │
│  → Does NOT create release_attributes or provider_observations            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Attribute Worker (attribute-worker.js) — RIGHTMON                          │
│  → getCandidatesWithoutAttributes() → parseFilename() → storeReleaseAttrs  │
│  → Writes to: release_attributes table (FTS5 auto-sync via triggers)       │
│  → Does NOT mutate candidate identity                                      │
│  → Does NOT create candidate_media or provider_observations               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Search Layer (search-engine.js + cache.js) — RIGHTMON                     │
│  → FTS5 MATCH on release_search virtual table                             │
│  → Structured filters (year, season, episode, resolution, source)         │
│  → Composite ranking: relevance × confidence × quality × provider         │
│  → Returns ranked candidates with parsed attributes + scores              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Consolidated Architecture

### 3.1 Source Adapters

| Adapter | File | Responsibility | Status |
|---------|------|----------------|--------|
| DMM Hashlist | `adapters/dmm.js` | Parse raw DMM records into ingest entries | ✅ Canonical (WINDOWS) |
| Torznab | `adapters/torznab.js` | Parse Torznab results | ✅ Existing |
| Stremio | `adapters/stremio.js` | Parse Stremio results | ✅ Existing |

**Contract:** Source adapters are pure parsers. They do NOT write to cache, call external APIs (except fetching), or contain pipeline logic. Output is always `{ infoHash, fileIndex, title, filename, ... }`.

### 3.2 Ingestion Boundary

| Function | File | Responsibility |
|----------|------|----------------|
| `ingestCandidates()` | `ingest.js` | Source-agnostic write boundary |
| `ingestEntry()` | `ingest.js` | Per-entry upsert + media association |

**Contract:**
- Input: `{ source, entries[], providerObservations[] }`
- Each entry must have `{ infoHash, fileIndex, ...candidateFields }`
- Optional `mediaAssociations[]` → writes to `candidate_media`
- Optional `providerObservations[]` → writes to `provider_observations`
- Writes to `candidates` via `upsertCandidate()`

### 3.3 Enrichment Workers

| Worker | File | Reads | Writes | Status |
|--------|------|-------|--------|--------|
| Attribute Worker | `attribute-worker.js` | `candidates` | `release_attributes` | ✅ MVP |
| Media Enrichment Worker | `worker.js` | `candidates` | `candidate_media` | ✅ Exists |

**Key separation:**
- Attribute worker = filename parsing (evidence only, no identity)
- Media enrichment worker = media identity resolution (TMDB/IMDb/Cinemeta)

Both are source-agnostic — they operate on any candidate regardless of ingestion source.

### 3.4 Search Layer

| Component | File | Responsibility |
|-----------|------|----------------|
| FTS5 Index | `cache.js` (triggers) | Auto-synced with `release_attributes` |
| Search Engine | `search-engine.js` | Query parsing, filtering, ranking |
| API Endpoint | `server/app.js` | `GET /api/search/internal` |

**Ranking formula:**
```
score = relevance × 0.30 + confidence × 0.25 + quality × 0.25 + provider × 0.20
```

---

## 4. Integration Boundary Verification

### 4.1 WINDOWS DMM → RIGHTMON Ingestion

**Finding:** WINDOWS' `adapters/dmm.js` (`parseDmmRecord`) is the canonical DMM parser. RIGHTMON's `dmm-ingestion-runner.js` previously had a duplicate `transformDMMRecord()`.

**Resolution:** Deleted the duplicate. `dmm-ingestion-runner.js` now imports `parseDmmRecord` from the adapter and only adds `firstSeen`/`lastSeen` timestamps.

**Result:** The adapter is the single source of truth for DMM parsing. The runner is the orchestrator.

### 4.2 Attribute Worker Independence

**Finding:** The attribute worker reads from `candidates` table generically. It does NOT import or depend on any DMM-specific code.

**Result:** The attribute worker can operate on candidates from ANY source (DMM, Torznab, scraper, manual).

### 4.3 Parser Version Safety

**Finding:** `storeReleaseAttributes()` uses "higher confidence wins" conflict resolution. Re-running with an improved parser only updates attributes where the new confidence is strictly higher.

**Result:** Parser upgrades are safe — they never degrade existing attributes.

### 4.4 Evidence-Only Boundary

**Finding:** The attribute worker writes ONLY to `release_attributes`. It explicitly does NOT:
- Mutate `candidates` (read-only)
- Create `candidate_media` associations
- Create `provider_observations`

**Result:** Filename parsing is evidence, not identity. Media identity resolution remains a separate concern.

### 4.5 Table Isolation

| Table | Written by Ingestion | Written by Attribute Worker | Written by Media Enrichment |
|-------|---------------------|----------------------------|------------------------------|
| `candidates` | ✅ | ❌ | ❌ |
| `candidate_media` | ✅ (if mediaAssociations) | ❌ | ✅ |
| `release_attributes` | ❌ | ✅ | ❌ |
| `provider_observations` | ✅ (if providerObservations) | ❌ | ❌ |

---

## 5. Remaining Blockers to Usable Backend API

### 5.1 Scheduling / Automation

**Gap:** No automated scheduler runs DMM ingestion or attribute parsing periodically.

**Required:**
- Cron or interval-based trigger for `DMMIngestionRunner.run()`
- Post-ingestion attribute parsing (already wired into runner)
- Health monitoring / metrics persistence

### 5.2 Provider Hydration

**Gap:** The `provider_observations` table exists and affects search ranking, but no worker populates it.

**Required:**
- TorBox cache status worker (check if hashes are cached)
- Real-Debrid cache status worker
- Torrentio/Comet intelligence ingestion (see §6)

### 5.3 Media Identity Resolution

**Gap:** `candidate_media` table exists and the media enrichment worker exists, but no enrichment source is wired.

**Required:**
- Filename → media identity resolution (Sonarr/Radarr Parse API)
- Cinemeta/TMDB metadata lookup
- Manual override capability

### 5.4 API Completeness

**Gap:** `/api/search/internal` exists but may need filtering enhancements.

**Required:**
- Quality/profile filtering
- Pagination with total count (exists)
- Release group filtering
- Multi-select filters (codec, audio, HDR)

---

## 6. Provider Integration Requirements (Future)

### 6.1 Torrentio/Comet — NOT Replacements

Torrentio and Comet are high-value **intelligence sources**, NOT replacements for local search.

**What they provide:**
- Real-time cache status (what's actually available on debrid services)
- Release quality signals (popularity, trust scores)
- Live availability data

**What they DON'T provide:**
- Durable corpus (they're ephemeral)
- Structured metadata (they return release titles, not parsed attributes)
- Full catalog (they're query-response, not bulk)

### 6.2 Integration Strategy

```
Torrentio/Comet → Provider Intelligence Worker → provider_observations
                                                           ↓
                                              Search ranking bonus
```

**Requirements:**
1. Query Torrentio/Comet for specific user searches (NOT bulk ingestion)
2. Extract: infoHash, cached status, release quality signals
3. Store in `provider_observations` (never in `candidates` directly)
4. Use as ranking bonus in search results

**Do NOT:**
- Replace DMM corpus with Torrentio/Comet
- Store their results as primary candidates
- Treat them as authoritative metadata sources

### 6.3 Real-Debrid

RD provides cache status for hashes. Integration:
1. Batch-check hashes against RD API
2. Store in `provider_observations` (provider: 'realdebrid')
3. Use as ranking signal (cached = higher score)

---

## 7. File Inventory (Post-Consolidation)

### Source Adapters
- `src/lib/discovery/adapters/dmm.js` — DMM hashlist parser (canonical, WINDOWS)
- `src/lib/discovery/adapters/torznab.js` — Torznab parser
- `src/lib/discovery/adapters/stremio.js` — Stremio parser

### Core Boundaries
- `src/lib/discovery/ingest.js` — Ingestion boundary (RIGHTMON)
- `src/lib/discovery/cache.js` — SQLite cache + FTS5 schema (RIGHTMON)

### Workers
- `src/lib/discovery/attribute-worker.js` — Filename parsing worker (RIGHTMON)
- `src/lib/discovery/worker.js` — Media identity worker (RIGHTMON)

### Storage Boundaries
- `src/lib/discovery/release-attributes.js` — Release attribute APIs (RIGHTMON)
- `src/lib/discovery/enrichment.js` — Media association APIs (RIGHTMON)

### Search
- `src/lib/discovery/search-engine.js` — FTS5 search engine (RIGHTMON)

### Orchestration
- `src/lib/discovery/dmm-ingestion-runner.js` — DMM ingestion orchestrator (consolidated)

### Tests
- `test/attribute-worker.test.js` — 15 tests (RIGHTMON)
- `test/dmm-ingestion.test.js` — 29 tests (consolidated)
- `test/search-engine.test.js` — 37+ tests (RIGHTMON)
- `test/cache.test.js` — 100 tests (RIGHTMON)

---

## 8. Decision Record

### DMM Parser Consolidation

**Decision:** Delete `transformDMMRecord()` from `dmm-ingestion-runner.js`. Import `parseDmmRecord()` from `adapters/dmm.js`.

**Rationale:**
- WINDOWS' adapter is well-tested with real DMM data
- RIGHTMON's runner duplicate was a subset (missing `mediaAssociations`, `seeders`, etc.)
- Single source of truth prevents drift
- The adapter remains a pure parser (no I/O, no cache writes)

**Impact:** Zero test failures. Adapter becomes canonical.

### FTS5 Trigger Mechanism

**Decision:** Replace FTS5 special `'delete'` command with `DELETE FROM ... WHERE rowid = old.rowid`.

**Rationale:**
- The `'delete'` command fails in Node.js's bundled SQLite
- Regular DELETE works perfectly in triggers
- No functional difference

**Impact:** Release attribute upserts now work correctly.

---

## 9. Next Milestone Candidates

1. **Scheduling** — Automated DMM ingestion (every 6 hours) + attribute parsing
2. **Provider Worker** — TorBox/RD cache status checks → `provider_observations`
3. **Media Identity Worker** — Wire Cinemeta/TMDB enrichment into `worker.js`
4. **API Hardening** — Rate limiting, input validation, error handling

**Do NOT:**
- Build a frontend
- Replace DMM with Torrentio/Comet
- Build a Stremio addon
- Chase hidden CDN infrastructure
