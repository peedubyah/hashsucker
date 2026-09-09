//! Terminal-failure vacancy + warm replacement.
//!
//! Extending the replacement seam:
//! a lane whose current producer becomes terminally unusable only after
//! existing recovery is exhausted (or correctly declines a hard error)
//! vacates and may be replaced by one already-warm same-TF capability.
//! This slice is terminal failure only. Ordering is preserved: failure ->
//! existing recovery attempts -> recovery or terminal exhaustion -> the
//! T18 seam may fill the vacancy. Recovery policy is untouched.
//!
//! Contract pinned here:
//! - active ownership is relinquished only through the existing terminal
//!   path (the chunk record resolves failed, never refetched, delivery
//!   truncates at it in order);
//! - the failed cap id joins the dead-cap exclusion and the lane vacates
//!   (distinct `terminal` cause, same downstream vacancy shape);
//! - the survivor keeps draining (no continent on a single terminal
//!   failure); both terminal restores the frozen drain-and-truncate path;
//! - the same worker attempts exactly one T18-style warm replacement
//!   (same TF, failed + survivor caps excluded, zero cold acquisition,
//!   max 2 lanes); on a miss the survivor drains alone;
//! - no failure of the whole demand is fabricated: truncation follows
//!   existing semantics, and the emitter joins workers on terminal
//!   failure (client present) so the remainder still drains durably.
//!
//! Four proofs (coordinator unit + real `get_file` demand path against
//! localhost mock CDNs):
//! 1. recoverable failure succeeds through existing recovery and does not
//!    create terminal vacancy;
//! 2. terminal B + warm C -> B vacates only after recovery exhaustion, C
//!    replaces B, survivor continues;
//! 3. terminal B + no C -> survivor-only completion;
//! 4. failed cap is not reselected; failed active chunk is not
//!    concurrently duplicated; exact bytes, api delta 0.
//!
//! Production adaptations vs the proven source: no promotion coordinator
//! exists on this branch, so there is no deadline-abort arm (the race
//! pends like the bare await); no hedge/promotion/stall telemetry was
//! added (mock hit logs + cache durability are the authority); producer
//! identity is `(provider, cap_id)`.

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
use crate::test_env::{env_lock, set_replace, set_retire, set_retire_ratio, set_steal, set_two_span};

const FILE: u64 = 1 << 20;
const CHUNK: u64 = 65536;
const SPAN8_END: u64 = 8 * CHUNK - 1;
const SPAN4_END: u64 = 4 * CHUNK - 1;
const TF_ID: &str = "tf_t19_det";
const INFO_HASH: &str = "infohash-t19-deterministic";
const PATH: &str = "t19-det.bin";

fn pat(off: u64) -> u8 {
    (off.wrapping_mul(2654435761).wrapping_add(off >> 7) % 251) as u8
}

fn expected_range(s: u64, e: u64) -> Vec<u8> {
    (s..=e).map(pat).collect()
}

fn chunk_range(i: u64) -> (u64, u64) {
    (i * CHUNK, (i + 1) * CHUNK - 1)
}

fn set_two_lane_gates(two_span: bool, steal: bool, retire: bool, replace: bool) {
    set_two_span(two_span);
    set_steal(steal);
    set_retire(retire);
    set_replace(replace);
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
}

fn cleanup_gates() {
    set_two_lane_gates(false, false, false, false);
    std::env::remove_var("HY4_ACTIVE_ACTIVE_RETIRE_RATIO");
    std::env::remove_var("HY4_FORCE_SLOT_ORDER");
    std::env::remove_var("SLICE35_FAULT_MIDBODY");
}

/// Pin lane A (the pre-acquired first reservation) to realdebrid (/la).
/// The B slot (torbox) then holds both the failing B cap and warm C.
fn pin_a_realdebrid() {
    std::env::set_var("HY4_FORCE_SLOT_ORDER", "tf_t19_det:realdebrid");
}

#[derive(Clone)]
enum Mode {
    Drip { piece: usize, delay_ms: u64 },
    Full,
    /// Instant hard failure (416) for any Range overlapping chunk `idx`;
    /// all other Ranges serve patterned 206 bytes.
    FailChunk { idx: u64 },
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
    if let Mode::FailChunk { idx } = mode {
        let (fs, fe) = chunk_range(idx);
        if s <= fe && fs <= e {
            // Hard range failure: recovery correctly declines (no retry,
            // no reacquire, no cooldown), terminal immediately.
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header("content-range", format!("bytes */{FILE}"))
                .body(Body::empty())
                .unwrap()
                .into_response();
        }
    }
    let data = expected_range(s, e);
    let cr = format!("bytes {s}-{e}/{FILE}");

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);
    let body = Body::from_stream(ReceiverStream::new(rx));
    match mode {
        Mode::Full => {
            let _ = tx.try_send(Ok(Bytes::from(data)));
        }
        Mode::Drip { piece, delay_ms } => {
            tokio::spawn(async move {
                for c in data.chunks(piece) {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    if tx.send(Ok(Bytes::from(c.to_vec()))).await.is_err() {
                        return;
                    }
                }
            });
        }
        Mode::FailChunk { .. } => {
            let _ = tx.try_send(Ok(Bytes::from(data)));
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
    cache: Arc<CacheEngine>,
    _tmp: tempfile::TempDir,
}

/// Build a demand stack with exactly the given warm caps pre-injected
/// (pool-warm, permits free -- zero acquisition on every headline path).
/// Coords deduplicate by (provider, resource), so B and C share one slot.
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
        cache: Some(cache.clone()),
        playback,
    });
    Stack {
        state,
        metrics,
        cache,
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
        .expect("T19: demand did not terminate within guard");
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

/// Upstream Ranges overlapping chunk `idx` (proves single-attempt /
// never-duplicated for the failed chunk).
fn opens_overlapping(hits: &[(String, u64, u64)], idx: u64) -> Vec<(String, u64, u64)> {
    let (fs, fe) = chunk_range(idx);
    let mut out: Vec<(String, u64, u64)> = hits
        .iter()
        .filter(|(_, s, e)| *s <= fe && fs <= *e)
        .cloned()
        .collect();
    out.sort();
    out
}

fn cache_key() -> String {
    crate::cache::TorrentFileId::new(
        TF_ID.to_string(),
        INFO_HASH.to_string(),
        PATH.to_string(),
        FILE,
    )
    .cache_key()
    .to_string()
}

/// Poll until every listed chunk is durable (or the guard expires).
async fn wait_durable(stack: &Stack, idxs: &[u64]) {
    let key = cache_key();
    let res = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if idxs
                .iter()
                .all(|i| stack.cache.is_present(&key, *i).unwrap_or(false))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(res.is_ok(), "T19: drain did not settle durably");
}

fn caps_ab() -> Vec<WarmCap> {
    vec![
        WarmCap {
            provider: "realdebrid",
            resource: "res-a",
            path: "/la",
        },
        WarmCap {
            provider: "torbox",
            resource: "res-b",
            path: "/lb",
        },
    ]
}

fn caps_abc() -> Vec<WarmCap> {
    vec![
        WarmCap {
            provider: "realdebrid",
            resource: "res-a",
            path: "/la",
        },
        WarmCap {
            provider: "torbox",
            resource: "res-b",
            path: "/lb",
        },
        WarmCap {
            provider: "torbox",
            resource: "res-b",
            path: "/lc",
        },
    ]
}

fn modes_abc(la: Mode, lb: Mode, lc: Mode) -> Arc<Mutex<HashMap<String, Mode>>> {
    Arc::new(Mutex::new(HashMap::from([
        ("/la".to_string(), la),
        ("/lb".to_string(), lb),
        ("/lc".to_string(), lc),
    ])))
}

/// A moderately slow lane: 16 KiB pieces at 100 ms (~400 ms per chunk).
fn drip_mid() -> Mode {
    Mode::Drip {
        piece: 16384,
        delay_ms: 100,
    }
}

/// A fast lane: 1 KiB pieces at 1 ms (~64 ms per chunk).
fn drip_fast() -> Mode {
    Mode::Drip {
        piece: 1024,
        delay_ms: 1,
    }
}

// ---- Proof 1: recoverable failure succeeds, no terminal vacancy ----
#[tokio::test]
async fn t19_recoverable_no_vacancy() {
    let _guard = env_lock();
    // Steal path with the mid-body fault armed: every per-chunk reader
    // drops once (drip pieces arrive separately, deterministically) and
    // resumes on the SAME cap. Recovery succeeds, every chunk is present,
    // and no lane ever vacates (ownership matches the fault-free shape
    // exactly, with one resume open per chunk).
    set_two_lane_gates(true, true, false, true);
    std::env::set_var("SLICE35_FAULT_MIDBODY", "1");
    pin_a_realdebrid();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) =
        spawn_mock(modes_abc(drip_fast(), drip_mid(), drip_mid()), hits.clone()).await;
    let stack = build_stack(port, caps_ab());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN4_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN4_END), "P1: full bytes exact after resume");
    {
        let h = hits.lock().unwrap();
        // A serves its chunks; B serves its own chunks (one extra resume
        // open per chunk). Had either lane terminally vacated, the
        // survivor would have stolen the other's queue instead.
        assert_eq!(served_by(&h, "/la"), vec![0, 0, 1, 1], "P1: A kept its own chunks");
        assert_eq!(
            served_by(&h, "/lb"),
            vec![2, 2, 3, 3],
            "P1: B kept its own chunks, got {:?}",
            served_by(&h, "/lb")
        );
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P1: resume is same-cap, zero acquisition"
    );
    server.abort();
    cleanup_gates();
}

// ---- Proof 2: terminal B + warm C -> C replaces B ----
#[tokio::test]
async fn t19_terminal_b_replaced_by_c() {
    let _guard = env_lock();
    // B fails instantly and terminally on chunk 4 (hard 416: recovery
    // correctly declines, exactly one open). B vacates only then; C binds
    // the B lane; A+C drain; delivery truncates at 4 in order.
    // NOTE: RETIRE stays ON because `replace_armed` chains through it
    // (proven gate semantics); retirement itself can never fire here (B
    // fails with ~zero samples, A alone cannot trigger either case).
    set_two_lane_gates(true, true, true, true);
    set_retire_ratio(Some(2.0));
    pin_a_realdebrid();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(
        modes_abc(drip_fast(), Mode::FailChunk { idx: 4 }, Mode::Full),
        hits.clone(),
    )
    .await;
    let stack = build_stack(port, caps_abc());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN8_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    let (fs4, _) = chunk_range(4);
    assert_eq!(
        out.bytes,
        expected_range(0, fs4 - 1),
        "P2: ordered prefix exact, truncate at 4"
    );
    // The survivor (and replacement) drains the remainder durably.
    wait_durable(&stack, &[0, 1, 2, 3, 5, 6, 7]).await;
    assert!(
        !stack.cache.is_present(&cache_key(), 4).unwrap_or(true),
        "P2: failed chunk absent, never refetched"
    );
    {
        let h = hits.lock().unwrap();
        // Failed chunk attempted once (instant hard error, no recovery
        // loop), never completed, never served elsewhere.
        assert_eq!(
            opens_overlapping(&h, 4),
            vec![("/lb".to_string(), fs4, chunk_range(4).1)],
            "P2: failed chunk opened once on B only"
        );
        // A popped head 0 and never touched the failed chunk; C took
        // unstarted tail (5 first, uncontended) and never touched 4.
        let la = served_by(&h, "/la");
        assert!(la.contains(&0), "P2: survivor popped head 0, got {la:?}");
        assert!(!la.contains(&4), "P2: survivor never touched the failed chunk");
        let lc = served_by(&h, "/lc");
        assert!(lc.contains(&5), "P2: replacement took unstarted tail, got {lc:?}");
        assert!(!lc.contains(&4), "P2: replacement never touched the failed chunk");
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P2: zero acquisition (warm-only vacancy + rebind)"
    );
    server.abort();
    cleanup_gates();
}

// ---- Proof 3: terminal B + no C -> survivor-only completion ----
#[tokio::test]
async fn t19_terminal_b_no_c_survivor_drains() {
    let _guard = env_lock();
    // Same failure as P2 but a 2-cap pool: the bounded attempt finds
    // nothing (both lanes hold their permits) and -- with no continent on
    // a single terminal failure -- the survivor drains the whole remainder
    // durably instead of abandoning it.
    // (RETIRE ON for the replace chain; retirement cannot fire here.)
    set_two_lane_gates(true, true, true, true);
    set_retire_ratio(Some(2.0));
    pin_a_realdebrid();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) = spawn_mock(
        modes_abc(drip_fast(), Mode::FailChunk { idx: 4 }, drip_fast()),
        hits.clone(),
    )
    .await;
    let stack = build_stack(port, caps_ab());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN8_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    let (fs4, _) = chunk_range(4);
    assert_eq!(
        out.bytes,
        expected_range(0, fs4 - 1),
        "P3: ordered prefix exact"
    );
    wait_durable(&stack, &[0, 1, 2, 3, 5, 6, 7]).await;
    assert!(
        !stack.cache.is_present(&cache_key(), 4).unwrap_or(true),
        "P3: failed chunk absent"
    );
    {
        let h = hits.lock().unwrap();
        assert_eq!(
            opens_overlapping(&h, 4).len(),
            1,
            "P3: failed chunk attempted once, got {:?}",
            opens_overlapping(&h, 4)
        );
        assert_eq!(
            served_by(&h, "/la"),
            vec![0, 1, 2, 3, 5, 6, 7],
            "P3: survivor drained everything but the failed chunk"
        );
        assert_eq!(
            served_by(&h, "/lb"),
            vec![4],
            "P3: failed lane opened once and served nothing else"
        );
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P3: zero acquisition"
    );
    server.abort();
    cleanup_gates();
}

// ---- Proof 4: failed cap not reselected; failed chunk never duplicated ----
#[tokio::test]
async fn t19_failed_cap_excluded_chunk_once() {
    let _guard = env_lock();
    // (RETIRE ON for the replace chain; no observes run in the unit half,
    // so retirement cannot fire.)
    set_two_lane_gates(true, true, true, true);
    set_retire_ratio(Some(2.0));

    // (a) Unit: a terminally failed cap is banned from immediate
    // reselection even while FREE; the other warm same-slot cap binds; the
    // attempt is bounded; gate OFF delegates to frozen finish (continent).
    {
        let metrics = Arc::new(Metrics::default());
        let tf = ControlTorrentFile {
            id: "tf_t19_unit".into(),
            info_hash: INFO_HASH.into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let coord = ProviderCoord {
            provider: "torbox".into(),
            account_scope: "test".into(),
            provider_resource_id: "res-u".into(),
            provider_file_id: "file-res-u".into(),
            state: "ready".into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let client = reqwest::Client::new();
        let mgr = Arc::new(CapabilityManager::new(
            tf,
            vec![coord],
            ApiKeys {
                torbox: String::new(),
                realdebrid: String::new(),
            },
            client,
            metrics.clone(),
        ));
        let slot_key = mgr.slots[0].durable_key.clone();
        let mk = |path: &str| {
            let cap = DeliveryCapability::new(
                format!("http://127.0.0.1:9{path}"),
                "torbox".into(),
                "test".into(),
                "tf_t19_unit".into(),
                "res-u".into(),
                "file-res-u".into(),
                None,
            );
            mgr.slots[0].caps.lock().unwrap().push(cap.clone());
            cap
        };
        let b_old = mk("/lb");
        let b_cur = mk("/lc");
        let c = mk("/lc2");
        let b_old_id = b_old.cap_id.clone();
        let api0 = metrics.api_requests.load(Ordering::SeqCst);

        let w = TwoStripeWork::new(vec![0, 1], vec![2, 3]);
        let _ = w.next(StripeSide::B, "torbox", &b_old_id);
        // Terminal failure on active chunk 2 with the CURRENT cap B-cur
        // (simulating a mid-tenure handoff): the retired-identity ban must
        // cover the assignment-time cap even though the worker moved on.
        w.finish_terminal(StripeSide::B, 2, &b_old_id);
        assert_eq!(w.retired_side(), None, "P4a: terminal is not retirement");
        // Survivor unaffected; vacant lane closed.
        let _ = w.next(StripeSide::A, "torbox", "cap-a-u");
        assert!(w.next(StripeSide::B, "torbox", "cap-b-u").is_none(), "P4a: vacant lane closed");
        // The old reservation wraps B-cur (held); retired B-old sits FREE
        // yet must be refused via the dead list.
        let (old, _) = mgr
            .reserve_standby(&b_old)
            .expect("P4a: warm B-cur reservable");
        assert!(Arc::ptr_eq(&old.cap, &b_cur), "P4a: old reservation holds B-cur");
        let ret = w
            .claim_replacement(StripeSide::B, &old, &mgr, &slot_key)
            .expect("P4a: warm C available");
        assert!(Arc::ptr_eq(&ret.cap, &c), "P4a: free failed B-old refused, C bound");
        assert_eq!(
            metrics.api_requests.load(Ordering::SeqCst),
            api0,
            "P4a: zero provider acquisition"
        );
        drop(ret);
        assert!(
            w.claim_replacement(StripeSide::B, &old, &mgr, &slot_key).is_none(),
            "P4a: one bounded attempt per vacancy"
        );
        // Gate OFF delegates to frozen finish: continent set, survivor
        // stops too.
        set_replace(false);
        let w2 = TwoStripeWork::new(vec![0], vec![1]);
        let _ = w2.next(StripeSide::B, "torbox", "cap-b-u");
        w2.finish_terminal(StripeSide::B, 1, "cap-b-u");
        assert!(
            w2.next(StripeSide::A, "torbox", "cap-a-u").is_none(),
            "P4a: gate OFF is frozen fail-fast"
        );
        set_replace(true);
    }

    // (b) End-to-end on the P2 fixture shape: the failed chunk's Range was
    // opened exactly once across all paths (never duplicated, never
    // retried); delivered bytes are the exact ordered prefix; api delta 0.
    {
        pin_a_realdebrid();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let (port, server) = spawn_mock(
            modes_abc(drip_fast(), Mode::FailChunk { idx: 4 }, Mode::Full),
            hits.clone(),
        )
        .await;
        let stack = build_stack(port, caps_abc());
        let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
        let out = demand(&stack.state, 0, SPAN8_END).await;
        let (fs4, _) = chunk_range(4);
        assert_eq!(
            out.bytes,
            expected_range(0, fs4 - 1),
            "P4b: exact ordered prefix bytes"
        );
        let h = hits.lock().unwrap();
        assert_eq!(
            opens_overlapping(&h, 4),
            vec![("/lb".to_string(), fs4, chunk_range(4).1)],
            "P4b: failed Range opened once total, never duplicated"
        );
        assert_eq!(
            stack.metrics.api_requests.load(Ordering::SeqCst),
            api0,
            "P4b: api delta 0"
        );
        server.abort();
    }
    cleanup_gates();
}
