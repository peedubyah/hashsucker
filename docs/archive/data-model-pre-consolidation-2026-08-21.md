# Data Model

> **ARCHIVED PRE-CONSOLIDATION MODEL:** Non-authoritative. Use [`../data-model.md`](../data-model.md); this snapshot contains unenforced merge, confidence, freshness, and identity claims.

Persistent storage uses SQLite (Node.js built-in `node:sqlite`) in WAL mode.

**Database path:** Configurable via `DISCOVERY_DB` env var or `dbPath` to `createDiscoveryCache()`. Defaults to in-memory.

---

## 1. candidates

**Purpose:** Normalized torrent/file identity — what came from discovery sources.

| Column | Type | Notes |
|--------|------|-------|
| `info_hash` | TEXT NOT NULL | 40-char hex infoHash |
| `file_index` | INTEGER | Raw file index (null for single-file) |
| `file_index_key` | INTEGER NOT NULL DEFAULT -1 | -1 when file_index is null (for PK) |
| `search_key` | TEXT | Search grouping key |
| `title` | TEXT | Display title |
| `filename` | TEXT | Original release filename |
| `size` | INTEGER | File size in bytes |
| `seeders` | INTEGER | Peer count (null from DMM) |
| `leechers` | INTEGER | Peer count (null from DMM) |
| `publish_date` | TEXT | Publication date |
| `magnet` | TEXT | Magnet URI |
| `download_url` | TEXT | Direct download URL |
| `metadata` | TEXT NOT NULL DEFAULT '{}' | JSON blob for extensibility |
| `sources` | TEXT NOT NULL DEFAULT '[]' | JSON array of source references |
| `first_seen` | INTEGER NOT NULL | Timestamp (ms) of first observation |
| `last_seen` | INTEGER NOT NULL | Timestamp (ms) of last observation |

**Primary key:** `(info_hash, file_index_key)` — exact identity, no fuzzy merging.

**Allowed writers:**
- `upsertCandidate()` — called by `ingestCandidates()` and `ingestEntry()`
- Direct cache API (rare)

**Invariants:**
- Identity is physical `(infoHash, fileIndex)`, not media identity
- `first_seen` preserved on update, `last_seen` always updated
- Scalar fields: incoming non-null values fill existing nulls (don't overwrite)
- `sources`: set-union by source key
- `metadata`: shallow merge

**Indexes:**
- `idx_candidates_last_seen` — for age-based queries
- `idx_candidates_search_key` — for search grouping

---

## 2. release_attributes

**Purpose:** Parsed filename metadata — evidence about what the release contains.

| Column | Type | Notes |
|--------|------|-------|
| `info_hash` | TEXT NOT NULL | FK to candidates |
| `file_index` | INTEGER | FK to candidates |
| `file_index_key` | INTEGER NOT NULL DEFAULT -1 | FK to candidates |
| `source` | TEXT NOT NULL | Parser source ('ptn-regex', etc.) |
| `filename` | TEXT NOT NULL | Raw filename preserved |
| `confidence` | REAL NOT NULL DEFAULT 0.5 | Parser confidence 0.0–1.0 |
| `title` | TEXT | Guessed title |
| `year` | INTEGER | Release year |
| `media_type` | TEXT | 'movie', 'episode', 'unknown' |
| `season` | INTEGER | Season number |
| `episode` | INTEGER | Episode number |
| `episode_range` | TEXT | Episode range (e.g., "1-3") |
| `resolution` | TEXT | '1080p', '2160p', etc. |
| `source_type` | TEXT | 'WEB-DL', 'BluRay', etc. |
| `codec` | TEXT | 'x264', 'x265', etc. |
| `hdr` | INTEGER | 0 or 1 |
| `audio` | TEXT | 'AAC', 'DTS', etc. |
| `language` | TEXT | Language code |
| `release_group` | TEXT | Release group name |
| `evidence` | TEXT | JSON array of evidence tags |
| `parsed_at` | INTEGER NOT NULL | Timestamp (ms) |

**Primary key:** `(info_hash, file_index_key, source)` — one row per candidate per parser source.

**Allowed writers:**
- `storeReleaseAttributes()` — called by attribute worker
- `storeReleaseAttributesBatch()` — batch store

**Invariants:**
- Evidence only — NOT media identity
- Higher confidence wins on conflict (same source overwrite)
- Equal confidence → latest wins (update allowed)
- Lower confidence is skipped
- Raw filename ALWAYS retained
- Multiple parsers can contribute (different sources)

**Indexes:**
- `idx_release_attributes_source`
- `idx_release_attributes_parsed_at`

---

## 3. candidate_media

**Purpose:** Media identity associations — links candidates to known media IDs.

| Column | Type | Notes |
|--------|------|-------|
| `info_hash` | TEXT NOT NULL | FK to candidates |
| `file_index_key` | INTEGER NOT NULL DEFAULT -1 | FK to candidates |
| `media_id` | TEXT NOT NULL | 'tt1234567' or 'tt1234567:1:1' |
| `source` | TEXT NOT NULL DEFAULT 'search' | Source of association ('cinemeta', etc.) |
| `confidence` | REAL NOT NULL DEFAULT 1.0 | Association confidence 0.0–1.0 |
| `evidence` | TEXT | JSON array of evidence tags |
| `associated_at` | INTEGER NOT NULL | Timestamp (ms) |

**Primary key:** `(info_hash, file_index_key, media_id)` — one association per media ID per candidate.

**Allowed writers:**
- `associateMedia()` — direct API
- `upsertMediaAssociation()` — merge on conflict
- `enrichCandidate()` — via enrichment worker

**Invariants:**
- Additive only — never removes existing associations
- Higher confidence wins on conflict (equal → latest wins)
- Lower confidence is skipped
- Source attribution preserved
- Evidence tags mandatory
- For series with season/episode: `media_id` format is `${id}:${season}:${episode}`

**Indexes:**
- `idx_candidate_media_media_id` — for reverse lookup

---

## 4. provider_observations

**Purpose:** Provider-specific cache state — separate from candidate identity.

| Column | Type | Notes |
|--------|------|-------|
| `info_hash` | TEXT NOT NULL | FK to candidates |
| `file_index` | INTEGER | FK to candidates |
| `file_index_key` | INTEGER NOT NULL DEFAULT -1 | FK to candidates |
| `provider` | TEXT NOT NULL | 'torbox', 'realdebrid', etc. |
| `cached` | INTEGER | 0, 1, or null (unknown) |
| `evidence` | TEXT | JSON array |
| `checked_at` | INTEGER NOT NULL | Timestamp (ms) |

**Primary key:** `(info_hash, file_index_key, provider)` — one observation per provider.

**Allowed writers:**
- `recordProviderObservation()` — only write path
- Ingestion (if providerObservations supplied)

**Invariants:**
- Provider state NEVER stored in candidates
- Independent refresh per provider
- Observations expire independently via `checked_at`

**Indexes:**
- `idx_observations_checked_at` — for TTL queries

---

## 5. release_search

**Purpose:** FTS5 full-text search index over release_attributes.

| Column | Type | Notes |
|--------|------|-------|
| `title` | — | Parsed release title |
| `filename` | — | Raw filename |
| `resolution` | — | 1080p, 720p, etc. |
| `source_type` | — | BluRay, WEB-DL, etc. |
| `codec` | — | x264, x265 |
| `audio` | — | AAC, DTS, etc. |
| `release_group` | — | Release group name |
| `language` | — | Language code |
| `media_type` | — | movie, episode, unknown |

**Tokenizer:** `porter unicode61`

**Sync:** Auto-maintained via triggers on `release_attributes`:
- `release_attributes_ai` — AFTER INSERT
- `release_attributes_ad` — AFTER DELETE
- `release_attributes_au` — AFTER UPDATE

**Allowed writers:** None directly — triggers maintain automatically.

**Invidences:**
- FTS5 is for retrieval only — not responsible for provider availability or quality
- Stores its own copy of searchable fields (external content would be more complex)

---

## Relationships

```
candidates (1) ──────────────── (0..*) release_attributes
  │                                    │
  │                                    └──→ release_search (FTS5, auto-sync)
  │
  ├────────────────────────────────── (0..*) candidate_media
  │
  └────────────────────────────────── (0..*) provider_observations
```

- One candidate has zero or many release_attributes (different parser sources)
- One candidate has zero or many candidate_media (different media associations)
- One candidate has zero or many provider_observations (one per provider)
- release_search is a denormalized index, not a separate entity

---

## Key Design Decisions

1. **Exact identity:** `(info_hash, file_index_key)` with no fuzzy merging
2. **Separate tables:** Provider state and media identity are not part of candidate
3. **Evidence vs identity:** Release attributes are evidence, not media identity
4. **Additive enrichment:** Media associations only add, never remove
5. **Multiple parsers:** Different parser sources can contribute to same candidate
6. **FTS5 auto-sync:** Triggers maintain the search index automatically
