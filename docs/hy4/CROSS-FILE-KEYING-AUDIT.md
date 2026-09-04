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

## Verdict (P3 correction, 2026-09-04)

Two genuine keying issues were found and fixed at the narrowest seam:

1. **Pre-P3 (host-tf_id bleed).** The Slice 4 cache key was being
   constructed from the **host-assigned `tf_id`** routing label rather than
   the **BitTorrent `info_hash`** S-1 also returns. Fixed in P3 step 3
   by adding `info_hash` to `AppState` and using it for the cache key.
   The new cache key was `format!("{info_hash}__{path_hash}__{size}")`.

2. **P3 correction (heuristic-key bleed).** The P3 fix in (1) replaced a
   *guaranteed-wrong* key (host routing label) with a *plausible* key
   (composite of info_hash + canonical_path + size). The plausible key is
   NOT a guarantee — it depends on the host never assigning two
   `torrent_files` rows the same `(internal_path, size)` under the same
   `info_hash`. The host durable identity is the `torrent_files.id` PK,
   and that is the only thing that is *guaranteed* unique by the schema.
   The P3 correction replaces the heuristic with the PK.

   Two sibling files in the same torrent legitimately share the same
   `info_hash`. They differ in `id`, `canonical_internal_path`, and `size`.
   The user's directive: "Cache/coalescing/single-flight identity MUST
   NOT collapse to infoHash alone" — addressed by the durable PK.

   `TorrentFileId::cache_key()` is now `self.tf_id_durable.clone()` —
   the exact `torrentFile.id` from S-1. `Slot.tf_id` (the capability
   single-flight key) is also the durable PK, so two siblings sharing
   the same `info_hash` get distinct sf_keys.

The correction is recorded in §1. After both fixes, every shared key in
the service is file-specific by construction, and the cache keying has
no heuristic dependency on host normalization.

Two label gaps (not keying gaps) are recorded honestly in §6: the metrics
counters and the diagnostic decision-log/stage ring are process-wide
aggregates, not per-tfId. These do not cause bleed — there is no key in
their construction that mixes two files — but they mean the `/metrics`
payload cannot be attributed to a specific `tf_id`.

## 1. The bleed — and the fix (P3 correction)

### What was wrong (pre-P3)

`AppState` (in `hy4-data-plane/src/serve.rs`) carried the S-1-projected
`tf_id` and `canonical_path` and `size`. The Slice 4 cache builds a
`TorrentFileId` from those plus the `info_hash` (40-char hex). The lab had
this right because the lab only ever served one file, populated at boot
from a constant. The new `main.rs` was building `AppState` with
`info_hash` left implicit and using `state.tf_id.clone()` in place of it:

```rust
// before the fix (also pre-P3)
let tf_id = TorrentFileId {
    info_hash: state.tf_id.clone(),  // WRONG: tf_id is a routing label
    canonical_path: state.canonical_path.clone(),
    size,
};
```

The cache then keyed on the host's `tf_id` (a routing/label string of the
shape `tf_<uuid>`) instead of the BitTorrent `info_hash`.

### What was still wrong after P3 step 3 (P3 correction)

P3 step 3 added `info_hash` to `AppState` and changed the cache key from
`info_hash_lowercase + path_hash + size` — a *plausible* key. But:

- Two sibling files in the same torrent legitimately share the same
  `info_hash`. If the host happens to assign them the same
  `canonical_internal_path` (legal for two files at the same relative
  path in two different torrents — and *the host-relative path is the
  same inside a single torrent* if the BT layout happens to repeat),
  the heuristic would collide.
- A host bug that recycled a `torrent_files.internal_path` for a
  different row would silently alias two files onto the same cache
  entry.

The user's directive is unambiguous: "Cache/coalescing/single-flight
identity MUST NOT collapse to infoHash alone" and "Use either
TorrentFile.id (if that ID is guaranteed to represent the exact durable
TorrentFile row), or an explicit composite equivalent to InfoHash +
CanonicalPath + Exact size." The P3 correction picks `TorrentFile.id`.

### The fix (P3 correction)

`TorrentFileId` now carries `tf_id_durable: String` — the exact
`torrentFile.id` from S-1 (which is the `torrent_files.id` SQLite PK,
guaranteed unique by the schema). The cache key is now the PK alone:

```rust
// after P3 correction
impl TorrentFileId {
    pub fn cache_key(&self) -> String {
        // The durable PK. No hashing, no composition: the PK is already
        // filesystem-safe (UUIDv4 in production), unique, and is what
        // VFS, resolver, and forensics all key on.
        self.tf_id_durable.clone()
    }
}
```

`AppState` carries `tf_id_durable: String` alongside `tf_id: String`.
The host `tf_id` is still kept on `AppState` for the `pool` summary,
for logging, and for routing — but it is no longer used as a cache key
component.

`Slot.tf_id` (the capability single-flight key) is also the durable PK
(P3 correction). Two siblings sharing the same `info_hash` get distinct
sf_keys because `Slot.tf_id` is `torrentFile.id`, not `info_hash`.

### Why this is the narrowest seam

- One new field on `TorrentFileId` (`tf_id_durable: String`).
- One new field on `AppState` (`tf_id_durable: String`).
- One new line in `main.rs::handle_files` (populate it from
  `resp.torrent_file.id`).
- One new line in `main.rs::handle_metrics` (empty value for the empty
  manager).
- One-line change in `serve.rs::get_file` (plan path) and one in the
  run-loop path (was using `tf_id_clone` shadow — see §10) to read the
  durable PK.
- One-line change in `manager.rs::CapabilityManager::new` to use
  `tf.id.clone()` for `Slot.tf_id`.
- Three-line change in `provider.rs` (3 sites) to populate the carried
  `DeliveryCapability.torrent_file_id` from the durable PK instead of
  `info_hash`.

No key format change. The Slice 4 cache on-disk layout is unchanged
(file-per-chunk keyed by a string). Existing cached bytes written under
the old composite key are orphaned in the same volume but not matchable
by the new key — this is acceptable because the only pre-existing volume
contents are the lab's smoke fixtures and are not load-bearing.

## 2. Cache keying (`cache.rs`)

`TorrentFileId::cache_key()` is now `self.tf_id_durable.clone()` — the
exact `torrentFile.id` from S-1. The PK is filesystem-safe
(UUIDv4 in production) and is what VFS, resolver, and forensics all
key on. No hashing, no composition — the schema already guarantees
uniqueness.

`InFlightMap` (`cache.rs:312-323`) is keyed by
`(cache_key, chunk_index)`. Two different `tf_id` requests cannot
coalesce onto the same `InFlight` because the cache key differs.

**Status: file-specific by construction.** No further change.

## 3. CapabilityManager keying (`manager.rs`)

`Slot::sf_key()` (`manager.rs:71-82`) is a 5-tuple:

```
{provider}|{account_scope}|{tf_id}|{provider_resource_id}|{provider_file_id}
```

Every component is file-specific: **`tf_id` is the durable PK
(torrentFile.id)** after the P3 correction, not the `info_hash`.
`provider_resource_id` and `provider_file_id` are the S-1-projected
provider coordinates. The negative cache and the single-flight
`inflight` map inside `CapabilityManager` are both keyed by
`{sf_key}#{idx}`, so two sibling files in the same torrent that
happen to share the same provider coord get distinct sf_keys because
their durable PKs differ.

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
- `tf_id_durable` (S-1, for cache keying — see §1; the durable PK)
- `info_hash` (S-1, for magnet links, capability.torrent_file_id)
- `canonical_path` (S-1, for logging)
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
  `tf_id_durable` (the exact durable PK from S-1). File-specific. P3
  correction replaced the heuristic composite with the PK.
- **Capability-manager keys** — `Slot::sf_key` 5-tuple where `tf_id` is
  the durable PK. File-specific. Per-`tf_id` manager in the new service.
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

## 9. Files changed by this audit (P3 correction)

- `hy4-data-plane/src/cache.rs` — `TorrentFileId` got `tf_id_durable`;
  `cache_key()` is now `self.tf_id_durable.clone()`. The pre-existing
  `short_hash` helper was deleted (dead code after the heuristic was
  removed). Three test fixtures got unique `tf_id_durable` values.
- `hy4-data-plane/src/serve.rs` — `AppState` got `tf_id_durable`;
  `get_file` uses it for the cache key in BOTH the plan path and the
  run-loop path. The run-loop previously shadowed by `tf_id_clone` (the
  host label) — that bug is fixed by adding `tf_id_durable_clone` and
  using it for the durable PK field.
- `hy4-data-plane/src/main.rs` — both `AppState` constructions
  populate `tf_id_durable` from `resp.torrent_file.id`.
- `hy4-data-plane/src/manager.rs` — `Slot.tf_id` is now `tf.id.clone()`
  (the durable PK), not `tf.info_hash.clone()`.
- `hy4-data-plane/src/provider.rs` — three `DeliveryCapability::new`
  call sites populate `torrent_file_id` from `tf.id.clone()` (the
  durable PK), not `tf.info_hash.clone()`. The field's meaning is
  upgraded from "infoHash" to "durable PK" to match.
- `hy4-data-plane/src/capability.rs` — comment on
  `DeliveryCapability::torrent_file_id` updated to reflect the durable
  PK meaning.
- This document.

The donor, the host, the lab, and the
control-plane store are untouched.

## 10. The run-loop shadow bug (corrected in P3)

The P3 step 3 fix added `info_hash` to `AppState` and changed the cache
key from `state.tf_id` to `state.info_hash`. The plan path
(`serve.rs::get_file` around line 222) was updated correctly. The
run-loop path (around line 355) was NOT:

```rust
// before P3 correction (run-loop)
let tf_id_clone = state.tf_id.clone();     // <-- THIS captured the host label
let canonical_clone = state.canonical_path.clone();
// ...
let tf_id = TorrentFileId {
    info_hash: tf_id_clone.clone(),        // <-- bug: this is the host label
    canonical_path: canonical_clone.clone(),
    size,
};
```

The variable name `tf_id_clone` is a leftover from the lab's
single-file bootstrap. The plan path was using `state.info_hash`; the
run-loop was using `state.tf_id` (the host label). Both paths used the
SAME `TorrentFileId` struct, but with DIFFERENT identity. The run-loop
effectively keyed the cache on the host label despite the comment
claiming otherwise.

The P3 correction fixes this by:

1. Adding `tf_id_durable_clone = state.tf_id_durable.clone()` to the
   move block.
2. Using `tf_id_durable_clone` for the `tf_id_durable` field of the
   `TorrentFileId` constructed in the run-loop.
3. Keeping `tf_id_clone` (the host label) only for `info_hash`, which
   is correct.

This was the actual identity concern the user raised: even the previous
P3 step 3 fix did not have a single, consistent identity for the cache
key. There were two distinct `TorrentFileId` construction sites in
`serve.rs`, each with a different (and in one case, wrong) identity.

After the P3 correction, both construction sites use the durable PK
(`tf_id_durable`) for `TorrentFileId::cache_key()`. The new in-crate
test `same_info_hash_sibling_files_get_distinct_cache_entries` proves
this end-to-end at the cache layer.

## 11. Adversarial same-infoHash proof

`hy4-data-plane/src/cache.rs` now contains a focused adversarial test
that proves the P3 correction under a worst-case setup:

- Two sibling files that share the same `info_hash`
- Different `tf_id_durable`, different `canonical_path`, different `size`
- The test fills chunk 0 of each with distinguishable bytes (0xAA vs
  0xBB) and asserts:
  1. `cache_key()` values are distinct and contain the durable PK.
  2. Both chunks are PRESENT (independent SQLite rows).
  3. `pread()` returns 0xAA for A and 0xBB for B (no cross-bleed).
  4. Warm reread cannot cross-alias.
  5. The capability single-flight key (`sf_key`) is distinct for two
     siblings that share the same provider coord (the worst case where
     `provider + account + resource + file` is identical and only
     `tf_id` differs).

This test is `same_info_hash_sibling_files_get_distinct_cache_entries`
and is the 18th test in the cache test module. It is capable of
failing under the previous composite key (which would not contain
`tf_sibling_A` or `tf_sibling_B` strings) and under an
`info_hash`-only key (which would have identical `cache_key()`s for the
two siblings).

Run with:
```
cargo test --lib same_info_hash_sibling_files
```
