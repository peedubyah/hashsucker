// Slice 3.5 — ResilientRangeReader: the per-read transport layer (Decypharr-style).
//
// This is the logical transport that owns the CURRENT OFFSET and can REOPEN the provider
// body UNDERNEATH the caller. From the HTTP handler's point of view the client `Range` is
// ONE logical operation: it asks for bytes [start, end] and receives a single 206 stream.
// Internally this reader replays/retries as needed:
//
//   Class A (link acquisition / API failure)  -> handled by the manager (acquire_for_read /
//       reacquire_for_read); here we only observe a fresh capability.
//   Class B (LIVE CDN STREAM failure: 429 / 5xx / transport drop / reset / EOF)
//       -> DO NOT mark the capability dead, DO NOT immediately expose 503, DO NOT
//          re-acquire requestdl. Wait behind the shared limiter/breaker and REOPEN the SAME
//          capability at the SAME offset (mid+1 after a mid-body drop). Bounded budget.
//   Class C (STALE/REJECTED capability: 401/403/404/410) -> mark dead, single-flight
//       reacquire ONCE (manager.reacquire_for_read), then reopen at the SAME offset.
//   416 -> permanent for that Range; no provider recovery.
//
// The reader is the ONLY place that understands recovery. The HTTP handler just streams
// from `next_chunk()` and never sees a retry.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use reqwest::header::{RANGE, RETRY_AFTER};

use crate::capability::parse_retry_after;
use crate::capability::DeliveryCapability;
use crate::manager::{CapabilityManager, ChildReaderHandle, ReservedCapability};
use crate::metrics::{Metrics, StageClock};
use crate::provider::host_of;

// §10 — bounded recovery budgets (configurable, reported separately).
const MAX_SAME_CAP_RETRIES: u32 = 3; // transient 429/5xx/transport reopen attempts per read
const MAX_REACQUIRES: u32 = 1; // dead-link single-flight reacquire-once
const RECOVERY_BACKOFF_DEFAULT: Duration = Duration::from_secs(30); // applied when no Retry-After

/// Default-off fault gates (validation scaffold only; never set in production).
#[derive(Clone, Copy)]
pub struct Faults {
    pub fault_429_always: bool, // every CDN attempt -> 429 (proves budget-exhaust -> 503, no reacquire)
    pub fault_429_once: bool,   // first CDN attempt per request -> 429 then 206 (proves internal hide)
    pub fault_dead_once: bool,  // first attempt of original cap -> 403 then real 206 (reacquire-once)
    pub fault_midbody_once: bool, // drop connection after first delivered chunk (mid-body resume)
}

/// A stale-link fault is meant to simulate ONE dead capability, not one per reader. We fire
/// `fault_dead_once` exactly once for the whole process so the proof "reacquire-once + resume"
/// stays deterministic (the other 18 reads then flow through the freshly reacquired cap).
static DEAD_FAULT_FIRED: AtomicBool = AtomicBool::new(false);

/// Failure to open a provider connection that could not be internally recovered.
/// Surfaced to the client ONLY when no bytes have been delivered yet (we can still change
/// the HTTP status). After streaming has begun, a failure can only truncate the 206 body.
pub enum OpenError {
    Client503, // transient recovery exhausted before any byte
    Client502, // dead-link reacquire exhausted before any byte
    Client416, // provider rejected the Range (permanent for this request)
}

/// One step of the logical stream presented to the caller.
pub enum Step {
    Chunk(Bytes),
    Eof,
    Terminal(OpenError), // recovery exhausted mid-body -> caller must truncate
}

/// What `open_at`'s recovery loop should do after a non-206 status. Helpers return this
/// instead of recursing, so no async fn calls another (avoids E0733 recursive-async).
/// Module-level (not nested in the impl) so it resolves in every method's scope.
enum Action {
    RetrySameCap,
    Reacquire,
    Fatal(OpenError),
}

struct Recovery {
    same_cap_retries: u32,
    reacquires: u32,
    /// Wall-clock milliseconds spent INSIDE internal recovery: from the first recoverable
    /// failure to either a successful resumption or bounded exhaustion. Excludes normal
    /// healthy transfer time. Closed in `finalize` once the read terminates.
    wall_ms: u64,
    /// `Some(t)` once the reader has entered the recovery path; used to measure wall time.
    /// `None` while the read is still in normal transfer or after `finalize` has run.
    recovery_started_at: Option<Instant>,
    /// Monotonic attempt counter for per-attempt CDN telemetry.
    attempt: u32,
}

/// How this reader holds its capability. `Owned` is the normal reservation
/// carrying the single permit; `Shared` borrows from a `CapabilityLease` and
/// carries no permit of its own. The shared variant is constructed only by the
/// `*shared_child*` constructors and cannot promote, reacquire independently, or
/// hand back a reservation via `into_reserved`.
enum ReaderCapability {
    Owned(ReservedCapability),
    Shared(ChildReaderHandle),
}

pub struct ResilientRangeReader {
    client: reqwest::Client,
    metrics: Arc<Metrics>,
    manager: Arc<CapabilityManager>,
    current: ReaderCapability,
    priority: u8,
    start: u64,
    req_end: u64, // inclusive end requested from the provider
    size: u64,    // authoritative file size (byte-exact invariant)
    pos: u64,     // next byte to deliver
    is_single: bool,
    response: Option<Box<reqwest::Response>>, // open provider connection (owns its decoder state)
    recovery: Recovery,
    faults: Faults,
    first_attempt: bool, // drives the *-once fault gates
    midbody_triggered: bool,
    /// Optional Slice 4 cache callback. Receives `(offset, &bytes)` for every chunk
    /// the resilient reader has committed to. The cache layer is responsible for
    /// writing verified bytes and publishing extents; the resilient reader does
    /// NOT know about the cache.
    on_chunk: Option<Arc<dyn Fn(u64, &[u8]) + Send + Sync>>,
    /// Slice 4.5 stage clock. Stamped here (not by the caller) because T3 and T4
    /// are only knowable inside the transport: T3 is the instant the CDN Range
    /// request is dispatched, T4 the instant the first body byte arrives. reqwest
    /// exposes neither as a separate timing, so we stamp them ourselves at the
    /// observable points rather than inventing a TCP/TLS timestamp.
    stage: Option<StageClock>,
    /// Instant when the most recent CDN response headers were received.
    last_headers_at: Option<Instant>,
}

impl ResilientRangeReader {
    /// Attach a Slice 4.5 stage clock so T3/T4 can be stamped at the real
    /// transport instants.
    pub fn set_stage_clock(&mut self, c: StageClock) {
        self.stage = Some(c);
    }

    /// T12 (proven as HY4 P2P on m3-north-db): hand back the fill's final
    /// reservation (post any in-fill reacquire replacement) so a stripe
    /// worker threads the same warm lane across chunk fills with zero
    /// acquisition. Additive accessor only: limiter/breaker/retry
    /// semantics are untouched.
    ///
    /// Returns `None` for a shared child reader (it holds no reservation of
    /// its own); the caller must handle the `None` path.
    pub fn into_reserved(self) -> Option<ReservedCapability> {
        match self.current {
            ReaderCapability::Owned(r) => Some(r),
            ReaderCapability::Shared(_) => None,
        }
    }

    /// T16: live producer identity for throughput-epoch attribution
    /// (proven as HY4 P2M on m3-north-db). Additive accessor only:
    /// recovery/limiter/breaker policy is untouched.
    pub fn current_cap(&self) -> Arc<DeliveryCapability> {
        match &self.current {
            ReaderCapability::Owned(r) => r.cap.clone(),
            ReaderCapability::Shared(h) => h.cap.clone(),
        }
    }

    /// T16: warm-promotion handoff (proven as HY4 P2M on m3-north-db).
    /// Replace the live producer with an already-warm same-TF reservation
    /// and resume at the current offset through the existing reopen path
    /// (`next_chunk` reopens via `open_at` at `self.pos` whenever no
    /// response is open). No acquisition and no recovery budget is consumed
    /// here; the old reservation drops (its permit freed). Call only on
    /// healthy delivery -- failure/recovery ordering stays authoritative.
    ///
    /// Shared children must not promote (it would bypass the lease's permit
    /// accounting); the call is a no-op for the shared variant so that a
    /// mis-ordered handoff cannot silently corrupt ownership.
    pub fn promote_to(&mut self, next: ReservedCapability) {
        match &mut self.current {
            ReaderCapability::Owned(r) => {
                *r = next;
                self.response = None;
            }
            ReaderCapability::Shared(_) => {}
        }
    }
    /// Shared-child construction. The reader borrows from a `CapabilityLease`:
    /// it holds no permit of its own, so `into_reserved` returns `None` and the
    /// child must never independently reacquire (a Class C dead-link would race
    /// the sibling for the single permit). Recovery budgets still apply per-read;
    /// Class C (dead-link) surfaces as a fatal terminal so the owner can decide
    /// on a single reacquire without coordinating two children.
    #[allow(clippy::too_many_arguments)]
    pub fn new_shared_child(
        client: reqwest::Client,
        metrics: Arc<Metrics>,
        manager: Arc<CapabilityManager>,
        child: ChildReaderHandle,
        priority: u8,
        start: u64,
        req_end: u64,
        size: u64,
        is_single: bool,
        faults: Faults,
    ) -> Self {
        Self::new_shared_child_with_chunk_cb(
            client, metrics, manager, child, priority, start, req_end, size, is_single, faults, None,
        )
    }

    /// Access the underlying capability regardless of how this reader holds
    /// it. Used by the transport's HTTP/recovery paths so they don't branch on
    /// the reservation model.
    fn cap_ref(&self) -> &Arc<DeliveryCapability> {
        match &self.current {
            ReaderCapability::Owned(r) => &r.cap,
            ReaderCapability::Shared(h) => &h.cap,
        }
    }

    /// Shared-child construction with the Slice 4 cache callback.
    #[allow(clippy::too_many_arguments)]
    pub fn new_shared_child_with_chunk_cb(
        client: reqwest::Client,
        metrics: Arc<Metrics>,
        manager: Arc<CapabilityManager>,
        child: ChildReaderHandle,
        priority: u8,
        start: u64,
        req_end: u64,
        size: u64,
        is_single: bool,
        faults: Faults,
        on_chunk: Option<Arc<dyn Fn(u64, &[u8]) + Send + Sync>>,
    ) -> Self {
        Self {
            client,
            metrics,
            manager,
            current: ReaderCapability::Shared(child),
            priority,
            start,
            req_end,
            size,
            pos: start,
            is_single,
            response: None,
            recovery: Recovery {
                same_cap_retries: 0,
                reacquires: 0,
                wall_ms: 0,
                recovery_started_at: None,
                attempt: 1,
            },
            faults,
            first_attempt: true,
            midbody_triggered: false,
            on_chunk,
            stage: None,
            last_headers_at: None,
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        client: reqwest::Client,
        metrics: Arc<Metrics>,
        manager: Arc<CapabilityManager>,
        current: ReservedCapability,
        priority: u8,
        start: u64,
        req_end: u64,
        size: u64,
        is_single: bool,
        faults: Faults,
    ) -> Self {
        Self::new_with_chunk_cb(client, metrics, manager, current, priority, start, req_end, size, is_single, faults, None)
    }

    /// Variant that also accepts a Slice 4 cache callback. The callback fires for every chunk
    /// the reader has committed to delivering (i.e. AFTER any internal recovery), with the
    /// chunk's authoritative offset and bytes.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_chunk_cb(
        client: reqwest::Client,
        metrics: Arc<Metrics>,
        manager: Arc<CapabilityManager>,
        current: ReservedCapability,
        priority: u8,
        start: u64,
        req_end: u64,
        size: u64,
        is_single: bool,
        faults: Faults,
        on_chunk: Option<Arc<dyn Fn(u64, &[u8]) + Send + Sync>>,
    ) -> Self {
        Self {
            client,
            metrics,
            manager,
            current: ReaderCapability::Owned(current),
            priority,
            start,
            req_end,
            size,
            pos: start,
            is_single,
            response: None,
            recovery: Recovery {
                same_cap_retries: 0,
                reacquires: 0,
                wall_ms: 0,
                recovery_started_at: None,
                attempt: 1,
            },
            faults,
            first_attempt: true,
            midbody_triggered: false,
            on_chunk,
            stage: None,
            last_headers_at: None,
        }
    }

    /// Open (or reopen) the provider body at the current offset. Bounded internal recovery.
    /// Single async fn with an internal retry loop (no recursion). Caller guarantees
    /// `self.response` is `None` on entry.
    async fn open_at(&mut self) -> Result<(), OpenError> {
        let range = format!("bytes={}-{}", self.pos, self.req_end);

        // Fault injection on the FIRST attempt of this read only.
        let forced = if self.first_attempt {
            if self.faults.fault_429_once {
                Some(429u16)
            } else if self.faults.fault_dead_once {
                // Fire the stale-link fault only ONCE for the whole process (see DEAD_FAULT_FIRED).
                let first = DEAD_FAULT_FIRED.swap(true, Ordering::SeqCst);
                if !first {
                    Some(403)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        self.first_attempt = false;

        let mut forced_status = forced;
        loop {
            let (status, provider_ra): (u16, Option<Duration>);
            if let Some(f) = forced_status {
                status = f;
                provider_ra = None;
            } else {
                let url = self.cap_ref().runtime_url.clone();
                let cdn_start = Instant::now();
                // ---- Slice 4.5 T3: the CDN Range request is dispatched.
                //
                // Operational definition (per the brief): the instant the HTTP
                // request leaves for the CDN. We do NOT report a separate
                // TCP/TLS connect phase — reqwest does not expose one, and
                // inventing it would be fabricated precision. So
                // `provider_connect_ms` = capability-ready -> dispatch, which
                // bundles connect+TLS+request construction honestly under the
                // name the benchmark expects.
                if let Some(s) = self.stage.as_ref() {
                    s.set_t3(cdn_start);
                }
                let resp = match self.client.get(&url).header(RANGE, &range).send().await {
                    Ok(r) => r,
                    Err(e) => {
                        // Network/transport error -> transient (Class B).
                        // Per-attempt telemetry: transport error.
                        // Classify: timeout vs transport error.
                        let outcome = if e.is_timeout() {
                            crate::metrics::AttemptOutcome::Timeout
                        } else {
                            crate::metrics::AttemptOutcome::TransportError
                        };
                        let failed_instant = Instant::now();
                        let headers_ms = failed_instant.saturating_duration_since(cdn_start).as_millis() as u64;
                        let attempt = self.recovery.attempt;
                        if let Some(s) = self.stage.as_ref() {
                            s.record_attempt_headers(attempt, host_of(&url).unwrap_or_default(), 0, cdn_start, headers_ms, None, self.cap_ref().provider.clone(), self.cap_ref().cap_id.clone(), s.corr_id(), outcome);
                            s.record_attempt_retry(attempt, cdn_start, failed_instant, true);
                        }
                        self.metrics
                            .upstream_errors
                            .fetch_add(1, Ordering::SeqCst);
                        // Branch: headerless reqwest timeout (no usable response headers) retries
                        // the SAME capability immediately with zero cooldown. Generic transport
                        // errors (connection refused, DNS failure, etc.) keep the existing 30s
                        // throttle policy. The timeout carries no provider-load signal, so the
                        // generic cooldown over-penalizes.
                        if e.is_timeout() {
                            match self.apply_transient_headerless_timeout().await {
                                Action::RetrySameCap => {
                                    forced_status = None;
                                    continue;
                                }
                                Action::Fatal(e) => return Err(e),
                                _ => unreachable!(),
                            }
                        } else {
                            match self.apply_transient(None).await {
                                Action::RetrySameCap => {
                                    forced_status = None;
                                    continue;
                                }
                                Action::Fatal(e) => return Err(e),
                                _ => unreachable!(),
                            }
                        }
                    }
                };
                let cdn_elapsed = cdn_start.elapsed();
                status = resp.status().as_u16();
                let host = host_of(&url).unwrap_or_default();
                self.metrics.record_cdn(status, cdn_elapsed, &host);
                // Per-attempt telemetry: record headers receipt.
                let attempt = self.recovery.attempt;
                if let Some(s) = self.stage.as_ref() {
                    s.record_attempt_headers(attempt, host.clone(), status, cdn_start, cdn_elapsed.as_millis() as u64, None, self.cap_ref().provider.clone(), self.cap_ref().cap_id.clone(), s.corr_id(), crate::metrics::AttemptOutcome::Pending);
                }
                provider_ra = parse_retry_after(
                    resp.headers()
                        .get(RETRY_AFTER)
                        .and_then(|v| v.to_str().ok()),
                );
                if status == 206 {
                    // Byte-exact invariant (preserved from Slice 2/3): the provider's Content-Range
                    // must agree with our request and the authoritative size before we trust the body.
                    if let Some((s, e, t)) = parse_content_range(
                        resp.headers()
                            .get(reqwest::header::CONTENT_RANGE)
                            .and_then(|v| v.to_str().ok()),
                    ) {
                        if t != self.size || s != self.pos || e != self.req_end {
                            self.metrics
                                .upstream_errors
                                .fetch_add(1, Ordering::SeqCst);
                            return Err(OpenError::Client502);
                        }
                    }
                    self.response = Some(Box::new(resp));
                    // Stamp headers receipt instant for T4/body timing.
                    self.last_headers_at = Some(Instant::now());
                    return Ok(());
                }
            }

            // Classify the non-206 status.
            match status {
                0 | 429 | 500..=599 => match self.apply_transient(provider_ra).await {
                    Action::RetrySameCap => {
                        forced_status = None;
                        continue;
                    }
                    Action::Fatal(e) => return Err(e),
                    _ => unreachable!(),
                },
                401 | 403 | 404 | 410 => match self.apply_dead().await {
                    Action::Reacquire => {
                        forced_status = None;
                        continue;
                    }
                    Action::Fatal(e) => return Err(e),
                    _ => unreachable!(),
                },
                416 => return Err(OpenError::Client416),
                _ => return Err(OpenError::Client502),
            }
        }
    }

    /// Mark the reader as having entered the internal-recovery window. Idempotent: subsequent
    /// calls do not reset the start instant, so the wall measurement spans the whole recovery
    /// path (not each individual retry).
    fn enter_recovery(&mut self) {
        if self.recovery.recovery_started_at.is_none() {
            self.recovery.recovery_started_at = Some(Instant::now());
        }
    }

    /// Class B: CDN 429 / 5xx / transport drop. Throttle the SAME capability (cooldown only —
    /// never expire), wait behind the shared limiter, and signal a retry at the SAME offset.
    /// No requestdl re-acquire (that would amplify API calls). Bounded by MAX_SAME_CAP_RETRIES.
    /// Non-recursive: returns an `Action`; `open_at` owns the loop.
    async fn apply_transient(&mut self, provider_ra: Option<Duration>) -> Action {
        let ra = provider_ra.unwrap_or(RECOVERY_BACKOFF_DEFAULT);
        // Fault gates use a ZERO cooldown so the deterministic test does not sleep; this
        // isolates the amplification question (does a CDN 429 still re-hit requestdl?).
        let effective = if self.faults.fault_429_always || self.faults.fault_429_once {
            Duration::ZERO
        } else {
            ra
        };
        self.enter_recovery();
        self.cap_ref().throttle(Instant::now() + effective);
        self.metrics.record_recovery_attempt();
        self.recovery.same_cap_retries += 1;
        // Record the enforced wait on the FAILING attempt BEFORE incrementing,
        // so the timeline reads: "attempt N failed -> waited W ms -> attempt N+1".
        let retry_wait = self.cap_ref().throttle_until()
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        if let Some(s) = self.stage.as_ref() {
            s.set_attempt_retry_wait(self.recovery.attempt, retry_wait);
            s.set_attempt_recovery_path(self.recovery.attempt, "generic_transient_cooldown");
        }
        self.recovery.attempt += 1;
        let applied_ms = effective.as_millis() as u64;
        self.metrics
            .record_retry_after(provider_ra.map(|d| d.as_secs()), effective.as_secs());
        self.metrics.add_internal_recovery_ms(applied_ms);
        if self.recovery.same_cap_retries <= MAX_SAME_CAP_RETRIES {
            if !effective.is_zero() {
                self.metrics.add_limiter_wait_ms(applied_ms);
                // `limiter_waits` counts wait EVENTS and is surfaced on
                // /metrics, but `record_limiter_wait()` was never called from
                // anywhere, so it read a permanent 0 — the same dead-metric
                // class as Slice 4's extents_present/extents_filling. Wire it
                // to the one place a limiter wait is actually served.
                self.metrics.record_limiter_wait();
                tokio::time::sleep(effective).await;
            }
            Action::RetrySameCap
        } else {
            Action::Fatal(OpenError::Client503)
        }
    }

    /// Class B headerless timeout: reqwest timeout with NO usable response headers.
    ///
    /// This is NOT a provider rate-limit directive (no Retry-After signal). It is a single
    /// CDN host failing to respond within the reqwest client timeout. Applying the generic
    /// 30s `RECOVERY_BACKOFF_DEFAULT` throttle here over-penalizes: it blocks this reader
    /// AND every other reader sharing the capability from retrying promptly, even though the
    /// failure carries zero information about provider load.
    ///
    /// So this path retries the SAME capability immediately (zero cooldown), consuming the
    /// same-cap retry budget exactly like `apply_transient`. It does NOT throttle the
    /// capability — other readers are not penalized.
    async fn apply_transient_headerless_timeout(&mut self) -> Action {
        self.enter_recovery();
        self.metrics.record_recovery_attempt();
        self.recovery.same_cap_retries += 1;
        // Telemetry: explicit zero cooldown so the timeline is unambiguous.
        if let Some(s) = self.stage.as_ref() {
            s.set_attempt_retry_wait(self.recovery.attempt, 0);
            s.set_attempt_recovery_path(self.recovery.attempt, "headerless_timeout_zero_cooldown");
        }
        self.recovery.attempt += 1;
        let applied_ms = 0;
        self.metrics
            .record_retry_after(None, applied_ms);
        self.metrics.add_internal_recovery_ms(applied_ms);
        if self.recovery.same_cap_retries <= MAX_SAME_CAP_RETRIES {
            Action::RetrySameCap
        } else {
            Action::Fatal(OpenError::Client503)
        }
    }

    /// Class C: capability rejected (401/403/404/410). Mark dead, single-flight reacquire ONCE,
    /// then signal a reopen at the SAME offset. Never infer capability death merely from another
    /// acquire. Non-recursive: returns an `Action`; `open_at` owns the loop.
    async fn apply_dead(&mut self) -> Action {
        self.enter_recovery();
        self.cap_ref().mark_dead();
        self.metrics
            .upstream_errors
            .fetch_add(1, Ordering::SeqCst);
        self.metrics.record_recovery_attempt();
        // Record retry wait on the failing attempt BEFORE incrementing.
        // Class C reacquires fresh caps: no throttle wait, but still record
        // on the failing attempt so the timeline is complete.
        if let Some(s) = self.stage.as_ref() {
            s.set_attempt_retry_wait(self.recovery.attempt, 0);
            s.set_attempt_recovery_path(self.recovery.attempt, "dead_capability_reacquire");
        }
        self.recovery.attempt += 1;
        self.recovery.reacquires += 1;
        // Shared children cannot independently reacquire: a reacquire would race the sibling
        // for the single permit. Surface fatal to the lease owner instead.
        if matches!(self.current, ReaderCapability::Shared(_)) {
            return Action::Fatal(OpenError::Client502);
        }
        if self.recovery.reacquires <= MAX_REACQUIRES {
            match self.manager.reacquire_for_read(self.priority).await {
                Ok(new_reserved) => {
                    self.metrics
                        .capability_reacquisitions
                        .fetch_add(1, Ordering::SeqCst);
                    self.current = ReaderCapability::Owned(new_reserved);
                    Action::Reacquire
                }
                Err(_) => Action::Fatal(OpenError::Client502),
            }
        } else {
            Action::Fatal(OpenError::Client502)
        }
    }

    /// Public: ensure a provider connection is open before the handler commits 206 headers.
    /// If this fails, no bytes have been delivered, so the caller may return an explicit status.
    pub async fn ensure_open(&mut self) -> Result<(), OpenError> {
        if self.response.is_some() {
            return Ok(());
        }
        self.open_at().await
    }

    /// Advance the logical stream by one chunk, performing internal recovery transparently.
    pub async fn next_chunk(&mut self) -> Step {
        if self.pos > self.req_end {
            self.finalize(true);
            return Step::Eof;
        }
        if self.response.is_none() {
            match self.open_at().await {
                Ok(()) => {}
                Err(e) => {
                    self.finalize(false);
                    return Step::Terminal(e);
                }
            }
        }
        loop {
            // Capture the next chunk into an OWNED value first so the mutable borrow of
            // `self.response` is released before we (re)assign `self.response` below.
            let chunk = {
                let resp = self.response.as_mut().unwrap();
                resp.chunk().await
            };
            match chunk {
                Ok(Some(b)) => {
                    // ---- Slice 4.5 T4: the first upstream CDN BODY byte arrived.
                    // `resp.chunk()` is the first await that yields body bytes;
                    // `.send()` returning only means headers arrived. Stamping T4
                    // at `.send()` would under-report provider TTFB by exactly
                    // the header-to-first-body gap.
                    if let Some(s) = self.stage.as_ref() {
                        s.set_t4(Instant::now());
                    // Per-attempt telemetry: record T4/body instant.
                    if let Some(hdr_instant) = self.last_headers_at.take() {
                        let attempt = self.recovery.attempt;
                        if let Some(s) = self.stage.as_ref() {
                            s.record_attempt_body(attempt, hdr_instant, Instant::now());
                        }
                    }
                    }
                    if self.is_single && self.pos == self.start {
                        // RD_SINGLE_BYTE_WORKAROUND: provider gave 2 bytes; hand back exactly 1.
                        let one = b.slice(0..1);
                        self.pos = self.req_end + 1;
                        self.metrics
                            .bytes_streamed
                            .fetch_add(1, Ordering::SeqCst);
                        self.finalize(true);
                        return Step::Chunk(one);
                    }
                    let n = b.len() as u64;
                    let chunk_offset = self.pos; // bytes start at the previous self.pos
                    self.pos += n;
                    self.metrics
                        .bytes_streamed
                        .fetch_add(n, Ordering::SeqCst);
                    // §3 PROOF C (fault-injected mid-body disconnect): after delivering the
                    // first chunk, simulate a transport drop so the NEXT offset is recovered from
                    // exactly `self.pos` (mid+1) with NO replay of already-delivered bytes. We drop
                    // the open response and let the next `next_chunk` reopen at `self.pos`.
                    if self.faults.fault_midbody_once
                        && !self.midbody_triggered
                        && !self.is_single
                        && self.pos > self.start
                    {
                        self.midbody_triggered = true;
                        self.response = None;
                        self.metrics.record_mid_body_resume();
                        self.metrics.record_recovery_attempt();
                        if let Some(s) = self.stage.as_ref() {
                            s.set_attempt_recovery_path(self.recovery.attempt, "mid_body_resume");
                        }
                        self.recovery.same_cap_retries += 1;
                    }
                    // Slice 4: notify the cache layer of the authoritative bytes we just
                    // committed to. The cache layer writes to its sparse file and only
                    // publishes `present` once the upstream read fully completes — never
                    // before, even though we forward the bytes to the client now.
                    if let Some(cb) = self.on_chunk.as_ref() {
                        cb(chunk_offset, &b);
                    }
                    if self.pos > self.req_end {
                        self.response = None;
                        self.finalize(true);
                        return Step::Chunk(b);
                    }
                    return Step::Chunk(b);
                }
                Ok(None) => {
                    // Provider closed the stream. If we still owe bytes, reopen at the current
                    // offset (continuous logical stream from the client's perspective).
                    self.response = None;
                    if self.pos > self.req_end {
                        self.finalize(true);
                        return Step::Eof;
                    }
                    match self.open_at().await {
                        Ok(()) => continue,
                        Err(e) => {
                            self.finalize(false);
                            return Step::Terminal(e);
                        }
                    }
                }
                Err(_) => {
                    // Mid-body transport failure (reset / EOF / stall). Resume from self.pos
                    // (== mid+1). This is the core §3 requirement: do NOT replay delivered bytes.
                    self.response = None;
                    if self.faults.fault_midbody_once
                        && !self.midbody_triggered
                        && self.pos > self.start
                    {
                        self.midbody_triggered = true;
                        self.metrics.record_mid_body_resume();
                    }
                    self.metrics.record_recovery_attempt();
                    if let Some(s) = self.stage.as_ref() {
                        s.set_attempt_recovery_path(self.recovery.attempt, "mid_body_resume");
                    }
                    self.recovery.same_cap_retries += 1;
                    if self.recovery.same_cap_retries <= MAX_SAME_CAP_RETRIES {
                        match self.open_at().await {
                            Ok(()) => continue,
                            Err(e) => {
                                self.finalize(false);
                                return Step::Terminal(e);
                            }
                        }
                    } else {
                        self.metrics
                            .client_truncated
                            .fetch_add(1, Ordering::SeqCst);
                        self.finalize(false);
                        return Step::Terminal(OpenError::Client502);
                    }
                }
            }
        }
    }

    fn finalize(&mut self, success: bool) {
        // Close the recovery wall-time window (if open) BEFORE recording the summary so the
        // value is a true wall-clock elapsed inside internal recovery, not a sum of cooldown
        // durations. The window spans the whole recovery path: first recoverable failure ->
        // either success or bounded exhaustion.
        if let Some(started) = self.recovery.recovery_started_at.take() {
            self.recovery.wall_ms = started.elapsed().as_millis() as u64;
        }
        self.metrics.record_recovery_summary(
            self.recovery.same_cap_retries,
            self.recovery.reacquires,
            self.recovery.wall_ms,
        );
        if success && (self.recovery.same_cap_retries > 0 || self.recovery.reacquires > 0) {
            self.metrics.record_internal_recovery_ok();
        }
    }
}

/// Minimal Content-Range parser (kept local; the manager already validates authority).
fn parse_content_range(hdr: Option<&str>) -> Option<(u64, u64, u64)> {
    let hdr = hdr?;
    let h = hdr.trim();
    let lower = h.to_ascii_lowercase();
    let rest = lower.strip_prefix("bytes ")?;
    let mut it = rest.split('/');
    let range = it.next()?;
    let total: u64 = it.next()?.parse().ok()?;
    if range == "*" {
        return None;
    }
    let mut se = range.splitn(2, '-');
    let s: u64 = se.next()?.parse().ok()?;
    let e: u64 = se.next()?.parse().ok()?;
    Some((s, e, total))
}
