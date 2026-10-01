# Stage 1 — Input and Request Ingestion

All intake funnels into one function: `searchByMedia(cache, request)` in
`media-search/src/api/media-request.js`. HTTP routes are thin adapters over it.

## Entry points

| Method + path | Purpose | Notes |
|---|---|---|
| `POST /api/media-request` | Native intent API (primary) | Validates `qualityProfile`, `intent`; builds request-scoped TorBox/RD ensure fns; runs retirement, publication profile, second-placement coverage |
| `POST /api/media-prepare` | Discovery/ranking/binding only | Same as above with `prepareOnly:true, source='prepare'`; no VFS/STRM/notify/desired-state |
| `POST /api/ingress/seerr` | Seerr/Jellyseerr/Overseerr webhooks | Bearer `SEERR_WEBHOOK_TOKEN`; request, decline/withdraw, availability events |
| `GET /stream/movie/:id`, `GET /stream/series/:id?season=&episode=` | STRM target URLs | 307 redirect ladder or typed JSON errors |
| `GET /media/:infoHash/:fileIndex` | Legacy compat byte path | Not authoritative; resolves via projection |
| `GET /api/media-request/:id/handoff` | Retrieve handoff by request ID | Read-only |
| WebDAV `PROPFIND/GET /vfs/...` | Filesystem projection | Movie + TV handlers; what Plex/Jellyfin walk |
| `POST /api/library/reconcile\|unpublish\|profile\|intent`, `POST /api/library/:id/promote`, `GET /api/library` | Library control plane | Intent/profile/retirement management |
| Download/intent endpoints | Staged-download intents | Separate state machine (`download/store.js`) |

## Request shape (`searchByMedia`)

Required: `mediaId`. Common optional fields (real names): `mediaType`
(`'movie'`/`'series'`), `season`, `episode`, `limit` (50, max 100),
`offset`, `persist` (`!==false`), `skipLiveDiscovery`,
`skipAvailability`, `prepareOnly`, `forceDiscovery`, `liveOnly`,
`source`, `sourceType`, `sourceId`, `intent`, `qualityProfile`,
`ttlHours`, `temporary`, `canonicalTitle`, `canonicalYear`,
`releaseDate`/`airDate`, `expectedAt`, `controlPlaneStore`,
`ensureTorBoxFileIdentity`, `ensureRealDebridFileIdentity`.

Movie example:

```json
{ "mediaId": "tt0133093", "mediaType": "movie",
  "source": "seerr", "sourceType": "request", "sourceId": "req-42" }
```

TV example:

```json
{ "mediaId": "tt0903747", "mediaType": "series", "season": 1, "episode": 1,
  "source": "seerr", "sourceType": "request", "sourceId": "req-43" }
```

## Movie vs TV differences

- Movies use `mediaId` alone; episodes key on `(mediaId, season, episode)`.
  DB child rows store `media_type:'tv'`; intent IDs may embed `tt…:S:E`.
- Wrong-episode guards are explicit in `/stream` and the reuse path.
- Series without S/E → `400 MISSING_EPISODE_INFO`.
- Seerr TV fan-out enumerates seasons → per-episode children; structural
  enumeration failure aborts the fan-out (500), per-episode failure isolates
  into deferred intents, never a partial lie.
- Plex episode confirmation (`confirmPlexEpisode`) applies to series only.

## Intent normalization (`src/lib/requests/intent.js`)

`createRequestIntent({type, mediaId})`: `movie` → stream scope; `series`
with `id` matching `/(.*):(\d+):(\d+)$` → episode scope with base ID.
Throws on bad type/empty id. External IDs (TMDB, TVDB, titles) are
metadata only — canonical internal identity is derived downstream, and
Seerr identities resolve TMDB→IMDb via request detail lookup.

## Idempotency / re-request

- Seerr duplicates collapse on `(source='seerr', source_id)` unless a
  future intent is still pending; already-`completed` children skip as
  `already-successful`.
- Healthy prior publication reuses without discovery
  (`tryReuseHealthyPublication`/`getPreparedDurableState`): requires stored
  handoff + same-hash positive-size TorrentFile + ≥1 data-plane coordinate
  (+ episode playable check + `desiredState !== 'absent'`). Path A is a
  pure noop (VFS row matches, STRM verified — zero writes, zero network);
  Path B republishes via `materializeVfsEntry`. Divergence falls through
  to full discovery; reuse never selects a new Release.

## Incomplete metadata

Missing S/E on series is a hard 400, never a guess. Unresolvable Seerr
identity, failed season enumeration, and unauthorized/misconfigured intake
fail closed with typed errors (`identity-unresolved`, `seerr-season-
enumeration-failed`, etc.).

## Source references

- `media-search/src/api/media-request.js`, `media-search/src/server/app.js`
- `media-search/src/lib/requests/`, `media-search/src/lib/intents/`
- `media-search/src/lib/discovery/playback-handoff.js`
