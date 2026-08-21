# Zilean Architecture Comparison

> **ARCHIVED RESEARCH:** This dated comparison is evidence only. Its HashSucker state matrix and identity assumptions are superseded by [`../architecture.md`](../architecture.md) and the [2026-08-21 audit](../audit/8-21-audit.md).

**Date:** 2026-08-20
**Purpose:** Understand minimum indexing/search layer needed for Zilean-like functionality in HashSucker.

## Overview

Zilean was a full-text search engine for DMM hashlists. It indexed parsed release metadata and provided a REST API for searching. This document compared Zilean's architecture to HashSucker's state at that date.

---

## Zilean Does

### Data Flow

```
DMM Hashlist (raw)
    |
    v
LZString Decoder (decompressFromEncodedURIComponent)
    |
    v
Record Normalizer
    - filename parsing (title, year, season, episode, quality, codec, group)
    - infoHash normalization (lowercase, 40-char hex)
    - size validation
    |
    v
Index Writer (Elasticsearch/Lucene)
    - Full-text search on title
    - Keyword fields for year, season, episode, resolution, source, codec
    - Range queries for year, size
    |
    v
Search API (REST)
    - Query parsing (title search + filters)
    - Ranking (relevance, recency, quality)
    - Pagination
    - Response formatting
```

### Search Model

| Feature | Implementation |
|---------|---------------|
| Query fields | title (primary), year, season, episode, resolution, source, codec |
| Indexed fields | All query fields + infoHash + size + timestamp |
| Ranking factors | TF-IDF relevance, recency boost, quality bonus |
| Fuzzy matching | Levenshtein distance on title, ~85% similarity threshold |
| Title normalization | Lowercase, strip punctuation, collapse whitespace |
| Year handling | Range queries, exact match |
| Episode handling | SxxEyy parsing, single episode or range |
| Quality filtering | Resolution whitelist, source whitelist |

### Storage/Index Technology

| Component | Technology |
|-----------|------------|
| Search index | Elasticsearch 7.x (or compatible) |
| Document model | JSON documents with keyword + text fields |
| Persistence | Elasticsearch indices on disk |
| Update strategy | Bulk indexing, append-only with upsert |
| Schema | Dynamic mapping with explicit field types |
| Sharding | Single-node, no replication |

### API Design

```
GET /search?q=title&year=2024&season=1&episode=3&resolution=1080p
```

Response:
```json
{
  "results": [
    {
      "infoHash": "abc123...",
      "title": "Show.S01E03.1080p.WEB-DL",
      "year": 2024,
      "season": 1,
      "episode": 3,
      "resolution": "1080p",
      "source": "WEB-DL",
      "size": 2147483648
    }
  ],
  "total": 42,
  "page": 1
}
```

---

## HashSucker Already Does

### Candidate Cache (SQLite)

| Feature | Status | Notes |
|---------|--------|-------|
| infoHash identity | ✅ | 40-char hex, lowercase |
| fileIndex support | ✅ | Multi-file torrent ready |
| Source provenance | ✅ | `sources[]` array with kind/id |
| Provider observations | ✅ | Separate table, cache status |
| Candidate upsert | ✅ | Identity-merge, no fuzzy |
| Media associations | ✅ | `candidate_media` table |

### Release Attributes

| Feature | Status | Notes |
|---------|--------|-------|
| Filename parsing | ✅ | PTN-style regex, 13 fields |
| Raw filename preservation | ✅ | Always retained |
| Confidence scoring | ✅ | 0.0-1.0 per parser |
| Evidence tags | ✅ | 11 distinct tags |
| Multiple parsers | ✅ | PK per source |
| Title extraction | ✅ | Normalized |
| Year extraction | ✅ | 1930-2023 range |
| Season/episode | ✅ | SxxEyy, ranges |
| Resolution | ✅ | 360p-2160p |
| Source | ✅ | WEB-DL, BluRay, etc. |
| Codec | ✅ | x264, x265, etc. |
| HDR | ✅ | Boolean flag |
| Audio | ✅ | AAC, DTS, etc. |
| Language | ✅ | ISO codes |
| Release group | ✅ | Extracted |

### Ingestion Boundary

| Feature | Status | Notes |
|---------|--------|-------|
| Source-agnostic boundary | ✅ | `ingestCandidates()` |
| DMM adapter | ✅ | LZString decode |
| Batch ingestion | ✅ | Configurable batch size |
| Streaming parser | ✅ | Generator pattern |
| Error isolation | ✅ | Per-record failure handling |
| Duplicate detection | ✅ | Identity merge |
| Metrics tracking | ✅ | Full instrumentation |

### Provider Observations

| Feature | Status | Notes |
|---------|--------|-------|
| Separate table | ✅ | Not in candidates |
| Multi-provider | ✅ | TorBox, Real-Debrid, etc. |
| Independent refresh | ✅ | Per-provider TTL |
| Evidence payload | ✅ | JSON evidence per observation |
| Cache status | ✅ | cached/unknown/expired |

---

## HashSucker Still Needs

### Search Layer

| Component | Description | Priority |
|-----------|-------------|----------|
| Full-text index | Title search (SQLite FTS5 or external) | HIGH |
| Query API | HTTP endpoint for search | HIGH |
| Filter by attributes | Year, resolution, source, codec | HIGH |
| Fuzzy title matching | Levenshtein or similar | MEDIUM |
| Ranking/relevance | TF-IDF or custom scoring | MEDIUM |
| Pagination | Offset/limit or cursor-based | LOW |

### Indexed Fields

| Field | Search Type | Current Status |
|-------|-------------|----------------|
| title | Full-text | ✅ Parsed, ❌ Not indexed |
| year | Range query | ✅ Extracted, ❌ Not queryable |
| season | Exact match | ✅ Extracted, ❌ Not queryable |
| episode | Exact match | ✅ Extracted, ❌ Not queryable |
| resolution | Keyword filter | ✅ Extracted, ❌ Not queryable |
| source | Keyword filter | ✅ Extracted, ❌ Not queryable |
| codec | Keyword filter | ✅ Extracted, ❌ Not queryable |
| hdr | Boolean filter | ✅ Extracted, ❌ Not queryable |
| audio | Keyword filter | ✅ Extracted, ❌ Not queryable |
| infoHash | Exact match | ✅ Stored, ❌ Not searchable |

### Query API (Minimum Viable)

```
GET /api/search?q=title+terms
  &year=2024
  &season=1
  &episode=3
  &resolution=1080p
  &source=WEB-DL
  &page=1
  &limit=50
```

Response should include:
- Matching candidates
- Parsed attributes (from release_attributes)
- Media associations (if any)
- Provider cache status (if requested)

### Ranking Factors

| Factor | Implementation |
|--------|---------------|
| Title relevance | FTS5 BM25 or custom TF-IDF |
| Attribute match | Bonus for each filter matched |
| Recency | `last_seen` timestamp |
| Quality | Resolution, source tier |
| Media association | Bonus if linked to known media |

### Storage for Search

**Option A: SQLite FTS5**
- Pros: No external dependency, already in use
- Cons: Limited fuzzy matching, manual ranking
- Recommended for: MVP, single-node deployments

**Option B: External Elasticsearch**
- Pros: Full-featured, scalable, proven
- Cons: Heavy dependency, operational complexity
- Recommended for: Multi-node, high-volume

**Option C: Hybrid**
- SQLite for primary data
- FTS5 for full-text index
- External ES if scale requires

---

## Things HashSucker Should NOT Copy

### 1. Monolithic Search Index

Zilean stored everything in Elasticsearch. HashSucker should keep:
- **Candidate identity** in SQLite (relational, transactional)
- **Release attributes** in SQLite (evidence layer)
- **Search index** as a derived/cache layer (rebuildable)

### 2. Implicit Media Identity

Zilean associated releases with media (IMDb/TMDB) at index time. HashSucker should:
- Keep media associations **separate** from release attributes
- Allow multiple/paradoxical associations
- Never delete attributes because association changes

### 3. Single-Node Elasticsearch

Zilean ran single-node ES. HashSucker should avoid:
- External dependency on Elasticsearch cluster
- Heavy JVM-based search infrastructure
- Complex index management

Instead: SQLite FTS5 for MVP, migrate to ES only if required.

### 4. Tight Coupling to DMM

Zilean was DMM-specific. HashSucker already supports:
- Multiple ingestion sources (DMM, Stremio, Torznab)
- Source-agnostic candidate model
- Multiple enrichment parsers

Keep this abstraction.

### 5. Recency-Only Ranking

Zilean ranked by recency + relevance. HashSucker should consider:
- Quality (resolution, source tier)
- Media association confidence
- Provider cache status
- User preferences/history

---

## Architecture Gap Analysis

### What Exists

```
┌─────────────────────────────────────────────────────────────┐
│ HashSucker Current State                                    │
├─────────────────────────────────────────────────────────────┤
│  Ingestion Layer (DMM adapter, ingestCandidates)           │
│  Candidate Cache (SQLite: candidates, provider_obs)        │
│  Release Attributes (SQLite: release_attributes)           │
│  Media Associations (SQLite: candidate_media)              │
│  Enrichment Boundary (enrichment.js, worker.js)            │
│  Parser Adapter (parser-adapter.js)                        │
│  Release Attributes API (release-attributes.js)            │
└─────────────────────────────────────────────────────────────┘
```

### What's Missing

```
┌─────────────────────────────────────────────────────────────┐
│ Search Layer (NEW)                                          │
├─────────────────────────────────────────────────────────────┤
│  Full-text Index (SQLite FTS5 or external)                 │
│  Query API (HTTP endpoint)                                 │
│  Ranking/Relevance Scoring                                 │
│  Attribute-based Filtering                                 │
│  Fuzzy Title Matching                                      │
└─────────────────────────────────────────────────────────────┘
```

### Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Search API (REST)                                           │
├─────────────────────────────────────────────────────────────┤
│ Ranking Layer (relevance, quality, recency)                │
├─────────────────────────────────────────────────────────────┤
│ Query Planner (parse filters, optimize)                    │
├─────────────────────────────────────────────────────────────┤
│ Full-text Index (FTS5) ───── Candidate Cache (SQLite)      │
├─────────────────────────────────────────────────────────────┤
│ Release Attributes (SQLite) ── Media Associations          │
└─────────────────────────────────────────────────────────────┘
```

---

## Minimum Viable Search Layer

### Phase 1: SQLite FTS5

```sql
-- Virtual table for full-text search
CREATE VIRTUAL TABLE release_search USING fts5(
  info_hash,
  title,
  year,
  season,
  episode,
  resolution,
  source,
  codec,
  release_group,
  content=release_attributes,
  content_rowid=rowid
);

-- Query example
SELECT * FROM release_search
WHERE title MATCH 'black mirror'
  AND year = 2024
  AND season = 7
  AND episode = 3;
```

### Phase 2: Query API

```
GET /api/search?q=black+mirror&year=2024&season=7&episode=3
```

Returns candidates with:
- infoHash
- title (parsed)
- attributes
- media associations (if any)
- provider cache status (if requested)

### Phase 3: Ranking

Score = (
  title_relevance * 0.4 +
  attribute_match * 0.3 +
  quality_bonus * 0.2 +
  recency * 0.1
)

### Phase 4: Fuzzy Matching

- Levenshtein distance on normalized titles
- ~85% similarity threshold
- Fallback to substring match

---

## Recommendations

### Immediate

1. **Add FTS5 index** on `release_attributes` table
2. **Create query API** in existing server
3. **Implement basic ranking** (attribute match + recency)
4. **Add filter parameters** to search endpoint

### Short-term

1. **Fuzzy title matching** (Levenshtein or trigram)
2. **Quality scoring** (resolution, source tier)
3. **Search result caching** (avoid repeated queries)
4. **Pagination** (cursor-based for large result sets)

### Long-term

1. **External search index** if FTS5 insufficient
2. **User preference learning** (ranking personalization)
3. **Search analytics** (query patterns, no-results)
4. **Advanced filters** (exclude groups, size ranges)

---

## Summary

| Aspect | Zilean | HashSucker |
|--------|--------|------------|
| Data source | DMM only | Multi-source |
| Search engine | SQLite → FTS5 (recommended) | SQLite FTS5 |
| Index strategy | Append-only | Upsert + evidence |
| Ranking | TF-IDF + recency | To be designed |
| Fuzzy matching | Levenshtein | Planned |
| Media identity | Implicit (at index time) | Explicit (separate layer) |
| API | REST | REST (planned) |
| Scalability | Single-node | Single-node (SQLite) |

**Bottom line:** HashSucker has a stronger foundation than Zilean had. The candidate identity model is cleaner, the release attributes are evidence-based, and the ingestion is source-agnostic. Adding a search layer on top of existing SQLite data is the missing piece.

---

*Research based on: Zilean README (via Riven/FakeZurg), DMM hashlist format, HashSucker codebase analysis*
