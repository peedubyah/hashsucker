# PRODUCTION RUNTIME CHECKPOINT — CachyOS

**main:** `46bde71beee3044792196e15f524f11bc3e05c5d`
**date:** 2026-09-08
**host:** CachyOS Linux (192.168.2.4)
**graduated behavior:** zero-cooldown headerless timeout retry
**transplant state:** NOT YET TRANSPLANTED — this `main` is the clean receiving point

---

## 1. PURPOSE

Capture the proven production runtime state at a clean `main` HEAD so a
future Windows-hybrid scheduler transplant has a verified, behaviorally-stable
receiving surface. This document is a **checkpoint**, not a roadmap. No
scheduler logic is imported here.

---

## 2. RECENT PRODUCTION COMMITS

| Commit | Subject |
|---|---|
| `4007f07` | provider-scoped runtime attribution (§15 Phase 4) |
| `e414a64` | runtime request/fill correlation via `corr_id` (§15 Phase 5) |
| `73c7995` | CDN timeout/outcome classification (§15 Phase 6) |
| `6b07ff4` | correct CDN attempt numbering + `retry_wait_ms` (§15 Phase 6 follow-up) |
| `47c17bb` | headerless reqwest timeout → zero-cooldown immediate same-cap retry |
| `46bde71` | explicit `recovery_path` attribution on `CdnAttempt` |

### 2.1 Graduated: zero-cooldown timeout (`47c17bb`)

Fully graduated by live Oppenheimer proof. A headerless reqwest timeout
(`headers_received=false`, `outcome=Timeout`) now retries immediately on the
**same capability** with `retry_wait_ms=0` and `recovery_path=headerless_timeout_zero_cooldown`.
A non-zero `Retry-After` still honors cooldown; only the zero-cooldown branch changed.

Proof trace:
```
corr_id=corr-2  provider=torbox  cap_id=torbox-0-0
  attempt 1  outcome=Timeout  headers_received=false  headers_ms=25000  retry_wait_ms=0
             recovery_path=headerless_timeout_zero_cooldown
  attempt 2  started_at_ms=25001  outcome=Success  headers_ms=525
```

---

## 3. NODE / RUST OWNERSHIP BOUNDARY (FROZEN)

### 3.1 Node owns durable truth
- **Release** = infoHash
- **TorrentFile** = `(infoHash, canonicalInternalPath, immutable exact positive size)`
- `ProviderPlacement`, persisted discovery/ranking
- publication / Plex-facing VFS
- alternate-Release fallback (Node's persisted-candidate list)
- DB schema declares the identity grain: "Identity is (info_hash,
  canonical_internal_path). The size is a positive integer invariant; once
  inserted it is never updated."

### 3.2 Rust owns runtime execution
- runtime-only `DeliveryCapability` (NEVER durable, NEVER logged, NEVER persisted)
- provider byte delivery, Range serving
- retries / Retry-After / recovery budgets
- per-capability limiter (`Semaphore(1)`, maxInFlight=1) and per-(provider,account) breaker
- same-TorrentFile recovery (Class B/C, `transport.rs`)
- fixed-grid cache/coalescing (`cache.rs`)
- exact byte motion

### 3.3 Critical rules
- Provider is execution metadata, **not** byte identity.
- Bytes are interchangeable across providers **only under the same TorrentFileId**.
- `DeliveryCapability` is runtime-only; its `runtime_url` is a signed URL that
  must never be logged, exposed, persisted, or treated as identity.
- Rust must NEVER choose another Release, never discover/rank, never mutate identity.

---

## 4. IDENTITY MODEL (P3 FINAL IDENTITY CHECK — Conclusion B)

TorrentFile surrogate PK (`torrent_files.id`, `tf_<UUID>`) is **NOT durable** across
DB reconstruction/merge/repair. Two-layer keying:

1. **`durable_key`** (logical) — human-inspectable `(info_hash § size § canonical_path)`
   for logging, forensics, capability single-flight.
2. **`physical_cache_key`** — SHA-256 of an unambiguous length-prefixed encoding of the
   same tuple; 64-char hex, safe as a directory name and object-store key.

Cache and capability single-flight **MUST NOT** key on `torrent_files.id`. The cache
format version (currently 2) and chunk size are persisted together; changing either
resets the grid rather than reinterpreting.

---

## 5. FIXED-GRID CACHE / COALESCING MODEL

- **Grid**: `TorrentFile -> chunkIndex -> complete chunk PRESENT|ABSENT`.
  `chunk_start(i) = i * chunk_size`, `chunk_len(i) = min(chunk_size, file_size - chunk_start(i))`.
- Durable truth is a pure function of `(file_size, chunk_size)`, independent of request shape.
- `chunks` row exists **IFF** the complete expected chunk is durably on disk. No durable
  partial, no durable FILLING state. FILLING is runtime-only (in-flight map).
- **Coalescing is per-chunk single-flight**: key = `(cache_key, chunk_index)`. One owner,
  any number of waiters. Adjacent missing chunks collapse into ONE provider Range, split back
  into chunks on arrival.
- EOF chunk is deterministically shorter (part of grid definition, not a special case).
- A 1-byte single bypasses the cache entirely (workaround, unchanged from Slice 4.5).

---

## 6. CAPABILITY / POOL MODEL

### 6.1 Slot
Each `Slot` = one fixed **ProviderCoord**:

```
(provider, account_scope, durable_key, provider_resource_id, provider_file_id)
```

Holds: `target: AtomicUsize` (starts at 1), `caps: Mutex<Vec<Arc<DeliveryCapability>>>`,
`breaker: Breaker`. `sf_key()` formats the coord as a single-flight key.

### 6.2 Per-capability serialization
`DeliveryCapability` owns a `Semaphore(1)` → **maxInFlight=1 per capability**.
Reused via `try_reserve`; a permit is held for the duration of the read and released
when `ReservedCapability` drops.

### 6.3 Pool growth trigger — `first_alive_busy`
`try_slot` (manager.rs:469-560), 4-step logic:
- **Step 0** — prune Dead/expired caps via `caps.retain(|c| !c.prunable(now))`.
- **Step 1** — reuse a free cap (`first_usable_free`: usable_now && permits > 0).
- **Step 2** — **growth**: if an Alive cap has its permit taken (`first_alive_busy`)
  AND `target < pool_max` AND breaker closed → `target.fetch_add(1)`, reason
  `"concurrent-read-pressure"`. Throttled caps are EXCLUDED (Alive match only).
- **Step 3** — `while caps.len() < target` → `resolve_internal(slot, idx)` + push + try_reserve.
- **Step 4** — block on `first_waitable` (wait out Throttle cooldown if needed).

### 6.4 The second capability
Growth re-resolves **the same `slot.coord`** — another signed runtime URL for the **same
provider placement**. It is NOT another Release, NOT runtime provider discovery, NOT Node
fallback. `resolve_internal` keys single-flight by `{sf_key()}#{idx}`, so a 2-cap pool
dedups by idx.

### 6.5 Pool max
`POOL_MAX` env var, default 2, **floor 2** (manager.rs:212-216). Max concurrent upstream per
TorrentFile = `slots × pool_max` (typically 2 per slot).

### 6.6 Monotonic target
`target` grows but does **not** decay. Dead/expired caps are pruned by `prunable(now)`
in Step 0 and `reacquire_for_read`; the slot then refills toward target. Active count
shrinks via pruning, not via target reduction.

### 6.7 Acquisition entry points
| Method | Blocking? | Grows pool? | Used by |
|---|---|---|---|
| `acquire_for_read` | yes | yes (via try_slot) | demand reads (`get_file`, `fill_chunk_run`) |
| `acquire_for_read_try` | no | **no** | prefetch (Try mode) |
| `acquire_for_read_prefetch` | bounded wait | **no** | prefetch (Wait mode) |
| `reacquire_for_read` | async | **no** | dead-link Class C recovery, single reacquire |
| `try_reserve` | sync | **no** | internal reuse of an existing cap |

`acquire_for_read` fails over across slots (Node-supplied provider order) for the SAME
TorrentFile. `AllSameTfFailed` only when every slot is exhausted and none can recover.

### 6.8 Negative cache
Bounded hard-failure cache (`neg_ttl` default 2s, keyed by coord) prevents re-acquire
storms. Transient failures (429/5xx) are **never** cached negative.

---

## 7. PRIORITY (DECLARED BUT UNIMPLEMENTED)

`priority: u8` is parsed from the `x-read-priority` header (default 1) and passed to
every `acquire_for_read*` call. In all three manager methods it is bound to `_priority`
(**unused**). Prefetch always reports `WorkClass::Prefetch` with the lowest
`prefetch_priority` (default 0). Acquisition ordering is therefore **currently
indeterminate** — a future scheduler transplant's declared injection point.

---

## 8. RETRY / RECOVERY TELEMETRY

`CdnAttempt` carries: `attempt`, `started_at_ms`, `outcome`, `status_code`,
`headers_received`, `headers_ms`, `body_ms`, `bytes`, `retry_wait_ms`,
`recovery_path`, `provider`, `cap_id`, `account_scope`, `corr_id`.

Recovery budgets (transport.rs):
- `MAX_SAME_CAP_RETRIES = 3` (Class B transient reopen attempts per read)
- `MAX_REACQUIRES = 1` (Class C dead-link single-flight reacquire-once)
- `RECOVERY_BACKOFF_DEFAULT = 30s` (applied when no Retry-After)

Class A (API/acquire failure) → manager failover. Class B (live stream 429/5xx/drop) →
wait behind limiter/breaker, reopen SAME cap at SAME offset. Class C (401/403/404/410) →
mark dead, single reacquire. 416 → permanent, no recovery.

---

## 9. PREFETCH (P9) — FROZEN CONTRACT

- Reuses the SAME chunk grid, cache/coalescer, capability pool, limiter/breaker, and
  `fill_chunk_run` (with `sink = None` so it only stages bytes durably).
- Runtime-only, bounded per-TorrentFile map (LRU eviction). Nothing persisted.
- Failure shielded: a prefetch failure stays inside the background task, never reaches
  the client, never triggers Node's candidate fallback.
- `PrefetchMode`: `Auto` (Wait only when `spare_capacity > 0`, else Try), `Try`,
  `Wait` (bounded). Never grows the pool.
- Seek reprioritization: non-sequential request bumps a per-TF generation counter; NO new
  prefetch issued for superseded position; in-flight prefetches allowed to finish.

---

## 10. PER-REQUEST ARCHITECTURE (P3 step 2)

`main.rs` constructs a fresh `AppState` **per request** after fetching the control
response for that `tfId`. There is no process-global `TORRENT_FILE_ID`. The ServiceState
holds a `managers: Mutex<HashMap<tfId, Arc<CapabilityManager>>>` so distinct TorrentFiles
get distinct pools. AppState carries: `authoritative_size`, `tf_id`, `tf_id_durable`,
`info_hash`, `canonical_path`, `client`, `metrics`, `manager`, `cache`, `playback`.

---

## 11. CANCELLATION

Client disconnect → `tx.send(...).await.is_err()` → increment `client_cancellations`
and return from the streaming loop. In-flight fills for that span are abandoned via
`stager.abort()` (discards any incomplete staging file; no partial chunk survives).
Chunk coalescer records are finalized (`success=false`, `done.notify_waiters()`) so
waiters don't deadlock. No task abortion / no join-handle cancellation.

---

## 12. SCHEDULER TRANSPLANT STATUS

**NOT YET TRANSPLANTED.** This `main` (`46bde71`) is the clean receiving point for a
separately-reviewed scheduler import. All runtime behavior, pool policy, acquisition
ordering, retry/coalescing semantics, identity ownership, and alternate-Release fallback
are frozen at this HEAD. The transplant inventory follows.

---

## 13. PRODUCTION TRANSPLANT RECEIVING-SURFACE INVENTORY

This section maps the exact production seams a future scheduler transplant would
have to touch. Each seam is classified:

- **MUST PRESERVE** — behavior the transplant may not alter.
- **POSSIBLE TRANSPLANT POINT** — a seam the scheduler could legitimately hook.
- **MUST NOT CROSS** — a boundary the scheduler may not violate.

The inventory is derived from source inspection of `data-plane/src/`. It does
NOT infer Windows scheduler behavior and does NOT invent transplant logic.

### 13.1 Demand scheduling

| Seam | Location | Classification |
|---|---|---|
| Per-request `AppState` construction (control fetch → manager lookup) | `main.rs` | MUST PRESERVE |
| `get_file` entry: range parse, cache plan, capability acquire, run loop | `serve.rs:300-700` | MUST PRESERVE |
| `RunKind::Local` vs `RunKind::Fetch` dispatch | `serve.rs` run loop | MUST PRESERVE |
| Concurrent fill of multiple fetch spans (`tokio::spawn(fill_chunk_run(...))`) | `serve.rs` | POSSIBLE TRANSPLANT POINT |
| Ascending-chunk consumption for ordered byte stream | `serve.rs` | MUST PRESERVE |

A scheduler may influence **which** spans fill concurrently and in what order, but
must not break the ascending-chunk delivery contract or the single-owner coalescer.

### 13.2 Prefetch scheduling

| Seam | Location | Classification |
|---|---|---|
| `PlaybackIntelligence::observe_and_claim_prefetch` | `playback_intel.rs` | MUST PRESERVE |
| `PrefetchMode` selection (`Auto`/`Try`/`Wait`) via `spare_capacity` | `playback_intel.rs`, `manager.rs:728` | MUST PRESERVE |
| `acquire_for_read_try` / `acquire_for_read_prefetch` (non-blocking, no growth) | `manager.rs:637-700` | MUST PRESERVE |
| `fill_chunk_run(..., sink=None, existing_cap=Some(cap))` for prefetch | `serve.rs` | MUST PRESERVE |
| `mark_prefetch_inflight` / `mark_prefetch_completed` attribution | `playback_intel.rs` | MUST PRESERVE |

A scheduler may adjust prefetch arming thresholds or contention policy via the
existing `PfConfig` env vars. It must not make prefetch grow the pool, block demand,
or surface prefetch failures to the client.

### 13.3 Work-class priority

| Seam | Location | Classification |
|---|---|---|
| `priority: u8` parsed from `x-read-priority` (default 1) | `serve.rs:~335` | POSSIBLE TRANSPLANT POINT |
| `_priority` bound but **unused** in all three `acquire_for_read*` methods | `manager.rs` | POSSIBLE TRANSPLANT POINT |
| `WorkClass::Prefetch` reported with lowest `prefetch_priority` (default 0) | `serve.rs`, `metrics.rs` | MUST PRESERVE |

Priority is a declared but unimplemented signal. A scheduler transplant's natural
injection point: consume `_priority` inside `try_slot` / `acquire_for_read` to order
acquisition. Must not reorder within a single-flight coalescer key, must not let
prefetch out-prioritize demand.

### 13.4 Acquisition ordering

| Seam | Location | Classification |
|---|---|---|
| Slot iteration order = Node-supplied provider preference order | `manager.rs:584-635` | MUST PRESERVE |
| `try_slot` 4-step logic (prune → reuse → grow → fill → block) | `manager.rs:469-560` | MUST PRESERVE |
| `first_usable_free` / `first_alive_busy` / `first_waitable` scan order | `manager.rs:416-452` | MUST PRESERVE |
| Single-flight dedup keyed by `{sf_key()}#{idx}` | `manager.rs:247-360` | MUST PRESERVE |

A scheduler may influence **which** capability is selected among free caps, but must
not bypass single-flight dedup, must not suppress the `first_alive_busy` growth
signal, and must not reorder slots away from Node's preference order.

### 13.5 Cache / fill ownership

| Seam | Location | Classification |
|---|---|---|
| Fixed-grid chunk identity `(cache_key, chunk_index)` | `cache.rs` | MUST PRESERVE |
| Per-chunk single-flight coalescer (`join_or_claim_many`) | `cache.rs` | MUST PRESERVE |
| One fill owner, N waiters; `done.notify_waiters()` | `cache.rs` | MUST PRESERVE |
| `mark` resolves every owned record (success/fail) to avoid waiter deadlock | `serve.rs:1180-1210` | MUST PRESERVE |
| Adjacent-missing-chunk collapse into one provider Range | `serve.rs` | MUST PRESERVE |
| Whole-chunk durable truth; no partial/filling persistence | `cache.rs` | MUST PRESERVE |

A scheduler must not introduce a second concurrency domain, must not duplicate an
in-flight chunk fill, and must not persist partial state.

### 13.6 Capability acquisition

| Seam | Location | Classification |
|---|---|---|
| `resolve_internal` single-flight + negative cache | `manager.rs:247-360` | MUST PRESERVE |
| `try_reserve` (permit acquire, maxInFlight=1 enforcement) | `manager.rs:~540-560` | MUST PRESERVE |
| `pool_max` floor 2, `POOL_MAX` env | `manager.rs:212-216` | MUST PRESERVE |
| `target` monotonic growth via `first_alive_busy` | `manager.rs:495-507` | MUST PRESERVE |
| `prunable` retain pruning (Dead/expired) | `manager.rs:475-483`, `capability.rs:143-155` | MUST PRESERVE |
| `reacquire_for_read` single reacquire (Class C) | `manager.rs:751-790` | MUST PRESERVE |

A scheduler must not mint capabilities outside the pool, must not suppress pruning,
and must not convert a same-cap retry into a pool growth.

### 13.7 Limiter / breaker interaction

| Seam | Location | Classification |
|---|---|---|
| Per-capability `Semaphore(1)` (maxInFlight=1) | `capability.rs:50-68` | MUST PRESERVE |
| Per-(provider,account) `Breaker` (threshold + cooldown + half-open probe) | `capability.rs` | MUST PRESERVE |
| `breaker.is_open` checked before each slot acquire | `manager.rs:590-595` | MUST PRESERVE |
| `limiter_permit_waits` / `limiter_waits` accounting | `metrics.rs`, `manager.rs` | MUST PRESERVE |

A scheduler must not open a second limiter domain, must not bypass the breaker, and
must not reset breaker state from outside the capability lifecycle.

### 13.8 Cancellation

| Seam | Location | Classification |
|---|---|---|
| Client disconnect → `tx.send().is_err()` → return | `serve.rs:698,915,991,1024` | MUST PRESERVE |
| `stager.abort()` discards incomplete staging file | `cache.rs:1264` | MUST PRESERVE |
| Coalescer record finalized (`failed=true`, `done.notify_waiters()`) | `serve.rs:1180-1210` | MUST PRESERVE |
| `client_cancellations` counter | `metrics.rs:22` | MUST PRESERVE |

A scheduler must not suppress cancellation propagation and must not leave partial
chunks or unresolved coalescer records.

### 13.9 Stage / demand telemetry

| Seam | Location | Classification |
|---|---|---|
| `StageClock` T0..T5 waterfall stamps | `serve.rs`, `metrics.rs` | MUST PRESERVE |
| `CdnAttempt` (attempt, outcome, headers_ms, retry_wait_ms, recovery_path, corr_id) | `transport.rs`, `metrics.rs` | MUST PRESERVE |
| `pool_summary` / `pool_attribution` per-cap telemetry | `manager.rs:808-840` | MUST PRESERVE |
| `concurrent_demand_current` / `_peak` + `DemandGuard` RAII | `metrics.rs`, `serve.rs:~364` | MUST PRESERVE |
| `record_demand_joined_fill` (coalescer-join wait) | `metrics.rs`, `serve.rs:~991` | MUST PRESERVE |

A scheduler may add new telemetry but must not remove or repurpose existing fields
that the production proofs depend on.

---

## 14. MUST-PRESERVE INVARIANTS (CONCISE)

1. **TorrentFile identity** — `(info_hash, canonical_internal_path, exact positive size)`;
   surrogate PK is NOT identity. Cache and single-flight key on the durable tuple only.
2. **Node ownership** — Node owns Release/TorrentFile/Placement/discovery/ranking/VFS/
   alternate-Release fallback. Rust never chooses another Release.
3. **Alternate-Release fallback** — a Rust-side failure never triggers Node's persisted-
   candidate fallback except via the explicit `AllSameTfFailed` → `S1_FETCH_FAILED` path.
4. **Fixed-grid cache identity** — chunk is the unit of durable truth; no partial/filling
   persistence; grid is a pure function of `(file_size, chunk_size)`.
5. **Coalescing semantics** — per-chunk single-flight; one owner, N waiters; adjacent
   missing chunks collapse to one Range; every owned record resolved on completion.
6. **Existing retry behavior** — Class A (manager failover), Class B (same-cap reopen),
   Class C (dead-link reacquire-once); budgets `MAX_SAME_CAP_RETRIES=3`, `MAX_REACQUIRES=1`.
7. **Provider/account coord identity** — `(provider, account_scope, durable_key,
   provider_resource_id, provider_file_id)`; growth re-resolves the SAME coord.
8. **Runtime-only DeliveryCapability** — never logged, never exposed, never persisted;
   `runtime_url` is a signed ephemeral URL.
9. **maxInFlight=1 per capability** — `Semaphore(1)`; a held permit is the in-flight proof.
10. **Pool growth is demand-only** — `first_alive_busy` signal; prefetch/try paths never grow.
11. **Zero-cooldown timeout** — headerless timeout retries immediately on the SAME cap;
    does not influence other capabilities, does not create new growth.
12. **Priority is declared but unused** — `_priority` bound in all acquire methods; current
    ordering indeterminate.

---

## 15. WINDOWS TRANSPLANT RECEIVING SURFACE (SUMMARY)

The smallest likely transplant surface, in dependency order:

1. **`manager.rs` `try_slot` / `acquire_for_read*`** — consume `_priority` to order
   acquisition among free caps and slots. MUST keep single-flight, growth signal,
   pruning, and failover intact.
2. **`serve.rs` run loop** — influence which fetch spans spawn concurrently and in what
   order. MUST keep ascending-chunk delivery and coalescer ownership intact.
3. **`playback_intel.rs` `PfConfig`** — adjust prefetch arming/contention via env. MUST
   keep prefetch failure-shielding and no-growth contract intact.
4. **`metrics.rs`** — add scheduler-specific telemetry. MUST NOT remove production-proof fields.

Boundaries the transplant MUST NOT cross:
- `control.rs` / `control-plane.db` (Node durable truth)
- `ProviderCoord` construction (Node-supplied, fixed at manager build)
- `DeliveryCapability` persistence or identity use
- Coalescer keying or single-flight semantics
- Breaker/limiter state from outside the capability lifecycle

---

## 16. BEHAVIOR CHANGES

- **expected:** none
- **actual:** none — this slice is documentation + inventory only.

---

## 17. NEXT ACTION

Production is ready to receive a separately-reviewed scheduler transplant from the
Windows track. Recommended branch point: the new pushed `origin/main` HEAD
(`46bde71` + this commit). Do not implement the transplant on `main` until reviewed.
