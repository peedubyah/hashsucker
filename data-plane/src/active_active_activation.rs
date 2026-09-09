//! Bounded automatic two-lane activation.
//!
//! A decision seam that chooses between the existing single producer and
//! the existing two-lane scheduler based only on missing-work size and
//! availability of a second already-warm same-TF capability. No new
//! scheduler behavior.<longcat_arg_value>

//!
//! Behind `HY4_ACTIVE_ACTIVE_AUTO=1` (default OFF), with the experimental
//! minimum-work threshold `HY4_ACTIVE_ACTIVE_MIN_CHUNKS` (proven default 4,
//! test-injectable), the scheduler engages only when ALL hold:
//! AUTO enabled, the consecutive missing run has >= min chunks, and the
//! standby reservation returns a second warm same-TF cap. The reservation
//! REMAINS the availability check (no pool peek); no cold acquisition is
//! ever performed merely to activate concurrency. Otherwise the existing
//! single-fill path is preserved. AUTO alone without STEAL yields the
//! frozen fixed 50/50 path; stealing and retirement behavior are unchanged
//! once engaged.
//!
//! Four proofs (real `get_file` demand path, localhost mock CDNs only):
//! 1. AUTO OFF preserves current behavior;
//! 2. below threshold stays single even with two warm caps;
//! 3. qualifying run + two warm same-TF caps engages the existing two-lane
//!    path with api delta 0;
//! 4. qualifying run + only one warm cap falls back single with zero cold
//!    acquisition.
//!
//! Production adaptations vs the proven source: no stripe/fallback
//! telemetry was added (transplant has no stripe report) -- the mock hit
//! logs (upstream Range count and shape) are the authority for which path
//! engaged, plus exact bytes and zero provider acquisition.

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
use crate::test_env::{
    env_lock, set_auto, set_min_chunks, set_retire, set_steal, set_two_span,
};

const FILE: u64 = 1 << 20;
const CHUNK: u64 = 65536;
const SPAN6_END: u64 = 6 * CHUNK - 1;
const SPAN2_END: u64 = 2 * CHUNK - 1;
const TF_ID: &str = "tf_t14_det";
const INFO_HASH: &str = "infohash-t14-deterministic";
const PATH: &str = "t14-det.bin";

fn pat(off: u64) -> u8 {
    (off.wrapping_mul(2654435761).wrapping_add(off >> 7) % 251) as u8
}

fn expected_range(s: u64, e: u64) -> Vec<u8> {
    (s..=e).map(pat).collect()
}

fn chunk_range(i: u64) -> (u64, u64) {
    (i * CHUNK, (i + 1) * CHUNK - 1)
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
    let (status, bytes) = tokio::time::timeout(Duration::from_secs(30), fut)
        .await
        .expect("T14: demand did not terminate within guard");
    DemandOutcome { status, bytes }
}

fn sorted_ranges(hits: &[(String, u64, u64)]) -> Vec<(u64, u64)> {
    let mut ranges: Vec<(u64, u64)> = hits.iter().map(|(_, s, e)| (*s, *e)).collect();
    ranges.sort();
    ranges
}

/// Chunk indices served by one mock path (i.e. by one warm lane).
fn served_by(hits: &[(String, u64, u64)], path: &str) -> Vec<u64> {
    let mut out: Vec<u64> = hits
        .iter()
        .filter(|(p, _, _)| p == path)
        .map(|(_, s, _)| s / CHUNK)
        .collect();
    out.sort();
    out
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

/// A moderately slow lane: 16 KiB pieces at 100 ms each (~400 ms per
/// 64 KiB chunk). The fast lane always exhausts first, so steal direction
/// is deterministic with hundreds of milliseconds of margin.
fn slow_mid() -> Mode {
    Mode::Drip {
        piece: 16384,
        delay_ms: 100,
    }
}

/// Pin lane A (the pre-acquired first reservation) to torbox (/la) so lane
/// direction is deterministic. Must be set before `build_stack` (the
/// manager reads it at construction) and removed after the test.
fn pin_a_torbox() {
    std::env::set_var("HY4_FORCE_SLOT_ORDER", "tf_t14_det:torbox");
}

fn cleanup_gates() {
    set_two_span(false);
    set_steal(false);
    set_retire(false);
    set_auto(false);
    set_min_chunks(None);
    std::env::remove_var("HY4_FORCE_SLOT_ORDER");
}

// ---- Proof 1: AUTO OFF preserves current behavior ----
#[tokio::test]
async fn t14_auto_off_preserves_current_behavior() {
    let _guard = env_lock();
    // Explicit T11/T12 gates, AUTO off: the frozen two-lane outcome.
    set_two_span(true);
    set_steal(true);
    set_retire(false);
    set_auto(false);
    set_min_chunks(None);
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    pin_a_torbox();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(Mode::Full, slow_mid()), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN6_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN6_END), "P1: bytes exact");
    {
        let h = hits.lock().unwrap();
        assert_eq!(h.len(), 6, "P1: six chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..6).map(chunk_range).collect::<Vec<_>>(),
            "P1: every logical Range exactly once"
        );
        assert_eq!(served_by(&h, "/la"), vec![0, 1, 2, 5], "P1: A owns + steals tail");
        assert_eq!(served_by(&h, "/lb"), vec![3, 4], "P1: B keeps active + next");
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P1: zero new capability acquisition"
    );
    server.abort();
    cleanup_gates();
}

// ---- Proof 2: below threshold stays single even with two warm caps ----
#[tokio::test]
async fn t14_below_threshold_stays_single() {
    let _guard = env_lock();
    // AUTO on, threshold 4, but only 2 missing chunks. Steal is armed and
    // two warm caps are available -- still single-fill.
    set_two_span(false);
    set_steal(true);
    set_retire(false);
    set_auto(true);
    set_min_chunks(Some(4));
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(Mode::Full, slow_mid()), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN2_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN2_END), "P2: bytes exact");
    assert_eq!(
        hits.lock().unwrap().len(),
        1,
        "P2: single fetch span, got {:?}",
        hits.lock().unwrap()
    );
    assert_eq!(
        sorted_ranges(&hits.lock().unwrap()),
        vec![(0, SPAN2_END)],
        "P2: below-threshold run stays single"
    );
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P2: zero acquisition (no reservation attempted to activate)"
    );
    server.abort();
    cleanup_gates();
}

// ---- Proof 3: qualifying run + two warm caps engages two-lane, api 0 ----
#[tokio::test]
async fn t14_qualifying_run_engages_two_lane() {
    let _guard = env_lock();
    // AUTO on, threshold 4, 6 missing chunks, two warm caps -- and NO
    // explicit TWO_SPAN gate: AUTO alone engages the frozen fixed halves
    // (STEAL off, so no per-chunk stealing).
    set_two_span(false);
    set_steal(false);
    set_retire(false);
    set_auto(true);
    set_min_chunks(Some(4));
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(Mode::Full, slow_mid()), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN6_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN6_END), "P3: bytes exact");
    assert_eq!(
        sorted_ranges(&hits.lock().unwrap()),
        vec![(0, 3 * CHUNK - 1), (3 * CHUNK, SPAN6_END)],
        "P3: AUTO engaged the existing two-lane halves, got {:?}",
        hits.lock().unwrap()
    );
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P3: api delta 0 (warm reservation is the availability check)"
    );
    server.abort();
    cleanup_gates();
}

// ---- Proof 4: qualifying run + one warm cap falls back single ----
#[tokio::test]
async fn t14_single_warm_cap_falls_back_single() {
    let _guard = env_lock();
    // AUTO on, threshold met, steal armed -- but only one warm cap exists,
    // so the availability check fails safe to single-fill with zero cold
    // acquisition to activate concurrency.
    set_two_span(false);
    set_steal(true);
    set_retire(false);
    set_auto(true);
    set_min_chunks(Some(4));
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    let hits = Arc::new(Mutex::new(Vec::new()));
    let modes = Arc::new(Mutex::new(HashMap::from([("/la".to_string(), Mode::Full)])));
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
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN6_END), "P4: bytes exact");
    assert_eq!(
        hits.lock().unwrap().len(),
        1,
        "P4: single fetch span, got {:?}",
        hits.lock().unwrap()
    );
    assert_eq!(
        sorted_ranges(&hits.lock().unwrap()),
        vec![(0, SPAN6_END)],
        "P4: one warm cap falls back single"
    );
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P4: zero cold acquisition"
    );
    server.abort();
    cleanup_gates();
}
