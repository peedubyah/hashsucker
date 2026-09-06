// Slice 3.5 — network accounting (three layers) + capability lifecycle + recovery budgets
// + stage timing.
//
// §8 requires the requestdl/API layer, the redirect layer, and the CDN Range layer to be
// reported SEPARATELY so we can answer: are the 429s API amplification? redirects? final-CDN
// throttling? or a combination? We must NOT collapse them into one "TorBox 429" metric.
//
// §10/§14 require recovery budgets to be reported separately: max same-capability retries, max
// reacquires, total recovery wall time, and the final failure status. Latency is observational
// only (§12/§15: no TTFB optimization this slice); we preserve stage timing so a future TTFB
// waterfall can explain where first-byte time goes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct Metrics {
    // request-facing
    pub requests: AtomicU64,
    pub bytes_streamed: AtomicU64,
    pub client_cancellations: AtomicU64,
    pub upstream_errors: AtomicU64,

    // Layer A — requestdl / TorBox API acquisition
    pub api_requests: AtomicU64,
    pub api_2xx: AtomicU64,
    pub api_4xx: AtomicU64,
    pub api_5xx: AtomicU64,
    pub api_429: AtomicU64,
    pub api_redirect_true: AtomicU64, // legacy redirect=true usage (should be 0 in 3.5)
    pub api_latency_ms: AtomicU64,
    pub api_latency_n: AtomicU64,

    // Layer B — redirect layer (should be 0 in 3.5)
    pub redirect_hops: AtomicU64,
    pub redirect_429: AtomicU64,

    // Layer C — CDN Range layer
    pub cdn_requests: AtomicU64,
    pub cdn_2xx: AtomicU64,
    pub cdn_206: AtomicU64,
    pub cdn_4xx: AtomicU64,
    pub cdn_5xx: AtomicU64,
    pub cdn_429: AtomicU64,
    pub cdn_latency_ms: AtomicU64,
    pub cdn_latency_n: AtomicU64,
    pub final_cdn_host: Mutex<Option<String>>,

    // Capability lifecycle
    pub capability_acquisitions: AtomicU64,
    pub capability_reuses: AtomicU64,
    pub capability_evictions: AtomicU64,
    pub capability_reacquisitions: AtomicU64,
    pub capability_negative_hits: AtomicU64,

    // rate-limit / failover (client-visible 503 count; internal retries are counted separately)
    pub rate_limited: AtomicU64,
    pub all_same_tf: AtomicU64,
    pub pool_growths: AtomicU64,
    // Waits behind the shared limiter/breaker. TWO distinct phenomena, both
    // reported, never collapsed (§10's own rule for recovery budgets):
    //
    //   limiter_waits        — a 429/5xx throttle COOLDOWN was served with a
    //                          non-zero backoff (wired Slice 4.5, transport.rs).
    //                          Zero under the deterministic fault gates, which
    //                          force a zero-length cooldown so tests do not sleep.
    //   limiter_permit_waits — queueing for a capability's maxInFlight=1 PERMIT.
    //                          This is the dominant case: Slice 4.75 proof M
    //                          measured 8 chunk spans claimed concurrently that
    //                          serialized 4.64x while limiter_waits stayed at 0.
    //
    // Before 4.75 only the first was instrumented, so the counter named
    // "limiter_waits" did not count the common meaning of waiting on the
    // limiter, and a bare 0 read as "no contention" when the opposite was true.
    pub limiter_waits: AtomicU64,
    pub limiter_permit_waits: AtomicU64,
    pub breaker_opens: AtomicU64,

    // Other TorBox APIs (expected 0 — proves they never enter the Range hot path)
    pub mylist_calls: AtomicU64,
    pub checkcached_calls: AtomicU64,
    pub search_calls: AtomicU64,

    // Acquisition mode (provenance for the before/after comparison, §10)
    pub acquisition_mode: Mutex<Option<String>>,

    // ---- §10 recovery budgets (honest, MEASURED) ----
    // Total internal recovery attempts (same-capability retries + reacquire attempts) that did
    // NOT immediately surface to the client — the heart of §2 "heal internally first".
    pub recovery_attempts: AtomicU64,
    // Per-request maxima (captured via fetch_max so the global max survives concurrency).
    pub max_same_cap_retries: AtomicU64,
    pub max_reacquires: AtomicU64,
    // Total wall time spent in recovery waits (cooldowns / backoffs), observational.
    pub recovery_wall_ms: AtomicU64,
    // Successful internal recoveries (a read that recovered and ultimately delivered all bytes),
    // including mid-body resumes.
    pub internal_recoveries: AtomicU64,
    // Mid-body disconnects we recovered from by resuming at mid+1 on the SAME capability (§3).
    pub mid_body_resumes: AtomicU64,
    // Client-visible final failure status (only after bounded recovery is exhausted, §2/§10).
    pub client_503: AtomicU64,
    pub client_502: AtomicU64,
    pub client_416: AtomicU64,
    // Mid-body exhaustion: recovery budget ran out after some bytes were already delivered, so the
    // open 206 stream had to be truncated (no status change possible post-headers).
    pub client_truncated: AtomicU64,

    // ---- §11 Retry-After observability (surface BOTH) ----
    // Provider-stated Retry-After (seconds) on the most recent throttle, and the wait we actually
    // applied. They can differ operationally (we may cap the wait). HTTP-date form, if ever parsed,
    // is reported as UNPROVEN (best-effort only).
    pub retry_after_provider_secs: Mutex<Option<u64>>,
    pub retry_after_applied_secs: Mutex<Option<u64>>,

    // ---- §15 stage timing (observational waterfall; no tuning) ----
    pub cold_ttfb_ms: Mutex<Option<u64>>,
    pub warm_ttfb_ms: Mutex<Option<u64>>,
    pub cold_acquire_ms: Mutex<Option<u64>>,
    pub cold_cdn_first_byte_ms: Mutex<Option<u64>>,
    // Cumulative time spent waiting behind the shared limiter/breaker (Warpbox-style, §6) — the
    // signal that 10 concurrent readers shared ONE gate rather than sleeping independently.
    //
    // Slice 4.75: this now receives BOTH throttle-cooldown time (4.5) and
    // permit-contention time (manager.rs). It was always documented as time
    // behind the shared limiter, but only ever received the cooldown case, so
    // it under-reported the dominant contributor.
    pub limiter_wait_ms_total: AtomicU64,
    // Cumulative time spent in internal retry recovery — distinct from limiter wait.
    pub internal_recovery_ms_total: AtomicU64,

    // ---- Slice 4 cache metrics ----
    pub cache: CacheMetrics,

    // ---- Slice 4.5 ----
    /// Per-fetch decision log. Drives proof G: every upstream request must be
    /// attributable to a captured reason, so the raw decision facts are recorded
    /// at fetch time rather than reconstructed later.
    pub cache_decisions: DecisionLog,
    /// Bounded ring of completed per-request stage waterfalls. Bounded (not
    /// unbounded) because this is diagnostic telemetry on a long-lived server.
    pub stage_reports: Mutex<Vec<StageReport>>,
    /// The most recently completed request's waterfall. This is what the
    /// benchmark reads for its permanent timing fields.
    pub stage_last: Mutex<Option<StageReport>>,
}

/// Cap on retained per-request stage waterfalls.
const STAGE_REPORT_CAP: usize = 64;

impl Metrics {
    /// Publish a completed request's stage waterfall. Retains the last
    /// `STAGE_REPORT_CAP` so concurrent bursts stay inspectable.
    pub fn record_stage_report(&self, r: StageReport) {
        *self.stage_last.lock().unwrap() = Some(r);
        let mut v = self.stage_reports.lock().unwrap();
        v.push(r);
        if v.len() > STAGE_REPORT_CAP {
            let over = v.len() - STAGE_REPORT_CAP;
            v.drain(0..over);
        }
    }

    pub fn stage_reports_json(&self) -> Vec<serde_json::Value> {
        self.stage_reports
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.to_json())
            .collect()
    }
}

#[derive(Default)]
pub struct CacheMetrics {
    pub full_hits: AtomicU64,
    pub partial_hits: AtomicU64,
    pub misses: AtomicU64,
    pub bytes_local: AtomicU64,
    pub bytes_upstream: AtomicU64,
    // NOTE: extent-state counts are deliberately NOT tracked here. An
    // `extents_present` / `extents_filling` pair used to live here and was
    // surfaced on /metrics, but nothing ever incremented it, so it read a
    // permanent 0 and made "did the cache actually publish an extent?"
    // unfalsifiable — proof G could neither pass nor fail for the right
    // reason. Those counts are now derived from the extent map on demand;
    // see CacheEngine::extent_counts, which cannot drift out of sync.
    pub inflight_joins: AtomicU64,
    pub overlap_bytes_avoided: AtomicU64,
    pub evictions: AtomicU64,
    pub bytes_evicted: AtomicU64,
    // NOTE: `current_bytes` is deliberately NOT an atomic here. It used to be,
    // and was surfaced on /metrics, but nothing ever wrote it — so it read a
    // permanent 0. That made Slice 4's proof F budget assertion
    // (`current_bytes <= max_bytes`) VACUOUS: it passed no matter how far over
    // budget the cache actually was. The live value is the engine's own
    // counter, read on demand in the /metrics handler.
    /// Number of times a partial-hit plan filled one or more missing extents from upstream
    /// (proves we refetch only the missing sub-range(s), not the entire request).
    pub missing_extents_filled: AtomicU64,
    /// Cumulative microseconds spent in `sync_data()` durability barriers. Slice 4
    /// fsyncs the data file before publishing `present` so restart can trust the
    /// extent map. This counter is the visibility for that cost (the brief:
    /// "Keep any durability cost visible in metrics/waterfall; do not optimize
    /// it yet").
    pub durable_sync_us: AtomicU64,

    // ---- Slice 4.5 A.1/A.2: coalescer origin accounting ----
    /// How many Upstream sub-intervals entered the in-flight coalescer at all.
    /// A.1 requires that partial-hit gaps use the SAME coalescer as full misses,
    /// so this counter must equal `gap_join_full_miss + gap_join_partial_hit`.
    pub coalescer_entries: AtomicU64,
    /// Coalescer entries whose plan was a FULL MISS (no present coverage at all).
    pub gap_join_full_miss: AtomicU64,
    /// Coalescer entries whose plan was a PARTIAL HIT (some present coverage,
    /// this sub-interval is the remaining gap). These must NOT bypass coalescing.
    pub gap_join_partial_hit: AtomicU64,

    // ---- Slice 4.5 A.3: eviction may never touch FILLING ----
    /// Times an eviction sweep REFUSED a candidate file because it still had
    /// `filling` extents. Nonzero proves the guard actually fires rather than
    /// merely existing.
    pub evict_skipped_filling: AtomicU64,
    /// `publish_present` calls whose UPDATE matched zero rows. A nonzero value
    /// is always a bug: it means we incremented `current_bytes` for an extent
    /// the map does not know about, which permanently inflates the byte budget
    /// and drives more eviction. Kept observable rather than silently ignored.
    pub publish_noop: AtomicU64,

    // ---- Slice 4.5 F: byte-accounting reconciliation ----
    /// Total bytes the CLIENT asked for across every request, counted once per
    /// request at plan time. This is the left-hand side of the identity
    /// `bytes_requested_total ~= bytes_local + bytes_upstream`; without it the
    /// two right-hand counters have no denominator to be checked against, which
    /// is how the Slice 4 table ended up with cold and warm implying different
    /// total footprints with no way to tell which was true.
    pub bytes_requested_total: AtomicU64,

    // ---- Slice 4.75: fixed-grid chunk accounting ----
    /// Bytes of provider Range spans we actually ISSUED, counted once per owned
    /// fetch span at dispatch. Under the fixed grid this is >= the bytes the
    /// client needed, because a fetch covers whole chunks. The excess is
    /// `chunk_overfetch_bytes`.
    ///
    /// Deliberately counted at ISSUE, not at delivery: this counter answers
    /// "how much demand did we place on the provider", so a retry does not
    /// inflate it.
    pub bytes_upstream_issued: AtomicU64,
    /// Bytes the provider actually DELIVERED, measured in the chunk callback.
    /// Includes bytes re-delivered by Slice 3.5 recovery (a mid-body resume does
    /// not replay, but a same-capability retry of an un-sent window does).
    /// `bytes_fetched_upstream - bytes_upstream_issued` is therefore the retry /
    /// recovery duplication, reported separately from intentional overfetch.
    pub bytes_fetched_upstream: AtomicU64,
    /// INTENTIONAL overfetch: bytes fetched only because the chunk grid is
    /// coarser than the client's request. `fetch_span_bytes - window_bytes`,
    /// counted once per owned fetch span. This is the price of whole-chunk
    /// durable truth and the number the closure report must state.
    pub chunk_overfetch_bytes: AtomicU64,
    /// Number of provider Range spans issued for chunk fills.
    pub fetch_spans: AtomicU64,
    /// Total chunks covered by those spans. `spans_collapsed_chunks / fetch_spans`
    /// is the network-collapse ratio: >1 means adjacent missing chunks were
    /// fetched as ONE provider Range rather than one Range per chunk.
    pub spans_collapsed_chunks: AtomicU64,
    /// Chunks we claimed ownership of (i.e. we drove the fill).
    pub chunk_claims: AtomicU64,
    /// Chunks we did NOT own because another reader was already filling them.
    pub chunk_join_waits: AtomicU64,
    /// Chunks that reached the durable PRESENT state.
    pub chunk_fills: AtomicU64,
    /// Chunks whose fill failed. A failed chunk is never published.
    pub chunk_fills_failed: AtomicU64,
}

// ---------------------------------------------------------------------------
// Slice 4.5 — per-fetch decision log (drives proof G: attribute every residual
// warm CDN request)
// ---------------------------------------------------------------------------

/// Why an upstream fetch happened, as far as the cache can tell AT DECISION TIME.
/// Deliberately factual rather than interpretive: the proof script re-classifies
/// these against the full timeline (it can see evictions and retries that the
/// cache cannot), but the raw evidence is captured here so the classification is
/// never a guess.
#[derive(Clone, Debug)]
pub struct CacheDecision {
    /// The client's requested `[start, end]` (inclusive) for this request.
    pub request: (u64, u64),
    /// Present extents overlapping the request BEFORE the fetch, as recorded by
    /// the planner. Empty means a full miss.
    pub present_before: Vec<(u64, u64)>,
    /// The exact missing interval handed to the coalescer. A.2 requires this to
    /// be the missing span, never the original client range. Under Slice 4.75
    /// this is the client-window portion of a fetch run.
    pub missing: (u64, u64),
    /// Slice 4.75: the chunk indices this fetch run covers, ascending.
    pub chunk_indices: Vec<u64>,
    /// Slice 4.75: the provider Range actually issued. Wider than `missing`
    /// whenever whole-chunk fetching overfetches; the difference is the
    /// intentional overfetch charged to `chunk_overfetch_bytes`.
    pub fetch_span: Option<(u64, u64)>,
    /// Whether the coalescer found an existing in-flight fill covering part of
    /// `missing` (i.e. this reader joined rather than purely fetching).
    pub joined_inflight: bool,
    /// Bytes of `missing` already covered by in-flight fills.
    pub overlap_bytes_avoided: u64,
    /// "full_miss" | "partial_hit" — which branch of `plan()` produced this gap.
    pub plan_origin: &'static str,
    /// Eviction counter value at decision time, so the proof script can detect
    /// an eviction/refetch (extent was present earlier, then evicted).
    pub evictions_before: u64,
}

/// Bounded ring of recent cache decisions. Bounded because this is diagnostic
/// telemetry on a long-lived server; 256 entries is far more than any proof
/// workload needs and keeps memory flat.
const DECISION_LOG_CAP: usize = 256;

#[derive(Default)]
pub struct DecisionLog {
    entries: Mutex<Vec<CacheDecision>>,
}

impl DecisionLog {
    pub fn push(&self, d: CacheDecision) {
        let mut v = self.entries.lock().unwrap();
        v.push(d);
        if v.len() > DECISION_LOG_CAP {
            let over = v.len() - DECISION_LOG_CAP;
            v.drain(0..over);
        }
    }
    pub fn snapshot(&self) -> Vec<CacheDecision> {
        self.entries.lock().unwrap().clone()
    }
    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }
}

// ---------------------------------------------------------------------------
// Slice 4.5 — T0..T5 cold-open stage clock
// ---------------------------------------------------------------------------

/// Raw stage instants for ONE logical client request.
///
/// Every stage is `Option` because not every stage occurs on every request: a
/// file-warm local hit performs no capability acquisition and no CDN request at
/// all. Those stages stay `None`, and their derived durations are reported as
/// `null` — NEVER as 0. Reporting 0 would claim the stage happened and was
/// instant, which is exactly the kind of fabricated precision the brief forbids.
#[derive(Clone, Copy, Default)]
pub struct StageInstants {
    pub t0_received: Option<Instant>,
    pub t1_acquire_issued: Option<Instant>,
    pub t2_capability_ready: Option<Instant>,
    pub t3_cdn_dispatched: Option<Instant>,
    pub t4_first_upstream_byte: Option<Instant>,
    pub t5_first_client_byte: Option<Instant>,
}

impl StageInstants {
    /// Milliseconds from `a` to `b`, or `None` if either endpoint did not occur.
    fn span_ms(a: Option<Instant>, b: Option<Instant>) -> Option<u64> {
        match (a, b) {
            (Some(x), Some(y)) => Some(y.saturating_duration_since(x).as_millis() as u64),
            _ => None,
        }
    }
}

/// Shared, interior-mutable stage clock. Created per client request and handed
/// to the resilient reader so T3/T4 are stamped at the REAL dispatch and
/// first-body-byte points inside the transport, rather than inferred from total
/// latency at the caller.
#[derive(Clone, Default)]
pub struct StageClock {
    inner: Arc<Mutex<StageInstants>>,
}

impl StageClock {
    pub fn new(t0: Instant) -> Self {
        Self {
            inner: Arc::new(Mutex::new(StageInstants {
                t0_received: Some(t0),
                ..Default::default()
            })),
        }
    }
    pub fn set_t1(&self, t: Instant) {
        self.inner.lock().unwrap().t1_acquire_issued = Some(t);
    }
    pub fn set_t2(&self, t: Instant) {
        self.inner.lock().unwrap().t2_capability_ready = Some(t);
    }
    pub fn set_t3(&self, t: Instant) {
        // First dispatch wins: later attempts are recovery retries, and the
        // cold-open waterfall is about the FIRST byte path.
        let mut g = self.inner.lock().unwrap();
        if g.t3_cdn_dispatched.is_none() {
            g.t3_cdn_dispatched = Some(t);
        }
    }
    pub fn set_t4(&self, t: Instant) {
        let mut g = self.inner.lock().unwrap();
        if g.t4_first_upstream_byte.is_none() {
            g.t4_first_upstream_byte = Some(t);
        }
    }
    pub fn set_t5(&self, t: Instant) {
        let mut g = self.inner.lock().unwrap();
        if g.t5_first_client_byte.is_none() {
            g.t5_first_client_byte = Some(t);
        }
    }
    pub fn snapshot(&self) -> StageInstants {
        *self.inner.lock().unwrap()
    }
}

/// One completed request's stage waterfall, in the shape the benchmark consumes.
/// All stage fields are nullable; see `StageInstants`.
#[derive(Clone, Copy)]
pub struct StageReport {
    pub instants: StageInstants,
    pub request: (u64, u64),
    pub cache_hit: bool,
    /// Provider API (requestdl/unrestrict) calls made by THIS request. Zero means
    /// the capability was reused, which is the whole point of separating process
    /// cold from process warm.
    pub api_requests_delta: u64,
    /// CDN Range requests made by this request.
    pub cdn_requests_delta: u64,
}

impl StageReport {
    /// Serialize as the permanent benchmark contract: raw T0..T5 (ms offsets from
    /// T0, so they are directly comparable across runs) plus every derived stage.
    pub fn to_json(&self) -> serde_json::Value {
        let i = self.instants;
        let off = |t: Option<Instant>| -> Option<u64> {
            i.t0_received
                .and_then(|t0| t.map(|x| x.saturating_duration_since(t0).as_millis() as u64))
        };
        serde_json::json!({
            "request": {"start": self.request.0, "end": self.request.1},
            "cache_hit": self.cache_hit,
            "api_requests_delta": self.api_requests_delta,
            "cdn_requests_delta": self.cdn_requests_delta,
            // Raw timestamps as ms offsets from T0.
            "T0_received_ms": off(i.t0_received),
            "T1_acquire_issued_ms": off(i.t1_acquire_issued),
            "T2_capability_ready_ms": off(i.t2_capability_ready),
            "T3_cdn_dispatched_ms": off(i.t3_cdn_dispatched),
            "T4_first_upstream_byte_ms": off(i.t4_first_upstream_byte),
            "T5_first_client_byte_ms": off(i.t5_first_client_byte),
            // Derived stages. Null where the stage did not occur.
            "control_pre_acquire_ms": StageInstants::span_ms(i.t0_received, i.t1_acquire_issued),
            "acquisition_api_ms": StageInstants::span_ms(i.t1_acquire_issued, i.t2_capability_ready),
            "provider_connect_ms": StageInstants::span_ms(i.t2_capability_ready, i.t3_cdn_dispatched),
            "provider_ttfb_ms": StageInstants::span_ms(i.t3_cdn_dispatched, i.t4_first_upstream_byte),
            "downstream_handoff_ms": StageInstants::span_ms(i.t4_first_upstream_byte, i.t5_first_client_byte),
            "capability_to_client_ms": StageInstants::span_ms(i.t2_capability_ready, i.t5_first_client_byte),
            "total_open_ttfb_ms": StageInstants::span_ms(i.t0_received, i.t5_first_client_byte),
        })
    }
}

impl Metrics {
    pub fn record_api(&self, status: u16, latency: Duration) {
        self.api_requests.fetch_add(1, Ordering::SeqCst);
        let ms = latency.as_millis() as u64;
        self.api_latency_ms.fetch_add(ms, Ordering::SeqCst);
        self.api_latency_n.fetch_add(1, Ordering::SeqCst);
        match status {
            200..=299 => {
                self.api_2xx.fetch_add(1, Ordering::SeqCst);
            }
            429 => {
                self.api_429.fetch_add(1, Ordering::SeqCst);
            }
            400..=499 => {
                self.api_4xx.fetch_add(1, Ordering::SeqCst);
            }
            _ => {
                self.api_5xx.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    pub fn record_redirect_hop(&self) {
        self.redirect_hops.fetch_add(1, Ordering::SeqCst);
    }

    pub fn record_cdn(&self, status: u16, latency: Duration, host: &str) {
        self.cdn_requests.fetch_add(1, Ordering::SeqCst);
        let ms = latency.as_millis() as u64;
        self.cdn_latency_ms.fetch_add(ms, Ordering::SeqCst);
        self.cdn_latency_n.fetch_add(1, Ordering::SeqCst);
        *self.final_cdn_host.lock().unwrap() = Some(host.to_string());
        match status {
            200..=299 => {
                self.cdn_2xx.fetch_add(1, Ordering::SeqCst);
                if status == 206 {
                    self.cdn_206.fetch_add(1, Ordering::SeqCst);
                }
            }
            429 => {
                self.cdn_429.fetch_add(1, Ordering::SeqCst);
            }
            400..=499 => {
                self.cdn_4xx.fetch_add(1, Ordering::SeqCst);
            }
            _ => {
                self.cdn_5xx.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    pub fn set_final_cdn_host(&self, host: &str) {
        *self.final_cdn_host.lock().unwrap() = Some(host.to_string());
    }

    pub fn record_cap_reuse(&self) {
        self.capability_reuses.fetch_add(1, Ordering::SeqCst);
    }
    pub fn record_cap_eviction(&self) {
        self.capability_evictions.fetch_add(1, Ordering::SeqCst);
    }
    pub fn record_cap_reacquire(&self) {
        self.capability_reacquisitions.fetch_add(1, Ordering::SeqCst);
    }
    pub fn record_negative_hit(&self) {
        self.capability_negative_hits.fetch_add(1, Ordering::SeqCst);
    }
    pub fn record_limiter_wait(&self) {
        self.limiter_waits.fetch_add(1, Ordering::SeqCst);
    }
    /// A read blocked waiting for a capability's maxInFlight=1 permit.
    ///
    /// Distinct from `record_limiter_wait`, which is a throttle cooldown. See
    /// the field comment on `limiter_waits` for why they are kept separate.
    pub fn record_limiter_permit_wait(&self) {
        self.limiter_permit_waits.fetch_add(1, Ordering::SeqCst);
    }
    pub fn record_breaker_open(&self) {
        self.breaker_opens.fetch_add(1, Ordering::SeqCst);
    }

    // ---- §10 recovery-budget accounting ----
    pub fn record_recovery_attempt(&self) {
        self.recovery_attempts.fetch_add(1, Ordering::SeqCst);
    }
    /// Capture a per-request recovery summary into the global maxima + totals.
    pub fn record_recovery_summary(&self, same_cap_retries: u32, reacquires: u32, wall_ms: u64) {
        let _ = self
            .max_same_cap_retries
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |cur| {
                Some(cur.max(same_cap_retries as u64))
            });
        let _ = self
            .max_reacquires
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |cur| {
                Some(cur.max(reacquires as u64))
            });
        self.recovery_wall_ms.fetch_add(wall_ms, Ordering::SeqCst);
    }
    pub fn record_internal_recovery_ok(&self) {
        self.internal_recoveries.fetch_add(1, Ordering::SeqCst);
    }
    pub fn record_mid_body_resume(&self) {
        self.mid_body_resumes.fetch_add(1, Ordering::SeqCst);
    }

    // ---- §11 Retry-After observability ----
    pub fn record_retry_after(&self, provider: Option<u64>, applied: u64) {
        *self.retry_after_provider_secs.lock().unwrap() = provider;
        *self.retry_after_applied_secs.lock().unwrap() = Some(applied);
    }

    // ---- §15 cumulative timing ----
    pub fn add_limiter_wait_ms(&self, ms: u64) {
        self.limiter_wait_ms_total.fetch_add(ms, Ordering::SeqCst);
    }
    pub fn add_internal_recovery_ms(&self, ms: u64) {
        self.internal_recovery_ms_total.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn avg(a: u64, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            a / n
        }
    }

    /// `a / b` as a float rounded to 4 dp, or 0 when `b` is 0.
    ///
    /// Reported as a ratio rather than a percentage because overfetch can
    /// exceed 1.0 (we may legitimately fetch several times more than the client
    /// asked for when a request touches the tail of one chunk).
    pub fn ratio(a: u64, b: u64) -> f64 {
        if b == 0 {
            0.0
        } else {
            let v = (a as f64) / (b as f64);
            (v * 10000.0).round() / 10000.0
        }
    }

    /// Count a client GET at request start (includes GETs that later fail before any byte).
    pub fn record_request(&self) {
        self.requests.fetch_add(1, Ordering::SeqCst);
    }

    /// Record first-byte TTFB for the cold/warm request (observational; does NOT touch the
    /// request counter, which is incremented by `record_request` at request start).
    pub fn record_first_byte(&self, ttfb: u64) {
        let n = self.requests.load(Ordering::SeqCst);
        if n == 1 {
            *self.cold_ttfb_ms.lock().unwrap() = Some(ttfb);
        } else if n == 2 {
            *self.warm_ttfb_ms.lock().unwrap() = Some(ttfb);
        }
    }
}
