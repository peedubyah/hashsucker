//! T13 transplant proof: slow-lane retirement.
//!
//! Proven as HY4 P2Q on m3-north-db, transplanted onto the T12 stealing
//! coordinator: if one lane is persistently and materially slower than its
//! sibling, it stops receiving new chunks after its current active chunk
//! completes, and the healthy lane steals/drains the remaining unstarted
//! work. Exactly two lanes.
//!
//! Retirement means: the slow active chunk is never canceled merely for
//! being slow and remains unstealable; the retired lane gets no new own
//! work and does not steal; its remaining unstarted queue stays stealable
//! by the healthy lane (retired-donor >= 1 gate; live donors keep the
//! frozen >= 2 gate); after its active chunk completes the retired worker
//! exits and releases its warm capability; no new capability acquisition
//! occurs.
//!
//! Measurement is worker-level relative useful throughput: useful upstream
//! bytes over monotonic time, lane vs lane (never an absolute media
//! bitrate). Retirement needs two independent clean observations; a
//! contaminated (downstream-backpressured) sample is dropped, clears the
//! lane's epoch, and latches taint; silence never classifies; a producer
//! (provider + cap id) change resets that lane's history.
//!
//! Gate: `HY4_ACTIVE_ACTIVE_RETIRE_SLOW_LANE=1`, default OFF, requiring the
//! T12 stealing path. The experimental ratio knob
//! (`HY4_ACTIVE_ACTIVE_RETIRE_RATIO`, proven default 4.0) is preserved
//! test-injectable; no production value is chosen here.
//!
//! Four proofs (localhost mock CDNs only, except the coordinator-rule
//! unit sections of proof 4):
//! 1. retirement gate OFF = T12 behavior unchanged;
//! 2. persistently slow B retires after its active chunk, A drains the
//!    remaining B work;
//! 3. persistently slow A mirrors correctly;
//! 4. transient or contaminated slowdown does not retire; the active chunk
//!    is never duplicated; api delta 0.
//!
//! Production adaptations vs the proven source: capabilities carry
//! `cap_id` (not the later HY4 generation); both lanes share the demand
//! stage clock (as in T11/T12); no stripe/retirement telemetry was added
//! -- the mock hit logs (which provider path served which chunk Range) are
//! the authority for retirement, exactly-once, and zero acquisition.

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
use crate::serve::{StripeSide, TwoStripeWork};
use crate::test_env::{env_lock, set_retire, set_retire_ratio, set_steal, set_two_span};

const FILE: u64 = 1 << 20;
const CHUNK: u64 = 65536;
const SPAN8_END: u64 = 8 * CHUNK - 1;
const SPAN6_END: u64 = 6 * CHUNK - 1;
const SPAN4_END: u64 = 4 * CHUNK - 1;
const TF_ID: &str = "tf_t13_det";
const INFO_HASH: &str = "infohash-t13-deterministic";
const PATH: &str = "t13-det.bin";

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
    let (status, bytes) = tokio::time::timeout(Duration::from_secs(60), fut)
        .await
        .expect("T13: demand did not terminate within guard");
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

/// Pin lane A (the pre-acquired first reservation) to torbox (/la) so the
/// fast/slow direction is deterministic. Must be set before `build_stack`
/// (the manager reads it at construction) and removed after the test.
fn pin_a_torbox() {
    std::env::set_var("HY4_FORCE_SLOT_ORDER", "tf_t13_det:torbox");
}

fn unpin_slot_order() {
    std::env::remove_var("HY4_FORCE_SLOT_ORDER");
}

fn cleanup_gates() {
    set_two_span(false);
    set_steal(false);
    set_retire(false);
    set_retire_ratio(None);
    unpin_slot_order();
}

/// A moderately slow lane for the retire-OFF baseline: 16 KiB pieces at
/// 100 ms each (~400 ms per 64 KiB chunk).
fn slow_mid() -> Mode {
    Mode::Drip {
        piece: 16384,
        delay_ms: 100,
    }
}

/// A fast lane for retirement: 1 KiB pieces at 1 ms each (~64 ms per
/// 64 KiB chunk).
fn fast() -> Mode {
    Mode::Drip {
        piece: 1024,
        delay_ms: 1,
    }
}

/// A persistently slow lane for retirement: 16 KiB pieces at 300 ms each
/// (~1.2 s per 64 KiB chunk, ~19x slower than `fast()`).
fn slow() -> Mode {
    Mode::Drip {
        piece: 16384,
        delay_ms: 300,
    }
}

// ---- Proof 1: retirement gate OFF = T12 behavior unchanged ----
#[tokio::test]
async fn t13_retire_off_is_t12_stealing() {
    let _guard = env_lock();
    set_two_span(true);
    set_steal(true);
    set_retire(false);
    set_retire_ratio(None);
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
        // Frozen T12 outcome: A owns {0,1,2} and steals B-tail 5; B keeps
        // active 3 + 4. No retirement may move chunk 4 to A.
        assert_eq!(h.len(), 6, "P1: six chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..6).map(chunk_range).collect::<Vec<_>>(),
            "P1: every logical Range exactly once"
        );
        assert_eq!(served_by(&h, "/la"), vec![0, 1, 2, 5], "P1: T12 steal, no retire");
        assert_eq!(served_by(&h, "/lb"), vec![3, 4], "P1: B keeps 3 + 4");
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P1: zero new capability acquisition"
    );
    server.abort();
    cleanup_gates();
}

// ---- Proof 2: persistently slow B retires after its active chunk ----
#[tokio::test]
async fn t13_slow_b_retires_a_drains() {
    let _guard = env_lock();
    set_two_span(true);
    set_steal(true);
    set_retire(true);
    set_retire_ratio(Some(2.0));
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    pin_a_torbox();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(fast(), slow()), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN8_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN8_END), "P2: exact output");
    {
        let h = hits.lock().unwrap();
        assert_eq!(h.len(), 8, "P2: eight chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..8).map(chunk_range).collect::<Vec<_>>(),
            "P2: every logical Range exactly once"
        );
        // B retires while still on its active chunk 4: it serves 4 exactly
        // once (never stolen, never duplicated, never canceled) and gets no
        // new work; A drains everything else including 5, which pure
        // stealing could never take while B was live.
        assert_eq!(served_by(&h, "/lb"), vec![4], "P2: B kept only active 4");
        assert!(!served_by(&h, "/la").contains(&4), "P2: active 4 never duplicated");
        assert_eq!(
            served_by(&h, "/la"),
            vec![0, 1, 2, 3, 5, 6, 7],
            "P2: A drained remaining B work"
        );
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P2: zero new capability acquisition"
    );
    server.abort();
    cleanup_gates();
}

// ---- Proof 3: persistently slow A mirrors correctly ----
#[tokio::test]
async fn t13_slow_a_retires_b_drains() {
    let _guard = env_lock();
    set_two_span(true);
    set_steal(true);
    set_retire(true);
    set_retire_ratio(Some(2.0));
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    pin_a_torbox();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(modes_pair(slow(), fast()), hits.clone()).await;
    let stack = build_stack(port, cross_caps());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN8_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN8_END), "P3: exact output");
    {
        let h = hits.lock().unwrap();
        assert_eq!(h.len(), 8, "P3: eight chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..8).map(chunk_range).collect::<Vec<_>>(),
            "P3: every logical Range exactly once"
        );
        // Mirror: A retires on its slow head chunk 0, served exactly once
        // by A; B drains everything else.
        assert_eq!(served_by(&h, "/la"), vec![0], "P3: A kept only active 0");
        assert!(!served_by(&h, "/lb").contains(&0), "P3: active 0 never duplicated");
        assert_eq!(
            served_by(&h, "/lb"),
            vec![1, 2, 3, 4, 5, 6, 7],
            "P3: B drained remaining A work"
        );
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P3: zero new capability acquisition"
    );
    server.abort();
    cleanup_gates();
}

// ---- Proof 4: transient/contaminated slowdown never retires; exactly-once; api 0 ----
#[tokio::test]
async fn t13_transient_and_contaminated_never_retire() {
    let _guard = env_lock();
    set_two_span(true);
    set_steal(true);
    set_retire(true);
    set_retire_ratio(Some(4.0));
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");

    // (a) Transient dip: one slow sample then immediate recovery, plus a
    // producer change (which resets that lane's history). Two independent
    // clean slow observations never accumulate, so no retirement.
    {
        let w = TwoStripeWork::new(vec![0, 1, 2, 3], vec![4, 5, 6, 7]);
        // Pop actives so early-overrun evaluation has assignment times.
        let _ = w.next(StripeSide::A);
        let _ = w.next(StripeSide::B);
        // A: one fast clean observation.
        w.observe(StripeSide::A, CHUNK, Duration::from_millis(64), false, "torbox", "cap-a");
        // B: one transient slow observation, then immediate recovery on a
        // NEW producer (history reset, mixed sample dropped).
        w.observe(StripeSide::B, CHUNK, Duration::from_millis(1200), false, "realdebrid", "cap-b");
        assert!(w.retired_side().is_none(), "P4a: single slow must not retire");
        w.observe(StripeSide::B, CHUNK, Duration::from_millis(1200), false, "realdebrid", "cap-b2");
        w.observe(StripeSide::A, CHUNK, Duration::from_millis(64), false, "torbox", "cap-a");
        w.observe(StripeSide::B, CHUNK, Duration::from_millis(64), false, "realdebrid", "cap-b2");
        assert!(w.retired_side().is_none(), "P4a: recovered lane must not retire");
        // A healthy lane still works its own queue after the episode.
        assert!(w.next(StripeSide::A).is_some(), "P4a: healthy lane unaffected");
    }

    // (b) Downstream contamination: two materially slow samples, both
    // contaminated, then a certain active overrun. The taint latch blocks
    // early-overrun retirement until a fresh clean epoch rebuilds.
    {
        set_retire_ratio(Some(2.0));
        let w = TwoStripeWork::new(vec![0, 1, 2, 3], vec![4, 5, 6, 7]);
        let _ = w.next(StripeSide::A);
        let _ = w.next(StripeSide::B);
        // A: two fast clean observations (~1 MiB/s).
        w.observe(StripeSide::A, CHUNK, Duration::from_millis(64), false, "torbox", "cap-a");
        w.observe(StripeSide::A, CHUNK, Duration::from_millis(64), false, "torbox", "cap-a");
        // B: two materially slow samples but both downstream-contaminated.
        w.observe(StripeSide::B, CHUNK, Duration::from_millis(1200), true, "realdebrid", "cap-b");
        w.observe(StripeSide::B, CHUNK, Duration::from_millis(1200), true, "realdebrid", "cap-b");
        // Let B's active certainly overrun 2x the fast avg (would retire if
        // the contaminated samples had counted).
        std::thread::sleep(Duration::from_millis(300));
        w.observe(StripeSide::A, CHUNK, Duration::from_millis(64), false, "torbox", "cap-a");
        assert!(
            w.retired_side().is_none(),
            "P4b: contaminated samples must not retire, got {:?}",
            w.retired_side()
        );
    }

    // (c) End-to-end: equal lanes with retirement armed -- no persistent
    // material imbalance, so no retirement; ownership stays T12 halves,
    // every Range exactly once, api delta 0.
    {
        set_retire_ratio(Some(2.0));
        pin_a_torbox();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let (port, server) =
            spawn_mock(modes_pair(slow_mid(), slow_mid()), hits.clone()).await;
        let stack = build_stack(port, cross_caps());
        let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
        let out = demand(&stack.state, 0, SPAN4_END).await;
        assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(out.bytes, expected_range(0, SPAN4_END), "P4c: exact output");
        let h = hits.lock().unwrap();
        assert_eq!(h.len(), 4, "P4c: four chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..4).map(chunk_range).collect::<Vec<_>>(),
            "P4c: every logical Range exactly once -- active chunks never duplicated"
        );
        assert_eq!(served_by(&h, "/la"), vec![0, 1], "P4c: A kept its own");
        assert_eq!(served_by(&h, "/lb"), vec![2, 3], "P4c: B kept its own, nothing retired");
        assert_eq!(
            stack.metrics.api_requests.load(Ordering::SeqCst),
            api0,
            "P4c: zero capability acquisition throughout"
        );
        server.abort();
    }
    cleanup_gates();
}
