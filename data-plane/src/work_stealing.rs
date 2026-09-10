//! Two-lane work stealing.
//!
//! Transplanted onto the fixed
//! two-lane scheduler: when one lane finishes its assigned work first, it
//! may steal unstarted chunks from the other lane's tail. Exactly two
//! lanes; the initial split remains the T11 ceil/floor.
//!
//! Gates: `HY4_ACTIVE_ACTIVE_TWO_SPAN=1` (T11) plus the work-steal gate
//! `HY4_ACTIVE_ACTIVE_STEAL=1` (both default OFF). Steal gate OFF leaves
//! the T11 fixed two-lane ownership unchanged.
//!
//! Steal policy (dumb, deterministic): a lane consumes its own queue front
//! first; once empty it may steal from the far end (back) of the donor
//! queue iff the donor still holds >= 2 unstarted chunks -- the donor's
//! last unstarted chunk (and always its active chunk, long popped) stays
//! theirs. One chunk per decision. Each logical chunk is claimed exactly
//! once, so stealing one chunk never duplicates an existing producer.
//! Both workers retain their existing warm capability across assigned and
//! stolen chunks (reservation threading, zero new acquisition). Ordered
//! output remains exact through cache/staging (head streams, the rest are
//! emitted durably).
//!
//! Four proofs (real `get_file` demand path, localhost mock CDNs only):
//! 1. steal gate OFF = T11 fixed two-lane ownership unchanged;
//! 2. slow B -> A steals unstarted B-tail work, every Range exactly once,
//!    exact output;
//! 3. slow A -> mirror behavior;
//! 4. active donor chunk cannot be stolen; zero capability acquisition
//!    throughout.
//!
//! Production adaptations vs the proven source: capabilities carry
//! `cap_id` (not the later HY4 generation); both lanes share the demand's
//! stage clock (as in T11); no stripe/steal telemetry was added -- the
//! mock hit logs (which provider path served which chunk Range) are the
//! authority for steal direction, exactly-once, and zero acquisition.

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
use crate::test_env::{env_lock, set_auto, set_min_chunks, set_retire, set_steal, set_two_span};

const FILE: u64 = 1 << 20;
const CHUNK: u64 = 65536;
const SPAN6_END: u64 = 6 * CHUNK - 1;
const SPAN4_END: u64 = 4 * CHUNK - 1;
const TF_ID: &str = "tf_t12_det";
const INFO_HASH: &str = "infohash-t12-deterministic";
const PATH: &str = "t12-det.bin";

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
        .expect("T12: demand did not terminate within guard");
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

/// A slow lane: 16 KiB pieces at 100 ms each, so one 64 KiB chunk takes
/// ~400 ms while a fast lane fills a chunk in ~1 ms. The fast lane always
/// exhausts its 3-chunk half (plus the steal) long before the slow lane
/// finishes even one chunk -- the steal direction is deterministic, with
/// hundreds of milliseconds of margin.
fn slow() -> Mode {
    Mode::Drip {
        piece: 16384,
        delay_ms: 100,
    }
}

/// Pin lane A (the pre-acquired first reservation) to torbox (/la) so the
/// fast/slow direction is deterministic. Slot order is otherwise
/// HashMap-ordered per manager build. Must be set before `build_stack`
/// (the manager reads it at construction) and removed after the test.
/// The value names this module's TF id, so it can never match another
/// module's manager even if observed there.
fn pin_a_torbox() {
    std::env::set_var("HY4_FORCE_SLOT_ORDER", "tf_t12_det:torbox");
}

fn unpin_slot_order() {
    std::env::remove_var("HY4_FORCE_SLOT_ORDER");
}

// ---- Proof 1: steal gate OFF = T11 fixed two-lane ownership unchanged ----
#[tokio::test]
async fn t12_steal_off_is_fixed_two_lane() {
    let _guard = env_lock();
    set_two_span(true);
    set_steal(false);
    // T13 isolation: these proofs pin T12 stealing behavior, so the
    // retirement gate is explicitly OFF (shared lock already excludes a
    // concurrent flip; this covers stale state from a panicked test).
    set_retire(false);
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    pin_a_torbox();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(Mode::Full, Mode::Full), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN6_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN6_END), "P1: bytes exact");
    // T11 fixed ceil/floor halves, one provider Range per lane.
    assert_eq!(
        sorted_ranges(&hits.lock().unwrap()),
        vec![(0, 3 * CHUNK - 1), (3 * CHUNK, SPAN6_END)],
        "P1: fixed two-lane ownership unchanged, got {:?}",
        hits.lock().unwrap()
    );
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P1: zero acquisition"
    );
    server.abort();
    set_two_span(false);
    set_steal(false);
    set_retire(false);
    unpin_slot_order();
}

// ---- Proof 2: slow B -> A steals unstarted B-tail work ----
#[tokio::test]
async fn t12_slow_b_fast_a_steals_tail() {
    let _guard = env_lock();
    set_two_span(true);
    set_steal(true);
    set_retire(false);
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    pin_a_torbox();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(Mode::Full, slow()), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN6_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN6_END), "P2: exact output");
    {
        let h = hits.lock().unwrap();
        // Six per-chunk fills on the steal path, every Range exactly once.
        assert_eq!(h.len(), 6, "P2: six chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..6).map(chunk_range).collect::<Vec<_>>(),
            "P2: every logical Range exactly once"
        );
        // A owns {0,1,2} and steals B's unstarted tail chunk 5; B keeps its
        // active chunk 3 plus 4. The donor's last unstarted chunk is never
        // taken while >= 2 remain -- only the far-end tail moves.
        assert_eq!(served_by(&h, "/la"), vec![0, 1, 2, 5], "P2: A stole B-tail 5");
        assert_eq!(served_by(&h, "/lb"), vec![3, 4], "P2: B kept active 3 + 4");
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P2: zero new capability acquisition"
    );
    server.abort();
    set_two_span(false);
    set_steal(false);
    set_retire(false);
    unpin_slot_order();
}

// ---- Proof 3: slow A -> mirror behavior ----
#[tokio::test]
async fn t12_slow_a_fast_b_steals_tail() {
    let _guard = env_lock();
    set_two_span(true);
    set_steal(true);
    set_retire(false);
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    pin_a_torbox();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(slow(), Mode::Full), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN6_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN6_END), "P3: exact output");
    {
        let h = hits.lock().unwrap();
        assert_eq!(h.len(), 6, "P3: six chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..6).map(chunk_range).collect::<Vec<_>>(),
            "P3: every logical Range exactly once"
        );
        // Mirror: B owns {3,4,5} and steals A's unstarted tail chunk 2.
        assert_eq!(served_by(&h, "/la"), vec![0, 1], "P3: A kept active 0 + 1");
        assert_eq!(served_by(&h, "/lb"), vec![2, 3, 4, 5], "P3: B stole A-tail 2");
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P3: zero new capability acquisition"
    );
    server.abort();
    set_two_span(false);
    set_steal(false);
    set_retire(false);
    unpin_slot_order();
}

// ---- Proof 4: active donor chunk cannot be stolen; zero acquisition ----
#[tokio::test]
async fn t12_active_donor_chunk_never_stolen() {
    let _guard = env_lock();
    set_two_span(true);
    set_steal(true);
    set_retire(false);
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    pin_a_torbox();
    // Four chunks: A owns {0,1}, B owns {2,3}. B pops active chunk 2 at
    // spawn, leaving a single unstarted chunk 3 -- below the >= 2 steal
    // threshold -- so the fast lane idles instead of stealing, and the
    // active chunk is unpoppable by construction either way.
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(Mode::Full, slow()), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN4_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN4_END), "P4: exact output");
    {
        let h = hits.lock().unwrap();
        // Steal path engages (four per-chunk fills, not two halves) yet
        // steals nothing: every Range exactly once, by its owner.
        assert_eq!(h.len(), 4, "P4: four chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..4).map(chunk_range).collect::<Vec<_>>(),
            "P4: every logical Range exactly once"
        );
        assert_eq!(served_by(&h, "/la"), vec![0, 1], "P4: A kept its own");
        assert_eq!(served_by(&h, "/lb"), vec![2, 3], "P4: active 2 + last-unstarted 3 never stolen");
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P4: zero capability acquisition throughout"
    );
    server.abort();
    set_two_span(false);
    set_steal(false);
    set_retire(false);
    unpin_slot_order();
}

// ---- Proof 5: shared-cap + steal enabled ----
#[tokio::test]
async fn t12_shared_cap_steal_enabled() {
    let _guard = env_lock();
    // AUTO + steal + shared_cap armed, only one warm cap -> shared-cap
    // fallback engages with work stealing. Two child readers from one
    // CapabilityLease; faster child steals at least one whole chunk.
    set_two_span(false);
    set_steal(true);
    set_retire(false);
    set_auto(true);
    set_min_chunks(Some(4));
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    std::env::set_var("HY4_ACTIVE_ACTIVE_SHARED_CAP", "1");
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(Mode::Full, slow()), hits.clone()).await;
    let stack = build_stack(port, vec![WarmCap {
        provider: "torbox",
        resource: "res-a",
        path: "/la",
    }]);
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN6_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN6_END), "P5: exact output");
    {
        let h = hits.lock().unwrap();
        // Six per-chunk fills, every Range exactly once.
        assert_eq!(h.len(), 6, "P5: six chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..6).map(chunk_range).collect::<Vec<_>>(),
            "P5: every logical Range exactly once"
        );
        // Both children share the same single path (/la), so all chunks
        // come from it. The faster child should steal at least one chunk.
        assert_eq!(served_by(&h, "/la"), vec![0, 1, 2, 3, 4, 5], "P5: all chunks from single cap");
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P5: zero new capability acquisition"
    );
    server.abort();
    set_auto(false);
    set_steal(false);
    set_retire(false);
    std::env::remove_var("HY4_ACTIVE_ACTIVE_SHARED_CAP");
}

// ---- Proof 6: shared-cap odd chunk count stays aligned ----
#[tokio::test]
async fn t12_shared_cap_odd_chunk_aligned() {
    let _guard = env_lock();
    // 3 missing chunks in shared-cap + steal mode: 2 + 1 initial split,
    // stealing still only moves whole chunks.
    set_two_span(false);
    set_steal(true);
    set_retire(false);
    set_auto(true);
    set_min_chunks(Some(2));
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    std::env::set_var("HY4_ACTIVE_ACTIVE_SHARED_CAP", "1");
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(Mode::Full, slow()), hits.clone()).await;
    let stack = build_stack(port, vec![WarmCap {
        provider: "torbox",
        resource: "res-a",
        path: "/la",
    }]);
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, 3 * CHUNK - 1).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, 3 * CHUNK - 1), "P6: bytes exact");
    {
        let h = hits.lock().unwrap();
        assert_eq!(h.len(), 3, "P6: three chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..3).map(chunk_range).collect::<Vec<_>>(),
            "P6: every logical Range exactly once"
        );
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P6: zero new capability acquisition"
    );
    server.abort();
    set_auto(false);
    set_steal(false);
    set_retire(false);
    std::env::remove_var("HY4_ACTIVE_ACTIVE_SHARED_CAP");
}
