//! T11 transplant proof: fixed two-lane disjoint fill.
//!
//! Proven as HY4 P2O on m3-north-db, transplanted onto the production
//! scheduler skeleton: one qualifying missing run of the same exact
//! TorrentFile is fetched concurrently by two already-warm capabilities,
//! each owning a disjoint half, with ordered client output through the
//! existing cache/staging boundary.
//!
//! Behind the default-OFF experimental active-active gate
//! (`HY4_ACTIVE_ACTIVE_TWO_SPAN=1`):
//! - the normal first capability is reserved;
//! - one second already-warm same-TF capability is reserved via T2
//!   (same-slot first, then same-TF cross-provider when
//!   `HY4_CROSS_PROVIDER_STANDBY=1`; never an acquisition);
//! - the consecutive missing chunk run splits deterministically into two
//!   disjoint halves (ceil/floor);
//! - exactly two fill workers run concurrently, each logical chunk with
//!   exactly one producer.
//!
//! Maximum lanes: 2. No cold acquisition engages the second lane. If no
//! second warm capability exists, the existing single-producer path is
//! preserved bit-for-bit.
//!
//! Four proofs (real `get_file` demand path, localhost mock CDNs only):
//! 1. gate OFF preserves the existing single-producer path;
//! 2. gate ON + two warm same-provider caps -> disjoint two-way fill,
//!    every logical Range exactly once, exact output;
//! 3. gate ON + warm cross-provider same-TF caps -> same exact behavior
//!    with zero new capability acquisition;
//! 4. gate ON + no second warm cap -> graceful single-producer fallback.
//!
//! Production adaptations vs the proven source: capabilities carry
//! `cap_id` (not the later HY4 generation); both stripes share the
//! demand's stage clock (the production path already shares one clock
//! across spans); no stripe telemetry was added (mock hit logs are the
//! authority for disjointness/exactly-once).

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
use crate::test_env::{env_lock, set_steal, set_two_span};

const FILE: u64 = 1 << 20;
const CHUNK: u64 = 65536;
const SPAN_END: u64 = 2 * CHUNK - 1;
const TF_ID: &str = "tf_t11_det";
const INFO_HASH: &str = "infohash-t11-deterministic";
const PATH: &str = "t11-det.bin";

/// Serializes the T11/T12 env-knob tests against each other via the shared
/// process-global gate lock (see `crate::test_env`): the four tests below
/// run in parallel by default and must not flip the process-global gates
/// under each other (or under the T12 steal tests in another file).

fn pat(off: u64) -> u8 {
    (off.wrapping_mul(2654435761).wrapping_add(off >> 7) % 251) as u8
}

fn expected_range(s: u64, e: u64) -> Vec<u8> {
    (s..=e).map(pat).collect()
}

#[derive(Clone)]
struct MockState {
    hits: Arc<Mutex<Vec<(String, u64, u64)>>>,
}

async fn cdn_handler(
    State(st): State<MockState>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Response {
    let v = headers.get("range").expect("mock: missing Range").to_str().unwrap();
    let inner = v.strip_prefix("bytes=").expect("mock: bad Range");
    let mut it = inner.split('-');
    let s: u64 = it.next().unwrap().parse().unwrap();
    let e: u64 = it.next().unwrap().parse().unwrap();
    assert!(s <= e && e < FILE, "mock: range out of bounds {s}-{e}");
    let path = uri.path().to_string();
    st.hits.lock().unwrap().push((path, s, e));
    let body = Body::from(Bytes::from(expected_range(s, e)));
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-range", format!("bytes {s}-{e}/{FILE}"))
        .header("accept-ranges", "bytes")
        .body(body)
        .unwrap()
        .into_response()
}

async fn spawn_mock(hits: Arc<Mutex<Vec<(String, u64, u64)>>>) -> (u16, tokio::task::JoinHandle<()>) {
    let st = MockState { hits };
    let app = axum::Router::new()
        .route("/la", get(cdn_handler))
        .route("/lb", get(cdn_handler))
        .route("/lc", get(cdn_handler))
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
/// Coords deduplicate by (provider, resource) so two caps sharing a
/// placement land in the SAME slot (same-provider standby); distinct
/// placements land in distinct slots of the same exact TorrentFile.
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
        .expect("T11: demand did not terminate within guard");
    DemandOutcome { status, bytes }
}

fn sorted_ranges(hits: &[(String, u64, u64)]) -> Vec<(u64, u64)> {
    let mut ranges: Vec<(u64, u64)> = hits.iter().map(|(_, s, e)| (*s, *e)).collect();
    ranges.sort();
    ranges
}

// ---- Proof 1: gate OFF preserves the existing single-producer path ----
#[tokio::test]
async fn t11_gate_off_is_single_fill() {
    let _guard = env_lock();
    set_two_span(false);
    // T12 isolation: this proof pins the fixed-path contract, so the
    // steal gate is explicitly OFF (shared lock already excludes a
    // concurrent flip; this covers stale state from a panicked test).
    set_steal(false);
    // Cross-provider standby state is irrelevant with the gate off, but
    // pin it ON so a parallel T2 unit test flipping the process-global
    // flag cannot change what this proof observes.
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(hits.clone()).await;
    let stack = build_stack(
        port,
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
        ],
    );
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN_END), "P1: bytes exact");
    assert_eq!(
        hits.lock().unwrap().len(),
        1,
        "P1: one fetch span, got {:?}",
        hits.lock().unwrap()
    );
    assert_eq!(
        sorted_ranges(&hits.lock().unwrap()),
        vec![(0, SPAN_END)],
        "P1: single collapsed span"
    );
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P1: zero acquisition"
    );
    server.abort();
    set_two_span(false);
}

// ---- Proof 2: gate ON + two warm same-provider caps -> disjoint two-way fill ----
#[tokio::test]
async fn t11_same_provider_two_lane_disjoint_fill() {
    let _guard = env_lock();
    set_two_span(true);
    set_steal(false);
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(hits.clone()).await;
    // Same placement (res-a): both caps live in the SAME slot, so the
    // same-slot phase of the existing T2 standby path supplies lane B.
    let stack = build_stack(
        port,
        vec![
            WarmCap {
                provider: "torbox",
                resource: "res-a",
                path: "/la",
            },
            WarmCap {
                provider: "torbox",
                resource: "res-a",
                path: "/lc",
            },
        ],
    );
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN_END), "P2: exact output");
    {
        let h = hits.lock().unwrap();
        assert_eq!(h.len(), 2, "P2: two concurrent Ranges, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            vec![(0, CHUNK - 1), (CHUNK, SPAN_END)],
            "P2: deterministic disjoint halves, every logical Range exactly once"
        );
        let mut paths: Vec<String> = h.iter().map(|(p, _, _)| p.clone()).collect();
        paths.sort();
        assert_eq!(
            paths,
            vec!["/la".to_string(), "/lc".to_string()],
            "P2: both warm same-provider lanes served"
        );
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P2: zero new capability acquisition"
    );
    server.abort();
    set_two_span(false);
}

// ---- Proof 3: gate ON + warm cross-provider same-TF caps -> same behavior, zero acquisition ----
#[tokio::test]
async fn t11_cross_provider_two_lane_disjoint_fill() {
    let _guard = env_lock();
    set_two_span(true);
    set_steal(false);
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(hits.clone()).await;
    let stack = build_stack(
        port,
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
        ],
    );
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN_END), "P3: exact output");
    {
        let h = hits.lock().unwrap();
        assert_eq!(h.len(), 2, "P3: two concurrent Ranges, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            vec![(0, CHUNK - 1), (CHUNK, SPAN_END)],
            "P3: deterministic disjoint halves, every logical Range exactly once"
        );
        let mut paths: Vec<String> = h.iter().map(|(p, _, _)| p.clone()).collect();
        paths.sort();
        assert_eq!(
            paths,
            vec!["/la".to_string(), "/lb".to_string()],
            "P3: both warm cross-provider lanes served"
        );
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P3: zero new capability acquisition"
    );
    server.abort();
    set_two_span(false);
}

// ---- Proof 4: gate ON + no second warm cap -> graceful single-producer fallback ----
#[tokio::test]
async fn t11_no_second_warm_falls_back_to_single_fill() {
    let _guard = env_lock();
    set_two_span(true);
    set_steal(false);
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(hits.clone()).await;
    let stack = build_stack(
        port,
        vec![WarmCap {
            provider: "torbox",
            resource: "res-a",
            path: "/la",
        }],
    );
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN_END), "P4: bytes exact");
    assert_eq!(
        hits.lock().unwrap().len(),
        1,
        "P4: single upstream span, got {:?}",
        hits.lock().unwrap()
    );
    assert_eq!(
        sorted_ranges(&hits.lock().unwrap()),
        vec![(0, SPAN_END)],
        "P4: graceful existing single-producer fallback"
    );
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P4: no cold acquisition to engage a second lane"
    );
    server.abort();
    set_two_span(false);
}
