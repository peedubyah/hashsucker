//! T15 transplant proof: sustained useful-throughput detector.
//!
//! Proven as HY4 P2L on m3-north-db, transplanted as the measurement
//! primitive only: it classifies an upstream producer as
//! sustained-low-throughput and never triggers promotion or scheduler
//! changes. All proofs are deterministic unit-level (virtual timestamps,
//! no I/O, no sleeps).
//!
//! Four proofs:
//! 1. detector disabled (floor unset/0/invalid) -> neutral/inert;
//! 2. sustained useful rate below threshold over a complete clean window
//!    -> low (epoch starts at the first useful byte; provider-side waits
//!    stay in the denominator);
//! 3. healthy rate -> not low;
//! 4. downstream-backpressure contamination or producer change prevents a
//!    false low classification.
//!
//! Production adaptation vs the proven source: producer identity is
//! `(provider, cap_id)` -- transplant capabilities carry the
//! observability-only `cap_id`, not the later HY4 generation counter.

use std::time::{Duration, Instant};

use crate::test_env::env_lock;
use crate::throughput::{
    config_from_env, EpochResetReason, ThroughputEstimator, ThroughputVerdict,
    DEFAULT_BLOCKED_MS, DEFAULT_WINDOW_MS,
};

/// Feed `total_bytes` evenly over `span_ms` in 16 KiB frames starting at
/// `t0`, returning the end instant. Downstream is unconstrained throughout
/// (every send completes fast: no contamination, epoch stays armed).
/// Fully deterministic: all timestamps are computed, nothing sleeps.
fn feed_frames(e: &mut ThroughputEstimator, t0: Instant, total_bytes: u64, span_ms: u64) -> Instant {
    let mut t = t0;
    let mut remaining = total_bytes;
    let frames = 8u64.max(total_bytes / 16384);
    let step_ms = span_ms as f64 / frames as f64;
    let mut i = 0u64;
    while remaining > 0 {
        let n = remaining.min(16384);
        t += Duration::from_micros((step_ms * 1000.0) as u64);
        e.observe(t, n);
        // Unconstrained downstream throughout: re-arm + no contamination.
        e.note_send(Duration::from_micros(10));
        remaining -= n;
        i += 1;
        if i > 100_000 {
            break;
        }
    }
    t
}

fn est(floor_bps: u64, window_ms: u64, provider: &str, cap_id: &str) -> ThroughputEstimator {
    ThroughputEstimator::new(
        floor_bps,
        Duration::from_millis(window_ms),
        Duration::from_millis(DEFAULT_BLOCKED_MS),
        provider.to_string(),
        cap_id.to_string(),
    )
}

fn cleanup_env() {
    std::env::remove_var("HY4_LOW_THROUGHPUT_BPS");
    std::env::remove_var("HY4_LOW_THROUGHPUT_WINDOW_MS");
    std::env::remove_var("HY4_LOW_THROUGHPUT_BLOCKED_MS");
}

// ---- Proof 1: detector disabled -> neutral/inert ----
#[test]
fn t15_disabled_is_inert() {
    let _guard = env_lock();
    // Floor unset / zero / invalid => no config => detector inert.
    std::env::remove_var("HY4_LOW_THROUGHPUT_BPS");
    assert!(config_from_env().is_none(), "P1: unset floor is inert");
    std::env::set_var("HY4_LOW_THROUGHPUT_BPS", "0");
    assert!(config_from_env().is_none(), "P1: zero floor is inert");
    std::env::set_var("HY4_LOW_THROUGHPUT_BPS", "not-a-number");
    assert!(config_from_env().is_none(), "P1: invalid floor is inert");
    // Positive floor enables; window/blocked fall back to experimental
    // measurement defaults; explicit values parse.
    std::env::set_var("HY4_LOW_THROUGHPUT_BPS", "2000000");
    std::env::remove_var("HY4_LOW_THROUGHPUT_WINDOW_MS");
    let c = config_from_env().expect("P1: floor set => enabled");
    assert_eq!(c.floor_bps, 2_000_000);
    assert_eq!(c.window, Duration::from_millis(DEFAULT_WINDOW_MS));
    std::env::set_var("HY4_LOW_THROUGHPUT_WINDOW_MS", "1500");
    std::env::set_var("HY4_LOW_THROUGHPUT_BLOCKED_MS", "25");
    let c2 = config_from_env().expect("P1: explicit window");
    assert_eq!(c2.window, Duration::from_millis(1500));
    assert_eq!(c2.blocked_threshold, Duration::from_millis(25));
    cleanup_env();
}

// ---- Proof 2: sustained low over a complete clean window -> low ----
#[test]
fn t15_sustained_low_classifies() {
    let _guard = env_lock();
    // (a) ~85 KiB/s sustained over 1200 ms against a 1 MB/s floor with a
    // 400 ms window: below floor for well over the full window.
    let mut e = est(1_000_000, 400, "torbox", "cap-a");
    // Construction happens "now", but the first useful byte arrives 5 s
    // later: measurement must start at the first byte, not at setup.
    let t0 = Instant::now() + Duration::from_secs(5);
    let tend = feed_frames(&mut e, t0, 102_400, 1200);
    let s = e.classify(tend);
    assert_eq!(s.verdict, ThroughputVerdict::LowThroughput, "P2a: sustained low");
    assert!(
        s.measured_bps.unwrap() < 1_000_000,
        "P2a: measured below floor, got {:?}",
        s.measured_bps
    );
    assert!(
        s.observation_ms < 2000,
        "P2a: epoch starts at first byte, not setup ({} ms)",
        s.observation_ms
    );
    assert_eq!(s.provider, "torbox");
    assert_eq!(s.cap_id, "cap-a");

    // (b) Provider-side waits stay in the denominator: fast-paced bytes
    // (~4 MB/s) with a 900 ms idle gap mid-window still read low, because
    // the gap contributes wall time with zero bytes. Had the gap been
    // subtracted, the retained rate would read ~3 MB/s (healthy).
    let mut g = est(1_000_000, 1000, "torbox", "cap-a");
    let g0 = Instant::now();
    let t1 = feed_frames(&mut g, g0, 800_000, 200);
    let t2 = t1 + Duration::from_millis(900);
    let tend2 = feed_frames(&mut g, t2, 102_400, 100);
    let s2 = g.classify(tend2);
    assert_eq!(
        s2.verdict,
        ThroughputVerdict::LowThroughput,
        "P2b: idle waits lower the measured rate, got {:?} @ {:?}",
        s2.verdict,
        s2.measured_bps
    );
    assert!(s2.measured_bps.unwrap() < 1_000_000);
}

// ---- Proof 3: healthy rate -> not low ----
#[test]
fn t15_healthy_rate_not_low() {
    let _guard = env_lock();
    // ~13 MB/s sustained against a 1 MB/s floor, well past the window so
    // the retained span covers it with margin.
    let mut e = est(1_000_000, 500, "torbox", "cap-a");
    let t0 = Instant::now();
    let tend = feed_frames(&mut e, t0, 20_000_000, 1500);
    let s = e.classify(tend);
    assert_eq!(s.verdict, ThroughputVerdict::Healthy, "P3: fast producer healthy");
    assert!(s.measured_bps.unwrap() > 1_000_000);
    assert_eq!(s.bytes_observed, 20_000_000);
    assert_eq!(s.provider, "torbox");
    assert_eq!(s.cap_id, "cap-a");
}

// ---- Proof 4: contamination / producer change prevent false low ----
#[test]
fn t15_contamination_and_producer_change_prevent_false_low() {
    let _guard = env_lock();
    // (a) Downstream backpressure suspends the epoch: a fast producer
    // behind a blocked downstream must not read as degradation, and the
    // post-resume epoch counts only post-resume bytes.
    {
        let mut e = est(1_000_000, 400, "torbox", "cap-a");
        let t0 = Instant::now();
        let t1 = feed_frames(&mut e, t0, 4_000_000, 200);
        // Channel full: latch taint, then confirm with a slow completion.
        e.note_presend(true);
        e.note_send(Duration::from_millis(200));
        assert_eq!(
            e.reset_reason(),
            Some(EpochResetReason::DownstreamBackpressure),
            "P4a: blocked send records the reason"
        );
        let s = e.classify(t1);
        assert_eq!(
            s.verdict,
            ThroughputVerdict::InsufficientSample,
            "P4a: contaminated epoch must not read as degradation"
        );
        // Samples while suspended are dropped, not accumulated.
        e.observe(t1 + Duration::from_millis(50), 1_000_000);
        let s2 = e.classify(t1 + Duration::from_millis(50));
        assert_eq!(s2.verdict, ThroughputVerdict::InsufficientSample);
        assert_eq!(s2.bytes_observed, 0);
        // Momentary fullness under active drain is a false alarm: taint
        // clears, samples stand, no reset recorded.
        let mut e2 = est(1_000_000, 400, "torbox", "cap-a");
        let u0 = Instant::now();
        let u1 = feed_frames(&mut e2, u0, 4_000_000, 200);
        e2.note_presend(true);
        e2.note_send(Duration::from_micros(20));
        assert_eq!(e2.reset_reason(), None, "P4a: false alarm records no reset");
        let su = e2.classify(u1);
        assert_eq!(su.bytes_observed, 4_000_000, "P4a: false alarm keeps samples");
        // Pressure clears: first unconstrained send re-arms, next samples
        // start a fresh epoch for the same producer.
        e.note_send(Duration::from_micros(5));
        let t3 = feed_frames(&mut e, t1 + Duration::from_millis(60), 8_000_000, 1200);
        let s3 = e.classify(t3);
        assert_eq!(s3.verdict, ThroughputVerdict::Healthy);
        assert_eq!(s3.bytes_observed, 8_000_000, "P4a: fresh epoch counts only post-resume bytes");
    }
    // (b) Producer change resets the epoch: a slow producer reads low,
    // then the new producer is judged only from its own samples.
    {
        let mut e = est(1_000_000, 400, "torbox", "cap-a");
        let t0 = Instant::now();
        let t1 = feed_frames(&mut e, t0, 102_400, 1200);
        let slow = e.classify(t1);
        assert_eq!(slow.verdict, ThroughputVerdict::LowThroughput, "P4b: slow first");
        assert_eq!(slow.provider, "torbox");
        e.reset_for_producer("realdebrid".to_string(), "cap-9".to_string());
        assert_eq!(e.reset_reason(), Some(EpochResetReason::ProducerChange));
        let t2 = feed_frames(&mut e, t1, 8_000_000, 1200);
        let fast = e.classify(t2);
        assert_eq!(fast.verdict, ThroughputVerdict::Healthy, "P4b: new producer healthy");
        assert_eq!(fast.provider, "realdebrid");
        assert_eq!(fast.cap_id, "cap-9");
        assert_eq!(fast.bytes_observed, 8_000_000, "P4b: new epoch counts only new-producer bytes");
    }
    cleanup_env();
}
