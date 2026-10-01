# Module Reference — Node (media-search)

Repo: `media-search/src/`. Each row: location · purpose · key entry points.

## Intake & serving

| Module | Purpose | Entry points |
|---|---|---|
| `server/app.js` (~4600 lines) | Monolithic HTTP routes | All `/api/*`, `/stream/*`, `/media/*`, `/vfs/*`, operator routes |
| `server/index.js` | Boot, wiring, all background timers | `arm*Timer` family (see Background-Jobs) |
| `api/media-request.js` | Core pipeline `searchByMedia` | Intake → reuse → discovery → rank → bind → publish → handoff |
| `lib/requests/` | Intake primitives, STRM publisher, queue (legacy), scoped ensure fns | `createRequestIntent`, `publishStrm`, `buildRequestScopedEnsureFn` |
| `lib/intents/` | Intent provider registry + Seerr provider | `MediaIntentProviderRegistry`, `buildSeerrIntent` |
| `lib/stream-resolver/index.js` | STUB (`not_implemented`) | Live `/stream` route does not use it |

## Discovery / ranking / identity

| Module | Purpose | Entry points |
|---|---|---|
| `lib/search.js` | Live fan-out + merge + TorBox hints | `searchMedia`, `mergeStreams`, `enrichAndFinalize` |
| `lib/discovery/` | Canonicalization, ingest, live-bridge, corpus lifecycle/versioning, FTS engine, Prowlarr, DMM adapters, decisions, hygiene | `toCanonicalLive`, `ingestCandidates`, `runLiveDiscovery`, `createCorpusLifecycle` |
| `lib/discovery/release-attributes.js` + `attribute-worker.js` | Parsed release features | `storeReleaseAttributes`, `runAttributeWorker` |
| `lib/discovery/enrichment.js`, `confidence*.js`, `identity-resolver.js` | Association + confidence (writes `candidate_media` only) | `enrichCandidates`, `computeConfidence` |
| `lib/discovery/ranking.js`, `rejection*.js`, `episode-coverage.js`, `selection.js` | Score, filter, select + bind | `rankHitsTiered`, `selectBestCandidate`, `selectBindableCandidate` |
| `lib/resolver/` | TV episode resolution, projections, fallback, revalidation, telemetry | `resolveTvTorrentFile`, `resolveProjection`, `createAlternateFallback` |
| `lib/torznab/torznab.js`, `lib/stremio/search.js` | Indexer + addon clients (outbound) | `searchTorznab`, `searchStremio` |
| `lib/metadata/`, `lib/discovery/media-metadata.js` | Cinemeta (7d cache) | `createCinemetaAdapter` |

## Providers & control plane

| Module | Purpose | Entry points |
|---|---|---|
| `lib/providers/torbox*.js` | Checkcached, inventory, placement, delivery, budgets, coordinators | `checkTorBoxCached`, `createTorBoxInventoryProvider`, `TorBoxCallBudget` |
| `lib/providers/realdebrid/` | Client, placement, observe, ensure, resolve, res-cache | `createRealDebridClient`, `createRdEnsure` |
| `lib/providers/errors.js` | Typed taxonomy | `ProviderOperationError`, `classifyProviderError` |
| `lib/control-plane/store.js` | Control-plane SQLite owner | Library/bindings/placements/files/exposures tables |
| `lib/control-plane/canonical-path.js` | Canonical VFS paths | `buildPreferredCanonicalPath` |
| `lib/control-plane/second-placement.js`, `prewarm.js`, `playback-redundancy.js`, `reconciler.js`, `rd-placement-realizer.js` | Coverage, warm, reconcile | Additive readiness only |
| `lib/acquisition/` | Decision/composition/observation/projection/policy | Acquisition state machines |

## Library, lifecycle, background

| Module | Purpose | Entry points |
|---|---|---|
| `lib/library/` | Intent, retirement, listing, unpublish | `markTemporaryPublication`, retirement policy |
| `lib/lifecycle/` | Upgrade watch+evaluator, quality profiles, coverage escalation, job retry | `createUpgradeEvaluator`, `profilePolicy` |
| `lib/anticipation/` | Future intents, Arr sync, scheduler, prewarm, quality gate | `tickOnce` (one intent/tick), `createArrSync` |
| `lib/defers/` | Seerr deferral, availability wakes | `classifySeerrDeferral`, wake log |
| `lib/promotion/`, `lib/download/` | Owned-storage promotion; staged-download worker/handoff | Workers (30s; inert unless paths set) |
| `lib/materialize/` | Byte-fetch + verify + atomic stage (promotion/download path) | `materializeTorrentFile` (returns `{ok:false}`, never throws, on fetch/verify failure) |
| `lib/vfs/` | Materialize, WebDAV handlers, data-plane forward, range validator | `materializeVfsEntry`, `streamFromDataPlane` |
| `lib/consumers/` (+ `lib/plex/`) | Plex/Jellyfin presence, sessions, reconcile, refresh coalescer, notifiers | `confirmPlexEpisode`, `runReconcile`, `createRefreshCoalescer` (750ms debounce, partial-refresh only) |
| `lib/importer/` | Importer-adjacent (with `torbox-importer/` service + `handoff/movie-importer-bridge/`) | Bridge tests, not a served route |
| `lib/ingestion/` | DMM bulk ingest | `importDmmPayload` |
| `lib/operator/`, `lib/tui/`, `lib/diagnostics/`, `lib/health.js`, `lib/metrics.js`, `lib/trace/` | Read-mostly operator surfaces | TUI uses read endpoints only |

## Failure posture (global)

Fail-closed with typed errors; retry-owned outcomes; `materializeTorrentFile`
returns `{ok:false}` instead of throwing; notifiers are fire-and-forget and
never fail requests; legacy compat paths are fenced from authoritative ones.

## Source references

- `media-search/AGENTS.override.md` (seam map — may be more current than this page)
- `media-search/test/` (217 entries, `*.test.js` under `node:test`)
