# Architecture

Components, identity model, data model, HTTP surface, and the invariants that hold the system
together. For scoring and the request pipeline see
[`discovery-ranking.md`](discovery-ranking.md); for delivery see
[`playback-delivery.md`](playback-delivery.md); for running it see
[`operations.md`](operations.md).

## 1. Services

| Service | Image | Listens | Owns |
|---|---|---|---|
| `media-search` | built from `./media-search` | `127.0.0.1:3000` by default | Durable truth, API, both SQLite databases, discovery/ranking, selection, resolver compatibility path, VFS/WebDAV namespace, static UI |
| `data-plane` | built from `./data-plane` | `3001` on the internal Compose network | Runtime provider capabilities, HTTP Range delivery, same-TorrentFile recovery, fixed-grid cache, coalescing, scheduling, limiter/breaker behavior |
| `torbox-importer` | built from `./torbox-importer` | none | Physical acquisition: drains the filesystem queue, places with TorBox, imports via Radarr/Sonarr |
| `edge` | `caddy:2-alpine` | `0.0.0.0:8080` | Only public listener; reverse proxy; strips `X-Resolver-*` and `X-Internal-*` |

`media-search` serves the built React UI from the same origin, so there is no second browser
origin in production. It and `torbox-importer` communicate through a bind-mounted filesystem
queue at `/requests` (`incoming/`, `processing/`, `done/`, `failed/`) — that directory, not the
database, is the authority for physical-acquisition ownership. `data-plane` instead consumes
Node's per-TorrentFile S-1 projection over the internal Compose network and stores cached bytes on
its own persistent volume.

`edge` is transport only. It forwards `Range`, `If-Range`, `If-Modified-Since`, and `Accept`
unchanged, must not buffer media, must not set `Content-Length`, `Content-Type`, `Content-Range`,
`Accept-Ranges`, or `Cache-Control`, and must not parse ranges, touch SQLite, read mounts, or call
provider APIs. Media bytes bypass Caddy when the legacy `/stream` resolver returns a 307 redirect.
A client that reaches the authoritative `/vfs` path through `edge` receives bytes through Caddy,
but Caddy remains a transparent streaming hop: Node forwards the request to Rust and does not move
byte authority into the gateway.

## 2. Identity

The following identity grains coexist and must not be collapsed.

**Release identity** — the torrent release:

```text
Release = infoHash
```

**Discovery release key** — the release plus the discovery-level file selector:

```text
releaseKey = "<lowercase 40-hex infoHash>" + ":" + (fileIndex === null ? "torrent" : fileIndex)
```

Null is torrent-level evidence and is deliberately distinct from file index `0`. Storage uses
`file_index_key = -1` for null for the same reason. Within a tier, ordering never crosses that
distinction. `releaseKey` is a discovery, ranking, and handoff key; it is not Release identity.

**TorrentFile identity** — the exact durable file within a Release:

```text
TorrentFile row identity = infoHash + canonicalInternalPath
size = immutable exact positive invariant
```

The Node schema enforces `(info_hash, internal_path)` uniqueness. A later conflicting size does not
mutate that row or become an authoritative ProviderFile mapping. Rust includes
`(infoHash, canonicalInternalPath, size)` in its cache and coalescing key. `torrent_files.id` is a
routing UUID and forensic label, not byte identity.

**Library identity** — the desired media, independent of any file instance:

```text
identity_key = "<type>:<mediaId>[:<editionKey>]"
```

Library paths are derived deterministically from it:
`Movies/<Title (Year)>/<Title (Year)>.<ext>` and
`TV/<Title (Year)>/Season NN/<Title> - SNNENN.<ext>`. Collisions get a deterministic
`[sha256-10]` suffix. Paths are normalized (no absolute, `.`, or `..` segments) and length-capped.

**Identity is never** a provider resource ID, provider-internal path, CDN URL, mount/VFS path, or
surrogate UUID. All of those are replaceable observations. The `canonicalInternalPath` inside a
TorrentFile is a durable torrent-internal identity component, not a provider, host, mount, or
consumer path.

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

WAL mode, `foreign_keys=ON`. 16 tables. The ones that define the durable relationships:

| Table | Holds |
|---|---|
| `library_items` | `desired_state`: `present` \| `absent` |
| `library_paths` | one active canonical path per item (partial unique index) |
| `provider_placements` | provider/account resource records; key `(provider, account_scope, provider_resource_id)`, with immutable `info_hash` |
| `provider_placement_observations`, `provider_readiness_observations` | current scoped placement/readiness observations |
| `torrent_files` | durable files keyed by `(info_hash, internal_path)`, with immutable positive size |
| `provider_files`, `provider_inventory_snapshots` | provider-authoritative file inventory; current mapped files can reference `torrent_files.id` |
| `candidate_file_mappings` | discovery `releaseKey` to provider-file evidence: `mapped` \| `ambiguous` \| `missing` \| `stale` |
| `exposures` | `pending` \| `visible` \| `missing` \| `degraded` \| `error` \| `unknown` |
| `bindings` | library item/path to release, placement, provider file, and exposure; `active` \| `superseded` \| `degraded` \| `failed`; one active per item |
| `repair_transactions` | `planned` \| `authorized` \| `executing` \| `failed` \| `succeeded` |
| `repair_steps` | `running` \| `succeeded` \| `failed` |
| `lifecycle_events` | append-only event log (also used for resolver telemetry) |
| `provider_delivery_evidence` | durable provider-delivery evidence, separate from byte identity |

Placements are **torrent-level** and have no file index. A `ProviderFile` is keyed within a
placement by `(placement_id, provider_file_id)` and records the provider's current path, size, and
presence. Authoritative inventory may map it to one TorrentFile; provider file IDs and paths may
churn without changing TorrentFile identity. `candidate_file_mappings` separately relates a
discovery `releaseKey` to a provider file. Never assume a placement is per-file or equate a
discovery file index with a provider file ID.

A binding records one semantic library item/path relationship to a release, placement, provider
file, and read-only exposure. On the authoritative path it reaches TorrentFile identity through the
mapped ProviderFile; legacy bindings need not have that mapping. It does not create byte identity
or choose the runtime `DeliveryCapability`. A `playback_handoffs.torrent_file_id` may carry the
TorrentFile routing UUID directly for VFS materialization.

Observation writes are monotonic by `observedAt`: an older observation is rejected. Several
tables are current projections updated only by an equal or newer observation; append-only history
lives in `lifecycle_events` and evidence/event tables. Freshness is a pure function of `expiresAt`
against an injected `now` — `fresh | stale | unbounded | missing`. Stale degrades effective state
to `unknown`, except `error` and `missing`, which stay terminal signals.

## 4. HTTP surface

Public and control-plane routes live in `media-search/src/server/app.js`; the internal byte-serving
routes live in the Rust data plane. There is no application authentication on these internal
routes; host binding and the trusted Compose/reverse-proxy boundary are the access-control story.

### Health and static

| Route | Purpose |
|---|---|
| `GET /health` | Liveness |
| `GET /health/ready` | Readiness; 200 or 503 |
| `GET /*` | Static UI when `STATIC_ROOT` is set |

### Playback and VFS

| Route | Purpose |
|---|---|
| `GET /stream/:type/:id` | Compatibility resolver; Node revalidates/selects a provider and returns `307`. `:id` may be `tt0944947:1:1` with `?season=&episode=` |
| `GET /media/:infoHash/:fileIndex` | Compatibility byte proxy from a mounted filesystem; `200`/`206` |
| `GET /media/lookup/:hash/:idx` | Projection as JSON, no bytes |
| `/vfs`, `/vfs/Movies/...`, `/vfs/TV/...` | Authoritative WebDAV namespace: Node handles metadata/selection; TorrentFile-backed `GET`/Range bytes are forwarded to Rust |
| `GET /api/data-plane/files/:tfId` | Internal S-1 projection of one TorrentFile and its usable mapped provider coordinates |
| `GET /api/library` | Product library listing: per movie/episode desired state, published/absent/incomplete state, presentation path, TorrentFile, size, and serving-coordinate presence |
| `POST /api/library/unpublish` | Remove VFS/STRM presentation for an exact movie, episode, or season; retains Release/TorrentFile/provider truth for cheap republish |
| `POST /api/library/reconcile` | Record consumer-library presence/absence/UNKNOWN observations for published items; retires ELIGIBLE items only when the retirement policy enables it (default OFF) |
| `GET /api/library/retirement` | Dry-run retirement planner: per-item presence, absence age, eligibility, exact ineligibility reason; read-only |
| `GET /api/diagnostics` | Rollout readiness: storage, data-plane, providers, consumers, publication, lifecycle in one payload (`ready|degraded|not_ready`); cheap checks only, no secrets |
| `POST /api/media-prepare` | Fulfillment preparation: discovery/ranking/selection/binding persisted as reusable durable truth with no presentation (no VFS, no STRM, no notifications); idempotent |

### Rollout readiness

`GET /api/diagnostics` answers whether the system can serve households
without SQLite archaeology. Fatal (`not_ready`): control-plane/discovery
DBs unreadable, STRM root not writable, data-plane unreachable. Degraded:
a provider down/unreachable, a configured consumer broken (Plex
`PLEX_UNREACHABLE`/`PLEX_AUTH_FAILED` covered distinctly), publication
store unreadable. Warnings (never fatal): Jellyfin library without
realtime monitoring, disabled automatic retirement, unconfigured
optionals. Consumer checks use cheap endpoints (TorBox single-hash
cache probe, Real-Debrid account info, Jellyfin/Plex info + auth
probe) — never inventory scans. A one-block readiness summary is also
logged once at startup.

### Consumer reconciliation and retirement eligibility

HashSucker observes playback-consumer libraries (Jellyfin reachable; Plex
currently UNKNOWN pending the parked endpoint/credential repair) and maps
consumer rows back to `(mediaId [+ season/episode])` via IMDb ids —
never filenames alone, never TorrentFile ids. Observations live in
`consumer_observations` (`present` 1/0/NULL for seen/absent/unknown) and
are a projection, not media identity.

Eligibility requires: policy enabled (`RETIREMENT_ENABLED`, default OFF),
item published, fresh observations, every required consumer (`JELLYFIN`
by default) reporting absent, and absence sustained past
`RETIREMENT_ABSENCE_GRACE_MS` (default 7 days) with history proving
sustained watching. UNKNOWN, stale, missing, or insufficient history
fails closed to not-eligible; a single missing scan never retires. The
executor reuses safe-unpublish semantics only — no provider or durable
identity deletion. No request-intent guard exists: request history cannot
safely answer "still wanted," so none is inferred.

### Authoritative TorrentFile byte path

For a VFS entry with a durable TorrentFile ID, the path is:

```text
Plex or another WebDAV client
→ edge (when the public listener is used)
→ Node /vfs namespace and durable TorrentFile selection
→ Rust GET /files/:tfId with the client Range
→ Node GET /api/data-plane/files/:tfId S-1 projection
→ Rust provider capability, Range serving, cache/coalescer, and recovery
→ streamed response through Node (and edge, when used) to the client
```

Node owns durable truth and is the only layer allowed to select another TorrentFile or Release.
Only a classified `PROVIDER_EXHAUSTED` result may invoke Node's persisted-alternate selection and
re-forward a different TorrentFile to Rust; other Rust failures do not fall through to a legacy
Node byte path. Rust may select or switch TorBox/Real-Debrid execution coordinates only for the
same exact TorrentFile.

`/stream` redirects and mounted `/media` delivery remain compatibility paths. Legacy VFS entries
without a TorrentFile may also use the legacy Node provider path. Those paths do not redefine the
authoritative TorrentFile/VFS ownership boundary.

### Rust data plane

| Route | Purpose |
|---|---|
| `GET /files/:tfId` | Parse and serve the requested HTTP Range for one Node-selected TorrentFile |
| `POST /files/:tfId/prewarm` | Warm one named provider placement for the same TorrentFile without serving media bytes |
| `GET /metrics` | Process-level delivery, cache, coalescing, scheduler, limiter, breaker, and capability counters |

For each request Rust consumes the S-1 projection rather than opening Node's SQLite databases. A
`DeliveryCapability` is runtime-only provider execution state: signed URL, provider/account and
provider-resource coordinates, provider file ID, per-capability concurrency state, and lifecycle
state. A reservation or shared lease owns the provider permit. Neither is durable identity, and
Rust capability URLs are never logged, exposed to the VFS client, or persisted as permanent
records.

Rust owns provider retry and `Retry-After`, limiter/breaker behavior, capability reuse/death and
reacquisition, a fixed-grid persistent cache (8 MiB current default), per-chunk single-flight
coalescing, and lane execution. The scheduler permits at most two active lanes per scheduled
missing run; that is not a process-wide concurrency limit. Shared-cap two-lane execution and work
stealing are experimental and default OFF. When shared-cap execution is armed, one lease owns one
capability reservation and permit for at most two logical child readers; the permit remains held
until the final child ends.

The cache and coalescer are provider-agnostic only after TorrentFile identity is established:

```text
same TorrentFile + same exact Range = identical bytes
regardless of TorBox vs Real-Debrid execution
```

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
| `POST /api/media-prepare` | `searchByMedia` with preparation only: discovery/ranking/selection/binding persisted, no presentation |
| `POST /api/ingress/seerr` | Seerr webhook ingress (bearer token) |
| `POST /api/future-intents` | Seed durable future intent (no presentation); scheduler prepares/publishes ahead of demand |
| `GET /api/future-intents` | List intents, counts, next check |

**Prepared vs published.** A *prepared* item has durable fulfillment truth —
playback handoff (exact Release + TorrentFile) + positive-size TorrentFile row
+ at least one present mapped provider coordinate — but no VFS row, no STRM,
no library desired-state, and no consumer notification. Preparation
(`POST /api/media-prepare`, or `prepareOnly` on `searchByMedia`) pays the
expensive provider proof off the human path; the next normal request
recognizes the prepared state and republishes locally in milliseconds with
zero provider work. Identity rows are immutable and carry no TTL; placement
liveness is re-proven at serve time, and stale truth falls back safely into
the normal path. `GET /api/diagnostics` reports the prepared count.

**Anticipatory intents.** `POST /api/future-intents` seeds durable
"expect this media later" records (movie or exact S/E scope, source,
optional expected date); seeding creates no presentation. The scheduler
runs one bounded intent per tick: prepare via `POST /api/media-prepare`,
then publish via the normal request path (which republishes prepared
truth and fires consumer refresh for overlap), then a byte-readiness
probe; head+tail grid prewarm fills cache concurrently in the background.
Intent states (`GET /api/future-intents`, counts under `anticipation` in
diagnostics): anticipated → preparing → prepared → published_preparing →
playable, plus failed/withdrawn. Provider exhaustion withdraws
presentation through safe-unpublish with history preserved. Future hooks
(Sonarr/Radarr) only need to seed intents; they never touch
provider/VFS internals.

**Intent sources.** Sonarr/Radarr act as sensors (monitored/upcoming reads
only — never downloads, queue edits, or release choice) via batched sync
into `future_intents` (`radarr:movie:<id>`, `sonarr:<series>:SxxExx`
provenance). Prowlarr/Torznab remains the next slice: it will become
another *candidate-intelligence* source (what hashes exist), parallel to
the corpus title index — never a fulfillment authority. The ranking and
binding path stays single and unchanged regardless of source.

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
- Never use a provider resource ID, provider-internal path, CDN URL, mount/VFS path, or routing UUID
  as identity. TorrentFile's canonical internal path is the explicit durable exception described
  in §2.
- Store canonical relative library/VFS paths, not consumer-specific absolute mount roots, provider
  paths, or `.strm`/HTTP presentation URLs, in the control plane.
- Never store CDN URLs as permanent records — there is no `resolved_urls` table.
- Never store corpus metadata (title, year, resolution, codec) or quality scores in the control
  plane.
- `fileIndex: null` is not `0`. No fuzzy matching, ever.
- Node owns durable truth and selection of another TorrentFile or Release. Rust owns execution and
  byte motion and may switch providers only within the same TorrentFile.
- The same exact Range of one TorrentFile must be byte-identical regardless of provider execution.

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
- Never merge durable provider observations across provider, account, instance, or mount scope
  boundaries. Runtime cache/coalescing is provider-agnostic only after the same TorrentFile identity
  has been established.
- Freshness is always computed against an injected `now`; never call `Date.now()` internally.

**Binding and repair**

- Bindings are mutated only through `store.activateBinding()`. Activation requires an active
  canonical path owned by the item, a placement whose info hash matches the release identity, a
  ready placement (and any stored readiness observation must be fresh and ready), an authoritative
  and complete inventory snapshot, an authoritative exact file mapping, and an exposure that is
  `visible` **and** `read_only=1`.
- A binding records a durable placement/file/exposure relationship; it does not choose a runtime
  provider capability or prevent Rust from switching providers for the same TorrentFile.
- Never create, degrade, or repair a binding in response to playback success or failure.
- Never delete or reactivate a superseded or failed binding; never reuse a binding version.
- Never allow destructive repair by default — the planner runs with `destructive:false`. Resource
  removal requires proven ownership, a fresh observation, and zero dependent bindings.
- Repair is never triggered automatically. The server calls only `planReconciliation`, in
  `mode:'shadow'`; `executeReconciliation` has no runtime caller.

**Resolver and gateway**

- The compatibility `/stream` resolver may revalidate providers, choose Real-Debrid or TorBox for
  the same selected release, and return a provider redirect. That policy does not govern the
  authoritative VFS/TorrentFile byte path.
- On the authoritative path, Node selects the TorrentFile and may select a persisted alternate only
  after classified provider exhaustion. Rust chooses runtime provider execution and performs
  same-TorrentFile recovery; a binding does not make that choice.
- The `/stream` route itself does not implement WebDAV. The `media-search` service owns the `/vfs`
  namespace and `PROPFIND`/metadata behavior while Rust owns TorrentFile-backed Range bytes.
- Never bypass resolved-path containment under the mount root on the compatibility `/media` path.
- The gateway, UI, and consumers must not write placement state. Runtime serving attribution stays
  internal; the VFS response does not expose capability metadata to the consumer.

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
| TorBox | Placement/acquisition, cache checks, authoritative file inventory, and runtime delivery capabilities; Node owns durable records and Rust owns byte execution |
| Real-Debrid | Placement/readiness and file coordinates plus expiring runtime delivery capabilities; Node owns durable records and Rust owns byte execution |
| Zurg/provider WebDAV | Read-only provider exposure and compatibility-mount boundary; `.zurgtorrent` is Zurg-local evidence, not provider placement or TorrentFile truth |
| HashSucker WebDAV (`/vfs`) | Node-owned virtual namespace and metadata; TorrentFile-backed GET/Range bytes are forwarded to Rust |
| rclone | External bridge that may mount HashSucker/provider WebDAV into a local filesystem; not called by HashSucker code and never identity or provider-selection authority |
| Radarr, Sonarr | Physical-import authority only |
| Plex, Jellyfin | Consumers of stable `.strm` URLs and/or the rclone-mounted VFS; authoritative VFS hides provider capabilities, while compatibility `/stream` redirects expose only the selected runtime destination |
| Seerr | Request ingress via webhook |
| Plex Watchlist | Request ingress via a manually run host script |

## 7. Non-goals

- Making the Node resolver or mounted-filesystem `/media` proxy the authoritative modern byte
  engine. Rust's bounded HTTP Range service is the authoritative TorrentFile execution path; Node
  owns VFS semantics and streams the Rust response without taking over provider execution.
- `rclone` union as semantic identity — union conflict and path-selection policy cannot enforce
  exact release choice, edition handling, placement preference, or provider failover.
- Hash-level or release-family deduplication. Family is evidence, never identity.
- Sonarr/Radarr completed-download import as a mandatory virtual path.
