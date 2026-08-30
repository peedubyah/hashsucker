# Architecture

Components, identity model, data model, HTTP surface, and the invariants that hold the system
together. For scoring and the request pipeline see
[`discovery-ranking.md`](discovery-ranking.md); for delivery see
[`playback-delivery.md`](playback-delivery.md); for running it see
[`operations.md`](operations.md).

## 1. Services

| Service | Image | Listens | Owns |
|---|---|---|---|
| `media-search` | built from `./media-search` | `127.0.0.1:3000` by default | API, corpus SQLite, ranking, control plane, resolver, WebDAV, static UI |
| `torbox-importer` | built from `./torbox-importer` | none | Physical acquisition: drains the filesystem queue, places with TorBox, imports via Radarr/Sonarr |
| `edge` | `caddy:2-alpine` | `0.0.0.0:8080` | Only public listener; reverse proxy; strips `X-Resolver-*` and `X-Internal-*` |

`media-search` serves the built React UI from the same origin, so there is no second origin in
production. The two containers communicate through a bind-mounted filesystem queue at
`/requests` (`incoming/`, `processing/`, `done/`, `failed/`) — that directory, not the database,
is the authority for physical-acquisition ownership.

`edge` is transport only. It forwards `Range`, `If-Range`, `If-Modified-Since`, and `Accept`
unchanged, must not buffer media, must not set `Content-Length`, `Content-Type`, `Content-Range`,
`Accept-Ranges`, or `Cache-Control`, and must not parse ranges, touch SQLite, read mounts, or call
provider APIs. In practice media bytes never traverse Caddy, because the resolver answers with a
307 redirect.

## 2. Identity

Two independent identity layers coexist and must not be collapsed.

**Release identity** — the exact thing that was requested or observed:

```text
releaseKey = "<lowercase 40-hex infoHash>" + ":" + (fileIndex === null ? "torrent" : fileIndex)
```

Null is torrent-level evidence and is deliberately distinct from file index `0`. Storage uses
`file_index_key = -1` for null for the same reason. Within a tier, ordering never crosses that
distinction.

**Library identity** — the desired media, independent of any file instance:

```text
identity_key = "<type>:<mediaId>[:<editionKey>]"
```

Library paths are derived deterministically from it:
`Movies/<Title (Year)>/<Title (Year)>.<ext>` and
`TV/<Title (Year)>/Season NN/<Title> - SNNENN.<ext>`. Collisions get a deterministic
`[sha256-10]` suffix. Paths are normalized (no absolute, `.`, or `..` segments) and length-capped.

**Identity is never** a provider resource ID, a CDN URL, a filesystem path, a mount path, or a
surrogate UUID. All of those are replaceable observations. Renaming a file, re-adding a torrent,
or moving a mount must not change identity.

## 3. Data model

Two independent SQLite databases. Neither is a general metadata store.

### Discovery SQLite — `DISCOVERY_DB`

WAL mode. FTS5 over `release_attributes`, synchronised by triggers.

| Table | Holds |
|---|---|
| `candidates` | Exact releases, PK `(info_hash, file_index_key)` |
| `release_attributes` | Parsed filename attributes; FTS5-backed corpus search |
| `candidate_media` | Media associations; drives the `Verified` / `Rejected` tiers |
| `provider_observations` | Per-provider cached-state observations |
| `media_intents` | Durable ingress intents; carries `imdb_id`, `tmdb_id`, `tvdb_id` |
| `media_requests` | One row per processed request; FK to `media_intents(id)` |
| `media_request_results` | Per-rank results including `identity_tier` and score breakdown |
| `playback_handoffs` | The resolved selection a `.strm` points at |

`media_metadata` is defined in source but never created at runtime — no module that defines it is
imported.

### Control-plane SQLite — `CONTROL_PLANE_DB`

WAL mode, `foreign_keys=ON`. 13 tables. The ones that carry state:

| Table | State vocabulary |
|---|---|
| `library_items` | `desired_state`: `present` \| `absent` |
| `library_paths` | one active canonical path per item (partial unique index) |
| `provider_placements` | `pending` \| `ready` \| `degraded` \| `error` \| `removed` \| `unknown` |
| `provider_readiness_observations` | same six values |
| `provider_files`, `provider_inventory_snapshots` | provider-authoritative file inventory |
| `candidate_file_mappings` | `mapped` \| `ambiguous` \| `missing` \| `stale` |
| `exposures` | `pending` \| `visible` \| `missing` \| `degraded` \| `error` \| `unknown` |
| `bindings` | `active` \| `superseded` \| `degraded` \| `failed`; one active per item |
| `repair_transactions` | `planned` \| `authorized` \| `executing` \| `failed` \| `succeeded` |
| `repair_steps` | `running` \| `succeeded` \| `failed` |
| `lifecycle_events` | append-only event log (also used for resolver telemetry) |

Placements are **torrent-level** and have no file index; file-level mapping lives entirely in
`candidate_file_mappings`. Never assume a placement is per-file.

Observations are append-only and monotonic: an observation older than the stored one is rejected,
and nothing is deleted. Freshness is a pure function of `expiresAt` against an injected `now` —
`fresh | stale | unbounded | missing`. Stale degrades effective state to `unknown`, except
`error` and `missing`, which stay terminal signals.

## 4. HTTP surface

Every route lives in `media-search/src/server/app.js`. There is no application authentication on
any route; the loopback default and the trusted reverse proxy are the whole access-control story.

### Health and static

| Route | Purpose |
|---|---|
| `GET /health` | Liveness |
| `GET /health/ready` | Readiness; 200 or 503 |
| `GET /*` | Static UI when `STATIC_ROOT` is set |

### Playback and VFS

| Route | Purpose |
|---|---|
| `GET /stream/:type/:id` | Resolver; `307` to the provider. `:id` may be `tt0944947:1:1` with `?season=&episode=` |
| `GET /media/:infoHash/:fileIndex` | Byte proxy from a mounted filesystem; `200`/`206` |
| `GET /media/lookup/:hash/:idx` | Projection as JSON, no bytes |
| `/vfs`, `/vfs/Movies/...`, `/vfs/TV Shows/...` | WebDAV: `PROPFIND` plus ranged `GET`/`HEAD` |

### Discovery and requests

| Route | Purpose |
|---|---|
| `GET /api/search?mediaId&type&...` | Combined corpus + live search (UI path) |
| `GET /api/search?q=` | Title search via Cinemeta |
| `GET /api/search/internal` | Corpus FTS5 only, no live discovery |
| `GET /api/search/stats`, `GET /api/search/cache/metrics` | Corpus and cache statistics |
| `GET /api/media?type&id` | Cinemeta media details |
| `POST /api/ingest/dmm` | DMM corpus ingestion |
| `POST /api/attributes/run` | Attribute parsing pass |
| `POST /api/requests` | Physical acquisition: queue + virtual fulfilment |
| `POST /api/media-request` | `searchByMedia` — the canonical request pipeline |
| `POST /api/ingress/seerr` | Seerr webhook ingress (bearer token) |

### Control plane

| Route | Purpose |
|---|---|
| `GET /api/control-plane/health` | Mount reachability; reports `mode: read-only-shadow` |
| `GET /api/control-plane/items` | Library items |
| `GET /api/control-plane/items/:id` | Reconciliation **plan** projection |

### Operator

Read-only console plus queue control over the filesystem spool and the lifecycle event store:
`/api/operator/requests` (with `?filter=`), `/api/operator/requests/{uuid}` (GET detail, DELETE),
`/api/operator/requests/{uuid}/retry`, `/api/operator/requests/{uuid}/reset`,
`/api/operator/requests/retry`, `/api/operator/requests/reset`,
`/api/operator/requests/delete-orphan`, `/api/operator/requests/inspect`,
`/api/operator/requests/{uuid}/inspect`, `/api/operator/requests/health`,
`/api/operator/health`, `/api/operator/workers`, `/api/operator/logs`,
`/api/operator/search-debug`, `/api/operator/events/recent`,
`/api/operator/events/request/{uuid}`, `/api/operator/events/failed`,
`/api/operator/events/stats`, `/api/operator/diagnostics`,
`/api/operator/diagnostics/run/{name}`.

### Debug

`/api/metrics` (plain JSON counters and ranking distribution — **not** Prometheus),
`/api/debug/enrichment`, `/api/debug/cache-intelligence`, `/api/debug/search-trace`,
`/api/debug/search-decisions`, `/api/debug/resolver-telemetry`.

## 5. Invariants

These are the rules code cannot express on its own.

**Identity and ownership**

- Provider state never becomes candidate identity.
- Never use a provider resource ID, CDN URL, filesystem path, or mount path as identity.
- Never store consumer paths (Plex, WebDAV, `.strm`) in the control plane.
- Never store CDN URLs as permanent records — there is no `resolved_urls` table.
- Never store corpus metadata (title, year, resolution, codec) or quality scores in the control
  plane.
- `fileIndex: null` is not `0`. No fuzzy matching, ever.

**Lifecycle separation**

A placement is not exposure; exposure is not a binding; a binding is not catalog visibility;
catalog visibility is not playback success. Cached, placed, exposed, bound, cataloged, and
playable are never synonyms. Each boundary gets its own state, timestamp, and failure category.

**Observation**

- Never treat a stale observation as evidence of current state.
- Never treat a *missing* observation as evidence of absence — a miss triggers re-observation, not
  repair.
- Never infer one observation kind from another: present does not imply ready, ready does not imply
  visible, visible does not imply bound.
- Never treat a missing filesystem exposure as provider deletion. Mount absence is exposure
  absence only.
- Never treat Zurg metadata as authoritative for Real-Debrid placement state. Zurg's
  `.zurgtorrent` is Zurg's local truth, not the provider's.
- Never write to provider mounts. All filesystem observers are strictly read-only.
- Never observe or join across provider, account, instance, or mount scope boundaries.
- Freshness is always computed against an injected `now`; never call `Date.now()` internally.

**Binding and repair**

- Bindings are mutated only through `store.activateBinding()`. Activation requires an active
  canonical path owned by the item, a placement whose info hash matches the release identity, a
  fresh readiness observation, an authoritative and complete inventory snapshot, an authoritative
  exact file mapping, and an exposure that is `visible` **and** `read_only=1`.
- Never create, degrade, or repair a binding in response to playback success or failure.
- Never delete or reactivate a superseded or failed binding; never reuse a binding version.
- Never allow destructive repair by default — the planner runs with `destructive:false`. Resource
  removal requires proven ownership, a fresh observation, and zero dependent bindings.
- Repair is never triggered automatically. The server calls only `planReconciliation`, in
  `mode:'shadow'`; `executeReconciliation` has no runtime caller.

**Resolver and gateway**

- The resolver never picks a provider. The binding determines the provider.
- The resolver never makes an acquisition decision, never calls a provider API on the read path,
  and never implements WebDAV, `PROPFIND`, or `LOCK`.
- Never bypass resolved-path containment under the mount root.
- Never let the gateway, resolver, UI, or a consumer observe or write placement state.

**Metadata**

- Cinemeta `/meta/{type}/{id}.json` is trustworthy and is the only Cinemeta surface that is.
  `/catalog/{type}/top/search={q}.json` returns static popular results regardless of query and
  must never be used for identity resolution. It still backs `GET /api/search?q=`, which is a known
  defect.
- Never let API keys, database paths, or mount roots cross the edge boundary or reach browser code.

## 6. External boundaries

| System | Boundary |
|---|---|
| Cinemeta | Metadata lookup only; `/meta/` endpoint only |
| DMM | Corpus source; ingestion is operator-triggered and not resumable |
| Torrentio, Comet, Torznab | Discovery evidence, never placement or file authority |
| TorBox | Placement, cache checks, file inventory, `requestdl` links |
| Real-Debrid | Preferred delivery; unrestricted links expire and are rate-limited |
| Zurg | Real-Debrid-only WebDAV; state read from `.zurgtorrent` sidecars, never via HTTP |
| rclone | Transport bridge to local filesystems; not called by HashSucker code |
| Radarr, Sonarr | Physical-import authority only |
| Plex, Jellyfin | Consumers of stable `.strm` URLs; never learn provider or binding state |
| Seerr | Request ingress via webhook |
| Plex Watchlist | Request ingress via a manually run host script |

## 7. Non-goals

- A custom HTTP byte proxy as the default data plane; the resolver answers with a `307` redirect so
  media bytes reach the player over mature transports.
- `rclone` union as semantic identity — union conflict and path-selection policy cannot enforce
  exact release choice, edition handling, placement preference, or provider failover.
- Hash-level or release-family deduplication. Family is evidence, never identity.
- Sonarr/Radarr completed-download import as a mandatory virtual path.
