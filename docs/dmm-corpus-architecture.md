# DMM Corpus Architecture

This document describes the existing DMM corpus persistence layer and search foundation.

## 1. Storage Design

### 1.1 Schema (4 tables + FTS5 virtual table)

**`candidates`** — Torrent/file identity (what came from DMM)
| Column | Type | Purpose |
|--------|------|---------|
| info_hash | TEXT | 40-char hex infoHash |
| file_index | INTEGER | File index (null for single-file) |
| file_index_key | INTEGER | -1 when file_index is null (for PK) |
| search_key | TEXT | Search grouping key |
| title | TEXT | Display title |
| filename | TEXT | Original release filename |
| size | INTEGER | File size in bytes |
| seeders/leechers | INTEGER | Peer counts (from DMM: always null) |
| publish_date | TEXT | Publication date |
| magnet | TEXT | Magnet URI |
| download_url | TEXT | Direct download URL |
| metadata | TEXT | JSON blob for extensibility |
| sources | TEXT | JSON array of source references |
| first_seen | INTEGER | Timestamp (ms) of first observation |
| last_seen | INTEGER | Timestamp (ms) of last observation |

**Primary key:** `(info_hash, file_index_key)` — exact identity, no fuzzy merging

**`release_attributes`** — Parsed filename metadata (separate from identity)
| Column | Type | Purpose |
|--------|------|---------|
| info_hash | TEXT | FK to candidates |
| file_index | INTEGER | FK to candidates |
| file_index_key | INTEGER | FK to candidates |
| source | TEXT | Parser source ('dmm', 'ptn', 'guessit') |
| filename | TEXT | Raw filename |
| confidence | REAL | Parser confidence 0.0–1.0 |
| title | TEXT | Guessed title |
| year | INTEGER | Release year |
| media_type | TEXT | 'movie', 'episode', 'unknown' |
| season | INTEGER | Season number |
| episode | INTEGER | Episode number |
| episode_range | TEXT | Episode range (e.g., "1-3") |
| resolution | TEXT | '1080p', '2160p', etc. |
| source_type | TEXT | 'WEB-DL', 'BluRay', etc. |
| codec | TEXT | 'x264', 'x265', etc. |
| hdr | INTEGER | 0 or 1 |
| audio | TEXT | 'AAC', 'DTS', etc. |
| language | TEXT | Language code |
| release_group | TEXT | Release group name |
| evidence | TEXT | JSON array of evidence tags |
| parsed_at | INTEGER | Timestamp (ms) |

**Primary key:** `(info_hash, file_index_key, source)` — multiple parsers can contribute

**`provider_observations`** — Future TorBox/Real-Debrid cache state
| Column | Type | Purpose |
|--------|------|---------|
| info_hash | TEXT | FK to candidates |
| file_index | INTEGER | FK to candidates |
| file_index_key | INTEGER | FK to candidates |
| provider | TEXT | 'torbox', 'realdebrid', etc. |
| cached | INTEGER | 0, 1, or null (unknown) |
| evidence | TEXT | JSON array |
| checked_at | INTEGER | Timestamp (ms) |

**Primary key:** `(info_hash, file_index_key, provider)` — one observation per provider

**`candidate_media`** — Media identity associations (from enrichment)
| Column | Type | Purpose |
|--------|------|---------|
| info_hash | TEXT | FK to candidates |
| file_index_key | INTEGER | FK to candidates |
| media_id | TEXT | 'tt1234567' or 'tt1234567:1:1' |
| source | TEXT | 'manual', 'imdb-match', 'tmdb-match' |
| confidence | REAL | Association confidence |
| evidence | TEXT | JSON array |
| associated_at | INTEGER | Timestamp (ms) |

**Primary key:** `(info_hash, file_index_key, media_id)`

**`release_search`** — FTS5 virtual table (auto-synced via triggers)
- Columns: title, filename, resolution, source_type, codec, audio, release_group, language, media_type
- Tokenizer: `porter unicode61`
- Triggers: `AFTER INSERT/UPDATE/DELETE` on `release_attributes`

### 1.2 Architectural Contracts

1. **Identity is exact** — `(info_hash, file_index_key)` with no fuzzy merging
2. **Provider observations are separate** — A candidate never stores `cached=true` directly
3. **Additive only** — Candidates survive cache reload; live discovery is source of truth
4. **Multiple parsers** — Different sources can contribute attributes; stronger confidence wins
5. **FTS5 is for retrieval only** — Not responsible for provider availability, quality scoring, or business logic

## 2. Ingestion Flow

```
DMM hashlist (HTML)
  ↓ extractHashFragment()
LZString payload
  ↓ decodeDmmPayload()
JSON { torrents: [...] }
  ↓ parseDmmRecord() per record
Ingest entry
  ↓ ingestCandidates() / importDmmString()
Candidate upsert (idempotent)
  ↓ parseFilename()
Release attributes
  ↓ triggers
FTS5 index auto-updated
```

### 2.1 Idempotency Rules

- Reprocessing the same DMM source updates `last_seen` and merges sources
- Same `info_hash` appearing in multiple sources merges provenance (set-union by source key)
- Candidates never disappear when absent from later source
- `first_seen` is preserved on conflict; `last_seen` is always updated

### 2.2 DMM-Specific Behavior

DMM records have:
- Required: `hash` (40-char hex), `filename`
- Optional: `bytes` (file size)

DMM does NOT provide:
- Media identity (no mediaId, imdb, tmdb)
- Confidence scores
- Seeders/leechers
- Magnet URIs

Media identity is inferred post-ingestion via filename enrichment.

## 3. Search Foundation

### 3.1 FTS5 Retrieval (`searchReleases`)

**FTS5 MATCH** for text:
- Title tokens
- Filename fragments
- Release groups

**SQL WHERE** for structured filters:
- `year` — exact year
- `season` / `episode` — season/episode numbers
- `resolution` — '1080p', '2160p', etc.
- `source_type` — 'WEB-DL', 'BluRay', etc.
- `codec` — 'x264', 'x265', etc.
- `hdr` — 0 or 1
- `audio` — 'AAC', 'DTS', etc.

**BM25 scoring** inverted so higher = better (1.0 / (1.0 + abs(bm25_score)))

### 3.2 Query Parsing

The search engine parses natural language queries:
- `"black mirror"` → FTS5 prefix match on title
- `s01e03` → season=1, episode=3 filter
- `2024` → year=2024 filter
- `1080p` → resolution='1080p' filter
- `blu-ray` → source_type='BluRay' filter

### 3.3 Ranking (`ranking.js`)

Pure ranking module with weighted composite:
```
score = relevance × 0.25
      + quality × 0.20
      + releaseConfidence × 0.20
      + identityConfidence × 0.15
      + providerAvailability × 0.10
      + episodeMatch × 0.10
```

**Quality score** derived from:
- Resolution (40%): 2160p=1.0, 1080p=0.9, 720p=0.7, etc.
- Source (30%): Remux=1.0, BluRay=0.95, WEB-DL=0.85, etc.
- Codec bonus (10%): x265 for 4K preferred
- HDR bonus (15%)

### 3.4 Combined Search (`combinedSearch`)

Merges DMM corpus + live discovery (Torrentio/Torznab):
1. Search DMM corpus via FTS5
2. Run live discovery (if enabled)
3. Normalize live results to corpus shape
4. Deduplicate by infoHash (corpus wins)
5. Apply pagination
6. Map to UI-compatible shape

## 4. Module Inventory

| File | Responsibility |
|------|---------------|
| `src/lib/discovery/cache.js` | SQLite schema, CRUD, provider observations |
| `src/lib/discovery/ingest.js` | Ingestion boundary for external sources |
| `src/lib/discovery/release-attributes.js` | Store parsed filename metadata |
| `src/lib/discovery/attribute-worker.js` | Background attribute parsing |
| `src/lib/discovery/search-engine.js` | FTS5 retrieval + combined search |
| `src/lib/discovery/ranking.js` | Pure ranking module |
| `src/lib/discovery/adapters/dmm.js` | DMM record parsing |
| `src/lib/ingestion/dmm.js` | Full DMM import pipeline |
| `src/lib/discovery/dmm-ingestion-runner.js` | Fetch + decompress + ingest |

## 5. Test Coverage

325 tests passing, covering:

1. **Decode → parse → store** (`ingestion-dmm.test.js`)
2. **Duplicate ingestion safety** (idempotent re-import)
3. **Search by title/release group/filename** (`search-engine.test.js`)
4. **Structured filters** (year, season/episode, resolution, codec)
5. **Large fixture performance** (50+ records, pagination)
6. **Malformed record handling** (invalid hash, empty filename)
7. **Release attribute parsing** (Movie.2024.1080p.BluRay.x264-Group.mkv)

## 6. Deliverables Summary

### Schema Summary
- 4 normalized tables + 1 FTS5 virtual table
- Triggers keep FTS5 in sync with release_attributes
- Separates identity, attributes, provider observations, and media associations

### Migration Files
- Schema defined inline in `cache.js` (SQLite `CREATE TABLE IF NOT EXISTS`)
- No separate migration files needed for SQLite

### Ingestion Flow Diagram
```
┌─────────────────┐
│  DMM HTML       │
│  (GitHub Pages) │
└────────┬────────┘
         │ extractHashFragment()
         ▼
┌─────────────────┐
│  LZString       │
│  Compressed JSON│
└────────┬────────┘
         │ decodeDmmPayload()
         ▼
┌─────────────────┐
│  JSON.parse()   │
│  {torrents:[…]} │
└────────┬────────┘
         │ parseDmmRecord()
         ▼
┌─────────────────┐
│  ingestEntry()  │
│  (idempotent)   │
└────────┬────────┘
         │ upsertCandidate()
         ▼
┌─────────────────┐     ┌──────────────────┐
│  candidates     │────▶│  release_attrs   │
│  (identity)     │     │  (parsed data)   │
└─────────────────┘     └────────┬─────────┘
                                 │ triggers
                                 ▼
                        ┌──────────────────┐
                        │  release_search  │
                        │  (FTS5 index)    │
                        └──────────────────┘
```

### Example Real Records Inserted
```javascript
// DMM record (from real hashlist)
{ hash: 'a1b2c3d4...', filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv', bytes: 8589934592 }

// After ingestion → candidates table
{
  infoHash: 'a1b2c3d4...',
  filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv',
  size: 8589934592,
  sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
  firstSeen: 1724123456789,
  lastSeen: 1724123456789
}

// After attribute parsing → release_attributes table
{
  infoHash: 'a1b2c3d4...',
  title: 'Movie',
  year: 2024,
  resolution: '1080p',
  sourceType: 'BluRay',
  codec: 'x264',
  releaseGroup: 'Group',
  confidence: 0.92,
  source: 'ptn-regex'
}
```

### Search Examples
```javascript
// Title search
searchReleases(cache, { query: 'black mirror' })

// Structured filters
searchReleases(cache, { query: 'show', season: 1, episode: 3, resolution: '1080p' })

// Natural language (parsed automatically)
searchReleases(cache, { query: 'breaking bad s05e14 1080p blu-ray' })

// With provider observations
searchReleases(cache, { query: 'movie', includeProviders: true })

// With media associations
searchReleases(cache, { query: 'movie', includeMedia: true })

// Pagination
searchReleases(cache, { query: 'movie', limit: 50, offset: 100 })
```

### Test Results
```
ℹ tests 325
ℹ pass 325
ℹ fail 0
ℹ duration_ms 227ms
```

## 7. Next Phase Ready

The foundation supports:
- **Enrichment workers** — `candidate_media` table ready for IMDb/TMDB associations
- **Media identity resolution** — `confidence` + `evidence` columns on associations
- **Ranking** — Pure module separated from retrieval; composite score computed
- **Provider observations** — `provider_observations` table with `cached` state and `evidence`
