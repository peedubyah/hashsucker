# Seam Audit — Concurrency Observability Vocabulary

**File:** `data-plane/src/metrics.rs`
**Context:** §15 Phase 2 GAP 2–3 — add minimal concurrency observability without behavior changes.
**Audit:** 2026-09-06

## Background

The data plane manages per-TorrentFile delivery concurrency via `CapabilityManager`. Each manager
holds a `Semaphore` (pool) and an `Arc<DeliveryCapability>` with `in_flight: AtomicU64`. The
observability gap was that no metric exposed: (a) how many demand reads were active vs. peak, or
(b) what the pool utilization looked like as an aggregate.

## Seam Inventory

A **seam** is a code boundary where concurrency state transitions. Nine seams were identified and
audited. All changes are observability-only; zero behavior modifications.

### Seam 1 — Demand Read Start (core)

**Location:** `serve.rs:364–367`
```rust
let _demand_guard = first_reserved
    .as_ref()
    .map(|_| state.metrics.start_demand());
```
**What it observes:** When a demand read is acquired via `CapabilityManager::acquire_for_read()`.
A capability is acquired when the request needs a provider (not a pure cache hit). The guard is
RAII — it fires on every exit path.
**Metric emitted:** `concurrent_demand_current.fetch_add(1)` + peak update.

### Seam 2 — Demand Read Complete (RAII drop)

**Location:** `metrics.rs:DemandGuard::drop`
```rust
impl Drop for DemandGuard {
    fn drop(&mut self) {
        if !self.done {
            self.done = true;
            self.metrics.record_demand_done();
        }
    }
}
```
**What it observes:** Any exit from a demand read span — success, error, or cancellation. The `done`
flag prevents double-decrement if `record_demand_done()` is called explicitly before drop.
**Metric emitted:** `concurrent_demand_current.fetch_sub(1)`.
**Invariant:** Every `start_demand()` has exactly one `record_demand_done()` (RAII).

### Seam 3 — Peak Tracking (fetch_update)

**Location:** `metrics.rs:record_demand_active()`
```rust
if prev + 1 > self.concurrent_demand_peak.load(Ordering::SeqCst) {
    let _ = self.concurrent_demand_peak.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |_| {
        Some((prev + 1) as u32)
    });
}
```
**What it observes:** A new concurrent maximum. Uses `fetch_update` for lock-free monotonic
increment — peak only increases, never decreases.
**Metric emitted:** `concurrent_demand_peak.fetch_update(...)`.
**Correctness:** Compare-and-swap semantics: only the thread that observes `prev + 1 > peak` writes.
Concurrent updates that lose the race are silently dropped (acceptable; peak is monotonically
non-decreasing regardless of which thread wins).

### Seam 4 — Pool Capacity (caps_total)

**Location:** `serve.rs:metrics_handler`
```rust
let caps_total = pool.iter().map(|(_, len, _)| *len as u64).sum::<u64>();
```
**What it observes:** Total slots available across all `DeliveryCapability` instances for this
TorrentFile. Derived from `CapabilityManager::pool_summary()` on every `/metrics` scrape.
**Metric emitted:** `pool_aggregate.caps`.
**Limitation:** This is a point-in-time snapshot. Concurrent scrapes may see slightly different
values if the pool is growing/shrinking. Acceptable for observability.

### Seam 5 — Pool Target (target_total)

**Location:** `serve.rs:metrics_handler`
```rust
let target_total = pool.iter().map(|(_, _, tgt)| *tgt as u64).sum::<u64>();
```
**What it observes:** Total configured target slots across all capabilities. The target is the
desired pool size (may differ from current `caps` during growth).
**Metric emitted:** `pool_aggregate.target`.

### Seam 6 — Utilization Percentage

**Location:** `serve.rs:metrics_handler`
```rust
let utilization_pct = if target_total > 0 {
    ((caps_total as f64 / target_total as f64) * 100.0).round() as u64
} else { 0u64 };
```
**What it observes:** `caps / target` as a percentage. Zero if no target is configured.
**Metric emitted:** `pool_aggregate.utilization_pct`.
**Correctness:** Using `target_total` (desired) not `caps_total` (current) as denominator — this
matches the intuition of "how full is the pool relative to what we want?" not "how full is it
relative to what it happens to be right now."

### Seam 7 — Limiter Wait (pre-existing)

**Location:** `metrics.rs:record_limiter_wait()`
**What it observes:** When a demand read blocks waiting for a `Semaphore` permit (pool exhaustion).
**Metric emitted:** `limiter_waits` (counter) and `limiter_wait_ms_total` (cumulative wall time).
**Note:** `limiter_permit_waits` tracks the sub-class of waits that did eventually acquire a permit
vs. those that gave up (e.g., timeout). Both pre-existed this audit.

### Seam 8 — Capability Acquisition (pre-existing)

**Location:** `metrics.rs:record_capability_acquisition()`
**What it observes:** When a new `DeliveryCapability` slot is created and added to the pool.
**Metric emitted:** `capability.acquisitions`.
**Seam relationship:** Seam 1 and Seam 8 are correlated but distinct: Seam 8 counts pool growth,
Seam 1 counts active demand reads. A pool can grow without active reads; reads can be active
without triggering pool growth.

### Seam 9 — Capability Reuse (pre-existing)

**Location:** `metrics.rs:record_capability_reuse()`
**What it observes:** When an existing `DeliveryCapability` slot is reused without reacquiring.
**Metric emitted:** `capability.reuses`.
**Seam relationship:** High `reuses / acquisitions` ratio indicates healthy slot reuse. Low ratio
with high `concurrent_demand` indicates the pool is too small for the workload.

## New Metric Surface

```
/metrics endpoint → JSON:

"concurrent_demand": {
    "current": u32,   // active demand reads at scrape time
    "peak": u32,      // all-time maximum concurrent demand
},
"pool_aggregate": {
    "caps": u64,          // total available slots
    "target": u64,         // total configured target slots
    "utilization_pct": u64 // caps/target as percentage
}
```

## Behavioral Invariants (unchanged)

1. **No concurrency changes.** Pool size, permit limits, and scheduling are unmodified.
2. **No new failure modes.** The new atomics are read-mostly; writes are single-location.
3. **RAII correctness.** `DemandGuard` fires on all exit paths; no leaks possible.
4. **Monotonic peak.** `concurrent_demand_peak` never decreases across scrapes.
5. **Zero-dependency metric.** `pool_aggregate` is derived from existing `pool_summary()` with no
   new queries or state reads.

## Verification

```
$ curl http://localhost:3001/metrics | jq '.concurrent_demand, .pool_aggregate'

# Before any demand reads:
{ "current": 0, "peak": 0 }
{ "caps": 0, "target": 0, "utilization_pct": 0 }

# After one demand read completes:
{ "current": 0, "peak": 1 }
{ ... }  # pool metrics reflect the TfId's pool state
```

## GAP 2 — Implementation

- ✅ `concurrent_demand_current: AtomicU32` added to `Metrics` struct
- ✅ `concurrent_demand_peak: AtomicU32` added to `Metrics` struct
- ✅ `record_demand_active()` — `fetch_add(1)` + monotonic peak update
- ✅ `record_demand_done()` — `fetch_sub(1)`
- ✅ `DemandGuard` — RAII wrapper with double-decrement guard
- ✅ `MetricsExt` trait + `impl` for `Arc<Metrics>::start_demand()`
- ✅ Guard instantiated at `serve.rs:364` after capability acquire
- ✅ `/metrics` endpoint emits both fields

## GAP 3 — Implementation

- ✅ `caps_total` — sum of all `len` values from `pool_summary()`
- ✅ `target_total` — sum of all `tgt` values from `pool_summary()`
- ✅ `utilization_pct` — `caps / target * 100`, rounded, zero-safe
- ✅ `/metrics` endpoint emits `pool_aggregate` object

## References

- `data-plane/src/metrics.rs` — metrics struct, `DemandGuard`, `MetricsExt`
- `data-plane/src/serve.rs` — guard instantiation, `/metrics` handler
- `data-plane/src/manager.rs` — `CapabilityManager::pool_summary()`
