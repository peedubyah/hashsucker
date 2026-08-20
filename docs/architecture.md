# HashSucker Architecture

Source-of-truth architecture document for the HashSucker project.

## Project Purpose

HashSucker is a media discovery, ingestion, and enrichment pipeline. It discovers media candidates from multiple sources (user searches, hashlists, scrapers), stores them with verified identity, and enriches them with media metadata.

## Current Pipeline

```
External sources (DMM, Stremio, Torznab, scrapers)
    |
    v
Ingestion (ingestCandidates — source-agnostic boundary)
    |
    v
Candidate cache (SQLite: candidates + provider_observations)
    |
    +------------------+------------------+------------------+
    |                  |                  |                  |
    v                  v                  v                  v
Attribute worker  Enrichment worker  Provider workers  (future)
(filename parse   (filename/title    (cache status)
 → release_attrs)  → media identity)
    |                  |
    v                  v
release_attributes   candidate_media
(evidence)           (associations +
                      confidence +
                      evidence)
    |
    v
FTS5 index (release_search)
    |
    v
Search layer (searchReleases — user-facing API)
```

## Layer Responsibilities

### 1. Ingestion Layer

**Source-agnostic boundary** that normalizes external data into the candidate cache.

- `src/lib/discovery/ingest.js` — `ingestCandidates()` writes candidates through cache APIs
- `src/lib/discovery/adapters/dmm.js` — DMM hashlist adapter (LZString + JSON parse)
- Source adapters convert raw data → `{ infoHash, fileIndex, title, filename, size, sources[] }`
- Ingestion does NOT infer media identity — it stores what the source provides

**Contract:**
- Ingestion must go through `ingestCandidates()` — never bypasses cache APIs
- Ingestion preserves candidate identity `(infoHash, fileIndex)`
- Ingestion does NOT create `candidate_media` associations
- Ingestion does NOT create provider observations

### 2. Candidate Cache

**SQLite-backed persistent storage** with two tables:

- `candidates` — normalized torrent identity + metadata
- `provider_observations` — provider-specific state (cached, evidence, timestamps)

Key APIs:
- `createDiscoveryCache()` — factory with `:memory:` or file path
- `upsertCandidate()` — identity-merge (no fuzzy merge)
- `queryCachedCandidates()` — read-through with `searchKey`, `maxAgeMs`, `withObservations`
- `StaleWhileRefresher` — SWR wrapper for cache-first queries
- `withCacheFailureIsolation()` — swallows cache errors, returns safe result

### 3. Media Associations (`candidate_media`)

**Separate table** linking candidates to media identifiers:

| Column | Type | Notes |
|--------|------|-------|
| `info_hash` | TEXT | FK to candidates |
| `file_index_key` | INTEGER | FK to candidates |
| `media_id` | TEXT | Media identifier (e.g., `tt2085059:7:3`) |
| `source` | TEXT | Source of association: `search`, `filename-parser`, etc. |
| `confidence` | REAL | 0.0–1.0 |
| `evidence` | TEXT | JSON array: why this association exists |
| `associated_at` | INTEGER | Epoch ms |

Key APIs:
- `associateMedia()` — create association (overwrites on conflict)
- `upsertMediaAssociation()` — merge association (preserves existing evidence on conflict)
- `getMediaAssociations()` — get all associations for a candidate
- `queryCandidatesByMedia()` — find candidates for a media ID

**Invariants:**
- Candidate identity is independent of media association
- Multiple media identifiers can associate with same candidate
- Same candidate from different sources merges by identity only
- Media association is additive — never removes existing associations
- Unknown media identity is valid — candidate with no associations is still retrievable

### 4. Enrichment Boundary

**Filename/title → media identity** resolution.

- `src/lib/discovery/enrichment.js` — `enrichCandidate()`, `enrichCandidates()`, `getUnenrichedCandidates()`

**Contract:**
- Input: candidate identity + available metadata (filename, title)
- Output: media associations with confidence + evidence
- Enrichment may associate candidates with media identifiers
- Enrichment MUST NOT mutate candidate identity
- Enrichment MUST NOT create provider observations
- Unknown matches remain unknown (no forced associations)
- Confidence is always explicit (default 0.5 if not provided)
- Evidence is optional but recommended (array of string tags)

### 5. Release Attributes Boundary

**Filename-derived attributes** separate from candidates and media associations.

- `src/lib/discovery/release-attributes.js` — `storeReleaseAttributes()`, `getReleaseAttributesForCandidate()`, etc.

**Table:** `release_attributes`

| Column | Type | Notes |
|--------|------|-------|
| `info_hash` | TEXT | FK to candidates |
| `file_index_key` | INTEGER | FK to candidates |
| `source` | TEXT | Parser source (e.g., 'ptn', 'guessit') |
| `filename` | TEXT | Raw filename preserved |
| `confidence` | REAL | Parser confidence 0.0–1.0 |
| `title` | TEXT | Normalized title |
| `year` | INTEGER | Release year |
| `media_type` | TEXT | Type guess: movie, episode, unknown |
| `season` | INTEGER | Season number |
| `episode` | INTEGER | Episode number |
| `episode_range` | TEXT | Episode range (e.g., "1-3") |
| `resolution` | TEXT | Resolution (e.g., "1080p", "2160p") |
| `source_type` | TEXT | Source (e.g., "WEB-DL", "BluRay") |
| `codec` | TEXT | Video codec (e.g., "x264", "x265") |
| `hdr` | INTEGER | HDR flag (0/1) |
| `audio` | TEXT | Audio format (e.g., "AAC", "DTS") |
| `language` | TEXT | Language (e.g., "en", "multi") |
| `release_group` | TEXT | Release group name |
| `evidence` | TEXT | JSON array of evidence tags |
| `parsed_at` | INTEGER | Epoch ms |

**Primary key:** `(info_hash, file_index_key, source)` — one row per candidate per parser source.

**Contract:**
- Release attributes are SEPARATE from candidates (different table)
- Release attributes are SEPARATE from candidate_media (different purpose)
- Release attributes are EVIDENCE, not identity — they don't imply media association
- Release attributes do NOT create provider observations
- Multiple parsers can contribute attributes
- Stronger confidence wins conflicts (same source overwrite)
- Attributes survive cache reload (persistent storage)
- Source is preserved — no fuzzy merge

**Key APIs:**
- `storeReleaseAttributes()` — store attributes from a parser source
- `storeReleaseAttributesBatch()` — batch store multiple sources
- `getReleaseAttributesForCandidate()` — get all sources (sorted by confidence)
- `getReleaseAttributesBySource()` — get specific parser source
- `getStrongestReleaseAttributes()` — get highest confidence attributes
- `mergeReleaseAttributes()` — merge multiple sources (highest confidence wins per field)
- `hasReleaseAttributes()` — check if candidate has any attributes
- `getCandidatesWithoutAttributes()` — find candidates needing parsing
- `validateReleaseAttributes()` — validate attributes object

### 6. Filename Parser Adapter

**Regex-based filename parser** producing release attributes from release filenames.

- `src/lib/discovery/parser-adapter.js` — `parseFilename()`, `createReleaseAttributes()`, `parseFilenames()`

**Parser source:** `ptn-regex` (custom regex implementation based on PTN patterns)

**Contract:**
- Parser failures do NOT break ingestion (returns null for invalid input)
- Low-confidence parses ARE stored (with low confidence value)
- Ambiguous titles remain unresolved (no forced matches)
- Evidence tags preserved (describes what patterns were detected)
- Raw filename ALWAYS retained (original string preserved)
- Does NOT resolve media identity
- Does NOT create candidate_media rows
- Does NOT create provider observations

**Parsed fields:** title, year, media_type, season, episode, episode_range, resolution, source_type, codec, hdr, audio, language, release_group

**Evidence tags:** title_extracted, year_detected, season_episode_detected, episode_range_detected, resolution_detected, source_detected, codec_detected, hdr_detected, audio_detected, language_detected, release_group_detected

### 7. Release Attribute Worker

**Orchestration layer** that processes candidates without release attributes.

- `src/lib/discovery/attribute-worker.js` — `runAttributeWorker()`, `createAttributeWorker()`

Pipeline:
```
getCandidatesWithoutAttributes() → worker → parseFilename() → storeReleaseAttributes()
```

**Contract:**
- Does NOT mutate candidate identity (infoHash, fileIndex)
- Does NOT create candidate_media associations
- Does NOT create provider observations
- Only creates release_attributes (parsed filename metadata)
- Per-candidate failure isolation (one parse failure doesn't affect others)
- Low-confidence parses ARE stored (with confidence value)
- Evidence tags preserved
- Raw filename always retained
- Worker is source-agnostic — parser function is injected
- Idempotent — re-running doesn't duplicate attributes

### 8. DMM Ingestion Runner

**Orchestrates fetching, parsing, and ingesting DMM hashlist data.**

- `src/lib/discovery/dmm-ingestion-runner.js` — `DMMIngestionRunner`, `DMMHashListSource`

Pipeline:
```
listFragments() → fetchFragment() → decompress → streamParse → transformDMMRecord → ingestCandidates
                                                                      ↓ (post-ingestion)
                                                              runAttributeWorker → release_attributes → FTS5 index
```

**Contract:**
- Uses existing `ingestCandidates()` boundary for candidate writes
- Automatically runs attribute parsing pass after ingestion (configurable)
- Streaming JSON parser for memory efficiency
- Batch ingestion with configurable size
- Metrics: records processed, inserted, updated, failed, duplicates, duration

### 10. Enrichment Worker

**Orchestration layer** that processes unenriched candidates.

- `src/lib/discovery/worker.js` — `runEnrichmentWorker()`, `createEnrichmentWorker()`, `enrichSingleCandidate()`

Pipeline:
```
getUnenrichedCandidates() → worker → enrichCandidates()
```

**Contract:**
- Per-candidate failure isolation (one failure doesn't affect others)
- All writes go through `enrichCandidates()` — never direct SQLite
- Worker is source-agnostic — enrichment function is injected
- Worker does NOT create provider observations
- Worker does NOT trigger importer behavior
- Progress callbacks available for observability

### 11. Search Layer

**FTS5-backed full-text search** over the parsed release corpus.

- `src/lib/discovery/search-engine.js` — `searchReleases()`, `getSearchStats()`, `rebuildSearchIndex()`
- `src/lib/discovery/cache.js` — `release_search` FTS5 virtual table with auto-sync triggers

Pipeline:
```
Query text + filters
  → FTS5 full-text match
  → Structured attribute filtering (year, season, resolution, etc.)
  → Rank by composite score (relevance × confidence × quality × provider)
  → Return ranked candidates with parsed attributes
```

**Scoring:**
```
score = relevance × 0.30 + confidence × 0.25 + quality × 0.25 + provider × 0.20
```

**Contract:**
- Auto-extracts filters from query (year, season/episode, resolution, source)
- Combines FTS5 text search with structured attribute filtering
- Ranks by composite score (relevance, parser confidence, release quality, provider cache)
- Supports pagination and provider observation inclusion
- FTS5 index auto-maintained by triggers on release_attributes

## Data Ownership Boundaries

### Candidates
- Torrent/hash identity: `(infoHash, fileIndex)` — physical file identity
- Source provenance: `sources[]` array — which discovery sources contributed
- Metadata: title, size, seeders, leechers, publish date, magnet, etc.
- Provider-agnostic: no provider-specific state stored here

### Candidate_media
- Inferred/confirmed media identity: `mediaId` — what media this represents
- Confidence: 0.0–1.0 — how certain is this association
- Source: which enrichment source created this association
- Evidence: array of string tags explaining WHY this association exists
- Timestamps: when the association was created/updated

### Release Attributes
- Filename-derived metadata: title, year, season, episode, resolution, codec, etc.
- Parser source: which parser produced these attributes
- Confidence: parser's confidence in the parse result
- Evidence: tags explaining what patterns were detected
- Multiple sources: one row per candidate per parser source
- Does NOT imply media identity — evidence only

### Provider Observations
- Provider-specific state: cached availability, evidence payloads
- Timestamps: when the observation was checked
- TTL: observations expire independently per provider
- NEVER store provider observations in candidates

## Ingestion Contract

### DMM Hashlists (Verified)

**Repository:** github.com/debridmediamanager/hashlists

**Format:** HTML wrapper → LZString-compressed JSON → `{ torrents: [...] }` or flat array

**Per-record fields (only 3):**
| DMM Field | HashSucker Field | Notes |
|-----------|-----------------|-------|
| `hash` | `infoHash` | Required, 40-char hex |
| `filename` | `title`, `filename` | Required, release title |
| `bytes` | `size` | Optional, file size in bytes |

**DMM does NOT provide:**
- Media identity (no mediaId, imdb, tmdb)
- Confidence score
- Seeders/leechers
- Magnet URI
- fileIndex

**Update cadence:** Every 6 hours
**Reference:** github.com/mhdzumair/MediaFusion/blob/main/python-deprecated/workers/scrapers/dmm_hashlist.py

### General Ingestion Rules

- Ingestion is source-agnostic — same boundary for all sources
- Ingestion stores what the source provides — no inference
- DMM is hash-first ingestion — media identity comes later via enrichment
- Ingestion adapters are pure parsers — no network calls, no cache writes

## Enrichment Contract

### Input
- Candidate identity: `{ infoHash, fileIndex }`
- Available metadata: `{ title, filename, size, sources[] }`

### Output
```js
{
  infoHash: "...",
  fileIndex: null,
  matches: [
    { mediaId: "tt2085059:7:3", confidence: 0.94 }
  ],
  source: "filename-parser",
  evidence: ["title_exact_match", "year_match", "movie_pattern"]
}
```

### Rules
- Enrichment may associate candidates with media identifiers
- Enrichment MUST NOT mutate candidate identity
- Enrichment MUST NOT create provider observations
- Unknown matches remain unknown (return `null` or empty `matches`)
- Confidence is always explicit (0.0–1.0)
- Evidence is optional but recommended (array of string tags)
- Higher confidence wins on conflict (equal confidence → latest wins)

## Cache Read-Through

**Stale-while-refresh semantics:**

```js
const refresher = new StaleWhileRefresher({
  cache,
  maxAgeMs: 30000,
  searchKey: intent.mediaId,
  refresh: async () => { /* live discovery */ },
});

const result = await refresher.query();
// result.status: 'fresh' | 'stale' | 'miss'
// result.candidates: array of candidates
```

- **Fresh** → cache hit within `maxAgeMs`, no refresh
- **Stale** → cache hit but older, returns stale data + triggers background refresh
- **Miss** → no candidates, triggers refresh

## Secrets Boundary

Provider credentials are server-side secrets. The browser never receives:
- API keys (TorBox, Sonarr, Radarr)
- Internal metadata (`raw`, `behaviorHints`, `torznab`)
- Direct download URLs (may contain API keys in query strings)

The server performs all provider-cache enrichment.

## Deployment

Single container, plain Node.js ESM (no build step). Production listens on configurable port (default 3000).

```
media-search container
    |
    +-- serves static UI
    +-- exposes /api/*
    +-- performs provider/discovery requests server-side
    +-- submits importer requests
    |
    v
shared request transport (/requests)
    |
    v
torbox-importer container
```

## Design Constraints

The following constraints are **explicitly preserved**:

- **No trash filtering**: Do not add aggressive quality/size filtering rules
- **No ranking overhaul**: Do not implement torrent ranking/scoring yet
- **No behavior changes**: Cache is additive; live discovery is authoritative
- **Cache failures must not break search**: All write paths are wrapped to swallow errors
- **No fuzzy merge**: Same hash = same candidate; different hash = different candidate
- **Provider observations separated**: Never store provider state in candidates
- **Enrichment is additive**: Never removes existing media associations

## Future Work

### Zurg-style enrichment research
- Zurg public release architecture investigation
- Metadata enrichment sources beyond filename parsing
- Title resolution via external APIs (TMDB, IMDB)

### Metadata enrichment sources
- Filename/title parsing (PTT-style)
- External metadata provider integration
- Season/episode pattern matching

### Provider expansion
- Additional debrid providers beyond TorBox
- Usenet (NZB) support
- Direct download support

### Ranking system
- RTN integration for quality-based ranking
- User preference learning
- Release scoring heuristics
