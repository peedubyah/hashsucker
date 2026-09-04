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

## Verdict (P3 correction + P3 final identity check, 2026-09-04)

Three genuine keying issues were found and fixed at the narrowest seam:

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

   `TorrentFileId::cache_key()` is now a deterministic representation of
   the durable tuple (info_hash + canonical_path + size). `Slot.sf_key()`
   is keyed on the same deterministic tuple. The current host PK
   `torrent_files.id` is retained on `TorrentFileId.tf_id_durable` for
   logging and forensics, but is **not** the cache key.

3. **P3 final identity check (durability audit).** The P3 correction in
   (2) chose `torrent_files.id` as the cache key on the assumption that
   this PK is durable across reconstruction. A final identity audit of
   the real host schema and lifecycle paths proved otherwise: `id` is a
   `tf_<randomUUID()>` minted at first insert (`store.js:923`) and is
   reused only if a row for the tuple is already present in the same DB
   instance. Any DB reconstruction, import, merge, repair that wipes the
   row, or different inventory-observation run can mint a new PK for the
   same logical TorrentFile. There is no `UPDATE torrent_files` and no
   `DELETE FROM torrent_files` anywhere in the repo. The PK is a
   **surrogate**, not durable. The cache key therefore cannot be the PK.
   The corrected key is a deterministic representation of the durable
   tuple that the schema itself declares (store.js:97-110):
   `info_hash + canonical_path + size`. See §11 for the durability
   audit and §12 for the corrected key.

After all three fixes, every shared key in the service is file-specific
by construction, and the cache keying has no heuristic dependency on
host normalization and no dependency on the (non-durable) host PK.

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
unique by the schema). After the P3 final identity check (§11), the
cache key is NOT the PK; it is a deterministic representation of the
durable tuple `(info_hash, canonical_path, size)` that the schema
itself declares as the identity grain. The PK is retained for logging
and forensics:

```rust
// after P3 correction + P3 final identity check
impl TorrentFileId {
    pub fn new(tf_id_durable: String, info_hash: String,
               canonical_path: String, size: u64) -> Self {
        let durable_key = Self::compute_durable_key(
            &info_hash, &canonical_path, size);
        Self { tf_id_durable, info_hash, canonical_path, size, durable_key }
    }
    pub fn cache_key(&self) -> String {
        // The deterministic tuple key. NOT the host PK — the PK is
        // a SQLite surrogate that can change across reconstruction.
        // The tuple key is invariant under any host DB change.
        self.durable_key.clone()
    }
    pub fn compute_durable_key(info_hash: &str, canonical_path: &str,
                               size: u64) -> String {
        format!("tfkv\x1f{}\x1f{}\x1f{}", info_hash, size, canonical_path)
    }
}
```

`AppState` carries `tf_id_durable: String` alongside `tf_id: String`.
The host `tf_id` is still kept on `AppState` for the `pool` summary,
for logging, and for routing — but it is no longer used as a cache key
component.

`Slot.durable_key` (the capability single-flight key) is the
deterministic tuple `(info_hash, canonical_path, size)`. Two siblings
sharing the same `info_hash` get distinct sf_keys because their
`canonical_path` differs. The sf_key is invariant under any host DB
reconstruction that changes the surrogate PK.

### Why this is the narrowest seam

- One new struct on `TorrentFileId` (`info_hash`, `canonical_path`,
  `size`, `durable_key` fields + `::new()` constructor +
  `compute_durable_key()` static method).
- One new field on `AppState` (`tf_id_durable: String`, retained for
  logging).
- One new line in `main.rs::handle_files` (populate it from
  `resp.torrent_file.id`).
- One new line in `main.rs::handle_metrics` (empty value for the empty
  manager).
- One-line change in `serve.rs::get_file` (plan path) and one in the
  run-loop path (was using `tf_id_clone` shadow — see §10) to construct
  via `::new()`.
- One new field on `Slot` (`durable_key: String`); one-line change in
  `Slot::sf_key()` to use it; one-line change in
  `CapabilityManager::new` to compute it.
- Three-line change in `provider.rs` (3 sites): only comments updated
  (the value passed is `tf.id.clone()` — informational, not a key).

No new crate dependencies. `sha2` / `hex` not used: the literal
`\x1f`-delimited tuple format is collision-free without hashing. The
Slice 4 cache on-disk layout is unchanged (file-per-chunk keyed by a
string). Existing cached bytes written under any of the previous keys
(PK-as-key, or the pre-P3 heuristic composite) are orphaned in the
same volume but not matchable by the new key — this is acceptable
because the only pre-existing volume contents are the lab's smoke
fixtures and are not load-bearing.

## 2. Cache keying (`cache.rs`)

`TorrentFileId::cache_key()` is now a deterministic representation of
the durable tuple `(info_hash, canonical_path, size)`. The format is
`tfkv\x1f<info_hash>\x1f<size_decimal>\x1f<canonical_path>` where
`\x1f` is the ASCII Unit Separator. This is **not** the host PK
(`torrent_files.id`); it is derived only from the three fields the
schema itself declares as the identity grain (see §11 and §12).

The current host PK is still carried on `TorrentFileId.tf_id_durable`
for logging, forensics, and downstream messaging — but it is NOT the
cache key and MUST NOT be used to namespace any persistent on-disk
state (cache files, single-flight, negative cache, breaker, extent
records, chunk-coalescer entries).

`InFlightMap` (`cache.rs:312-323`) is keyed by
`(cache_key, chunk_index)`. Two different `tf_id` requests cannot
coalesce onto the same `InFlight` because the cache key differs.

**Status: file-specific by construction. The cache key is also
invariant under any host DB reconstruction that changes the surrogate
PK** — see §11 for the proof and §12 for the key derivation.

## 3. CapabilityManager keying (`manager.rs`)

`Slot::sf_key()` (`manager.rs:71-82`) is a 5-tuple:

```
{provider}|{account_scope}|{durable_key}|{provider_resource_id}|{provider_file_id}
```

Every component is file-specific: **`durable_key` is the
deterministic tuple key** `(info_hash, canonical_path, size)` after
the P3 final identity check, not the host PK `torrent_files.id`.
`provider_resource_id` and `provider_file_id` are the S-1-projected
provider coordinates. The negative cache and the single-flight
`inflight` map inside `CapabilityManager` are both keyed by
`{sf_key}#{idx}`, so two sibling files in the same torrent that
happen to share the same provider coord get distinct sf_keys because
their `(info_hash, canonical_path, size)` tuples differ. The capability
sf_key is also **invariant under any host DB reconstruction that
changes the surrogate PK** — see §11.

**Status: file-specific by construction. The sf_key is also invariant
under PK change** — see §11 and §12.

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
- `tf_id_durable` (S-1, current host PK, **informational only** — NOT a
  cache key; see §11, §12)
- `info_hash` (S-1, for magnet links, capability.torrent_file_id, and as
  one component of the durable_key)
- `canonical_path` (S-1, for logging and as one component of the
  durable_key)
- `client` (process-global, stateless, fine to share)
- `metrics` (process-global, see §6)
- `manager` (per-tfId, see §3)
- `cache` (process-global engine, keyed per request — see §2, §4)

There is no `AppState` cache anywhere. Each request gets a fresh
`Arc<AppState>`. The lab had a single process-global `AppState`; the
service deliberately does not.

**Status: file-specific by construction.** Note: `AppState.tf_id_durable`
is the **current host PK string** as projected by S-1. After the P3
final identity check (§11) the field's meaning is "informational"; the
durable on-disk namespace uses the deterministic tuple key derived
from `info_hash + canonical_path + authoritative_size`.

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

- **Cache keys** — `TorrentFileId::cache_key()` is the deterministic
  tuple `tfkv\x1f<info_hash>\x1f<size>\x1f<canonical_path>`. File-specific.
  P3 correction replaced the heuristic composite with the host PK; the
  P3 final identity check replaced the host PK with the deterministic
  tuple (because the PK is a surrogate, not durable — see §11, §12).
- **Capability-manager keys** — `Slot::sf_key` 5-tuple where the
  `tf_id` slot is the deterministic durable_key (the same tuple).
  File-specific and invariant under any host DB reconstruction that
  changes the surrogate PK. Per-`tf_id` manager in the new service.
- **Single-flight keys** — `BTreeMap<(cache_key, chunk_index)>` and
  `HashMap<{sf_key}#{idx}>`. File-specific and PK-invariant.
- **Breaker / limiter ownership** — `Breaker` is per-`Slot` (inside the
  `Slot` struct, not shared). `maxInFlight=1` semaphore is per
  capability, which is per-slot, which is per durable_key. No
  process-global limiter remains.
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

## 9. Files changed by this audit (P3 correction + P3 final identity check)

### P3 correction (PK-as-key)

- `hy4-data-plane/src/cache.rs` — `TorrentFileId` got `tf_id_durable`;
  `cache_key()` was `self.tf_id_durable.clone()`. The pre-existing
  `short_hash` helper was deleted (dead code after the heuristic was
  removed). Three test fixtures got unique `tf_id_durable` values.
- `hy4-data-plane/src/serve.rs` — `AppState` got `tf_id_durable`;
  `get_file` used it for the cache key in BOTH the plan path and the
  run-loop path. The run-loop previously shadowed by `tf_id_clone` (the
  host label) — that bug was fixed by adding `tf_id_durable_clone` and
  using it for the durable PK field.
- `hy4-data-plane/src/main.rs` — both `AppState` constructions
  populated `tf_id_durable` from `resp.torrent_file.id`.
- `hy4-data-plane/src/manager.rs` — `Slot.tf_id` was `tf.id.clone()`
  (the host PK), not `tf.info_hash.clone()`.
- `hy4-data-plane/src/provider.rs` — three `DeliveryCapability::new`
  call sites populated `torrent_file_id` from `tf.id.clone()` (the host
  PK), not `tf.info_hash.clone()`. The field's meaning was upgraded
  from "infoHash" to "host PK" to match.

### P3 final identity check (durable tuple key)

- `hy4-data-plane/src/cache.rs` — `TorrentFileId` was restructured:
  - Added `info_hash: String`, `canonical_path: String`, `size: u64`,
    `durable_key: String` fields.
  - Added `TorrentFileId::new(...)` constructor that computes
    `durable_key` once at construction.
  - Added `TorrentFileId::compute_durable_key(info_hash, canonical_path,
    size)` static method.
  - `cache_key()` now returns `self.durable_key.clone()` — the
    deterministic tuple key, not the host PK.
  - Five new in-crate tests cover the durability contract (see §11).
  - All existing test sites converted to `::new()`; the sibling-file
    test rewritten to assert the new key shape.
- `hy4-data-plane/src/serve.rs` — both `TorrentFileId { ... }` literals
  (plan path and run-loop path) converted to `::new()`. The
  `AppState.tf_id_durable` doc comment updated to reflect that the
  field is the current host PK, **informational only**, NOT a key.
- `hy4-data-plane/src/manager.rs` — `Slot` gained
  `durable_key: String` field. `Slot::sf_key()` uses `durable_key`
  in the 5-tuple (not the host PK). Slot construction computes
  `durable_key` via `crate::cache::TorrentFileId::compute_durable_key`.
- `hy4-data-plane/src/provider.rs` — three `DeliveryCapability::new`
  call sites: only the inline comments were updated. The value passed
  is `tf.id.clone()`, which is correct — `DeliveryCapability.torrent_file_id`
  is informational, not a key.
- `hy4-data-plane/src/capability.rs` — `DeliveryCapability::torrent_file_id`
  doc comment changed from "durable PK" to "current host DB row id;
  informational only, NOT a key".
- This document — §11 and §12 added.

The donor, the host, the lab, and the control-plane store are untouched.

## 10. The run-loop shadow bug (corrected in P3, refined in P3 final)

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

After the P3 correction, both construction sites use the host PK
(`tf_id_durable`) for `TorrentFileId::cache_key()`. The new in-crate
test `same_info_hash_sibling_files_get_distinct_cache_entries` proves
this end-to-end at the cache layer.

**P3 final identity check refinement.** The P3 final identity check
(§11) further refines this: `tf_id_durable` is *not* durable across
host DB reconstruction. The run-loop's `tf_id_durable_clone` is now
passed to `TorrentFileId::new(...)` and used as the
`tf_id_durable` field of the struct, but `cache_key()` is the
deterministic tuple `tfkv\x1f<info_hash>\x1f<size>\x1f<canonical_path>`
— *not* `tf_id_durable.clone()`. The PK is informational only.

## 11. P3 final identity check — durability audit

The P3 correction in §1 picked `torrent_files.id` as the cache key on
the implicit assumption that this PK is **durable** across any host DB
reconstruction. The user's final identity check required a hard
verification of that assumption against the real host schema and
lifecycle paths. This section records the audit.

### 11.1 Question (verbatim from the user)

> Inspect the real host schema and the code paths that create, ingest,
> merge, repair, or recreate torrent_files. Determine: How is
> torrent_files.id created, and does the same logical TorrentFile
> necessarily retain the same ID across restart, provider
> reacquisition, repair, import/merge, DB maintenance, and any
> supported rebuild/reconstruction path?

### 11.2 Schema (DDL + invariant)

The torrent_files DDL is at
`media-search/src/lib/control-plane/store.js:97-110`:

```sql
-- Slice 1.5: durable physical-file identity grain (TorrentFile).
-- Identity is (info_hash, canonical_internal_path). The size is a positive
-- integer invariant; once inserted it is never updated. Provider addresses
-- live in provider_files and may churn without disturbing identity.
CREATE TABLE IF NOT EXISTS torrent_files (
  id TEXT PRIMARY KEY,
  info_hash TEXT NOT NULL CHECK (length(info_hash) = 40 AND info_hash NOT GLOB '*[^0-9a-f]*'),
  internal_path TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  created_at INTEGER NOT NULL,
  UNIQUE (info_hash, internal_path)
);
CREATE INDEX IF NOT EXISTS idx_torrent_files_hash
  ON torrent_files(info_hash);
```

Two schema-level facts:

1. **The schema's own comment declares the identity grain as
   `(info_hash, internal_path)`**, not as `id`. This is the canonical
   declaration of what counts as "the same TorrentFile" inside the
   host.
2. **The PK `id TEXT PRIMARY KEY` carries no CHECK constraint**, no
   UNIQUE-by-construction invariant, and no relation to the tuple.
   Combined with the `UNIQUE (info_hash, internal_path)` constraint, the
   schema guarantees the tuple is unique within the current DB — but
   the PK is a free string, and the schema does not commit to any
   particular value or value-generation scheme.

A second confirming comment lives at `store.js:1080`:

```
* torrent_files.internal_path = DURABLE TorrentFile IDENTITY,
* and is NOT a filesystem path in any namespace
```

— making the schema's intent explicit: the *internal_path* (alongside
`info_hash`) is the durable identity, the PK is not.

### 11.3 Lifecycle paths

Inspected across the entire repo.

| Path | Site | Effect on `torrent_files.id` |
|---|---|---|
| First insert | `store.js:923-924` | `const torrentFileId = \`tf_${randomUUID()}\``; new UUID minted. |
| Re-acquire (same DB, row present) | `store.js:876-921` | `existing.id` is reused. |
| Re-acquire (DB wiped, partial restore, or different inventory run that finds no row) | `store.js:876-921` else-branch | `tf_<new-randomUUID>` minted. |
| Migration / schema collapse | `store.js:2158-2227` (`migrateTorrentFileSchema`) | Preserves existing PK strings during the legacy `torrent_file_provider_refs` → `provider_files` collapse; does NOT deterministically reconstruct them; fresh rows still get fresh UUIDs. |
| Update | — | **No `UPDATE torrent_files` anywhere in the repo** (Grep across the entire repo returns zero matches). |
| Delete | — | **No `DELETE FROM torrent_files` anywhere in the repo** (Grep across the entire repo returns zero matches). |
| Read | `rowToTorrentFile` at `store.js:1967-1972` | Returns `id` as-is. S-1 (`app.js:2220-2278`) projects it to the data plane as `torrentFile.id`. |

Conclusion: **`torrent_files.id` is a SQLite surrogate, not a durable
identity.** The same logical TorrentFile — defined by the schema as
`(info_hash, internal_path)` — will be assigned a different `id` on any
DB reconstruction that wipes the row, any import/merge that goes
through the else-branch of the re-acquire path, or any rebuild that
replays the inventory. The PK is unique *within the current DB
instance only*.

### 11.4 Conclusion: B (PK is a surrogate, not durable)

> **B. `torrent_files.id` is only a surrogate/current-DB identifier.**
> It can change when the same logical TorrentFile is reconstructed,
> reimported, or rebuilt. The persistent cache identity MUST therefore
> be a deterministic representation of the durable tuple, not the PK.

Required code change: cache key + capability single-flight key MUST
be derived from `(info_hash, canonical_path, size)` — the same grain
the schema itself declares — and MUST NOT be derived from the PK.

### 11.5 Adversarial proof — same tuple, different PKs

Added five new in-crate tests in `hy4-data-plane/src/cache.rs`. All
five are in the existing test module, isolated to tempdir-backed
`CacheEngine` instances — no live DB mutation.

1. `same_logical_torrentfile_with_different_surrogate_pk_shares_cache_key`
   — constructs two `TorrentFileId`s with the same `(info_hash,
   canonical_path, size)` but different `tf_id_durable` strings; asserts
   `cache_key()` is identical and `durable_key` is identical.
2. `same_logical_torrentfile_survives_chunk_grid_after_surrogate_change`
   — end-to-end: stages chunk 0 under PK_A, "rebuilds" with PK_B
   (different `tf_id_durable`, same tuple), asserts chunk 0 is still
   reachable and `pread` returns the staged bytes.
3. `different_canonical_path_same_info_hash_yields_different_cache_key`
   — sibling guard: two files with the same `info_hash` and `size` but
   different `canonical_path` MUST have distinct cache keys.
4. `different_size_same_info_hash_same_path_yields_different_cache_key`
   — size-conflict guard: same `(info_hash, path)` with a 1-byte size
   difference MUST have distinct cache keys.
5. `capability_sf_key_is_invariant_under_surrogate_pk_change` — proves
   `Slot::sf_key()` is stable under PK change. Two `Slot`s constructed
   for the same tuple with different PKs get the same 5-tuple sf_key.

Full test run: `cargo test --lib` returns `test result: ok. 23 passed;
0 failed; 0 ignored; 0 measured; 0 filtered out` (18 pre-existing + 5
new P3 final identity check tests).

The PK was also changed in the pre-existing
`same_info_hash_sibling_files_get_distinct_cache_entries` test to use
the new tuple-based key shape (the previous test asserted
`key_a.contains("tf_sibling_A")`, which the new key does not — the
new assertions check the `tfkv\x1f...` shape directly).

## 12. The corrected cache key

### 12.1 Why a deterministic tuple, not a hash

The natural temptation is to hash `(info_hash, canonical_path, size)`
and use the hex digest as the cache key. The P3 brief is explicit:
"do not derive from provider path. Do not use providerFileId." A
hash adds a dependency (`sha2` / `hex` in `Cargo.toml`) for no
correctness benefit — the literal tuple is already
collision-free, filesystem-safe, and human-readable in
diagnostics.

The chosen format is:

```
tfkv\x1f<info_hash>\x1f<size_decimal>\x1f<canonical_path>
```

- `tfkv\x1f` — a fixed prefix. The `tfkv` literal sorts before any
  concrete `tf_<UUID>` for human log scanning; the `\x1f` is the ASCII
  Unit Separator, an unambiguous field delimiter.
- `<info_hash>` — 40 lowercase hex chars (per the schema's CHECK
  constraint).
- `<size_decimal>` — Rust `u64` serialized as decimal. Cannot be empty,
  cannot contain a delimiter.
- `<canonical_path>` — the verbatim `canonicalizeInternalPath` output.
  Per the canonicalizer, the only forbidden characters are `\\`, NUL,
  and `..` as a path component. `\x1f` is not in any provider's path
  emission and is the conventional unambiguous field delimiter in
  similar tools (e.g., `LevelDB` record blocks, `ASCII FS`-separated
  exports).

### 12.2 Where the key is computed

`TorrentFileId::compute_durable_key(info_hash, canonical_path, size)` is
a `pub` static method on `TorrentFileId` (in
`hy4-data-plane/src/cache.rs`). The key is computed once at
construction and stored on the `TorrentFileId.durable_key` field. Two
callers:

1. `TorrentFileId::new(...)` in `cache.rs` — the canonical constructor.
2. `manager.rs` — `Slot` construction site computes the key directly
   from the S-1 projected fields:
   `crate::cache::TorrentFileId::compute_durable_key(&tf.info_hash, tf.canonical_internal_path.as_deref().unwrap_or(""), tf.size)`.

`Slot::sf_key()` and `TorrentFileId::cache_key()` are both
implementations of "use the `durable_key` field, verbatim." There is
no other code path that derives a cache or single-flight key.

### 12.3 What the host PK is good for, after the change

`TorrentFileId.tf_id_durable` and `DeliveryCapability.torrent_file_id`
are still populated from `torrentFile.id`. Their new role is
**informational**: logging, forensics, and any future
host-aware messaging. They MUST NOT be used to namespace any
persistent on-disk state. The doc comments on both fields say so
explicitly.

## 13. Adversarial same-infoHash proof (P3 correction test)

`hy4-data-plane/src/cache.rs` contains a focused adversarial test
that proves the P3 correction under a worst-case setup:

- Two sibling files that share the same `info_hash`
- Different `tf_id_durable`, different `canonical_path`, different `size`
- The test fills chunk 0 of each with distinguishable bytes (0xAA vs
  0xBB) and asserts:
  1. `cache_key()` values are distinct and contain the durable tuple key.
  2. Both chunks are PRESENT (independent SQLite rows).
  3. `pread()` returns 0xAA for A and 0xBB for B (no cross-bleed).
  4. Warm reread cannot cross-alias.
  5. The capability single-flight key (`sf_key`) is distinct for two
     siblings that share the same provider coord (the worst case where
     `provider + account + resource + file` is identical and only
     `(info_hash, canonical_path, size)` differs).

This test is `same_info_hash_sibling_files_get_distinct_cache_entries`.
It is the 18th test in the cache test module. It is capable of
failing under the previous composite key (which would not contain
`tf_sibling_A` or `tf_sibling_B` strings) and under an
`info_hash`-only key (which would have identical `cache_key()`s for the
two siblings).

The P3 final identity check extends this test's invariant: under the
P3 final identity check contract, this test additionally proves that
the cache key is **invariant under any host DB reconstruction** —
because the key contains no PK. See §11.5 for the new tests that
prove this directly.

Run with:
```
cargo test --lib same_info_hash_sibling_files
```
