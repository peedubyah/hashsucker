# Frontend API Contract

> **ARCHIVED CONFLICTED SNAPSHOT:** Non-authoritative. It intentionally retains unresolved merge markers and stale routes. Use [`../../media-search/src/api/API_CONTRACT.md`](../../media-search/src/api/API_CONTRACT.md).

This document described competing backend API contracts for the frontend application.
All endpoints were claimed to be served from the media-search application.

## Base URL

Relative to the same origin (e.g., `/api/...`).

---

## Endpoints

### GET /api/search?q=QUERY

<<<<<<< HEAD
Search for titles by query string (Cinemeta catalog).
=======
Search for titles by query string. Provider-agnostic: the backend owns
which metadata providers are queried (Cinemeta today, TMDB in future).
Results are cached in-memory for fast typeahead responses.
>>>>>>> github/frontend/vite

**Request:**
```
GET /api/search?q=Black+Mirror
```

**Response (200):**
```json
{
  "results": [
    {
      "id": "tt2085059",
      "type": "series",
<<<<<<< HEAD
      "name": "Black Mirror",
      "poster": "https://m.media-amazon.com/images/...",
      "year": "2011-",
      "description": null
    }
  ],
=======
      "title": "Black Mirror",
      "year": 2011,
      "posterUrl": "https://m.media-amazon.com/images/...",
      "backdropUrl": null,
      "overview": "A dark anthology series exploring technology"
    }
  ],
  "requestId": "req-1",
  "fromCache": false,
>>>>>>> github/frontend/vite
  "timings": {
    "totalMs": 106
  }
}
```

**Fields:**
<<<<<<< HEAD
- `results[]` — Array of title results
  - `id` — Media identifier (e.g., "tt2085059")
  - `type` — "movie" or "series"
  - `name` — Title name
  - `poster` — Poster URL (nullable)
  - `year` — Year or year range (nullable)
  - `description` — Brief description (nullable)
=======
- `results[]` — Array of normalized media results (provider-agnostic)
  - `id` — Media identifier (e.g., "tt2085059")
  - `type` — "movie" or "series"
  - `title` — Canonical title
  - `year` — Release year (nullable)
  - `posterUrl` — Poster image URL (nullable)
  - `backdropUrl` — Backdrop/fanart URL (nullable)
  - `overview` — Brief description (nullable)
- `requestId` — Unique request ID for stale response detection
- `fromCache` — Whether results came from the in-memory cache
- `errors[]` — Provider errors (omitted if all providers succeeded)
  - `provider` — Provider name
  - `error` — Error message
>>>>>>> github/frontend/vite
- `timings.totalMs` — Response time in milliseconds

**Errors:**
- 400 — Invalid query (too short/long)

<<<<<<< HEAD
=======
**Notes:**
- Query must be 2-120 characters
- Frontend should debounce input; backend deduplicates concurrent identical requests
- Slow upstream requests cannot overwrite newer results (requestId tracking)

>>>>>>> github/frontend/vite
---

### GET /api/search?type=TYPE&mediaId=ID

Search for releases by media identity. This is the primary endpoint for
finding downloadable releases. Results are ranked by composite score.

Merges DMM corpus results with live discovery (Torrentio/Torznab),
deduplicates by infoHash (corpus takes precedence), and returns
a single ranked result set.

**Request:**
```
GET /api/search?type=series&mediaId=tt0944947:7:3
```

**Response (200):**
```json
{
  "intent": {
    "streamType": "series",
    "mediaType": "tv",
    "scope": "episode",
    "mediaId": "tt0944947:7:3",
    "baseMediaId": "tt0944947",
    "season": 7,
    "episodes": [3]
  },
  "results": [
    {
      "infoHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "fileIndex": null,
      "title": "Black Mirror",
      "filename": "Black.Mirror.S07E03.2160p.WEB-DL.DV.HDR10.mkv",
      "size": null,
      "resolution": "2160p",
      "quality": "WEB-DL",
      "codec": null,
      "hdr": "true",
      "audio": null,
      "releaseGroup": null,
      "year": null,
      "season": 7,
      "episode": 3,
      "confidence": 0.5,
      "score": 0.82,
      "components": {
        "relevance": 1,
        "quality": 0.805,
        "releaseConfidence": 0.92,
        "identityConfidence": 0.5,
        "providerAvailability": 0.5,
        "episodeMatch": 1
      },
      "providers": {
        "torbox": { "cached": true, "evidence": ["usenet"] }
      },
      "media": [],
      "_source": "corpus"
    }
  ],
  "total": 638,
  "timings": { "totalMs": 45 },
  "stats": { "indexed": 3, "total": 3 }
}
```

**Fields:**
- `intent` — Parsed media intent from the request
  - `streamType` — "movie" or "series"
  - `mediaType` — "movie" or "tv"
  - `scope` — "movie", "series", or "episode"
  - `mediaId` — Full media identifier
  - `baseMediaId` — Base media ID (without season:episode)
  - `season` — Season number (nullable)
  - `episodes` — Episode numbers array
- `results[]` — Ranked release candidates
  - `infoHash` — 40-char hex infoHash
  - `fileIndex` — File index (null for single-file torrents)
  - `title` — Parsed title
  - `filename` — Original release filename
  - `size` — File size in bytes (nullable)
  - `resolution` — "1080p", "2160p", "720p", etc. (nullable)
  - `quality` — "WEB-DL", "BluRay", "HDTV", etc. (nullable)
  - `codec` — "x264", "x265", etc. (nullable)
  - `hdr` — "true" if HDR (nullable)
  - `audio` — Audio format (nullable)
  - `releaseGroup` — Release group name (nullable)
  - `year` — Release year (nullable)
  - `season` — Season number (nullable)
  - `episode` — Episode number (nullable)
  - `confidence` — Parse confidence (0.0-1.0)
  - `score` — Composite ranking score (0.0-1.0)
  - `components` — Score breakdown:
    - `relevance` — Title relevance
    - `quality` — Quality score
    - `releaseConfidence` — Release parse confidence
    - `identityConfidence` — Media identity confidence
    - `providerAvailability` — Provider availability
    - `episodeMatch` — Episode match score
  - `providers` — Provider observations keyed by provider name
    - `[provider].cached` — Boolean (null=unknown, true=cached, false=not cached)
    - `[provider].evidence` — Array of evidence tags (nullable)
  - `media` — Media associations array
  - `_source` — "corpus" (DMM) or "live" (Torrentio/Torznab)
- `total` — Total number of results
- `timings.totalMs` — Response time
- `stats.indexed` — Number of candidates in FTS5 index
- `stats.total` — Total candidates in database

**Errors:**
- 400 — Invalid type or mediaId

---

### GET /api/search/internal?q=QUERY

Search the DMM corpus directly via FTS5 (no live discovery).

**Request:**
```
GET /api/search/internal?q=Black+Mirror
```

**Response (200):**
```json
{
  "results": [
    {
      "hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "fileIndex": null,
      "filename": "Black.Mirror.S07E03.2160p.WEB-DL.mkv",
      "parsed": {
        "title": "Black Mirror",
        "year": null,
        "season": 7,
        "episode": 3,
        "resolution": "2160p",
        "source": "WEB-DL",
        "codec": null,
        "hdr": false,
        "audio": null,
        "releaseGroup": null
      },
      "confidence": 0.92,
      "score": 0.82,
      "relevance": 1,
      "quality": 0.805,
      "releaseConfidence": 0.92,
      "identityConfidence": 0.5,
      "provider": 0.5,
      "episodeMatch": 1,
      "components": {
        "relevance": 1,
        "quality": 0.805,
        "releaseConfidence": 0.92,
        "identityConfidence": 0.5,
        "providerAvailability": 0.5,
        "episodeMatch": 1
      },
      "providers": [
        {
          "provider": "torbox",
          "cached": true,
          "evidence": ["usenet"],
          "checkedAt": 1724123456789
        }
      ],
      "media": [
        {
          "mediaId": "tt0944947",
          "source": "manual",
          "confidence": 0.9,
          "evidence": ["imdb-match"],
          "associatedAt": 1724123456789
        }
      ]
    }
  ],
  "total": 638,
  "query": {
    "match": "\"black\"* AND \"mirror\"*",
    "filters": {},
    "titleQuery": "Black Mirror"
  },
  "timings": { "totalMs": 45 },
  "stats": { "indexed": 3, "total": 3 }
}
```

**Differences from `/api/search?mediaId=...`:**
- Result objects use `hash` (not `infoHash`)
- Result objects use `parsed` nested object (not top-level fields)
- Result objects include `relevance`, `quality`, etc. as top-level fields
- Result objects use `provider` (not `providerAvailability`) for the component
- `providers` is an array of observation objects (not a keyed object)
- Includes `query` object with FTS5 match expression and parsed filters
- Only DMM corpus results (no live discovery)

**Errors:**
- 400 — Invalid query

---

### GET /api/search/stats

Get search index statistics.

**Request:**
```
GET /api/search/stats
```

**Response (200):**
```json
{
  "indexed": 10181,
  "total": 10181
}
```

---

### GET /api/media?type=TYPE&id=ID

<<<<<<< HEAD
Get media details by type and ID.
=======
Get media details by type and ID. Provider-agnostic.
>>>>>>> github/frontend/vite

**Request:**
```
GET /api/media?type=series&id=tt2085059
```

**Response (200):**
```json
{
  "media": {
    "id": "tt2085059",
    "type": "series",
<<<<<<< HEAD
    "name": "Black Mirror",
    "poster": "https://images.metahub.space/poster/small/tt2085059/img",
    "year": "2011–",
    "description": "Featuring stand-alone dramas...",
=======
    "title": "Black Mirror",
    "year": 2011,
    "posterUrl": "https://images.metahub.space/poster/small/tt2085059/img",
    "backdropUrl": null,
    "overview": "A dark anthology series...",
>>>>>>> github/frontend/vite
    "videos": [
      {
        "id": "tt2085059:0:1",
        "season": 0,
        "episode": 1,
        "title": "Episode 1",
        "released": "2014-12-16T03:00:00.000Z",
        "thumbnail": "https://episodes.metahub.space/tt2085059/0/1/w780.jpg"
      }
    ]
  },
  "timings": { "totalMs": 45 }
}
```

**Fields:**
- `media.id` — Media identifier
- `media.type` — "movie" or "series"
<<<<<<< HEAD
- `media.name` — Title name
- `media.poster` — Poster URL (nullable)
- `media.year` — Year or year range (nullable)
- `media.description` — Brief description (nullable)
=======
- `media.title` — Canonical title
- `media.year` — Release year (nullable)
- `media.posterUrl` — Poster URL (nullable)
- `media.backdropUrl` — Backdrop URL (nullable)
- `media.overview` — Brief description (nullable)
>>>>>>> github/frontend/vite
- `media.videos[]` — Episode list (series only)
  - `id` — Video identifier (e.g., "tt2085059:7:3")
  - `season` — Season number
  - `episode` — Episode number
  - `title` — Episode title
  - `released` — Release date ISO string (nullable)
  - `thumbnail` — Thumbnail URL (nullable)

**Errors:**
- 404 — Media not found

---

<<<<<<< HEAD
=======
### GET /api/search/cache/metrics

Get metadata cache performance metrics.

**Request:**
```
GET /api/search/cache/metrics
```

**Response (200):**
```json
{
  "hits": 150,
  "misses": 50,
  "evictions": 10,
  "size": 45,
  "maxEntries": 500,
  "hitRatio": 0.75
}
```

**Fields:**
- `hits` — Total cache hits
- `misses` — Total cache misses
- `evictions` — Total entries evicted (TTL expiry or LRU)
- `size` — Current number of cached entries
- `maxEntries` — Maximum cache capacity
- `hitRatio` — Hit ratio (0.0-1.0), null if no requests yet

---

>>>>>>> github/frontend/vite
### POST /api/requests

Submit a media request for import.

**Request:**
```json
{
  "type": "series",
  "mediaId": "tt0944947:7:3",
  "release": {
    "infoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "title": "Test",
    "filename": "Test.mkv",
    "size": 1000,
    "resolution": "1080p",
    "quality": "WEB-DL",
    "codec": "x264",
    "hdr": "true"
  }
}
```

**Required fields:**
- `type` — "movie" or "series"
- `mediaId` — Media identifier (e.g., "tt0944947:7:3")
- `release.infoHash` — 40-char hex infoHash

**Optional fields:**
- `release.title`, `release.filename`, `release.size`
- `release.resolution`, `release.quality`, `release.codec`, `release.hdr`

**Response (202):**
```json
{
  "requestId": "12345678-1234-1234-1234-123456789abc",
  "status": "queued"
}
```

**Errors:**
- 400 — Invalid request (missing infoHash, invalid scope, etc.)

---

### GET /api/requests/REQUEST_ID

Get request status.

**Request:**
```
GET /api/requests/12345678-1234-1234-1234-123456789abc
```

**Response (200):**
```json
{
  "requestId": "12345678-1234-1234-1234-123456789abc",
  "status": "processing"
}
```

**Status values:** "queued", "processing", "done", "failed"

**Errors:**
- 404 — Request not found

---

### POST /api/ingest/dmm

Trigger DMM hashlist ingestion (admin/background operation).

**Request:**
```json
{
  "maxFragments": 1,
  "batchSize": 1000
}
```

**Response (200):**
```json
{
  "imported": 10181,
  "inserted": 9531,
  "updated": 650,
  "failed": 0,
  "attributesParsed": 10181,
  "durationMs": 667
}
```

---

### POST /api/attributes/run

Trigger release attribute parsing for unparsed candidates.

**Request:**
```json
{
  "limit": 100
}
```

**Response (200):**
```json
{
  "parsed": 100,
  "failed": 0
}
```

---

### GET /health

Health check endpoint.

**Response (200):**
```json
{
  "ok": true
}
```

---

## Usage Notes

### Natural Language / Title Query Flow

1. User enters query → `GET /api/search?q=QUERY`
2. Display title results (`id`, `name`, `type`, `poster`, `year`)
3. User selects a title → Store `mediaId` (e.g., "tt0944947")
4. For series, user selects season/episode → Construct full `mediaId` (e.g., "tt0944947:7:3")
5. `GET /api/search?type=series&mediaId=tt0944947:7:3` → Ranked release candidates
6. Display results with quality badges, resolution, size, score
7. User selects release → `POST /api/requests` with infoHash

### Media Identity as Aid

- Use `GET /api/media?type=series&id=tt2085059` to fetch:
  - Season/episode list for series
  - Poster and description for display
  - Episode titles for better UX

### Provider Observations

The `providers` field on release results contains provider-specific state.

**For `/api/search?mediaId=...` (ReleaseResult):**
```json
{
  "providers": {
    "torbox": { "cached": true, "evidence": ["usenet"] }
  }
}
```
- `providers[provider].cached` — Boolean (null=unknown, true=cached, false=not cached)
- `providers[provider].evidence` — Array of evidence tags

**For `/api/search/internal` (InternalReleaseResult):**
```json
{
  "providers": [
    {
      "provider": "torbox",
      "cached": true,
      "evidence": ["usenet"],
      "checkedAt": 1724123456789
    }
  ]
}
```
- `providers` is an array of observation objects
- Each includes `provider`, `cached`, `evidence`, and `checkedAt`

### Ranking

Results are pre-ranked by the backend. The `score` field (0.0-1.0) is a
composite of relevance, quality, release confidence, identity confidence,
provider availability, and episode match.

**Formula:**
```
score = relevance × 0.25
      + quality × 0.20
      + releaseConfidence × 0.20
      + identityConfidence × 0.15
      + providerAvailability × 0.10
      + episodeMatch × 0.10
```

Display results in score order (highest first).

### Error Handling

All endpoints return JSON with an `error` field on failure:
```json
{
  "error": "Description of what went wrong"
}
```

Common error patterns:
- 400 — Client input validation (missing fields, invalid format)
- 404 — Resource not found (media, request)
- 502 — Backend processing error

### Endpoint Selection Guide

| Use Case | Endpoint |
|----------|----------|
| Search titles by name | `GET /api/search?q=QUERY` |
| Find releases for a specific episode/movie (with live discovery) | `GET /api/search?type=TYPE&mediaId=ID` |
| Search DMM corpus only (no live discovery) | `GET /api/search/internal?q=QUERY` |
| Get media details (poster, episodes) | `GET /api/media?type=TYPE&id=ID` |
| Submit import request | `POST /api/requests` |
| Check request status | `GET /api/requests/REQUEST_ID` |
| Get index statistics | `GET /api/search/stats` |
| Trigger DMM ingestion | `POST /api/ingest/dmm` |
| Trigger attribute parsing | `POST /api/attributes/run` |
| Health check | `GET /health` |
