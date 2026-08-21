# ADR 001: Discovery Cache

> **ARCHIVED PRE-CONSOLIDATION SNAPSHOT:** Non-authoritative. Use [`../decisions/001-discovery-cache.md`](../decisions/001-discovery-cache.md) for the current decision record.

## Status

Implemented (2026-08-20).

## Context

Discovery is currently request-time: each search query triggers live calls to Stremio/Torznab providers and TorBox cache checks. This works but is not scalable for:

- Background discovery (ingesting torrents independent of user queries)
- Ranking/scoring (requires a corpus to rank)
- Provider workers (multiple providers observing the same candidates)

We need a persistent cache to store normalized discovery candidates.

## Decision

Use SQLite via Node.js built-in `node:sqlite` with two tables:

1. **`candidates`** — normalized torrent/media candidates keyed by `(info_hash, file_index)`
2. **`provider_observations`** — provider-specific state keyed by `(info_hash, file_index, provider)`

### Why SQLite

- **Node.js built-in** (`node:sqlite` in Node 24+): No native compilation, no external dependencies, works in Alpine Docker
- **Single-file**: Database is a single file, easy to backup/mount
- **WAL mode**: Concurrent reads with write performance
- **Familiar**: SQL is well-understood; no new query language to learn

### Why Node.js built-in `node:sqlite` over `better-sqlite3`

- **Alpine compatibility**: `better-sqlite3` requires native compilation (node-gyp), which fails in musl-based Alpine containers without build tools
- **No install scripts**: `better-sqlite3` uses `prebuild-install` or `node-gyp rebuild`, both blocked by default in secure npm configurations
- **Maintenance**: `node:sqlite` is maintained by the Node.js team; `better-sqlite3` is a third-party dependency

### Why Candidate Identity is Separate from Provider State

**Problem**: Storing `cached: true` directly on a candidate couples identity to provider state.

**Consequences of coupling**:
- Multiple providers cannot observe the same candidate independently
- Provider state refresh requires mutating the candidate
- Adding a new provider requires schema migration
- Provider observation failure corrupts the candidate

**Solution**: Two-table design where `provider_observations` references candidates by `(info_hash, file_index)` but stores independent observation rows.

**Benefits**:
- Providers refresh observations without touching candidates
- New providers are added by inserting observation rows
- Observation failures don't corrupt candidate data
- Each observation has its own TTL/expiration via `checked_at`

### Why Write-Through Only (Initially)

**Read-through** (cache-first) introduces staleness concerns: users may see outdated results. **Write-through** (cache-aside) keeps live discovery authoritative while building the cache substrate for future background ingestion.

## Alternatives Considered

| Alternative | Rejected Because |
|-------------|------------------|
| `better-sqlite3` | Native compilation issues in Alpine; blocked install scripts |
| `node:sqlite` async API | Sync API is sufficient for write-through; simpler code |
| JSON file store | No query capability; concurrent write issues |
| Redis | External dependency; overkill for single-host deployment |
| Single table with embedded provider state | Couples identity to provider state; not extensible |

## Consequences

- **Positive**: Background discovery, ranking, and provider workers can now be built on a persistent substrate
- **Positive**: Cache is additive — live discovery behavior unchanged
- **Negative**: Storage growth requires monitoring (mitigated by SQLite's efficiency and WAL checkpointing)
- **Negative**: Cache read path not yet implemented (planned for future)

## Future Extensibility

This design supports:
- Background scrapers writing to `candidates`
- DMM hashlist ingestion feeding the same pipeline
- RTN/ranking operating on the cached corpus
- Provider workers refreshing `provider_observations` independently
- Read-through query path when staleness requirements are defined
