//! T15 sustained-useful-throughput detector (proven as HY4 P2L on m3-north-db).
//!
//! Measures provider useful-body throughput for ONE active fill and
//! classifies a sustained low-rate condition. Detector only: it records
//! verdicts and reports them through an optional callback. It NEVER
//! promotes, fails over, hedges, acquires, or mutates scheduler state.
//!
//! WHAT IS COUNTED
//!   Only upstream useful body bytes handed to `observe()` -- in production
//!   a future fill loop would call it from the committed post-recovery
//!   provider body frames. Cache/local bytes, headers,
//!   acquisition/permit waits never enter (they never reach `observe`).
//!   Provider-side throttle/retry/recovery time stays in the denominator:
//!   the caller passes wall-clock instants it does not subtract from, so a
//!   throttled path contributes wall time with zero bytes, which correctly
//!   lowers the measured rate.
//!
//! EPOCH START
//!   Measurement starts at the first useful byte, not at construction or
//!   connection/setup time: `epoch_start` is stamped on the first
//!   `observe()` call. Setup/acquisition silence before the first body
//!   byte can never read as degradation.
//!
//! CONTAMINATION BOUNDARY (not subtraction)
//!   Downstream backpressure is measurement contamination, not a number to
//!   subtract. A future fill loop would report each downstream send in two
//!   steps: `note_presend` with the channel-full pre-check (structural: the
//!   send is about to block), then `note_send` with the actual send
//!   duration. A full channel that drains fast is a false alarm (momentary
//!   fullness under active drain): the taint clears and the samples stand.
//!   A send that actually blocks past the hygiene threshold -- or a
//!   pre-checked full send that only completes after a stall -- discards
//!   the epoch (reset reason `DownstreamBackpressure`) and suspends
//!   observation until an unconstrained send re-arms a fresh epoch. Any
//!   window that touched a blocked interval therefore classifies
//!   `InsufficientSample`, never `LowThroughput`. A healthy fast upstream
//!   behind a stalled client can never read as provider degradation, and a
//!   bursty-but-healthy pipeline does not oscillate: only materially
//!   blocked sends reset anything.
//!
//! EPOCHS AND RESETS
//!   One estimator instance lives exactly one fill (loop-local, no shared
//!   state, no locks). It resets on producer replacement
//!   (`reset_for_producer`, reason `ProducerChange`) and on contamination.
//!   Same-producer reopen/retry stays in the same epoch (same producer).
//!   Fill completion/cancel drops the instance with the task: later fills
//!   are unaffected by construction.
//!
//! CLASSIFICATION
//!   Rolling bytes over monotonic time within one bounded window:
//!   `LowThroughput` requires at least `window` of total observation since
//!   the epoch start (startup noise excluded), two or more retained
//!   samples, and non-zero bytes, with the retained-window rate below the
//!   configured floor. The rate itself is measured over the retained window
//!   only (rolling, not cumulative), so a late degradation is never masked
//!   by early speed. Anything short of that is `InsufficientSample`
//!   (including silence -- stalls are handled elsewhere, never
//!   double-counted here). Otherwise `Healthy`.
//!
//! CONFIGURATION (all experimental, detector default OFF)
//!   `HY4_LOW_THROUGHPUT_BPS` -- sustained-useful-bytes floor. Unset,
//!   unparseable, or zero disables the detector entirely (inert).
//!   `HY4_LOW_THROUGHPUT_WINDOW_MS` -- bounded observation window.
//!   Experimental default 10_000 ms when the floor is set but the window
//!   is not; documented as a measurement default, never a production
//!   threshold.
//!   `HY4_LOW_THROUGHPUT_BLOCKED_MS` -- send-blocked hygiene threshold.
//!   Experimental default 50 ms; measurement hygiene, not provider policy.
//!
//! Production adaptation vs the proven source: producer identity is
//! `(provider, cap_id)` -- transplant capabilities carry the
//! observability-only `cap_id`, not the later HY4 generation counter.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Default observation window when the floor is set but no window is.
/// Experimental measurement default, not a production threshold.
pub const DEFAULT_WINDOW_MS: u64 = 10_000;
/// Default send-blocked hygiene threshold. A downstream send that takes
/// longer than this (or a send issued with zero channel capacity)
/// contaminates the epoch. Experimental hygiene default.
pub const DEFAULT_BLOCKED_MS: u64 = 50;
/// Bound on retained per-epoch samples (process-local state hygiene).
/// Window-based eviction dominates in practice; this cap only guards
/// pathological frame floods. Overflow evicts oldest (shortens span,
/// which fails safe toward `insufficient_sample`).
pub const MAX_SAMPLES: usize = 4096;
/// Minimum useful bytes in a classifiable window. Startup noise is
/// handled by the full-window-span requirement; this floor rejects
/// degenerate near-empty windows.
pub const MIN_WINDOW_BYTES: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThroughputVerdict {
    Healthy,
    InsufficientSample,
    LowThroughput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpochResetReason {
    ProducerChange,
    DownstreamBackpressure,
}

/// Request/fill-scoped telemetry snapshot. Carries the epoch attribution
/// (provider + capability id) so a consumer can tell producer epochs
/// apart without any global state.
#[derive(Debug, Clone)]
pub struct ThroughputSnapshot {
    pub provider: String,
    pub cap_id: String,
    pub verdict: ThroughputVerdict,
    pub bytes_observed: u64,
    pub observation_ms: u64,
    pub measured_bps: Option<u64>,
    pub floor_bps: u64,
    pub window_ms: u64,
    pub resets: u64,
    pub last_reset: Option<EpochResetReason>,
}

/// Test/observability hook: invoked with a snapshot on every evaluation
/// (future production wiring passes None).
pub type ThroughputHook = Arc<dyn Fn(ThroughputSnapshot) + Send + Sync>;

/// T16 window-cadenced consecutive-low policy state (proven as HY4 P2M on
/// m3-north-db). Fill-local (lives beside the estimator in the fill loop,
/// never shared).
///
/// A single `LowThroughput` classification is one observation window's
/// opinion, and `classify()` runs at body-frame cadence: two adjacent
/// Low verdicts 3 ms apart may describe the SAME rolling window. This
/// policy advances its count only for temporally INDEPENDENT sustained
/// observations, all within one producer epoch:
/// - the first qualifying clean Low completes observation #1;
/// - the count advances again only after at least one full observation
///   interval (`window`) has elapsed since the previous observation;
/// - any Healthy verdict, estimator reset (contamination or producer
///   change, observed via the resets counter / capability id), or
///   capability-id mismatch restarts the sequence;
/// - `InsufficientSample` (silence, sparse windows) neither manufactures
///   nor destroys.
/// A consumer arms a low-throughput response only at count >= 2, i.e.
/// never on the first complete window after producer start/reset.
///
/// Production adaptation vs the proven source: producer identity is the
/// transplant `cap_id` string, not the later HY4 generation counter.
#[derive(Debug, Clone)]
pub struct LowObservationPolicy {
    count: u32,
    cap_id: Option<String>,
    last_observation_at: Option<Instant>,
    tracked_resets: u64,
}

impl LowObservationPolicy {
    pub fn new() -> Self {
        Self {
            count: 0,
            cap_id: None,
            last_observation_at: None,
            tracked_resets: 0,
        }
    }

    pub fn count(&self) -> u32 {
        self.count
    }

    /// Explicit sequence restart (warm-standby miss at dispatch): the
    /// next Low rebuilds from observation #1, so another attempt cannot
    /// occur on the next couple of body frames.
    pub fn reset_sequence(&mut self) {
        self.count = 0;
        self.last_observation_at = None;
    }

    /// Feed one estimator evaluation. Returns true exactly when a NEW
    /// independent low observation completes. `window` is the configured
    /// observation interval (no second knob); `now` is the evaluation
    /// instant.
    pub fn note_verdict(
        &mut self,
        snap: &ThroughputSnapshot,
        window: Duration,
        now: Instant,
    ) -> bool {
        if snap.resets != self.tracked_resets || self.cap_id.as_deref() != Some(snap.cap_id.as_str()) {
            self.count = 0;
            self.cap_id = Some(snap.cap_id.clone());
            self.last_observation_at = None;
            self.tracked_resets = snap.resets;
        }
        match snap.verdict {
            ThroughputVerdict::LowThroughput => match self.last_observation_at {
                Some(t) if now.duration_since(t) < window => false,
                _ => {
                    self.count += 1;
                    self.last_observation_at = Some(now);
                    true
                }
            },
            ThroughputVerdict::Healthy => {
                self.count = 0;
                self.last_observation_at = None;
                false
            }
            ThroughputVerdict::InsufficientSample => false,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ThroughputConfig {
    pub floor_bps: u64,
    pub window: Duration,
    pub blocked_threshold: Duration,
}

/// Read the experimental detector configuration. `None` (detector inert)
/// unless a positive floor is set. Window/blocked thresholds fall back to
/// experimental measurement defaults.
pub fn config_from_env() -> Option<ThroughputConfig> {
    let floor_bps = std::env::var("HY4_LOW_THROUGHPUT_BPS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|bps| *bps > 0)?;
    let window = std::env::var("HY4_LOW_THROUGHPUT_WINDOW_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(DEFAULT_WINDOW_MS));
    let blocked_threshold = std::env::var("HY4_LOW_THROUGHPUT_BLOCKED_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(DEFAULT_BLOCKED_MS));
    Some(ThroughputConfig {
        floor_bps,
        window,
        blocked_threshold,
    })
}

pub struct ThroughputEstimator {
    floor_bps: u64,
    window: Duration,
    blocked_threshold: Duration,
    samples: VecDeque<(Instant, u64)>,
    bytes_total: u64,
    epoch_start: Option<Instant>,
    suspended: bool,
    /// Latch set by a channel-full pre-check, confirmed or cleared when
    /// that send completes. A full channel under active drain completes
    /// fast (false alarm); a truly blocked send completes slow (or never,
    /// while parked) and the elapsed backstop settles it.
    tainted: bool,
    resets: u64,
    last_reset: Option<EpochResetReason>,
    provider: String,
    cap_id: String,
}

impl ThroughputEstimator {
    pub fn new(
        floor_bps: u64,
        window: Duration,
        blocked_threshold: Duration,
        provider: String,
        cap_id: String,
    ) -> Self {
        Self {
            floor_bps,
            window,
            blocked_threshold,
            samples: VecDeque::new(),
            bytes_total: 0,
            epoch_start: None,
            suspended: false,
            tainted: false,
            resets: 0,
            last_reset: None,
            provider,
            cap_id,
        }
    }

    pub fn provider(&self) -> &str {
        &self.provider
    }

    pub fn cap_id(&self) -> &str {
        &self.cap_id
    }

    pub fn reset_reason(&self) -> Option<EpochResetReason> {
        self.last_reset
    }

    fn suspend(&mut self, reason: EpochResetReason) {
        self.samples.clear();
        self.bytes_total = 0;
        self.epoch_start = None;
        self.suspended = true;
        self.tainted = false;
        self.resets += 1;
        self.last_reset = Some(reason);
    }

    /// Producer replacement: new epoch for the new producer.
    /// Old-producer samples can never contaminate the new classification.
    pub fn reset_for_producer(&mut self, provider: String, cap_id: String) {
        self.provider = provider;
        self.cap_id = cap_id;
        self.samples.clear();
        self.bytes_total = 0;
        self.epoch_start = None;
        self.suspended = false;
        self.tainted = false;
        self.resets += 1;
        self.last_reset = Some(EpochResetReason::ProducerChange);
    }

    /// Observe `n` useful upstream body bytes received at `now`. While
    /// suspended (after contamination) samples are dropped until an
    /// unconstrained send re-arms a fresh epoch.
    pub fn observe(&mut self, now: Instant, n: u64) {
        if n == 0 || self.suspended {
            return;
        }
        if self.epoch_start.is_none() {
            self.epoch_start = Some(now);
        }
        self.bytes_total += n;
        self.samples.push_back((now, self.bytes_total));
        while self.samples.len() > MAX_SAMPLES {
            self.samples.pop_front();
        }
    }

    /// Pre-send structural signal: true when the downstream channel has
    /// zero capacity, i.e. this send is about to block. Only latches a
    /// taint -- confirmation (or clearing) happens in `note_send` when the
    /// send completes, so momentary fullness under active drain never
    /// resets anything.
    pub fn note_presend(&mut self, channel_full: bool) {
        if channel_full {
            self.tainted = true;
        }
    }

    /// Report one completed downstream send with its elapsed duration.
    /// A send slower than the hygiene threshold confirms downstream
    /// pacing (suspend with reason); a fast send clears any pending
    /// taint as a false alarm and, when suspended, re-arms a fresh
    /// epoch for subsequent samples.
    pub fn note_send(&mut self, elapsed: Duration) {
        if elapsed > self.blocked_threshold {
            if !self.suspended {
                self.suspend(EpochResetReason::DownstreamBackpressure);
            } else {
                self.tainted = false;
            }
            return;
        }
        // Fast send: any pending taint was momentary fullness, not a
        // material block. Samples stand.
        self.tainted = false;
        if self.suspended {
            self.suspended = false;
        }
    }

    /// Classify the current window as of `now`. Pure: evicts expired
    /// samples, then applies the verdict rules.
    ///
    /// Coverage rule: classification requires at least `window` of total
    /// observation since the epoch start (startup noise excluded), two or
    /// more retained samples, and non-zero bytes. The rate itself is
    /// measured over the retained window only (rolling, not cumulative),
    /// so a late degradation is not masked by early speed. Silence reads
    /// `InsufficientSample`.
    pub fn classify(&mut self, now: Instant) -> ThroughputSnapshot {
        while let Some((t, _)) = self.samples.front() {
            if now.duration_since(*t) > self.window {
                self.samples.pop_front();
            } else {
                break;
            }
        }
        let observed_ms = self
            .epoch_start
            .map(|s| now.duration_since(s).as_millis() as u64)
            .unwrap_or(0);
        let covered = self
            .epoch_start
            .map(|s| now.duration_since(s) >= self.window)
            .unwrap_or(false);
        let (verdict, measured_bps, bytes_observed) =
            match (self.samples.front(), self.samples.back()) {
                (Some((first_t, first_b)), Some((last_t, last_b)))
                    if covered && self.samples.len() >= 2 && !self.suspended =>
                {
                    let span = last_t.duration_since(*first_t);
                    let bytes = last_b.saturating_sub(*first_b);
                    if bytes >= MIN_WINDOW_BYTES && !span.is_zero() {
                        let rate =
                            (bytes as f64 / span.as_secs_f64()).round() as u64;
                        let v = if rate < self.floor_bps {
                            ThroughputVerdict::LowThroughput
                        } else {
                            ThroughputVerdict::Healthy
                        };
                        (v, Some(rate), self.bytes_total)
                    } else {
                        (
                            ThroughputVerdict::InsufficientSample,
                            None,
                            self.bytes_total,
                        )
                    }
                }
                _ => (
                    ThroughputVerdict::InsufficientSample,
                    None,
                    self.bytes_total,
                ),
            };
        ThroughputSnapshot {
            provider: self.provider.clone(),
            cap_id: self.cap_id.clone(),
            verdict,
            bytes_observed,
            observation_ms: observed_ms,
            measured_bps,
            floor_bps: self.floor_bps,
            window_ms: self.window.as_millis() as u64,
            resets: self.resets,
            last_reset: self.last_reset,
        }
    }
}
