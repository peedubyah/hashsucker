# Stage 9 — Rust Data-Plane Execution

`data-plane/src/`: axum binary. No SQLite reads, no discovery, no
ranking, no TorrentFile substitution, no durable-identity mutation —
enforced in code comments (`lib.rs`, `control.rs`, `manager.rs`) and by
error semantics (`S1_FETCH_FAILED`: never try unrelated candidates;
`PROVIDER_EXHAUSTED`: the sole fallback-eligible error).

## Endpoints (`main.rs`)

| Endpoint | Behavior |
|---|---|
| `GET /files/:tfId` | Fetch S-1 per request; verified `local` coord → 206 local file; else per-TF `CapabilityManager` → `get_file`. 206 (+`Content-Range`, serving headers iff provider used), 416 (`Content-Range: bytes */size`), 502 `PROVIDER_EXHAUSTED` (fallback-eligible) / `S1_FETCH_FAILED` (not eligible), 503+`Retry-After` |
| `POST /files/:tfId/prewarm` | `{provider, providerResourceId[, providerFileId, accountScope]}` → `already_warm/warmed/in_flight/unavailable/invalid/failed` |
| `GET /metrics` | Counters, cache, stages, pool, attribution |

S-1 (`control.rs`): `GET {CONTROL_URL}/data-plane/files/{tfId}`,
`schema_version` must be 1; rejects 404, empty coords, bad local.

## Ranges, cache grid, coalescing

- `parse_range`: `bytes=s-e/s-` only; rejects lists, suffixes,
  out-of-bounds → 416. Single-byte `N-N` fetches `[N,N+1]` upstream,
  delivers 1, bypasses cache.
- Fixed grid: 8 MiB chunks (`CACHE_FORMAT_VERSION=2`),
  `cache/<sha256>/<idx>.chunk` + `chunks.sqlite` (WAL, fsync before
  publish, `INSERT OR IGNORE` anti-double-charge, LRU evict coldest,
  skips in-flight). Survives restart (complete chunks only; `.tmp`
  discarded); format/grid change resets the store.
- Coalescing: `InFlightMap::join_or_claim_many` on
  `(physical_cache_key, chunk_idx)`; owner fills, waiters notified;
  single-byte path never coalesces.

## Capability, CDN, retry, breaker

- Acquire: fast-path usable+free → pressure-grow 1→2 → single-flight
  resolve (2s neg-cache on hard failures only) → block on first waitable
  (throttled sleeps to `throttle_until` reusing the SAME URL; busy waits
  on permit). Failover across S-1 slots; `AllSameTfFailed` iff all
  exhausted — same TorrentFile throughout.
- TorBox acquire: `GET .../torrents/requestdl?token&torrent_id&file_id`
  (provider IDs from S-1, never invented), parse `data` as CDN URL,
  reject `*.torbox.app` hosts, TTL 600s. RD MODE-A: verify
  `rd_info_checked` hash, exact path+size match, `/unrestrict/link`,
  TTL 3600s.
- Retry: 429/5xx/transport → throttle (`Retry-After` numeric seconds,
  else 30s) + retry same cap ≤3; headerless timeout → zero-cooldown
  retry; 401/403/404/410 → mark dead + one reacquire; 416 fatal.
  Reactive cross-provider failover lane (different provider, same
  durable key, warm-first, ≤1/read) precedes sleeps.
- Breaker per `(provider, scope)`: threshold 3, 30s cooldown, half-open;
  per-capability `Semaphore(1)`.
- Split fill: serve span (window+suffix, streamed) then optional staged
  prefix backfill; suppressed under provider pressure (60s throttle-age
  window) or when the consumer is gone; serve span always runs.

## Prewarm, local route, lanes, hedges

- Prewarm is warm-only: no pool growth, no bytes, no permits.
- Local route: verified permanent path only (canonicalize under
  `LOCAL_ROOT`, regular file, `len == size`).
- Throughput estimator + 2-low-observations policy arms hedge/promotion;
  two-lane fill, work stealing, lane retirement/replacement, hedged
  requests, shared-cap leases: all same-exact-TF, warm-only, zero cold
  acquisition, mostly env-gated (`DATA_PLANE_*`; hedge OFF by default).
- Playback intelligence: sequential-detect + bounded prefetch
  (`PREFETCH_ENABLED` kill-switch), failures contained, never picks
  another release.

## Restart semantics

Survives: chunk objects + sqlite rows + LRU order. Does NOT survive:
in-flight map, capability pools/permits/limiters/breakers, managers map,
metrics, lane state, prefetch state. Boot starts at zero TorrentFiles;
managers rebuild from fresh S-1 per request.

## Source references

- `data-plane/src/{main,lib,serve,cache,capability,manager,provider,
  transport,control,metrics,prewarm*.rs,local_route.rs,
  torrent_file_identity.rs,range_hedge.rs,throughput*.rs}`
