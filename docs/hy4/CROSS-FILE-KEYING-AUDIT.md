# Cross-file keying audit — HY4 P3 multi-TorrentFile service

The single largest risk in turning the lab's single-TorrentFile process into a
multi-TorrentFile service is that durable/cache/coalescing state from one
TorrentFile accidentally gets used for another. This audit walks every
shared-state key the service holds and confirms each one is engineered
strongly enough that two different `tf_id` requests cannot alias the same
slot, cache entry, single-flight, breaker, negative cache, or coalescer.

Scope: the audit is **narrow on purpose** per the P3 brief — "inspect only the
state that can accidentally bleed across files. Do not perform a broad
architecture audit." Everything below is a keying observation; nothing in
this document is a style critique.

## Verdict

One genuine keying issue was found and fixed at the narrowest seam: the
Slice 4 cache key was being constructed from the **host-assigned `tf_id`**
routing label rather than the **BitTorrent `info_hash`** S-1 also returns.
The fix is recorded in the §1 exception below. After that fix, every shared
key in the service is file-specific by construction.

Two label gaps (not keying gaps) are recorded honestly in §6: the metrics
counters and the diagnostic decision-log/stage ring are process-wide
aggregates, not per-tfId. These do not cause bleed — there is no key in
their construction that mixes two files — but they mean the `/metrics`
payload cannot be attributed to a specific `tf_id`.

## 1. The one true bleed — and the fix

### What was wrong

`AppState` (in `hy4-data-plane/src/serve.rs`) carried the S-1-projected
`tf_id` and `canonical_path` and `size`. The Slice 4 cache builds a
`TorrentFileId` from those plus the `info_hash` (40-char hex). The lab had
this right because the lab only ever served one file, populated at boot
from a constant. The new `main.rs` was building `AppState` with
`info_hash` left implicit and using `state.tf_id.clone()` in place of it:

```rust
// before the fix
let tf_id = TorrentFileId {
    info_hash: state.tf_id.clone(),  // WRONG: tf_id is a routing label
    canonical_path: state.canonical_path.clone(),
    size,
};
```

The cache then keyed on the host's `tf_id` (a routing/label string of the
shape `tf_<uuid>`) instead of the BitTorrent `info_hash`.

### Why that is a real bleed

- **Same physical torrent, different `tf_id` over time.** If the host ever
  re-imports a torrent (or reassigns a `tf_id` for any reason), the cache
  would treat the new `tf_id` as a *different* file and start cold for
  bytes it already durably holds. No cache miss is fatal, but the cache
  would silently lose its durably-present truth and re-download.

- **Same `tf_id` shape, different physical file.** A host bug that
  recycled a `tf_id` (or a future schema change) would alias two
  physically different files onto the same cache entry. That is the
  classic cache-collision failure mode and is the bleed the audit is
  trying to rule out.

The lab dodged both because the lab had a single, never-changing `tf_id`.
The service must not.

### The fix

`AppState` now carries an explicit `info_hash: String` field sourced from
`ControlTorrentFile::info_hash` (the S-1 projection). The cache key is
constructed from `state.info_hash`, not from `state.tf_id`:

```rust
// after the fix
let tf_id = TorrentFileId {
    info_hash: state.info_hash.clone(),    // S-1-projected, durable
    canonical_path: state.canonical_path.clone(),
    size,
};
```

`state.tf_id` is still kept on `AppState` for the `pool` summary, for
logging, and for routing — but it is no longer used as a cache key
component.

### Why this is the narrowest seam

- One new field on `AppState` (`info_hash: String`).
- One new line in `main.rs::handle_files` (populate it from S-1).
- One new line in `main.rs::handle_metrics` (empty value for the empty
  manager).
- One-line change in `serve.rs::get_file` to read it instead of `tf_id`.

No cache.rs, manager.rs, or capability.rs change. No key format change.
The Slice 4 cache on-disk layout is unchanged. Existing cached bytes
written under the old key remain addressable only by their old key (no
migration is required because the lab had no on-disk cache to migrate).

## 2. Cache keying (`cache.rs`)

`TorrentFileId::cache_key()` is
`{lowercase(info_hash)}__{hash(canonical_path)}__{size}`
(`cache.rs:78-82`). The 16-hex `DefaultHasher` of the canonical path is
collision-resistant for our purposes; equal `(info_hash, size)` with two
different canonical paths is exactly the legitimate "two different
TorrentFile rows that happen to live at the same path in two different
torrents" case, and the audit confirms the path-hash keeps them apart.

`InFlightMap` (`cache.rs:312-323`) is `Mutex<BTreeMap<(String, u64), Arc<ChunkInFlightRecord>>>`,
keyed by `(cache_key, chunk_index)`. Two different `tf_id` requests cannot
coalesce onto the same `InFlight` because the cache key differs.

**Status: file-specific by construction.** No further change.

## 3. CapabilityManager keying (`manager.rs`)

`Slot::sf_key()` (`manager.rs:71-82`) is a 5-tuple:

```
{provider}|{account_scope}|{tf_id}|{provider_resource_id}|{provider_file_id}
```

Every component is file-specific: `tf_id` is the S-1-projected host id,
`provider_resource_id` and `provider_file_id` are the S-1-projected
provider coordinates, `provider` and `account_scope` are the provider
identity S-1 also hands us. The negative cache and the single-flight
`inflight` map inside `CapabilityManager` are both keyed by
`{sf_key}#{idx}` (`manager.rs:197, 263, 371, 543`), so two `tf_id`
requests cannot alias.

`Breaker` is per-`Slot` (`manager.rs:65`), not shared across slots.
A breaker opening for one file does not affect another.

In the new `main.rs`, the `CapabilityManager` itself is constructed per
`tf_id` (cached in `ServiceState.managers` keyed by `tf_id` string) and
never shared between `tf_id` requests. Two concurrent requests for the
same `tf_id` race to insert; the loser is discarded but the
`Arc<CapabilityManager>` is equivalent because both racers were built
from the same S-1 row. That race is wasteful but not unsafe — it cannot
cause identity bleed.

**Status: file-specific by construction.** No further change.

## 4. Cache extent keying

`CacheEngine::plan_chunks` keys every present-extent record and every
chunk-coalescer entry on `tf_id.cache_key()` (see §2). Two different
`tf_id` requests cannot share an extent or a chunk fill because their
cache keys differ.

**Status: file-specific by construction.** No further change.

## 5. Per-request AppState (the new seam)

`AppState` is built **per request** in `main.rs::handle_files` from the
S-1 response. It carries:

- `authoritative_size` (S-1)
- `tf_id` (S-1, for routing)
- `info_hash` (S-1, for cache keying — see §1)
- `canonical_path` (S-1)
- `client` (process-global, stateless, fine to share)
- `metrics` (process-global, see §6)
- `manager` (per-tfId, see §3)
- `cache` (process-global engine, keyed per request — see §2, §4)

There is no `AppState` cache anywhere. Each request gets a fresh
`Arc<AppState>`. The lab had a single process-global `AppState`; the
service deliberately does not.

**Status: file-specific by construction.** No further change.

## 6. Metrics labels and aggregation (`metrics.rs`)

`Metrics` is process-wide, with all counters as `AtomicU64` aggregated
across every request the process has served. There is **no `tf_id` label
on any counter**. This is deliberate — Slice 4.75 was designed for a
single TorrentFile and reports aggregate counts.

In a multi-TorrentFile service this means:

- `requests`, `bytes_streamed`, `cache.full_hits`, `cache.misses`,
  `cache.bytes_local`, `cache.bytes_upstream`, `api_requests`, `cdn_*`,
  `recovery.*`, etc. are **process totals**, not per-tfId totals.
- The `pool` summary is per-tfId because it is computed from
  `CapabilityManager::pool_summary()` which iterates the per-slot
  `sf_key` (see §3) — but `/metrics` calls `pool_summary` on the empty
  manager, so the `/metrics` `pool` is `[]`. Per-tfId pool inspection
  requires a per-tfId metrics endpoint, which is a future slice.
- `cache_decisions` and `stages_recent` are process-wide bounded rings
  (256 and 64 entries respectively) without a `tf_id` field on each
  entry. A request for `tf_id=A` can sit adjacent in the ring to a
  request for `tf_id=B` and the `/metrics` consumer cannot tell which
  decision belonged to which file.

**This is a label gap, not a keying gap.** The decision log and stage
ring do not key anything — they are read-only diagnostic telemetry.
Nothing in the cache, manager, or capability layer depends on them, so
their lack of per-tfId labels cannot cause bleed.

**Status: recorded as a known label gap.** Not fixed in this tranche —
the brief is "narrow seam, do not redesign for style." A future slice
should add a `tf_id` field to `CacheDecision` and `StageReport` and
either fork the rings per-tfId or accept the diagnostic ambiguity
explicitly.

## 7. Items the brief asked about, in order

- **Cache keys** — `TorrentFileId::cache_key()` keyed on
  `{info_hash, canonical_path, size}`. File-specific. Fixed in §1 to
  use the real `info_hash` rather than the routing `tf_id`.
- **Capability-manager keys** — `Slot::sf_key` 5-tuple. File-specific.
  Per-`tf_id` manager in the new service.
- **Single-flight keys** — `BTreeMap<(cache_key, chunk_index)>` and
  `HashMap<{sf_key}#{idx}>`. File-specific.
- **Breaker / limiter ownership** — `Breaker` is per-`Slot` (inside the
  `Slot` struct, not shared). `maxInFlight=1` semaphore is per
  capability, which is per-slot, which is per-`tf_id`. No process-global
  limiter remains.
- **Negative cache keys** — `HashMap<{sf_key}#{idx}, NegEntry>`. File-specific.
- **Metrics labels/aggregation** — process-wide. Label gap recorded in §6.

## 8. What this audit does not cover

- **VFS, legacy provider paths, south cutover, fallback rewiring.** The
  P3 brief says do not touch VFS, do not delete legacy south, do not
  rewire fallbacks. None of those layers were inspected.
- **The on-disk cache format.** `format_version = 2` and the fixed grid
  are unchanged from Slice 4.75 and were proven byte-correct by the
  Slice 4.75 closure.
- **The host SQLite schema.** North owns it; Rust reads only what S-1
  projects. The path-namespace invariant is documented separately
  in `S1-CONTROL-CONTRACT.md`.
- **The full historical proof suite.** Out of scope for this tranche.

## 9. Files changed by this audit

- `hy4-data-plane/src/serve.rs` — added `info_hash: String` to
  `AppState`; `get_file` uses `state.info_hash` (not `state.tf_id`) for
  the cache key.
- `hy4-data-plane/src/main.rs` — `handle_files` populates
  `info_hash` from S-1; `handle_metrics` uses an empty value.
- This document.

No other file was changed. The lab, the donor, the host, and the
control-plane store are untouched.
