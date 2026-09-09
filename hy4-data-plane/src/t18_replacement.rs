//! T18 transplant proof: warm replacement of a retired lane.
//!
//! Proven as HY4 P2T on m3-north-db, extending T13 retirement: when lane A
//! or B retires, after its active chunk completes normally the vacant lane
//! tries exactly once to rebind to a different already-warm capability for
//! the same exact TorrentFile, restoring two useful lanes. This slice
//! handles retirement vacancy only (no terminal-failure vacancy).
//!
//! Contract pinned here:
//! - the retired active chunk completes normally and is never stolen;
//! - only after that active ownership is cleared may replacement occur;
//! - one warm-only same-TF reservation attempt, excluding the survivor's
//!   capability (structurally, via its held permit) and every retired cap
//!   id (via the exclusion list);
//! - on success the SAME worker task rebinds and resumes unstarted work
//!   (never three concurrent lanes); otherwise the survivor drains alone
//!   exactly as in T13;
//! - maximum active lanes stays 2; zero cold acquisition.
//! Gate: `HY4_ACTIVE_ACTIVE_REPLACE_LANE=1`, default OFF, requiring the
//! T12 steal path (retirement can only happen there).
//!
//! Four proofs (coordinator unit + real `get_file` demand path against
//! localhost mock CDNs):
//! 1. replacement gate OFF = current T13 behavior unchanged;
//! 2. retired B + warm C -> B finishes its active chunk, C rebinds into
//!    the B lane, A+C finish concurrently;
//! 3. no warm C -> survivor-only drain exactly as current T13;
//! 4. retired cap cannot immediately be reselected (unit: a free retired
//!    cap is refused, the attempt is bounded); exact bytes, no duplicate
//!    Range ownership, api delta 0.
//!
//! Production adaptations vs the proven source: producer identity is
//! `(provider, cap_id)`; no replacement telemetry was added (mock hit
//! logs are the authority for who served which chunk); the manager seam
//! (`reserve_standby_excluding`) shares the T2 search with one extra
//! predicate and leaves `reserve_standby` behavior identical.

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
const TF_ID: &str = "tf_t18_det";
const INFO_HASH: &str = "infohash-t18-deterministic";
const PATH: &str = "t18-det.bin";

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
    set_retire_ratio(None);
    std::env::remove_var("HY4_FORCE_SLOT_ORDER");
}

/// Pin lane A (the pre-acquired first reservation) to realdebrid (/la).
/// The B slot (torbox) then holds both the slow B cap and the warm C cap.
fn pin_a_realdebrid() {
    std::env::set_var("HY4_FORCE_SLOT_ORDER", "tf_t18_det:realdebrid");
}

#[derive(Clone)]
enum Mode {
    Drip { piece: usize, delay_ms: u64 },
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
    let data = expected_range(s, e);
    let cr = format!("bytes {s}-{e}/{FILE}");

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);
    let body = Body::from_stream(ReceiverStream::new(rx));
    match mode {
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
        .expect("T18: demand did not terminate within guard");
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

/// A moderately slow lane: 16 KiB pieces at 100 ms (~400 ms per chunk).
fn drip_a() -> Mode {
    Mode::Drip {
        piece: 16384,
        delay_ms: 100,
    }
}

/// A very slow lane: 16 KiB pieces at 500 ms (~2 s per chunk).
fn drip_b() -> Mode {
    Mode::Drip {
        piece: 16384,
        delay_ms: 500,
    }
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

// ---- Proof 1: replacement gate OFF = current T13 behavior unchanged ----
#[tokio::test]
async fn t18_replace_off_is_t13_drain() {
    let _guard = env_lock();
    set_two_lane_gates(true, true, true, false);
    set_retire_ratio(Some(2.0));
    pin_a_realdebrid();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) =
        spawn_mock(modes_abc(drip_a(), drip_b(), drip_a()), hits.clone()).await;
    // NOTE: no C cap injected (only A+B); the third mock path is inert.
    let stack = build_stack(port, caps_ab());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN8_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN8_END), "P1: bytes exact");
    {
        let h = hits.lock().unwrap();
        assert_eq!(h.len(), 8, "P1: eight chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..8).map(chunk_range).collect::<Vec<_>>(),
            "P1: every logical Range exactly once"
        );
        // T13 survivor drain: B keeps only its slow active chunk 4; A
        // serves everything else (own halves plus steals of 7, 6, 5).
        assert_eq!(served_by(&h, "/lb"), vec![4], "P1: B kept only active 4");
        assert_eq!(
            served_by(&h, "/la"),
            vec![0, 1, 2, 3, 5, 6, 7],
            "P1: survivor A drains alone"
        );
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P1: zero new capability acquisition"
    );
    server.abort();
    cleanup_gates();
}

// ---- Proof 2: retired B + warm C -> C rebinds into the B lane ----
#[tokio::test]
async fn t18_retired_b_rebound_by_warm_c() {
    let _guard = env_lock();
    set_two_lane_gates(true, true, true, true);
    set_retire_ratio(Some(2.0));
    pin_a_realdebrid();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) =
        spawn_mock(modes_abc(drip_a(), drip_b(), drip_a()), hits.clone()).await;
    let stack = build_stack(port, caps_abc());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN8_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN8_END), "P2: exact bytes across rebind");
    {
        let h = hits.lock().unwrap();
        assert_eq!(h.len(), 8, "P2: eight chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..8).map(chunk_range).collect::<Vec<_>>(),
            "P2: no duplicate Range ownership"
        );
        // B finishes only its slow active chunk 4, then vacates; C rebinds
        // into the B lane and takes B-lane work (chunk 5 unconditionally:
        // it is the lane-front at rebind) while A still owns active work
        // (A+C finish concurrently -- at most 2 lanes, no third task).
        // The exact A/C split of the remaining tail is timing-dependent;
        // the invariants are who vacated, who rebound, and exactly-once.
        assert_eq!(served_by(&h, "/lb"), vec![4], "P2: retired B served only active 4");
        assert!(
            served_by(&h, "/lc").contains(&5),
            "P2: C rebound into the B lane, got {:?}",
            served_by(&h, "/lc")
        );
        for i in [0, 1, 2, 3] {
            assert!(
                served_by(&h, "/la").contains(&i),
                "P2: survivor A kept its own chunk {i}, got {:?}",
                served_by(&h, "/la")
            );
        }
    }
    assert_eq!(
        stack.metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "P2: api delta 0 (warm-only rebind, zero cold acquisition)"
    );
    server.abort();
    cleanup_gates();
}

// ---- Proof 3: no warm C -> survivor-only drain exactly as T13 ----
#[tokio::test]
async fn t18_no_warm_c_survivor_drains_alone() {
    let _guard = env_lock();
    // Identical to P1 except the replace gate is ON: the claim runs, finds
    // no free warm cap (both lanes hold their permits), and the outcome
    // must equal current T13 behavior bit-for-bit.
    set_two_lane_gates(true, true, true, true);
    set_retire_ratio(Some(2.0));
    pin_a_realdebrid();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, server) =
        spawn_mock(modes_abc(drip_a(), drip_b(), drip_a()), hits.clone()).await;
    let stack = build_stack(port, caps_ab());
    let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
    let out = demand(&stack.state, 0, SPAN8_END).await;
    assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(out.bytes, expected_range(0, SPAN8_END), "P3: bytes exact");
    {
        let h = hits.lock().unwrap();
        assert_eq!(h.len(), 8, "P3: eight chunk fills, got {h:?}");
        assert_eq!(
            sorted_ranges(&h),
            (0..8).map(chunk_range).collect::<Vec<_>>(),
            "P3: every logical Range exactly once"
        );
        assert_eq!(served_by(&h, "/lb"), vec![4], "P3: B kept only active 4");
        assert_eq!(
            served_by(&h, "/la"),
            vec![0, 1, 2, 3, 5, 6, 7],
            "P3: miss preserves the T13 survivor drain exactly"
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

// ---- Proof 4: retired cap cannot be reselected ----
#[tokio::test]
async fn t18_retired_cap_never_reselected() {
    let _guard = env_lock();
    set_two_lane_gates(true, true, true, true);
    set_retire_ratio(Some(2.0));

    // (a) Unit: the retired cap is FREE (vacated) yet refused via the dead
    // list; the other warm same-slot cap is bound instead; the attempt is
    // bounded (one per vacancy); api delta 0.
    {
        let metrics = Arc::new(Metrics::default());
        let tf = ControlTorrentFile {
            id: "tf_t18_unit".into(),
            info_hash: INFO_HASH.into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let coord = |provider: &str, resource: &str| ProviderCoord {
            provider: provider.into(),
            account_scope: "test".into(),
            provider_resource_id: resource.into(),
            provider_file_id: format!("file-{resource}"),
            state: "ready".into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let client = reqwest::Client::new();
        let mgr = Arc::new(CapabilityManager::new(
            tf,
            vec![coord("torbox", "res-u")],
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
                "tf_t18_unit".into(),
                "res-u".into(),
                "file-res-u".into(),
                None,
            );
            mgr.slots[0].caps.lock().unwrap().push(cap.clone());
            cap
        };
        let b_old = mk("/lb");
        let b_new = mk("/lc");
        let c = mk("/lc2");
        let b_old_id = b_old.cap_id.clone();
        let c_id = c.cap_id.clone();
        let api0 = metrics.api_requests.load(Ordering::SeqCst);

        let w = TwoStripeWork::new(vec![0, 1], vec![2, 3]);
        // B pops active chunk 2; A pops 0 for the fast observations.
        let _ = w.next(StripeSide::B, "torbox", &b_old_id);
        let _ = w.next(StripeSide::A, "torbox", "cap-a-u");
        // Two fast A observations, then B's active certainly overruns
        // 2x the fast avg: B retires with (possibly) zero samples, so the
        // assignment-time identity is what excludes it.
        w.observe(StripeSide::A, CHUNK, Duration::from_millis(64), false, "torbox", "cap-a-u");
        std::thread::sleep(Duration::from_millis(250));
        w.observe(StripeSide::A, CHUNK, Duration::from_millis(64), false, "torbox", "cap-a-u");
        assert_eq!(w.retired_side(), Some(StripeSide::B), "P4a: B retired");
        // B's active resolves; the old reservation wraps the CURRENT cap
        // (B-new, simulating a mid-tenure handoff), while the retired B-old
        // sits FREE in the slot: it must still be refused.
        w.finish(2, true);
        let (old, _) = mgr
            .reserve_standby(&b_old)
            .expect("P4a: warm B-new reservable");
        assert!(Arc::ptr_eq(&old.cap, &b_new), "P4a: old reservation holds B-new");
        let ret = w
            .claim_replacement(StripeSide::B, &old, &mgr, &slot_key)
            .expect("P4a: warm C available");
        assert!(Arc::ptr_eq(&ret.cap, &c), "P4a: free retired B-old refused, C bound");
        assert_eq!(ret.cap.cap_id, c_id, "P4a: bound identity is C");
        assert_eq!(
            b_old.limiter.available_permits(),
            1,
            "P4a: retired cap untouched (permit still free)"
        );
        assert_eq!(
            c.limiter.available_permits(),
            0,
            "P4a: bound cap holds the normal per-cap permit"
        );
        assert_eq!(
            metrics.api_requests.load(Ordering::SeqCst),
            api0,
            "P4a: zero provider acquisition"
        );
        // Bounded: the same vacancy never retries.
        drop(ret);
        assert!(
            w.claim_replacement(StripeSide::B, &old, &mgr, &slot_key).is_none(),
            "P4a: one bounded attempt per vacancy"
        );
    }

    // (b) End-to-end on the P2 fixture shape: the vacated B cap serves
    // nothing after its active chunk (had it been rebound, post-4 bytes
    // would hit /lb); exact bytes, no duplicate ownership, api delta 0.
    {
        pin_a_realdebrid();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let (port, server) =
            spawn_mock(modes_abc(drip_a(), drip_b(), drip_a()), hits.clone()).await;
        let stack = build_stack(port, caps_abc());
        let api0 = stack.metrics.api_requests.load(Ordering::SeqCst);
        let out = demand(&stack.state, 0, SPAN8_END).await;
        assert_eq!(out.status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(out.bytes, expected_range(0, SPAN8_END), "P4b: exact bytes");
        let h = hits.lock().unwrap();
        assert_eq!(
            sorted_ranges(&h),
            (0..8).map(chunk_range).collect::<Vec<_>>(),
            "P4b: no duplicate Range ownership"
        );
        assert_eq!(
            served_by(&h, "/lb"),
            vec![4],
            "P4b: vacated B cap served nothing after chunk 4"
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
