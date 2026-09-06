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
use crate::manager::{CapabilityManager, ReservedCapability};
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
}

pub struct ResilientRangeReader {
    client: reqwest::Client,
    metrics: Arc<Metrics>,
    manager: Arc<CapabilityManager>,
    current: ReservedCapability,
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
}

impl ResilientRangeReader {
    /// Attach a Slice 4.5 stage clock so T3/T4 can be stamped at the real
    /// transport instants.
    pub fn set_stage_clock(&mut self, c: StageClock) {
        self.stage = Some(c);
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
            current,
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
            },
            faults,
            first_attempt: true,
            midbody_triggered: false,
            on_chunk,
            stage: None,
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
                let url = self.current.cap.runtime_url.clone();
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
                    Err(_) => {
                        // Network/transport error -> transient (Class B).
                        self.metrics
                            .upstream_errors
                            .fetch_add(1, Ordering::SeqCst);
                        match self.apply_transient(None).await {
                            Action::RetrySameCap => {
                                forced_status = None;
                                continue;
                            }
                            Action::Fatal(e) => return Err(e),
                            _ => unreachable!(),
                        }
                    }
                };
                let cdn_elapsed = cdn_start.elapsed();
                status = resp.status().as_u16();
                let host = host_of(&url).unwrap_or_default();
                self.metrics.record_cdn(status, cdn_elapsed, &host);
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
        self.current.cap.throttle(Instant::now() + effective);
        self.metrics.record_recovery_attempt();
        self.recovery.same_cap_retries += 1;
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

    /// Class C: capability rejected (401/403/404/410). Mark dead, single-flight reacquire ONCE,
    /// then signal a reopen at the SAME offset. Never infer capability death merely from another
    /// acquire. Non-recursive: returns an `Action`; `open_at` owns the loop.
    async fn apply_dead(&mut self) -> Action {
        self.enter_recovery();
        self.current.cap.mark_dead();
        self.metrics
            .upstream_errors
            .fetch_add(1, Ordering::SeqCst);
        self.metrics.record_recovery_attempt();
        self.recovery.reacquires += 1;
        if self.recovery.reacquires <= MAX_REACQUIRES {
            match self.manager.reacquire_for_read(self.priority).await {
                Ok(new_reserved) => {
                    self.metrics
                        .capability_reacquisitions
                        .fetch_add(1, Ordering::SeqCst);
                    self.current = new_reserved;
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
