# HY4-SOUTH-BASELINE

> **Purpose.** This document freezes the **current** south-side architecture of
> HashSucker (the `media-search/` runtime) so that the HY4 south-side
> transplant can diff against an unambiguous baseline. It is **not** an
> architecture spec, **not** a refactor proposal, and **not** an aspiration.
> It documents the code that exists at HEAD of `m3-north-db` after the
> hygiene pass.
>
> **Audience.** HY4 implementer (or any reviewer) who needs to know which
> files are live, which are seams, and which are off-limits until HY4.
>
> **Rule of thumb for HY4.** The current south is "obvious but not pretty."
> Leave it obvious. HY4 is the only process allowed to replace it.

---

## A. North / South boundary

| Side | What it owns | Where it lives |
|---|---|---|
| **North** | Real-Debrid acquirer hardening, event identity (`sourceEventId`), bounded merge into `historical_provider_evidence`, RD `/torrents` + `/downloads` census | `media-search/src/lib/acquisition/rd-history.js`, `media-search/src/lib/discovery/cache.js` (north PK + inserted counter), `media-search/src/scripts/import-historical-provider-evidence.js`, `media-search/src/scripts/rd-census.mjs`, `media-search/src/scripts/rd-downloads-census.mjs` |
| **South** | The runtime: search → resolve → materialize → WebDAV serve. Real-Debrid + TorBox provider paths, control plane, VFS, operator console, all of `/api/*` and `/stream/*` | `media-search/src/server/`, `media-search/src/lib/resolver/`, `media-search/src/lib/vfs/`, `media-search/src/lib/providers/`, `media-search/src/lib/discovery/`, `media-search/src/lib/control-plane/`, `media-search/src/lib/operator/`, `media-search/src/lib/requests/`, `media-search/src/lib/metadata/`, `media-search/src/lib/stream-resolver/`, `media-search/api/`, `media-search/src/api/` |

**HY4 is replacing the south.** North files are *consumed* by HY4, not
replaced. The north commit at `fe4aa60` is the authoritative north baseline
that HY4 must keep compatible.

### North → South surface (the only north files HY4 must integrate against)

| North file | What HY4 must preserve |
|---|---|
| `src/lib/acquisition/rd-history.js` | `deriveEventId({provider, sourceId, rdId, hash, observedAtMs})` = `sha256(...).slice(0,32)`. Dedup on `sourceEventId`. Bounded external sort with `mergeFanIn=64`, chunked spill at `chunkRows`. `contentVersion` = SHA-256 of the output bytes. |
| `src/lib/discovery/cache.js` | `historical_provider_evidence` PK = `(provider, source_event_id, hash, file_index, observed_at)`. `ingestHistoricalProviderEvidence` returns `{ingested, inserted, skipped, errors, ...}` with `r.changes > 0` tracked as `inserted`. |
| `src/scripts/import-historical-provider-evidence.js` | Splits the corpus dump into `rowsNewSightings` (from `r.inserted`) and `rowsExistingSightings`. The two counters are the source of truth for "is the merger idempotent." |

---

## B. Active production call graph

Entry point: `media-search/src/server/index.js` →
`createApp({...dependencies})` in `media-search/src/server/app.js`. The HTTP
listener is a single `http.createServer(createRequestHandler(dependencies))`;
routes are dispatched in one big `if (request.method === 'GET' && url.pathname === '…')`
chain in `app.js` (no router library).

### B.1 Movie playback

```
GET /stream/movie/<infoHash>
  └─ app.js streamMatch branch
     └─ resolveProjection({ store, infoHash, fileIndex, env })       [lib/resolver/resolver.js]
        └─ findActiveBinding / findExposure / evaluateReadiness
     └─ buildMediaSource({ projection, env })                        [lib/resolver/source.js]
        └─ canBuildSource(projection)
     └─ createMediaStream(source, options)                            [lib/resolver/transport.js]
        ├─ source.type === 'torbox'
        │   └─ ensureTorBoxDelivery({...}) / resolveTorBoxRedirect   [lib/resolver/torbox-delivery.js, torbox-redirect.js]
        │      └─ createTorBoxProvider().getDownloadUrl(...)
        ├─ source.type === 'realdebrid'
        │   └─ attemptRdResolution(client, cache, candidate)         [lib/providers/realdebrid/resolve.js]
        │      └─ getRdPlaybackUrl(client, torrentInfo, rdFileId)
        └─ source.type === 'local'
           └─ (direct) createMovieWebDav lookup
     └─ on stream failure → createAlternateFallback({...})           [lib/resolver/alternate-fallback.js]
        └─ tries the next binding/exposure combination
        └─ returns 502 with FALLBACK_REASON on exhaustion
```

**Movie VFS path** is `createMovieWebDav({...})` in `lib/vfs/movie-webdav.js`
(1043 lines). It implements GET/HEAD with `parseContentRange` /
`normalizeRange` for byte-range responses.

### B.2 TV playback

```
GET /stream/series/<infoHash>
  └─ app.js streamMatch branch (kind=series)
     └─ resolveProjection(...)
     └─ buildMediaSource(...)
     └─ createMediaStream(source, options)
        └─ ensureTorBoxFileIdentity({...})                            [lib/resolver/torbox-file-identity.js]
           └─ createTorBoxInventoryProvider().resolve(fileIdentity)
        └─ createTvWebDav({...})                                     [lib/vfs/tv-webdav.js]
           └─ 1067 lines, GET/HEAD with normalizeRange
     └─ on stream failure → createAlternateFallback(...)
```

The TV path additionally has `openSeasonFanOutScope` (Plex) wired in via
`lib/requests/plex-notifier.js`, but the HTTP byte stream path is
`createTvWebDav` only.

### B.3 Search (titles, releases, intake)

```
GET /api/search?q=…                        → searchTitles / getMediaById / getCacheMetrics
                                              [lib/metadata/unified-search.js, lib/metadata/cinemeta.js]
GET /api/search?imdb=…&type=…              → searchReleases(cache, options) / combinedSearch
                                              [lib/discovery/search-engine.js]
                                              └─ ranking + eligibility in lib/discovery/ranking.js
GET /api/media?imdb=…                      → getMedia
POST /api/media-request                    → searchByMedia(cache, request)
                                              [api/media-request.js]
                                              └─ searchReleases(...) with intent
                                              └─ resolveProjection for top-N
                                              └─ createHandoff → createRequestIntent
                                              └─ fulfillVirtualSelection [lib/requests/virtual-library.js]
POST /api/ingest/dmm                       → runDMMIngestion
                                              [lib/discovery/dmm-ingestion-runner.js]
POST /api/attributes/run                   → runAttributeWorker
                                              [lib/discovery/attribute-worker.js]
POST /api/ingress/seerr                    → createHandoff + createRequestIntent
                                              [lib/requests/handoff.js, lib/requests/intent.js]
```

### B.4 Control plane + operator surface (selected)

```
GET  /api/control-plane/health             → getControlPlaneHealth
GET  /api/control-plane/items              → planReconciliation
GET  /api/control-plane/items/<id>         → toControlPlaneItemDetail / toControlPlaneItemSummary
                                              [api/control-plane-dto.js]
GET  /api/operator/requests                → listDiagnostics / inspectRequests
                                              [lib/operator/diagnostics.js, lib/operator/request-inspector.js]
POST /api/operator/requests/retry          → runRepairExecutor
POST /api/operator/requests/reset          → runRepairPlanner
GET  /api/operator/requests/inspect        → inspectRequests
GET  /api/operator/health                  → getSystemHealth
GET  /api/operator/diagnostics             → listDiagnostics
POST /api/operator/diagnostics             → runDiagnostic
GET  /api/operator/events/recent           → formatRequestTimeline
GET  /api/operator/events/failed           → formatFailedRuns
GET  /api/operator/events/stats            → createLifecycleEventStore
GET  /api/operator/logs                    → getTraceLog
```

### B.5 Discovery cache and search decisions

```
GET /api/search/stats                      → getSearchStats
GET /api/search/internal                   → searchTrace + formatSearchTrace
GET /api/debug/search-trace                → searchTrace
GET /api/debug/search-decisions            → decisionFromTrace
GET /api/debug/cache-intelligence          → getCacheMetrics
GET /api/debug/enrichment                  → getEnrichmentDiagnostics
GET /api/debug/provider-accounting         → providerAccounting
POST /api/debug/provider-accounting/reset  → providerAccounting reset
GET /api/debug/discovery-accounting        → discoveryAccounting
POST /api/debug/discovery-accounting/reset → discoveryAccounting reset
GET /api/debug/resolver-telemetry          → getRecentResolverTelemetry
```

### B.6 Background durability (off by default)

The runtime scheduler in `lib/control-plane/durability-scheduler.js` is
constructed only when `BACKGROUND_DURABILITY_MODE` is set to `observe` or
`execute`. The default is `disabled` (no live provider calls, no scheduled
pass, no TorBox snapshot adapter, no library scan). Schema migration is
idempotent and applied only when the scheduler is constructed; no startup
storm is performed.

### B.7 WebDAV sub-protocol (PROPFIND)

`app.js` has a dedicated `PROPFIND` branch serving directory listing for
movie and TV roots; bodies are produced inline (no separate
`createWebDavServer` module). This is the only sub-protocol the runtime
speaks.

---

## C. Shared seam files (south; off-limits to renames until HY4)

These are the files HY4 will need to **read** and likely **replace** but
must not be casually renamed / restructured in M3 hygiene:

| File | Why it is a seam |
|---|---|
| `media-search/src/server/app.js` | 2730-line request handler. HY4 will rewrite this. Until then, every change to it is a high-risk diff. |
| `media-search/src/server/index.js` | Process entrypoint. Wires `createControlPlaneStore`, `createDiscoveryCache`, `createTorBoxInventoryProvider`, and the durability runtime. HY4 must keep these four named exports alive. |
| `media-search/src/api/media-request.js` | `searchByMedia` is the only export. Pure seam between `/api/media-request` and `searchReleases` + `createHandoff`. |
| `media-search/src/api/release-contract.js` | Defines `Release(infoHash, fileIndex) → { infoHash, fileIndex, releaseKey }`. **All call sites go through this.** |
| `media-search/src/api/control-plane-dto.js` | `toControlPlaneItemSummary` / `toControlPlaneItemDetail`. Public DTO shape for control-plane GETs. |
| `media-search/src/lib/resolver/resolver.js` | `resolveProjection`, `findActiveBinding`, `findExposure`, `evaluateReadiness`, `parseIdentityFromParams`, `ResolverError`. Movie + TV both go through it. |
| `media-search/src/lib/resolver/source.js` | `buildMediaSource`, `canBuildSource`, `SourceError`. Decides `source.type` ∈ {`torbox`, `realdebrid`, `local`}. |
| `media-search/src/lib/resolver/transport.js` | `createMediaStream`, `canTransport`, `streamToBuffer`, `TransportError`. Single function the rest of the app uses to get a stream. |
| `media-search/src/lib/resolver/alternate-fallback.js` | `createAlternateFallback`, `FALLBACK_REASON`, `FallbackError`. The retry ladder. HY4 may rewrite the ladder, not the entry point. |
| `media-search/src/lib/resolver/torbox-delivery.js` | `ensureTorBoxDelivery`, `resolveTorBoxDeliveryWithStaleRecovery`, `TorBoxDeliveryError`. Stale-recovery is exposed as a separate function. |
| `media-search/src/lib/resolver/torbox-redirect.js` | `resolveTorBoxRedirect`, `RedirectResolutionError`, `formatRedirectLog`. |
| `media-search/src/lib/resolver/torbox-file-identity.js` | `ensureTorBoxFileIdentity`. TV-only seam. |
| `media-search/src/lib/resolver/availability-revalidation.js` | `createRevalidator`, `mapRevalidationToHttp`, `REVALIDATION_SOURCE`, `REVALIDATION_OUTCOME`. |
| `media-search/src/lib/resolver/terminal-delivery-evidence.js` | `createTerminalDeliveryEvidenceStore`. |
| `media-search/src/lib/resolver/liveness.js` | `isUrlLive`. |
| `media-search/src/lib/resolver/telemetry.js` | `createResolverTelemetry`, `getRecentResolverTelemetry`, `RESOLVER_OUTCOME`. |
| `media-search/src/lib/resolver/profiler.js` | `createResolverProfiler`. |
| `media-search/src/lib/vfs/movie-webdav.js` | 1043 lines. `createMovieWebDav`, `parseContentRange`, `normalizeRange`, `MOVIE_VFS_ROOT`. |
| `media-search/src/lib/vfs/tv-webdav.js` | 1067 lines. `createTvWebDav`, `normalizeRange`. |
| `media-search/src/lib/vfs/materialize.js` | `materializeVfsEntry`. |
| `media-search/src/lib/vfs/range-response-validator.js` | (helper for VFS range parsing) |
| `media-search/src/lib/providers/torbox.js` | `createTorBoxProvider`, `checkTorBoxCached`. |
| `media-search/src/lib/providers/torbox-inventory.js` | `createTorBoxInventoryProvider`. |
| `media-search/src/lib/providers/torbox-execution.js` | `createTorBoxExecutionAdapter`, `TORBOX_EXECUTION_STATUS`, `TORBOX_PROVIDER_ID`. |
| `media-search/src/lib/providers/realdebrid/client.js` | `createRealDebridClient`, `RdCooldownError`. |
| `media-search/src/lib/providers/realdebrid/resolve.js` | `attemptRdResolution`, `getRdPlaybackUrl`, `getRdObservationState`, `classifyCandidateToRdFile`, `classifyRdFilenameFilter`, `RD_FILENAME_FILTER_RULES`, `RdResolutionError`. |
| `media-search/src/lib/providers/realdebrid/placement.js` | `createRealDebridPlacementAdapter`, `REALDEBRID_PROVIDER_ID`, `REALDEBRID_API_BASE`. |
| `media-search/src/lib/providers/realdebrid/observe.js` | `buildRdObservation`, `probeAndPersist`. |
| `media-search/src/lib/providers/realdebrid/rd-resolution-cache.js` | `getRdResolutionCache`. |
| `media-search/src/lib/providers/provider-accounting.js` | `providerAccounting`, `formatProviderAccounting`. (the warm-playback budget asserted here at M3.) |
| `media-search/src/lib/providers/accounting-cache-wrapper.js` | `wrapTorBoxDownloadUrlCacheWithAccounting`. |
| `media-search/src/lib/providers/observations.js` | (used to construct observations from createReleaseIdentity) |
| `media-search/src/lib/providers/resources.js` | (used to construct resources from createReleaseIdentity) |
| `media-search/src/lib/providers/realdebrid.js` | (legacy single-file RD adapter; re-exports `createReleaseIdentity`) |
| `media-search/src/lib/providers/zurg-metadata.js` | (used to construct zurg metadata from createReleaseIdentity) |
| `media-search/src/lib/stream-resolver/index.js` | `resolveStream`, `parseMediaIdentity`, `StreamResolverError`. |
| `media-search/src/lib/discovery/search-engine.js` | `searchReleases`, `combinedSearch`, `searchTrace`, `getSearchStats`, `rebuildSearchIndex`. |
| `media-search/src/lib/discovery/cache.js` | `createDiscoveryCache`. **North changed the `historical_provider_evidence` PK here; south uses everything else.** |
| `media-search/src/lib/control-plane/store.js` | `createControlPlaneStore`. |
| `media-search/src/lib/control-plane/reconciler.js` | `planReconciliation`. |
| `media-search/src/lib/control-plane/health.js` | `getControlPlaneHealth`. |
| `media-search/src/lib/control-plane/rd-zurg-slice.js` | `projectRdZurgLifecycle`. |
| `media-search/src/lib/requests/handoff.js` | `createHandoff`, `HANDLING_MODES`. |
| `media-search/src/lib/requests/intent.js` | `createRequestIntent`. |
| `media-search/src/lib/requests/virtual-library.js` | `fulfillVirtualSelection`. |
| `media-search/src/lib/requests/timing.js`, `timing-formatter.js` | (format helpers) |
| `media-search/src/lib/requests/plex-notifier.js` | `bindPlexMetricsSink`, `openSeasonFanOutScope`. |
| `media-search/src/lib/metadata/cinemeta.js` | `getMedia`, `searchCatalog`. |
| `media-search/src/lib/metadata/unified-search.js` | `searchTitles`, `getMediaById`, `getCacheMetrics`. |
| `media-search/src/lib/health.js` | `liveness`, `readiness`. |
| `media-search/src/lib/metrics.js` | `getMetrics`, `setPlexRefreshAccount`. |
| `media-search/src/lib/debug.js` | `getRequestDebug`. |
| `media-search/src/lib/trace/events.js` | `emit`, `EVENTS`. |
| `media-search/src/lib/operator/*` | Diagnostics, request lifecycle, repair planner/executor, event store, worker visibility, trace, request inspector. HY4 will likely replace the entire operator surface. |
| `media-search/src/lib/importer/queue-client.js` | `QueueImporterClient` (handoff/movie-importer-bridge). |

**Rule.** Renames inside this table are not part of M3 hygiene. If a name
must change, do it under HY4 in a single named refactor.

---

## D. Known ugly / legacy behavior (documented, NOT repaired)

These are behaviors that the south runtime exhibits today. They are
documented here so HY4 has a checklist of what **must** change before it
can be considered "clean" — but they are **not** bugs to fix in M3.

1. **`app.js` is one 2730-line function.** All routes are an if-ladder
   inside `createRequestHandler`. There is no router. The single-file
   shape is intentional and must not be split during hygiene.
2. **No `express`/`fastify`/router library.** The runtime is a hand-rolled
   `http.createServer`. This is the seam HY4 is meant to replace.
3. **`createReleaseKey` always returns `${infoHash}:${fileIndex ?? 'torrent'}`.**
   The literal string `'torrent'` is the sentinel for "torrent-level
   (not file-level) identity." HY4 should preserve this sentinel as part
   of the persisted ranking key.
4. **Real-Debrid cooldown errors are surfaced as `RdCooldownError`.** The
   error class lives in `lib/providers/realdebrid/client.js` and is the
   only RD-specific exception that bypasses the alternate-fallback ladder.
5. **TorBox redirect resolution has a separate stale-recovery path.**
   `resolveTorBoxDeliveryWithStaleRecovery` is exposed alongside
   `ensureTorBoxDelivery`; both must remain reachable.
6. **PROPFIND is handled inline in `app.js`.** There is no separate
   WebDAV server module.
7. **`background-durability-runtime.js` is constructed only on explicit
   opt-in.** Default is `disabled` (no live provider calls). Schema
   migration is idempotent.
8. **`search-engine.js` has five named exports** (`searchReleases`,
   `combinedSearch`, `searchTrace`, `getSearchStats`,
   `rebuildSearchIndex`); only `searchReleases` is on the hot path.
9. **`realdebrid.js` (single file in `lib/providers/`) is legacy.** It
   re-exports `createReleaseIdentity` and is referenced for backwards
   compatibility with paths the new `realdebrid/{client,resolve,...}.js`
   don't yet cover. Not a candidate for deletion in M3.
10. **`acquire-rd-history.js` is a one-shot M3 script**, not a runtime
    module. It exists to bootstrap `historical_provider_evidence` from the
    RD census. HY4 may remove it once a continuous ingestion path is in
    place.
11. **The 4 DMM `dmm-*.js` scripts (`dmm-rebuild`, `dmm-census`,
    `dmm-prevalence`, `dmm-seed-probes`, `dmm-ingest`) are corpus
    tooling**, not part of the playback path. They run against
    `artifacts/dmm-rebuild/*.db` and are wired to `npm run dmm:ingest` /
    `dmm:seed-probes` in `package.json`. Keep them.
12. **`stage3-fixture-report.js` and `lib/discovery/retrieval-benchmark.js`**
    are Stage 3 fixture tooling. They are referenced by
    `test/benchmark-integrity.test.js` and the `stage3:report` /
    `test:stage3` npm scripts. They are not part of the playback path,
    but they are not dead.
13. **8 forensic audit notes live in `media-search/.audit-*.md`.** These
    are intentionally **not** part of the source tree. They are local
    forensic notes from M3 audits (candidate eligibility, corpus
    lifecycle, FPFN durability, ranking determinism, evidence
    confidence projection, historical provider evidence, ranking
    determinism repair). They are gitignored and preserved as HY4
    reference material only.
14. **`scripts/` (root) holds canaries and validators.** Of these, only
    `canary.mjs` is wired to `npm run canary`. The others are
    investigator/operator scripts (ad-hoc, not part of `npm test`).
15. **`request-inspector.js` returns structured results** ("filesystem
    inspection unavailable in container-native environments") rather
    than a stdout dump. A previous runner (`request-inspector-runner.mjs`)
    existed as an alternate CLI entrypoint; it was deleted in the M3
    hygiene pass because it had zero references.

---

## E. Do-not-break invariants

These invariants the south side currently maintains and that HY4 must
preserve:

| Invariant | Where it lives | Why it matters |
|---|---|---|
| **`Release(infoHash, fileIndex)` is a stable identity** | `api/release-contract.js` `createReleaseIdentity` | The persisted ranking, RD observation cache, control-plane bindings, and `historical_provider_evidence` all key on it. A different shape silently breaks deduplication, ranking, and accounting. |
| **`releaseKey = ${infoHash}:${fileIndex ?? 'torrent'}`** | same | String-keyed, persisted, and queried. The `'torrent'` sentinel means "torrent-level (not file-level) identity." |
| **`historical_provider_evidence` PK includes `source_event_id`** | `lib/discovery/cache.js` (north changed) | The bounded merge in `rd-history.js` relies on this for idempotency. The PK is `(provider, source_event_id, hash, file_index, observed_at)`. |
| **`contentVersion` = SHA-256 of output bytes** | `lib/acquisition/rd-history.js` | Used to detect external mutation of the corpus dump. |
| **`providerAccounting` warm-playback budget** | `lib/providers/provider-accounting.js` | For an already-fulfilled healthy media, a single playback session must produce: `availability_checkcached: 0`, `placement_lookup_mylist: 0`, `placement_create: 0`, `inventory_fetch: 0`, `requestdl_resolution: <=1`, `requestdl_cache_hit: >= requestdl_resolution`, `requestdl_rate_limited_429: 0`, `requestdl_upstream_5xx: 0`. Ten seeks must not produce ten requestdl resolutions. |
| **`alternate-fallback` ladder is bounded** | `lib/resolver/alternate-fallback.js` | The ladder is the only path to a 502 with `FALLBACK_REASON`. HY4 may rewrite the ladder, but the entry point contract (`createAlternateFallback(deps) → fallback(source, error) → source | FallbackError`) is consumed by `transport.js`. |
| **`/stream/movie/<infoHash>` and `/stream/series/<infoHash>`** are the only playback endpoints | `app.js` streamMatch regex | Both branches route through `createMediaStream`. HY4 may add endpoints but must keep the regex shape. |
| **`MOVIE_VFS_ROOT` is the source of truth for movie mount root** | `lib/vfs/movie-webdav.js` | `parseContentRange` and `normalizeRange` are exported individually and reused by `tv-webdav.js`. |
| **`background-durability-runtime` is opt-in** | `index.js` | Default `BACKGROUND_DURABILITY_MODE` is `disabled`. The runtime must remain so until HY4 wires continuous ingestion. |
| **`createDiscoveryCache({ dbPath })` is the only discovery-cache constructor** | `lib/discovery/cache.js` | The PK change in north did not change the constructor signature. |

---

## F. File counts and shape at HEAD

- `media-search/src/server/`: 2 files (`app.js`, `index.js`)
- `media-search/src/api/`: 4 files (`client.js`, `types.js`, `media-request.js`, `release-contract.js`, `control-plane-dto.js`) — `client.js` and `types.js` are UI-facing only and consumed via Vite alias `@api/client`
- `media-search/src/lib/`: ~14 subdirectories, ~140 source files (after M3 hygiene removed `request-inspector-runner.mjs` and `playback-budget.js`)
- `media-search/src/scripts/`: 25 ad-hoc / DMM / RD-census scripts; 7 are wired to `package.json` (`search`, `cache:probe`, `dmm:ingest`, `dmm:seed-probes`, `enrichment`, `media-request`, `media-request-batch`, `intents`, `availability`, `realdebrid`, `stage3:report`)
- `media-search/test/`: ~85 test files (Node `node --test`)
- `media-search/ui/`: Vite SPA; not part of the server runtime

---

## G. What changed in M3 hygiene (relative to the pre-hygiene state)

1. **Deleted** `media-search/src/lib/operator/request-inspector-runner.mjs`
   (alternate CLI wrapper around `request-inspector.js`; zero references
   in source, tests, or scripts).
2. **Deleted** `media-search/src/lib/providers/playback-budget.js` (canary
   assertion helper; comment claimed "used by canary tooling and tests"
   but grep found zero references).
3. **Tracked** `media-search/test/ranking-determinism.test.js` (was
   untracked; tests `rankHit` / `rankHits` / `rankHitsTiered` /
   `compareHits` / `compareHitsDetailed` permutation determinism).
4. **Updated** `.gitignore` to:
   - exclude `artifacts/preflight-*/` and `artifacts/postrun-*/` (runtime
     diagnostic snapshots, reproducible by `scripts/preflight-*.sh` and
     `scripts/postrun-*.mjs`)
   - exclude `.tmp-tests/` (per-shell test scratch)
   - exclude `media-search/.audit-*.md` (forensic audit notes; local
     HY4 reference material, not part of HY4 baseline)
   - exclude `artifacts/dmm-rebuild/rd-{census,downloads}-*.json` and
     `census-*.json` (re-runnable via the `src/scripts/rd-census.mjs` and
     `rd-downloads-census.mjs` scripts)
5. **Did NOT delete**:
   - `src/api/client.js`, `src/api/types.js` (used by `media-search/ui/`
     via Vite alias `@api/client`)
   - `src/lib/discovery/retrieval-benchmark.js` (referenced by
     `test/benchmark-integrity.test.js`; Stage 3 fixture harness)
   - `src/lib/providers/realdebrid.js` (legacy RD adapter; re-exports
     `createReleaseIdentity`)
   - The 7 single-purpose canary scripts in `media-search/scripts/`
     (`canary-playback-bytes`, `canary-plex-direct-play`,
     `canary-plex-refresh-coalesce`, `canary-plex-transcode`,
     `live-tv-gate-canary`, `seerr-tmdb-translation-canary`,
     `tv-identity-canary`, `vfs-consistency-check`, etc.) — these are
     investigator/operator scripts, not part of `npm test`.
   - The 8 `.audit-*.md` files (forensic notes; HY4 reference material).

---

## H. Diff noise risk for HY4

When HY4 opens a diff against this baseline, the following files will
produce high-noise conflicts. The risk grade is a *signal* for HY4 to
budget time, not a recommendation to pre-rewrite:

| Risk | File | Why |
|---|---|---|
| **HIGH** | `media-search/src/server/app.js` | 2730 lines, one function, every route inlined. The HY4 refactor will touch this. |
| **HIGH** | `media-search/src/lib/resolver/transport.js` | `createMediaStream` is the only consumer of `source.type`. Renaming the `type` discriminator breaks everything downstream. |
| **HIGH** | `media-search/src/lib/resolver/source.js` | `buildMediaSource` decides `source.type`. Same risk. |
| **HIGH** | `media-search/src/lib/resolver/alternate-fallback.js` | The fallback ladder shape is consumed by `transport.js`. The entry point contract is fixed. |
| **MEDIUM** | `media-search/src/lib/discovery/search-engine.js` | Five named exports; only `searchReleases` is on the hot path. HY4 may add/remove the others. |
| **MEDIUM** | `media-search/src/lib/control-plane/*` | 14 files, tightly coupled. HY4 will likely replace this entire surface. |
| **MEDIUM** | `media-search/src/lib/requests/{handoff,intent,virtual-library}.js` | The intake pipeline. |
| **MEDIUM** | `media-search/src/lib/vfs/{movie-webdav,tv-webdav}.js` | 1000+ lines each, range parsing is exported and reused. |
| **LOW** | `media-search/src/lib/providers/realdebrid/*.js` | Small, well-typed modules; renaming is cheap. |
| **LOW** | `media-search/src/lib/providers/torbox*.js` | Same. |
| **LOW** | `media-search/api/release-contract.js` | Single invariant; touch carefully. |
| **LOW** | `media-search/src/api/media-request.js` | One export (`searchByMedia`); minimal blast radius. |
| **LOW** | `media-search/src/lib/discovery/cache.js` | North already changed the `historical_provider_evidence` PK; further changes touch the discovery cache surface. |
| **N/A** (consumed, not replaced) | `media-search/src/lib/acquisition/rd-history.js` | North; HY4 keeps the contract. |
| **N/A** (consumed, not replaced) | `media-search/src/scripts/import-historical-provider-evidence.js` | North; HY4 keeps the contract. |

---

## I. How to use this document

1. **Before HY4 starts**, run `git rev-parse HEAD` and write it into a
   HY4 commit message. The commit that produces this document is the
   pin.
2. **When HY4 opens a diff**, every file listed in §C should be reviewed
   against the call graph in §B. If a HY4 change is in §E (do-not-break
   invariants), reject the change.
3. **When HY4 removes a file**, check §G. The "Did NOT delete" list is
   the reference for what is *intentionally* preserved.
4. **If HY4 needs to add a file**, add it to §C and §H before the commit
   so the next diff-noise audit has it.

— end of baseline —
