# media-search HTTP API contract

**Code-verified:** 2026-08-22

**Runtime authority:** `src/server/app.js`

This is the only detailed HTTP contract. Public release identity is enforced by the executable contract in `release-contract.js`; contract tests, frontend types/build checks, and importer protocol tests guard this documented behavior.

## General behavior

- Default base URL: `http://localhost:3000`.
- All responses are JSON with `cache-control: no-store`.
- Most thrown input failures use `{ "error": "message" }` with status `400`; missing resources use `404`, and processing/upstream failures generally use `502`.
- Exceptions: invalid title-query length currently returns `200` with an empty result envelope and omits the validation message. Request bodies are capped at 64KB; malformed JSON and oversized bodies return `400`.
- There is no application authentication or authorization. Ingestion, mutation, and request routes must remain behind a trusted boundary.
- In production, the server serves the built React UI from `STATIC_ROOT` on the same origin; local API-only execution may leave that setting unset.

## Metadata shape

Active normalized media fields:

```json
{
  "id": "tt2085059",
  "type": "series",
  "title": "Black Mirror",
  "year": 2011,
  "posterUrl": "https://example/poster.jpg",
  "backdropUrl": null,
  "overview": "Description"
}
```

For series detail, `videos` may be attached:

```json
{
  "id": "tt2085059:7:3",
  "season": 7,
  "episode": 3,
  "title": "Episode title",
  "released": "2026-01-01T00:00:00.000Z",
  "thumbnail": null
}
```

The UI TypeScript definitions use these active normalized metadata names.

## `GET /health`

Response `200`:

```json
{ "ok": true }
```

## `GET /api/search?q=QUERY`

Title search through the unified metadata layer (Cinemeta currently). Query length is 2–120 characters.

Response `200`:

```json
{
  "results": [
    {
      "id": "tt2085059",
      "type": "series",
      "title": "Black Mirror",
      "year": 2011,
      "posterUrl": "https://example/poster.jpg",
      "backdropUrl": null,
      "overview": "Description"
    }
  ],
  "requestId": "request-sequence-id",
  "fromCache": false,
  "errors": [{ "provider": "provider-name", "error": "message" }],
  "timings": { "totalMs": 12 }
}
```

`errors` is omitted when all providers succeed. `requestId` is for stale-response handling; `fromCache` describes the in-memory metadata cache.

## `GET /api/media?type=TYPE&id=ID`

- `type`: `movie` or `series`.
- `id`: provider media ID.

Response `200`: `{ "media": <normalized-media>, "timings": { "totalMs": 12 } }`. Series media may include `videos`. Returns `404` when not found.

## `GET /api/search?type=TYPE&mediaId=ID`

Combined local-corpus and live release discovery.

- `type`: `movie` or `series`.
- Movie ID example: `tt1234567`.
- Episode ID example: `tt1234567:2:4`.
- Optional filters: `q`, `year`, `resolution`, `source`, `codec`, `hdr`, `audio`, `limit`, `offset`.
- `limit` is capped at 100.

Response envelope:

```json
{
  "intent": {
    "streamType": "series",
    "mediaType": "tv",
    "scope": "episode",
    "mediaId": "tt1234567:2:4",
    "baseMediaId": "tt1234567",
    "season": 2,
    "episodes": [4]
  },
  "results": [],
  "total": 0,
  "timings": { "totalMs": 12 },
  "stats": { "indexed": 0, "total": 0 }
}
```

Release result shape:

```json
{
  "infoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "fileIndex": null,
  "releaseKey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:torrent",
  "title": "Parsed title",
  "filename": "Release.Name.mkv",
  "size": null,
  "resolution": "1080p",
  "quality": "WEB-DL",
  "codec": "x264",
  "hdr": null,
  "audio": null,
  "releaseGroup": null,
  "year": 2026,
  "season": 2,
  "episode": 4,
  "confidence": 0.5,
  "score": 0.8,
  "components": {
    "relevance": 1,
    "quality": 0.8,
    "releaseConfidence": 0.9,
    "identityConfidence": 0.5,
    "providerAvailability": 0.5,
    "episodeMatch": 1
  },
  "providers": {
    "torbox": { "cached": true, "evidence": [] }
  },
  "media": [],
  "_source": "corpus"
}
```

Exact identity semantics:

- `infoHash` is a 40-character hexadecimal string and is normalized to lowercase.
- `fileIndex` is exactly `null` or a non-negative JavaScript-safe integer. `null` is torrent-level/unknown-file evidence and never means file zero.
- `releaseKey` is canonical and derived as `lower(infoHash) + ":" + ("torrent" when fileIndex is null, otherwise decimal fileIndex)`.
- Merge deduplication uses `releaseKey`; corpus results win only when the exact key collides. Same-hash file indexes and the null index remain separate results.

Other current semantics:

- Local retrieval is not constrained by `mediaId`.
- Local candidates are ranked; live candidates receive `score: 0` and empty `components`.
- There is no final global rerank.
- `total` is the bounded merged count after exact-key deduplication, not an exhaustive corpus count.
- Provider observations may be stale; age is not enforced.
- Corpus confidence is projected from the ranked candidate's parser confidence; live confidence follows live normalization.

The local score formula is:

$$
S = 0.25R + 0.20Q + 0.20C_r + 0.15C_i + 0.10P + 0.10E
$$

This score is not currently comparable to live result score.

## `GET /api/search/internal`

Direct local SQLite/FTS search with no live discovery.

Optional parameters: `q`, `year`, `season`, `episode`, `resolution`, `source`, `codec`, `hdr`, `audio`, `limit`, `offset`, `providers=true`, and `media=true`.

The response contains `results`, `total`, parsed `query`, `timings`, and `stats`. Internal result shape differs from public UI release shape: it uses `hash`, nested `parsed` attributes, top-level score components, and provider/media arrays when requested. This endpoint is operator/internal surface and should not be copied into frontend domain types unless used.

## `GET /api/search/stats`

Response:

```json
{ "indexed": 100, "total": 100 }
```

`indexed` counts FTS rows; `total` currently counts release-attribute rows.

## `GET /api/search/cache/metrics`

Returns metadata cache metrics when available, otherwise `{ "error": "Cache not available" }` with status `200`.

## `POST /api/requests`

Submits an explicit physical-acquisition request. Current API forces provider `torbox`.

Accepted intents:

- `type: "movie"` with a movie media ID;
- `type: "series"` with exactly one episode media ID such as `tt1234567:2:4`.

Request:

```json
{
  "type": "series",
  "mediaId": "tt1234567:2:4",
  "release": {
    "infoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "fileIndex": 0,
    "releaseKey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0",
    "title": "Optional title",
    "filename": "Optional filename.mkv",
    "size": 1000,
    "resolution": "1080p",
    "quality": "WEB-DL",
    "codec": "x264",
    "hdr": "true"
  }
}
```

`release.infoHash`, `release.fileIndex`, and `release.releaseKey` are required. The identity must satisfy the exact semantics above; a missing field, invalid index, or inconsistent key returns `400`. Optional strings are trimmed/truncated and invalid size becomes null.

Response `202`:

```json
{
  "requestId": "12345678-1234-1234-1234-123456789abc",
  "status": "queued",
  "release": {
    "infoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "fileIndex": 0,
    "releaseKey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0"
  }
}
```

The selected exact identity is serialized into protocol-v1 queue JSON and returned by queue status. Browser/corpus `fileIndex` is provenance; it is never interpreted as a provider `file_id`.

## `GET /api/requests/:uuid`

Returns:

```json
{
  "requestId": "12345678-1234-1234-1234-123456789abc",
  "status": "queued",
  "release": {
    "infoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "fileIndex": 0,
    "releaseKey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0"
  }
}
```

Status is derived from queue directory and is one of `queued`, `processing`, `done`, or `failed`. Legacy protocol-v1 queue files that omitted both exact fields are reported as `fileIndex: null` and `releaseKey: lower(infoHash) + ":torrent"`; partial exact fields are invalid. Returns `404` if no file exists in those directories.

## `POST /api/ingest/dmm`

Operator mutation route. Body fields:

```json
{ "maxFragments": 1, "batchSize": 1000 }
```

The exact response is the `DMMIngestionRunner` result. Do not rely on the historical alternate-importer metrics shape.

Known defect: the reachable runner recognizes only a `decompressFromEncodedURIComponent('...')` script call, while sampled current fragments use iframe/hash. It can therefore fail with `No payload found` before decoding valid current data.

## `POST /api/attributes/run`

Operator mutation route. Optional body: `{ "limit": 100 }`. Returns attribute-worker statistics from active code.

## Not implemented

- `/api/releases` — no route exists.
- Authentication/authorization.
- Provider-neutral placement or virtual-library endpoints.
- WebDAV/mount/catalog/playback lifecycle endpoints.

When implementation changes, update contract tests/shared types and this file together. Do not duplicate this full contract in `README.md`, `docs/pipeline.md`, or UI documentation.
