# Architecture

Source-of-truth architecture document for the media-search project.

## Project Purpose

Unified media discovery/search layer.

The application is a single-container browser application for finding media releases and submitting explicit TV episode requests to the torbox-importer shared queue. It is the user-facing request producer.

## Current Architecture

```
User request
    |
    v
API/search layer
    |
    v
Discovery adapters
    |
    v
Candidate normalization/merging
    |
    v
Provider enrichment
    |
    v
Response
```

### Component Responsibilities

- **`media-search/src/server/`** — HTTP server, API routes, static UI serving
- **`media-search/src/lib/discovery/`** — Discovery adapters (Stremio, Torznab), candidate normalization, source registry
- **`media-search/src/lib/providers/`** — Provider-specific cache checks (TorBox)
- **`media-search/src/lib/importer/`** — Importer client abstraction (queue-based)
- **`media-search/src/lib/requests/`** — Request intent, handoff, queue primitives
- **`media-search/src/ui/`** — Browser application

## Discovery Model

### Candidate Identity

A discovery candidate is identified by exactly `(infoHash, fileIndex)`.

- **`infoHash`** — 40-character hex SHA-1 hash of the torrent info dictionary
- **`fileIndex`** — Optional integer index for multi-file torrents; `null` for single-file

**No fuzzy merge.** Same hash = same candidate. Different hash = different candidate, even if titles match.

### infoHash + fileIndex Semantics

- `infoHash` alone identifies a torrent
- `infoHash + fileIndex` identifies a specific file within a torrent
- `fileIndex: null` is treated as `-1` for database identity (distinct from `fileIndex: 0`)

### Sources

A candidate's `sources` array tracks which discovery sources contributed to this candidate. Multiple sources can contribute the same candidate; they are merged by set-union using a composite key:

```
sourceKey = id|kind|instance|indexer|capability
```

### Metadata Merging

On update (same identity):
- Scalar fields (title, size, seeders, etc.): incoming non-null values **overwrite** existing values
- `sources`: set-union by source key
- `metadata`: shallow merge — incoming keys fill existing missing keys (no overwrite)

### Provider Observations

Provider state is intentionally **separated** from candidates:

- **Candidate** = normalized torrent/media identity (provider-agnostic)
- **Observation** = provider-specific state (cached status, evidence, timestamp)

This separation allows:
- Multiple providers to observe the same candidate independently
- Provider observations to expire and refresh without mutating the candidate
- New providers to be added without schema migration

## Cache Architecture

SQLite-backed persistent cache using Node.js built-in `node:sqlite` (available in Node 24+).

### Tables

**`candidates`** — Normalized torrent/media candidates

| Column | Type | Notes |
|--------|------|-------|
| `info_hash` | TEXT | 40-char hex hash |
| `file_index` | INTEGER | Original fileIndex (nullable) |
| `file_index_key` | INTEGER | `COALESCE(file_index, -1)` — used for PK |
| `title` | TEXT | |
| `filename` | TEXT | |
| `size` | INTEGER | Bytes |
| `seeders` | INTEGER | |
| `leechers` | INTEGER | |
| `publish_date` | TEXT | ISO 8601 |
| `magnet` | TEXT | Magnet URI |
| `download_url` | TEXT | Direct download URL |
| `metadata` | TEXT | JSON object (resolution, codec, HDR, etc.) |
| `sources` | TEXT | JSON array of source objects |
| `first_seen` | INTEGER | Epoch ms |
| `last_seen` | INTEGER | Epoch ms |

**Primary key**: `(info_hash, file_index_key)`

**`provider_observations`** — Provider-specific cache state

| Column | Type | Notes |
|--------|------|-------|
| `info_hash` | TEXT | |
| `file_index` | INTEGER | |
| `file_index_key` | INTEGER | `COALESCE(file_index, -1)` |
| `provider` | TEXT | Provider name (e.g., `torbox`) |
| `cached` | INTEGER | Boolean as 0/1/NULL |
| `evidence` | TEXT | JSON object |
| `checked_at` | INTEGER | Epoch ms |

**Primary key**: `(info_hash, file_index_key, provider)`

### Why Provider State is Separated

1. **Independence**: Each provider's cached state can be refreshed independently without touching the candidate
2. **Extensibility**: New providers are added by inserting observations, not by altering the candidates table
3. **Failure isolation**: A provider observation failure does not corrupt the candidate
4. **TTL flexibility**: Each observation has its own `checked_at` for independent expiration

### Write-Through Integration

Current integration is **write-only** (additive):

```
Live discovery
    |
    v
Candidate normalization
    |
    v
Write-through to cache (fire-and-forget)
    |
    v
Response (unchanged)
```

Cache write failures are swallowed and logged. Live discovery remains authoritative.

### Configuration

- **`DISCOVERY_CACHE_PATH`** — SQLite database file path (default: `/config/discovery-cache.db`)
- WAL mode enabled for concurrent read performance

## Current Implementation Status

### Implemented
- Discovery abstraction (Stremio, Torznab adapters)
- Candidate normalization and merging
- Source registry
- SQLite discovery cache (candidates + provider observations)
- Write-through caching (fire-and-forget, failure-isolated)
- Provider-neutral search result structure

### Not Implemented
- Read-through cache (cache-first query path)
- Background ingestion
- DMM hashlist ingestion
- Ranking system (RTN integration)
- UI overhaul (current UI is functional but has known polish issues)

## Design Constraints

The following constraints are **explicitly preserved**:

- **No trash filtering**: Do not add aggressive quality/size filtering rules
- **No ranking overhaul**: Do not implement torrent ranking/scoring yet
- **No behavior changes**: Cache is additive; live discovery is authoritative
- **Cache failures must not break search**: All write paths are wrapped to swallow errors
- **No fuzzy merge**: Same hash = same candidate; different hash = different candidate

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

## See Also

- `docs/decisions/001-discovery-cache.md` — Architecture decision record for cache design
- `ai-handover.md` — Current implementation state and next work
- `AGENTS.md` — Product boundaries and safety invariants
- `CODEX.md` — Implementation contract
