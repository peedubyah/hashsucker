# HashSucker current execution handoff

This is the single active handoff for the next coding agent. Use
[`../docs/architecture.md`](../docs/architecture.md) for durable architecture,
[`../docs/PRODUCTION-STATE-2026-09-11.md`](../docs/PRODUCTION-STATE-2026-09-11.md)
for the current verified checkpoint, and [`../docs/ROADMAP.md`](../docs/ROADMAP.md)
for shipping phases. Other files in `handoff/` are historical evidence.

## Current product state

HashSucker's authoritative VFS path is operational: Node selects durable truth
and a TorrentFile, while Rust serves and recovers its bytes. Provider lifecycle,
cancellation/reclaim, restart/reacquisition, exact bytes, and playback-shaped
abuse have completed their correctness phase. The scheduler and coalescer are in
production code, but experimental two-lane gates remain default OFF.

### Complete

- Node/Rust ownership and the S-1 per-TorrentFile control boundary.
- Fixed-grid caching, per-chunk single-flight coalescing, and adjacent missing
  chunk collapse.
- Capability permit ownership, logical-child lifetime, cancellation teardown,
  failed-fill reclaim, dead-cap replacement boundaries, stale-slot refresh,
  lease reentry, and one-owner failed-chunk retry.
- Scheduler observability baseline and audited metric semantics.

### Proven live

- TorBox and Real-Debrid independently delivered exact HTTP Ranges, survived
  seeks and client cancellation/reopen, and reacquired runtime capabilities
  after data-plane restart without an API/acquisition storm.
- Playback-shaped sequential, overlapping, seek, cancel/reopen, hot/cold, and
  restart workloads completed for both providers.
- The same exact Range of the same TorrentFile was byte-identical across TorBox
  and Real-Debrid.
- A cold overlapping TorBox probe joined an in-flight chunk instead of issuing a
  duplicate fill.
- Distinct-cap two-lane execution ran against real provider bytes in an isolated
  production-code stack. It was not shared-cap execution or the deployed stack.

### Structurally or deterministically proven, not live shipping proof

- One shared capability lease owns one provider permit for at most two logical
  child readers and releases it only after the final child ends.
- Shared-cap cancellation, dead-cap admission boundaries, reclaim, fresh-cap
  acquisition, and exactly-one retry ownership are covered by deterministic
  mock-CDN tests.
- Fixed shared-cap splitting and shared-cap work stealing are implemented and
  gated, but their production benefit has not been established.

## Phase A closed — outcome A3 (2026-09-12)

LongCat's single-lane versus fixed shared-cap A/B (work stealing OFF) is
complete. Outcome: **A3 — no demonstrated production use-case justifies
enabling shared-cap two-lane execution.**

- The gated two-lane mechanism is functional and its activation conditions are
  understood.
- Ordinary sequential cold playback did not naturally activate it (OFF and ON
  arms both recorded zero two-lane activations; do not read that table as proof
  that activated two-lane is slower).
- Concurrent-reader pressure already obtains parallelism through normal
  capability-pool growth (`first_alive_busy`).
- No unique shipping benefit was demonstrated.

Shared-cap two-lane stays default OFF. Do not tune it further unless a concrete
production workload exposes a gap it uniquely solves. The A/B scripts and
artifacts remain untracked work in progress: do not modify, stage, or commit
them.

## Frozen architectural boundaries

### Ownership

- **Node owns durable truth:** Release, TorrentFile, ProviderPlacement,
  ProviderFile, binding/publication/VFS semantics, discovery/ranking, persisted
  candidates, and selection of another TorrentFile or Release.
- **Rust owns execution and byte motion:** DeliveryCapability lifecycle,
  TorBox/Real-Debrid Range delivery, retry and `Retry-After`, limiter/breaker,
  same-TorrentFile provider recovery, cache, coalescing, and scheduling.
- Rust may switch providers only for the same exact TorrentFile. Only Node may
  select a persisted alternate TorrentFile or Release, and only after the
  authoritative VFS path receives classified provider exhaustion.

### Identity and relationships

| Entity | Durable meaning |
|---|---|
| Release | `infoHash` |
| Discovery `releaseKey` | `(infoHash, fileIndex)`, with null rendered as `torrent`; discovery/ranking key, not Release identity |
| TorrentFile | row identity `(infoHash, canonicalInternalPath)` with immutable positive size; Rust cache/coalescing key also includes size |
| `torrent_files.id` | routing UUID and forensic label only |
| ProviderPlacement | key `(provider, accountScope, providerResourceId)`; `infoHash` is immutable for that key |
| ProviderFile | current file observation keyed within a placement; maps to a TorrentFile when authoritative |
| MediaBinding | library item/path to release, placement, ProviderFile, and read-only exposure; reaches TorrentFile through ProviderFile on the authoritative path and does not choose runtime provider execution |
| DeliveryCapability | private Rust runtime state containing an ephemeral signed URL; never persisted or used as identity |

For one TorrentFile, the same exact byte Range must be identical regardless of
TorBox or Real-Debrid execution.

## Production topology and byte paths

| Component | Boundary |
|---|---|
| `edge` | public `:8080`; transparent reverse proxy |
| `media-search` | host-loopback `:3000`; Node API, durable truth, selection, VFS/WebDAV namespace |
| `data-plane` | internal `:3001`; `GET /files/:tfId`, prewarm, metrics, and provider byte execution |
| `torbox-importer` | no listener; filesystem-queue physical acquisition and Arr import |

Authoritative byte path:

```text
Plex/rclone WebDAV client
→ edge when used
→ Node /vfs selects a durable TorrentFile
→ Rust /files/:tfId receives the client Range
→ Rust fetches Node's /api/data-plane/files/:tfId projection
→ Rust serves cache or provider bytes and performs same-TorrentFile recovery
→ Node/edge stream the response to the client
```

The Node `/stream/:type/:id` provider redirect and mounted
`/media/:infoHash/:fileIndex` proxy remain compatibility paths. They are not the
authoritative modern TorrentFile byte path. No non-exhaustion Rust failure may
silently fall through to a legacy Node byte path.

## Scheduler state

- Fixed cache grid: 8 MiB current default. Do not change it without production
  evidence.
- Maximum scheduler topology: two active lanes per scheduled missing run, not
  two clients or capabilities process-wide.
- Coalescing gives each missing chunk one owner; overlapping readers join the
  in-flight record.
- Distinct-cap execution uses two independently reserved warm capabilities for
  the same TorrentFile.
- Shared-cap execution uses one capability lease and permit for two logical
  child readers. It is concurrency, not provider redundancy.
- `DATA_PLANE_ACTIVE_ACTIVE_TWO_SPAN`, `DATA_PLANE_ACTIVE_ACTIVE_AUTO`,
  `DATA_PLANE_ACTIVE_ACTIVE_SHARED_CAP`, and
  `DATA_PLANE_ACTIVE_ACTIVE_STEAL` are experimental and default OFF;
  `DATA_PLANE_ACTIVE_ACTIVE_MIN_CHUNKS` defaults to 4. Cross-provider warm
  standby (`DATA_PLANE_CROSS_PROVIDER_STANDBY`) is separately default OFF. Work
  stealing is a separate shipping question.
- Fixed shared-cap selection requires `SHARED_CAP`, an existing primary
  reservation, and at least two missing chunks, plus two-lane engagement via
  explicit `TWO_SPAN` or qualifying AUTO — no second warm standby is required.
  A genuine second warm capability still takes the distinct-cap path first.
  Shared-cap stays default OFF; A3 remains the shipping disposition.

### Metric limits that affect the A/B

- `scheduler_lane_a_chunks` and `scheduler_lane_b_chunks` record shared-cap
  lane assignment on both the fixed-half path and the coordinator/work-stealing
  path. `scheduler_work_steals` is incremented only by the coordinator worker.
  Neither lane counter covers distinct-cap execution.
- `inflight_joiners` counts per-chunk join events, not unique clients.
- Metrics are process-lifetime cumulative counters. Use bounded before/after
  deltas and a known cache state.
- Cache hits and the hot/cold mix can dominate process-wide amplification
  ratios. Control cache state for cold A/B comparisons.

## Known traps

- Zero lane counters rule out shared-cap lane assignment but not distinct-cap
  two-lane execution; confirm the actual branch with fetch-span/cache-decision
  and CDN attempt evidence.
- Shared-cap lanes share a provider capability and failure domain. They are not
  provider redundancy.
- Never explain different bytes as a provider variation for the same
  TorrentFile; that is an identity violation.
- Do not reopen completed lifecycle hardening without a concrete production
  defect.
- Do not change the 8 MiB grid from synthetic or small-range amplification
  alone.
- Do not combine work stealing with the first shared-cap decision; it destroys
  attribution.
- Do not use historical HY4 handoffs as the active roadmap. HY4 names remain
  only where source still accepts them as compatibility environment variables.

## Immediate next action

Phase A is closed (A3). Use the provider-by-provider graduation matrix in
[`../docs/GRADUATION-MATRIX.md`](../docs/GRADUATION-MATRIX.md) as the Phase C
exit bar. Run only a bounded canary the matrix names as a true blocker;
otherwise proceed to the Phase B evidence pass for the next production
bottleneck. Do not reopen lifecycle hardening or shared-cap scheduler work
without a concrete defect.
