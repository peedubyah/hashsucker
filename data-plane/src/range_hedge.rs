//! Bounded same-TF first-valid-wins hedge.
//!
//! Adapted to the production fill path:
//! for one in-progress fill, when the low-throughput policy arms (two
//! independent clean sustained-low observations), one second already-warm
//! same-TorrentFile reader races the same remaining byte range instead of
//! abandon-and-promote. The first reader to produce a valid body chunk
//! wins and becomes the sole producer. No new scheduling architecture.
//!
//! Contract pinned here:
//! - one logical fill stays the sole cache/InFlight/staging authority
//!   (per-attempt staging gates + manual exactly-once winner staging);
//! - hedge uses one second already-warm same-TF capability from T2;
//! - both readers race the same `[current_pos, fill_end]`; maximum two
//!   attempts; at most one hedge per logical fill;
//! - first completed valid body chunk wins; the winner's first chunk is
//!   staged/emitted exactly once; the loser is dropped/cancelled, and that
//!   cancellation records no breaker/provider failure;
//! - after selection only the winner continues; zero cold acquisition.
//! Gate/trigger semantics follow the proven source (`DATA_PLANE_HEDGE_ENABLED=1`,
//! default OFF, armed by the consecutive-low policy); no new hedge policy
//! or threshold is invented. There are no stall/runway arms on this
//! branch, so the race pends like the bare await and real failures keep
//! their authoritative ordering (a Terminal still fails the fill).
//!
//! Four proofs (real `get_file` demand path, localhost mock CDNs only):
//! 1. hedge gate OFF = current fill behavior unchanged;
//! 2. slow primary + warm standby -> standby wins first useful chunk,
//!    exact bytes, api delta 0;
//! 3. fast primary -> primary wins, loser cancelled without
//!    breaker/failure accounting;
//! 4. every logical byte is staged once; no second warm cap -> normal
//!    current producer continues with zero cold acquisition.
//!
//! Production adaptations vs the proven source: no hedge/promotion event
//! telemetry was added (mock hit logs + byte counters are the authority);
//! a hedge that errors before election keeps its warm cap for the
//! promotion attempt below instead of a deadline path (none exists here).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;
use std::time::Duration;

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
use crate::test_env::{env_lock, set_hedge};

const FILE: u64 = 1 << 20;
const CHUNK: u64 = 65536;
const SPAN6_END: u64 = 6 * CHUNK - 1;
const SPAN3_END: u64 = 3 * CHUNK - 1;
const TF_ID: &str = "tf_t17_det";
const INFO_HASH: &str = "infohash-t17-deterministic";
const PATH: &str = "t17-det.bin";

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
    set_hedge(false);
    std::env::remove_var("HY4_FORCE_SLOT_ORDER");
}

/// Pin lane A (the pre-acquired first reservation) to torbox (/la).
fn pin_a_torbox() {
    std::env::set_var("HY4_FORCE_SLOT_ORDER", "tf_t17_det:torbox");
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
        .expect("T17: demand did not terminate within guard");
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
fn slow_mid() -> Mode {
    Mode::Drip {
        piece: 16384,
        delay_ms: 100,
    }
}

/// A very slow lane: 16 KiB pieces at 300 ms each (~55 KiB/s; one 64 KiB
/// chunk takes ~1.2 s).
fn slow() -> Mode {
    Mode::Drip {
        piece: 16384,
        delay_ms: 300,
    }
}

fn fetched(metrics: &Metrics) -> u64 {
    metrics.cache.bytes_fetched_upstream.load(Ordering::SeqCst)
}

fn api_delta(metrics: &Metrics) -> u64 {
    metrics.api_requests.load(Ordering::SeqCst)
}

// ---- Proof 1: hedge gate OFF = current fill behavior unchanged ----
#[tokio::test]
async fn t17_hedge_off_is_current_fill() {
    let _guard = env_lock();
    // Detector armed and a warm standby available, but the hedge gate OFF:
    // the fast fill never arms and serves one Range.
    set_two_lane_gates(false, false, false, false);
    set_detector(true);
    set_hedge(false);
    pin_a_torbox();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(Mode::Full, Mode::Full), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = api_delta(&stack.metrics);
    let out = demand(&stack.state, 0, SPAN6_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN6_END), "P1: bytes exact");
    assert_eq!(
        hits.lock().unwrap().len(),
        1,
        "P1: single producer throughout, got {:?}",
        hits.lock().unwrap()
    );
    assert_eq!(
        hits.lock().unwrap()[0],
        ("/la".to_string(), 0, SPAN6_END),
        "P1: current fill behavior unchanged"
    );
    assert_eq!(fetched(&stack.metrics), SPAN6_END + 1, "P1: every byte staged once");
    assert_eq!(api_delta(&stack.metrics), api0, "P1: zero acquisition");
    server.abort();
    cleanup_all();
}

// ---- Proof 2: slow primary + warm standby -> standby wins ----
#[tokio::test]
async fn t17_slow_primary_standby_wins() {
    let _guard = env_lock();
    // Plain single-fill path (all two-lane gates OFF), detector armed,
    // hedge armed: very slow torbox first, instant realdebrid standby.
    set_two_lane_gates(false, false, false, false);
    set_detector(true);
    set_hedge(true);
    pin_a_torbox();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(slow(), Mode::Full), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = api_delta(&stack.metrics);
    let out = demand(&stack.state, 0, SPAN6_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN6_END), "P2: exact bytes across election");
    {
        let h = hits.lock().unwrap();
        // Election shape: the slow producer opens the full span, then the
        // standby wins the first useful chunk and serves the resume Range.
        // Maximum two attempts, one hedge per fill.
        assert_eq!(h.len(), 2, "P2: open + one resume, got {h:?}");
        assert_eq!(
            h[0],
            ("/la".to_string(), 0, SPAN6_END),
            "P2: slow producer opens the full span"
        );
        assert_eq!(h[1].0, "/lb".to_string(), "P2: standby wins first useful chunk");
        assert!(
            h[1].1 > 0 && h[1].1 < SPAN6_END,
            "P2: resume starts mid-span after arming, got {:?}",
            h[1]
        );
        assert_eq!(h[1].2, SPAN6_END, "P2: winner runs to the span end");
    }
    assert_eq!(
        fetched(&stack.metrics),
        SPAN6_END + 1,
        "P2: winner's bytes staged exactly once (loser staged nothing)"
    );
    assert_eq!(
        api_delta(&stack.metrics),
        api0,
        "P2: api delta 0 (warm standby, zero cold acquisition)"
    );
    server.abort();
    cleanup_all();
}

// ---- Proof 3: fast primary wins, loser cancelled cleanly ----
#[tokio::test]
async fn t17_fast_primary_wins_loser_cancelled() {
    let _guard = env_lock();
    // Primary moderately slow (arms the policy) but strictly faster to the
    // next frame than the very-slow standby: the primary wins, the hedge
    // opens the resume Range and is then dropped. A promotion would have
    // abandoned the primary instead, so this outcome pins the race.
    set_two_lane_gates(false, false, false, false);
    set_detector(true);
    set_hedge(true);
    pin_a_torbox();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(slow_mid(), slow()), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = api_delta(&stack.metrics);
    let breakers0 = stack.metrics.breaker_opens.load(Ordering::SeqCst);
    let upstream0 = stack.metrics.upstream_errors.load(Ordering::SeqCst);
    let truncated0 = stack.metrics.client_truncated.load(Ordering::SeqCst);
    // 3 chunks: the race fires (~800 ms) with one chunk left, so no
    // re-arming promotion can follow within the fill.
    let out = demand(&stack.state, 0, SPAN3_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN3_END), "P3: exact bytes");
    {
        let h = hits.lock().unwrap();
        assert_eq!(h.len(), 2, "P3: open + one hedge attempt, got {h:?}");
        assert_eq!(
            h[0],
            ("/la".to_string(), 0, SPAN3_END),
            "P3: primary opens the full span"
        );
        assert_eq!(h[1].0, "/lb".to_string(), "P3: hedge opened the resume Range");
        assert!(
            h[1].1 > 0 && h[1].1 < SPAN3_END,
            "P3: hedge raced the remainder, got {:?}",
            h[1]
        );
    }
    assert_eq!(
        fetched(&stack.metrics),
        SPAN3_END + 1,
        "P3: primary served every byte exactly once (loser staged nothing)"
    );
    assert_eq!(
        stack.metrics.breaker_opens.load(Ordering::SeqCst),
        breakers0,
        "P3: loser cancellation is not breaker failure"
    );
    assert_eq!(
        stack.metrics.upstream_errors.load(Ordering::SeqCst),
        upstream0,
        "P3: loser cancellation is not provider failure"
    );
    assert_eq!(
        stack.metrics.client_truncated.load(Ordering::SeqCst),
        truncated0,
        "P3: no truncation"
    );
    assert_eq!(api_delta(&stack.metrics), api0, "P3: zero acquisition");
    server.abort();
    cleanup_all();
}

// ---- Proof 4: staged-once bytes; no warm cap -> normal producer ----
#[tokio::test]
async fn t17_no_standby_continues_staged_once() {
    let _guard = env_lock();
    // Detector + hedge armed, two full slow windows elapse (the policy
    // arms), but only one warm cap exists: reservation misses, the current
    // producer serves the whole span. No cold acquisition, no failure.
    set_two_lane_gates(false, false, false, false);
    set_detector(true);
    set_hedge(true);
    pin_a_torbox();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let modes = Arc::new(Mutex::new(HashMap::from([("/la".to_string(), slow_mid())])));
    let (port, server) = spawn_mock(modes, hits.clone()).await;
    let stack = build_stack(
        port,
        vec![WarmCap {
            provider: "torbox",
            resource: "res-a",
            path: "/la",
        }],
    );
    let api0 = api_delta(&stack.metrics);
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
        fetched(&stack.metrics),
        SPAN6_END + 1,
        "P4: every logical byte staged exactly once"
    );
    assert_eq!(
        api_delta(&stack.metrics),
        api0,
        "P4: no cold acquisition to manufacture a standby"
    );
    server.abort();
    cleanup_all();
}
