//! Sustained-low-throughput warm promotion.
//!
//! Wired into the existing
//! provider-backed fill loop: the T15 detector measures useful upstream
//! progress per fill, the window-cadenced policy arms after two
//! independent clean sustained-low observations, and the fire reserves an
//! already-warm same-TF standby through T2 and hands the reader off to it
//! (resume at the current offset). No other recovery mechanism is added:
//! on a standby miss the fill continues on its current producer with no
//! budget spent, and the existing failure/recovery ordering stays
//! authoritative.
//!
//! Four proofs (policy unit + real `get_file` demand path against
//! localhost mock CDNs):
//! 1. one clean low observation alone does not promote (unit: single and
//!    rapid-same-window lows complete exactly one observation; healthy
//!    resets);
//! 2. two independent sustained-low observations + warm same-TF standby
//!    -> promotion with exact bytes and zero acquisition (slow full-span
//!    Range on the old producer, resume Range on the new producer);
//! 3. healthy recovery or downstream contamination between observations
//!    -> no promotion (unit contamination + fast end-to-end fill);
//! 4. two low observations with no warm standby -> current producer
//!    continues, no cold acquisition and no false failure.
//!
//! Production adaptations vs the proven source: producer identity is
//! `(provider, cap_id)`; promotion reuses the reader's existing
//! reopen-at-offset path (no separate promotion coordinator exists on this
//! branch); there are no runway/no-progress budgets to spend, so the miss
//! path only resets the policy sequence; no promotion telemetry counters
//! were added (mock hit logs are the authority).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use bytes::Bytes;

use crate::cache::{CacheConfig, CacheEngine};
use crate::capability::{ApiKeys, DeliveryCapability};
use crate::control::{ControlTorrentFile, ProviderCoord};
use crate::manager::CapabilityManager;
use crate::metrics::Metrics;
use crate::playback_intel::{PfConfig, PlaybackIntelligence, PrefetchMode};
use crate::serve::{get_file, AppState};
use crate::test_env::env_lock;
use crate::throughput::{LowObservationPolicy, ThroughputEstimator, ThroughputSnapshot, ThroughputVerdict};

const FILE: u64 = 1 << 20;
const CHUNK: u64 = 65536;
const SPAN6_END: u64 = 6 * CHUNK - 1;
const TF_ID: &str = "tf_t16_det";
const INFO_HASH: &str = "infohash-t16-deterministic";
const PATH: &str = "t16-det.bin";

const FLOOR_BPS: u64 = 1_000_000;
const WINDOW_MS: u64 = 400;

fn pat(off: u64) -> u8 {
    (off.wrapping_mul(2654435761).wrapping_add(off >> 7) % 251) as u8
}

fn expected_range(s: u64, e: u64) -> Vec<u8> {
    (s..=e).map(pat).collect()
}

fn set_detector(on: bool) {
    if on {
        std::env::set_var("HY4_LOW_THROUGHPUT_BPS", FLOOR_BPS.to_string());
        std::env::set_var("HY4_LOW_THROUGHPUT_WINDOW_MS", WINDOW_MS.to_string());
    } else {
        std::env::remove_var("HY4_LOW_THROUGHPUT_BPS");
        std::env::remove_var("HY4_LOW_THROUGHPUT_WINDOW_MS");
    }
    std::env::remove_var("HY4_LOW_THROUGHPUT_BLOCKED_MS");
}

fn set_two_lane_gates(two_span: bool, steal: bool, retire: bool, auto: bool) {
    for (v, on) in [
        ("HY4_ACTIVE_ACTIVE_TWO_SPAN", two_span),
        ("HY4_ACTIVE_ACTIVE_STEAL", steal),
        ("HY4_ACTIVE_ACTIVE_RETIRE_SLOW_LANE", retire),
        ("HY4_ACTIVE_ACTIVE_AUTO", auto),
    ] {
        if on {
            std::env::set_var(v, "1");
        } else {
            std::env::remove_var(v);
        }
    }
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
}

fn cleanup_all() {
    set_two_lane_gates(false, false, false, false);
    set_detector(false);
    std::env::remove_var("HY4_FORCE_SLOT_ORDER");
}

/// Pin lane A (the pre-acquired first reservation) to torbox (/la).
fn pin_a_torbox() {
    std::env::set_var("HY4_FORCE_SLOT_ORDER", "tf_t16_det:torbox");
}

#[derive(Clone)]
enum Mode {
    Drip { piece: usize, delay_ms: u64 },
    Full,
}

#[derive(Clone)]
struct MockState {
    modes: Arc<Mutex<HashMap<String, Mode>>>,
    hits: Arc<Mutex<Vec<(String, u64, u64)>>>,
}

fn parse_range(h: &HeaderMap) -> (u64, u64) {
    let v = h.get("range").expect("mock: missing Range").to_str().unwrap();
    let inner = v.strip_prefix("bytes=").expect("mock: bad Range");
    let mut it = inner.split('-');
    let s: u64 = it.next().unwrap().parse().unwrap();
    let e: u64 = it.next().unwrap().parse().unwrap();
    assert!(s <= e && e < FILE, "mock: range out of bounds {s}-{e}");
    (s, e)
}

async fn cdn_handler(
    State(st): State<MockState>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Response {
    use tokio::sync::mpsc;
    use tokio_stream::wrappers::ReceiverStream;
    let path = uri.path().to_string();
    let mode = st.modes.lock().unwrap().get(&path).cloned().unwrap();
    let (s, e) = parse_range(&headers);
    st.hits.lock().unwrap().push((path.clone(), s, e));
    let cr = format!("bytes {s}-{e}/{FILE}");

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);
    let body = Body::from_stream(ReceiverStream::new(rx));
    match mode {
        Mode::Full => {
            let _ = tx.try_send(Ok(Bytes::from(expected_range(s, e))));
        }
        Mode::Drip { piece, delay_ms } => {
            tokio::spawn(async move {
                for c in expected_range(s, e).chunks(piece) {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    if tx.send(Ok(Bytes::from(c.to_vec()))).await.is_err() {
                        return;
                    }
                }
            });
        }
    }
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-range", cr)
        .header("accept-ranges", "bytes")
        .body(body)
        .unwrap()
        .into_response()
}

async fn spawn_mock(
    modes: Arc<Mutex<HashMap<String, Mode>>>,
    hits: Arc<Mutex<Vec<(String, u64, u64)>>>,
) -> (u16, tokio::task::JoinHandle<()>) {
    let st = MockState { modes, hits };
    let app = axum::Router::new()
        .route("/la", get(cdn_handler))
        .route("/lb", get(cdn_handler))
        .with_state(st);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (port, handle)
}

/// One injected warm capability: provider slot placement + mock path.
#[derive(Clone)]
struct WarmCap {
    provider: &'static str,
    resource: &'static str,
    path: &'static str,
}

struct Stack {
    state: Arc<AppState>,
    metrics: Arc<Metrics>,
    _tmp: tempfile::TempDir,
}

/// Build a demand stack with exactly the given warm caps pre-injected
/// (pool-warm, permits free -- zero acquisition on every headline path).
fn build_stack(port: u16, caps: Vec<WarmCap>) -> Stack {
    let tmp = tempfile::tempdir().unwrap();
    let metrics = Arc::new(Metrics::default());
    let cache = CacheEngine::open(
        CacheConfig {
            root: tmp.path().join("c"),
            max_bytes: 64 << 20,
            chunk_size: CHUNK,
        },
        metrics.clone(),
    )
    .unwrap();
    let mut seen: Vec<(String, String)> = Vec::new();
    for c in &caps {
        if !seen.contains(&(c.provider.to_string(), c.resource.to_string())) {
            seen.push((c.provider.to_string(), c.resource.to_string()));
        }
    }
    let coords: Vec<ProviderCoord> = seen
        .iter()
        .map(|(p, r)| ProviderCoord {
            provider: p.clone(),
            account_scope: "test".into(),
            provider_resource_id: r.clone(),
            provider_file_id: format!("file-{r}"),
            state: "ready".into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        })
        .collect();
    let control_tf = ControlTorrentFile {
        id: TF_ID.into(),
        info_hash: INFO_HASH.into(),
        canonical_internal_path: Some(PATH.into()),
        size: FILE,
    };
    let client = reqwest::Client::new();
    let manager = Arc::new(CapabilityManager::new(
        control_tf,
        coords,
        ApiKeys {
            torbox: String::new(),
            realdebrid: String::new(),
        },
        client.clone(),
        metrics.clone(),
    ));
    for c in &caps {
        let slot = manager
            .slots
            .iter()
            .find(|s| s.coord.provider == c.provider && s.coord.provider_resource_id == c.resource)
            .expect("slot for warm cap");
        let cap = DeliveryCapability::new(
            format!("http://127.0.0.1:{port}{}", c.path),
            c.provider.to_string(),
            "test".into(),
            TF_ID.into(),
            c.resource.to_string(),
            format!("file-{}", c.resource),
            None,
        );
        slot.caps.lock().unwrap().push(cap);
    }
    let playback = PlaybackIntelligence::new(PfConfig {
        enabled: false,
        ahead_chunks: 1,
        sequential_threshold: 3,
        prefetch_priority: 0,
        mode: PrefetchMode::Try,
    });
    let state = Arc::new(AppState {
        authoritative_size: FILE,
        tf_id: TF_ID.into(),
        tf_id_durable: TF_ID.into(),
        info_hash: INFO_HASH.into(),
        canonical_path: PATH.into(),
        client: client.clone(),
        metrics: metrics.clone(),
        manager: manager.clone(),
        cache: Some(cache),
        playback,
    });
    Stack {
        state,
        metrics,
        _tmp: tmp,
    }
}

struct DemandOutcome {
    status: StatusCode,
    bytes: Vec<u8>,
}

/// One full demand through the real `get_file` path. Deadline-guarded so
/// a regression fails loudly instead of hanging the suite.
async fn demand(state: &Arc<AppState>, s: u64, e: u64) -> DemandOutcome {
    let mut headers = HeaderMap::new();
    headers.insert("range", format!("bytes={s}-{e}").parse().unwrap());
    let fut = async {
        let resp = get_file(State(state.clone()), headers).await;
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        (status, bytes)
    };
    let (status, bytes) = tokio::time::timeout(Duration::from_secs(60), fut)
        .await
        .expect("T16: demand did not terminate within guard");
    DemandOutcome { status, bytes }
}

fn cross_caps() -> Vec<WarmCap> {
    vec![
        WarmCap {
            provider: "torbox",
            resource: "res-a",
            path: "/la",
        },
        WarmCap {
            provider: "realdebrid",
            resource: "res-b",
            path: "/lb",
        },
    ]
}

fn modes_pair(la: Mode, lb: Mode) -> Arc<Mutex<HashMap<String, Mode>>> {
    Arc::new(Mutex::new(HashMap::from([
        ("/la".to_string(), la),
        ("/lb".to_string(), lb),
    ])))
}

/// A slow lane: 16 KiB pieces at 100 ms each (~164 KiB/s, well below the
/// 1 MB/s test floor; one 64 KiB chunk takes ~400 ms).
fn slow() -> Mode {
    Mode::Drip {
        piece: 16384,
        delay_ms: 100,
    }
}

fn low_snap(cap_id: &str, resets: u64, verdict: ThroughputVerdict) -> ThroughputSnapshot {
    ThroughputSnapshot {
        provider: "torbox".to_string(),
        cap_id: cap_id.to_string(),
        verdict,
        bytes_observed: 100_000,
        observation_ms: WINDOW_MS,
        measured_bps: Some(100_000),
        floor_bps: FLOOR_BPS,
        window_ms: WINDOW_MS as u64,
        resets,
        last_reset: None,
    }
}

// ---- Proof 1: one clean low observation alone does not promote ----
#[test]
fn t16_single_low_never_arms() {
    // Pure policy unit proof (no env, no I/O): one full low window plus
    // arbitrarily many rapid Low-returning frames completes exactly one
    // observation; promotion needs count >= 2.
    let window = Duration::from_millis(WINDOW_MS);
    let mut p = LowObservationPolicy::new();
    let t0 = Instant::now();
    assert!(
        p.note_verdict(&low_snap("cap-a", 0, ThroughputVerdict::LowThroughput), window, t0),
        "P1: first Low completes observation #1"
    );
    assert_eq!(p.count(), 1, "P1: one observation is not armed");
    for i in 1..50u64 {
        let t = t0 + Duration::from_millis(i * 3);
        assert!(
            !p.note_verdict(&low_snap("cap-a", 0, ThroughputVerdict::LowThroughput), window, t),
            "P1: frame +{i}ms describes the same window, no advance"
        );
    }
    assert_eq!(p.count(), 1, "P1: rapid frames never manufacture observation #2");
    // Healthy recovery restarts the sequence; the next Low rebuilds #1.
    assert!(
        !p.note_verdict(&low_snap("cap-a", 0, ThroughputVerdict::Healthy), window, t0 + Duration::from_millis(401)),
        "P1: healthy returns false"
    );
    assert_eq!(p.count(), 0, "P1: healthy resets the sequence");
    assert!(
        p.note_verdict(&low_snap("cap-a", 0, ThroughputVerdict::LowThroughput), window, t0 + Duration::from_millis(402)),
        "P1: post-recovery Low rebuilds from #1"
    );
    assert_eq!(p.count(), 1);
}

// ---- Proof 2: two sustained lows + warm standby -> promotion ----
#[tokio::test]
async fn t16_two_lows_with_standby_promotes() {
    let _guard = env_lock();
    // Plain single-fill path (all two-lane gates OFF) with the detector
    // armed: slow torbox first, fast realdebrid warm standby.
    set_two_lane_gates(false, false, false, false);
    set_detector(true);
    pin_a_torbox();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(slow(), Mode::Full), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN6_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN6_END), "P2: exact bytes across handoff");
    {
        let h = hits.lock().unwrap();
        // Promotion shape: the slow producer opens the full span, then the
        // fill resumes mid-span on the warm standby. No third Range, no
        // replay of already-delivered bytes.
        assert_eq!(h.len(), 2, "P2: open + one resume, got {h:?}");
        assert_eq!(
            h[0],
            ("/la".to_string(), 0, SPAN6_END),
            "P2: slow producer opens the full span"
        );
        assert_eq!(h[1].0, "/lb".to_string(), "P2: resume happens on the warm standby");
        assert!(
            h[1].1 > 0 && h[1].1 < SPAN6_END,
            "P2: resume starts mid-span after two sustained windows, got {:?}",
            h[1]
        );
        assert_eq!(h[1].2, SPAN6_END, "P2: resume runs to the span end");
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P2: zero acquisition (warm standby, no cold acquire)"
    );
    server.abort();
    cleanup_all();
}

// ---- Proof 3: healthy recovery / contamination -> no promotion ----
#[tokio::test]
async fn t16_healthy_or_contaminated_never_promotes() {
    let _guard = env_lock();
    // (a) Unit: a Low, then contamination suspends the epoch. The next
    // verdicts are Insufficient (policy restarts on the resets bump and
    // never advances), so the sequence can never arm.
    {
        let mut e = ThroughputEstimator::new(
            FLOOR_BPS,
            Duration::from_millis(WINDOW_MS),
            Duration::from_millis(50),
            "torbox".to_string(),
            "cap-a".to_string(),
        );
        let t0 = Instant::now();
        // Slow feed for 600 ms: covered, clean, Low -> observation #1.
        let mut t = t0;
        for _ in 0..6 {
            t += Duration::from_millis(100);
            e.observe(t, 16384);
            e.note_send(Duration::from_micros(10));
        }
        let mut p = LowObservationPolicy::new();
        let s1 = e.classify(t);
        assert_eq!(s1.verdict, ThroughputVerdict::LowThroughput, "P3a: slow reads low");
        assert!(p.note_verdict(&s1, Duration::from_millis(WINDOW_MS), t));
        assert_eq!(p.count(), 1);
        // Downstream stalls: epoch suspended.
        e.note_presend(true);
        e.note_send(Duration::from_millis(200));
        let s2 = e.classify(t);
        assert_eq!(
            s2.verdict,
            ThroughputVerdict::InsufficientSample,
            "P3a: contaminated epoch never reads low"
        );
        assert!(!p.note_verdict(&s2, Duration::from_millis(WINDOW_MS), t));
        assert_eq!(p.count(), 0, "P3a: contamination restarts the sequence");
        // Resume + short slow feed: window incomplete -> still insufficient.
        e.note_send(Duration::from_micros(5));
        let mut t3 = t + Duration::from_millis(10);
        for _ in 0..3 {
            t3 += Duration::from_millis(100);
            e.observe(t3, 16384);
            e.note_send(Duration::from_micros(10));
        }
        let s3 = e.classify(t3);
        assert_eq!(s3.verdict, ThroughputVerdict::InsufficientSample, "P3a: fresh epoch incomplete");
        assert!(!p.note_verdict(&s3, Duration::from_millis(WINDOW_MS), t3));
        assert_eq!(p.count(), 0, "P3a: never armed");
    }
    // (b) End-to-end: fast fill with the detector armed and a warm standby
    // available. Every verdict is Healthy, so no promotion: one Range.
    {
        set_two_lane_gates(false, false, false, false);
        set_detector(true);
        pin_a_torbox();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let (port, server) = spawn_mock(modes_pair(Mode::Full, Mode::Full), hits.clone()).await;
        let stack = build_stack(port, cross_caps());
        let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
        let out = demand(&stack.state, 0, SPAN6_END).await;
        assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(out.bytes, expected_range(0, SPAN6_END), "P3b: exact bytes");
        assert_eq!(
            hits.lock().unwrap().len(),
            1,
            "P3b: healthy fill never promotes, got {:?}",
            hits.lock().unwrap()
        );
        assert_eq!(
            stack.metrics.api_requests.load(Ordering::SeqCst),
            api0,
            "P3b: zero acquisition"
        );
        server.abort();
    }
    cleanup_all();
}

// ---- Proof 4: two lows, no warm standby -> current producer continues ----
#[tokio::test]
async fn t16_no_standby_continues_without_failure() {
    let _guard = env_lock();
    // Detector armed, two full slow windows elapse (policy arms more than
    // once), but only one warm cap exists: every fire misses, resets, and
    // continues on the current producer. No cold acquisition, no failure.
    set_two_lane_gates(false, false, false, false);
    set_detector(true);
    pin_a_torbox();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let modes = Arc::new(Mutex::new(HashMap::from([("/la".to_string(), slow())])));
    let (port, server) = spawn_mock(modes, hits.clone()).await;
    let stack = build_stack(
        port,
        vec![WarmCap {
            provider: "torbox",
            resource: "res-a",
            path: "/la",
        }],
    );
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN6_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT, "P4: no false failure");
    assert_eq!(out.bytes, expected_range(0, SPAN6_END), "P4: exact bytes, slow but complete");
    assert_eq!(
        hits.lock().unwrap().len(),
        1,
        "P4: single producer throughout, got {:?}",
        hits.lock().unwrap()
    );
    assert_eq!(
        hits.lock().unwrap()[0],
        ("/la".to_string(), 0, SPAN6_END),
        "P4: current producer serves the whole span"
    );
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P4: no cold acquisition to manufacture a standby"
    );
    server.abort();
    cleanup_all();
}
