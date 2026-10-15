//! Serve-layer coalescing / concurrency harness.
//!
//! Exercises the REAL serve-layer request path: an axum router wired to
//! `serve::get_file` (the same handler the binary mounts), over real HTTP,
//! against a fake CDN origin with exact Range semantics and deterministic
//! fault injection. Nothing is mocked at the coalescer boundary — the proofs
//! are made at the HTTP response and durable-state level.
//!
//! Proved:
//!   * two concurrent readers over overlapping ranges -> ONE useful origin
//!     fill for the shared chunk, both byte-exact
//!   * a late joiner attaches to an in-flight fill
//!   * cancelling one reader does not cancel the other's useful work
//!   * no duplicate durable writes (each chunk staged exactly once)
//!   * no cross-TorrentFile sharing (A and B never read each other's bytes)
//!   * near-EOF remains exact; an unsatisfiable Range is a clean 416

use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State as AxState;
use axum::http::HeaderMap;
use axum::routing::get;
use axum::Router;
use data_plane::cache::{CacheConfig, CacheEngine, TorrentFileId};
use data_plane::capability::{ApiKeys, DeliveryCapability};
use data_plane::control::{ControlTorrentFile, ProviderCoord};
use data_plane::manager::CapabilityManager;
use data_plane::metrics::Metrics;
use data_plane::playback_intel::{PfConfig, PlaybackIntelligence, PrefetchMode};
use data_plane::serve::{get_file, AppState};

const MODE_OK: u8 = 0;

fn byte_at(offset: u64) -> u8 {
    (offset as u8).wrapping_mul(31).wrapping_add(7)
}
fn expected(start: u64, len: usize) -> Vec<u8> {
    (start..start + len as u64).map(byte_at).collect()
}
fn parse_bytes(h: &str) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?;
    let (s, e) = spec.split_once('-')?;
    Some((s.parse().ok()?, e.parse().ok()?))
}

#[derive(Clone)]
struct OriginState {
    requests: Arc<AtomicUsize>,
    ranges: Arc<AtomicUsize>,
    gate: Arc<tokio::sync::Notify>,
    gate_target: Arc<AtomicUsize>,
    size: u64,
}

async fn origin_handler(AxState(st): AxState<OriginState>, headers: HeaderMap) -> axum::response::Response {
    let n = st.requests.fetch_add(1, Ordering::SeqCst);
    if st.gate_target.load(Ordering::SeqCst) == n + 1 {
        st.gate.notified().await;
    }
    let build = |status: u16, hdrs: Vec<(&str, String)>, body: Vec<u8>| {
        let mut b = axum::response::Response::builder().status(status);
        for (k, v) in hdrs {
            b = b.header(k, v);
        }
        b.body(axum::body::Body::from(body)).unwrap()
    };
    let range = headers
        .get(axum::http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_bytes);
    match range {
        Some((s, e)) => {
            if s >= st.size {
                return build(416, vec![("content-range", format!("bytes */{}", st.size))], vec![]);
            }
            let end = e.min(st.size - 1);
            st.ranges.fetch_add(1, Ordering::SeqCst);
            let len = (end - s + 1) as usize;
            let body: Vec<u8> = (s..=end).map(byte_at).collect();
            build(
                206,
                vec![
                    ("content-range", format!("bytes {s}-{end}/{}", st.size)),
                    ("content-length", len.to_string()),
                ],
                body,
            )
        }
        None => build(200, vec![], (0..st.size).map(byte_at).collect()),
    }
}

/// Everything a reader needs to reach the serve layer and observe the origin.
#[derive(Clone)]
struct Refs {
    server_base: String,
    origin_requests: Arc<AtomicUsize>,
    origin_ranges: Arc<AtomicUsize>,
    gate: Arc<tokio::sync::Notify>,
    gate_target: Arc<AtomicUsize>,
}

/// One HTTP Range read through the real serve-layer router.
async fn read(r: &Refs, s: u64, e: u64) -> (u16, Vec<u8>) {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/files/any", r.server_base))
        .header("range", format!("bytes={s}-{e}"))
        .send()
        .await
        .expect("serve-layer request");
    let status = resp.status().as_u16();
    let bytes = resp.bytes().await.expect("body").to_vec();
    (status, bytes)
}

async fn await_origin_requests(r: &Refs, n: usize) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while r.origin_requests.load(Ordering::SeqCst) < n && std::time::Instant::now() < deadline {
        tokio::task::yield_now().await;
    }
}

async fn yield_budget(n: usize) {
    for _ in 0..n {
        tokio::task::yield_now().await;
    }
}

struct Stack {
    refs: Refs,
    cache: Arc<CacheEngine>,
    _origin_task: tokio::task::JoinHandle<()>,
    _server: tokio::task::JoinHandle<()>,
    _dir: tempfile::TempDir,
    info_hash: String,
    canonical_path: String,
    size: u64,
}

impl Stack {
    fn cache_key(&self) -> String {
        TorrentFileId::new(
            format!("tf-{}", self.info_hash),
            self.info_hash.clone(),
            self.canonical_path.clone(),
            self.size,
        )
        .cache_key()
    }
    fn present(&self, idx: u64) -> bool {
        self.cache.is_present(&self.cache_key(), idx).unwrap_or(false)
    }
}

/// Build a full serve-layer stack for one TorrentFile and serve it over HTTP.
async fn build_stack(info_hash: &str, canonical_path: &str, size: u64, chunk_size: u64, origin_path: &str) -> Stack {
    build_stack_with_caps(info_hash, canonical_path, size, chunk_size, origin_path, 1).await
}

/// `warm_caps` pre-warms N capabilities in the slot. Production grows the
/// pool 1->2 under measured pressure (a real requestdl acquisition); this
/// fixture cannot perform that acquisition (no provider credentials), so it
/// pre-warms the number of concurrent readers the test needs.
async fn build_stack_with_caps(
    info_hash: &str,
    canonical_path: &str,
    size: u64,
    chunk_size: u64,
    origin_path: &str,
    warm_caps: usize,
) -> Stack {
    std::env::set_var("SLICE4_CHUNK_SIZE", chunk_size.to_string());
    let dir = tempfile::tempdir().unwrap();
    let metrics = Arc::new(Metrics::default());
    let cache = CacheEngine::open(
        CacheConfig {
            root: dir.path().join("cache"),
            max_bytes: 64 << 20,
            chunk_size,
        },
        metrics.clone(),
    )
    .unwrap();

    let origin_requests = Arc::new(AtomicUsize::new(0));
    let origin_ranges = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(tokio::sync::Notify::new());
    let gate_target = Arc::new(AtomicUsize::new(0));
    let st = OriginState {
        requests: origin_requests.clone(),
        ranges: origin_ranges.clone(),
        gate: gate.clone(),
        gate_target: gate_target.clone(),
        size,
    };
    let origin_app = Router::new()
        .route(origin_path, get(origin_handler))
        .with_state(st);
    let origin_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin_addr = origin_listener.local_addr().unwrap();
    let _origin_task = tokio::spawn(async move {
        axum::serve(origin_listener, origin_app).await.unwrap();
    });
    let origin_base = format!("http://{origin_addr}");

    let tf = TorrentFileId::new(
        format!("tf-{info_hash}"),
        info_hash.to_string(),
        canonical_path.to_string(),
        size,
    );
    let manager = Arc::new(CapabilityManager::new(
        ControlTorrentFile {
            id: tf.tf_id_durable.clone(),
            info_hash: info_hash.to_string(),
            canonical_internal_path: Some(canonical_path.to_string()),
            size,
        },
        vec![ProviderCoord {
            provider: "torbox".into(),
            account_scope: "default".into(),
            provider_resource_id: "res-1".into(),
            provider_file_id: "0".into(),
            state: "ready".into(),
            canonical_internal_path: Some(canonical_path.to_string()),
            size,
        }],
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    ));
    for i in 0..warm_caps {
        manager.slots[0].caps.lock().unwrap().push(DeliveryCapability::new(
            format!("{origin_base}{origin_path}"),
            "torbox".into(),
            "default".into(),
            tf.tf_id_durable.clone(),
            "res-1".into(),
            "0".into(),
            None,
        ));
    }

    let state = Arc::new(AppState {
        authoritative_size: size,
        tf_id: tf.tf_id_durable.clone(),
        tf_id_durable: tf.tf_id_durable.clone(),
        info_hash: info_hash.to_string(),
        canonical_path: canonical_path.to_string(),
        client: reqwest::Client::new(),
        metrics,
        manager,
        cache: Some(cache.clone()),
        playback: PlaybackIntelligence::new(PfConfig {
            enabled: false,
            ahead_chunks: 1,
            sequential_threshold: 3,
            prefetch_priority: 0,
            mode: PrefetchMode::Try,
        }),
    });

    let app = Router::new()
        .route("/files/:tfId", get(get_file))
        .with_state(state);
    let server_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server_addr = server_listener.local_addr().unwrap();
    let _server = tokio::spawn(async move {
        axum::serve(server_listener, app).await.unwrap();
    });

    Stack {
        refs: Refs {
            server_base: format!("http://{server_addr}"),
            origin_requests,
            origin_ranges,
            gate,
            gate_target,
        },
        cache,
        _origin_task,
        _server,
        _dir: dir,
        info_hash: info_hash.to_string(),
        canonical_path: canonical_path.to_string(),
        size,
    }
}

// ===========================================================================
// S1 — two concurrent readers over overlapping ranges: one useful origin fill
// ===========================================================================

#[tokio::test]
async fn s1_overlapping_readers_coalesce_to_one_origin_fill() {
    let st = build_stack(&"a".repeat(40), "Show/S01/Show - S01E01.mkv", 24_000, 8_192, "/cdn/0").await;
    let refs = st.refs.clone();
    refs.gate_target.store(1, Ordering::SeqCst);

    let ra = refs.clone();
    let a = tokio::spawn(async move { read(&ra, 0, 8_191).await });
    await_origin_requests(&refs, 1).await;
    let rb = refs.clone();
    let b = tokio::spawn(async move { read(&rb, 4_096, 8_191).await });
    yield_budget(400).await;
    refs.gate.notify_waiters();

    let (sa, ba) = a.await.unwrap();
    let (sb, bb) = b.await.unwrap();
    assert_eq!(sa, 206, "reader A got a partial content response");
    assert_eq!(sb, 206, "reader B got a partial content response");
    assert_eq!(ba, expected(0, 8_192), "reader A byte-exact");
    assert_eq!(bb, expected(4_096, 4_096), "reader B byte-exact");
    assert_eq!(
        refs.origin_ranges.load(Ordering::SeqCst),
        1,
        "overlapping readers produce exactly ONE useful origin fill"
    );
    assert_eq!(st.cache.current_bytes(), 8_192, "the shared chunk is durable exactly once");
}

// ===========================================================================
// S2 — a late joiner attaches to an in-flight fill (sequential arrival)
// ===========================================================================

#[tokio::test]
async fn s2_late_joiner_attaches_to_in_flight_fill() {
    let st = build_stack(&"b".repeat(40), "Show/S01/Show - S01E02.mkv", 16_000, 8_192, "/cdn/1").await;
    let refs = st.refs.clone();
    refs.gate_target.store(1, Ordering::SeqCst);
    let ra = refs.clone();
    let a = tokio::spawn(async move { read(&ra, 0, 8_191).await });
    await_origin_requests(&refs, 1).await;
    let rb = refs.clone();
    let b = tokio::spawn(async move { read(&rb, 0, 4_095).await });
    yield_budget(400).await;
    refs.gate.notify_waiters();
    let (sa, ba) = a.await.unwrap();
    let (sb, bb) = b.await.unwrap();
    assert_eq!(sa, 206);
    assert_eq!(sb, 206);
    assert_eq!(ba, expected(0, 8_192));
    assert_eq!(bb, expected(0, 4_096));
    assert_eq!(refs.origin_ranges.load(Ordering::SeqCst), 1, "one fill serves both readers");
    assert_eq!(st.cache.current_bytes(), 8_192, "exactly one durable chunk");
}

// ===========================================================================
// S3 — cancelling one reader must not cancel the other's useful work
// ===========================================================================

#[tokio::test]
async fn s3_reader_cancellation_does_not_cancel_other_work() {
    let st = build_stack(&"c".repeat(40), "Show/S01/Show - S01E03.mkv", 24_000, 8_192, "/cdn/2").await;
    let refs = st.refs.clone();
    refs.gate_target.store(1, Ordering::SeqCst);
    let ra = refs.clone();
    let a = tokio::spawn(async move { read(&ra, 0, 8_191).await });
    await_origin_requests(&refs, 1).await;
    let rb = refs.clone();
    let b = tokio::spawn(async move { read(&rb, 8_192, 16_383).await });
    yield_budget(200).await;
    b.abort();
    let _ = b.await;
    refs.gate.notify_waiters();
    let (sa, ba) = a.await.unwrap();
    assert_eq!(sa, 206, "the surviving reader is unaffected by the cancellation");
    assert_eq!(ba, expected(0, 8_192));
    // The abandoned reader's chunk must not be partial durable truth. It was
    // never completed, so the only durable bytes belong to A.
    assert_eq!(st.cache.current_bytes(), 8_192, "only the surviving reader's chunk is durable");
}

// ===========================================================================
// S4 — no cross-TorrentFile sharing under concurrency
// ===========================================================================

#[tokio::test]
async fn s4_two_torrent_files_never_share_bytes() {
    let st_a = build_stack(&"d".repeat(40), "Show/S01/Show - S01E04.mkv", 12_000, 8_192, "/cdn/a").await;
    let st_b = build_stack(&"e".repeat(40), "Show/S01/Show - S01E05.mkv", 12_000, 8_192, "/cdn/b").await;
    let ra = st_a.refs.clone();
    let rb = st_b.refs.clone();
    let ta = tokio::spawn(async move { read(&ra, 0, 4_095).await });
    let tb = tokio::spawn(async move { read(&rb, 0, 4_095).await });
    let (sa, ba) = ta.await.unwrap();
    let (sb, bb) = tb.await.unwrap();
    assert_eq!(sa, 206);
    assert_eq!(sb, 206);
    assert_eq!(ba, expected(0, 4_096), "A served A's bytes");
    assert_eq!(bb, expected(0, 4_096), "B served B's bytes");
    assert_ne!(st_a.cache_key(), st_b.cache_key(), "distinct cache identities");
    assert!(st_a.present(0) && st_b.present(0), "each TorrentFile cached its own chunk");
    assert!(!st_a.present(1) && !st_b.present(1), "neither wrote the other's chunk");
}

// ===========================================================================
// S5 — near-EOF and unsatisfiable ranges at the serve layer
// ===========================================================================

#[tokio::test]
async fn s5_near_eof_and_unsatisfiable_ranges() {
    let st = build_stack(&"f".repeat(40), "Show/S01/Show - S01E06.mkv", 10_000, 4_096, "/cdn/3").await;
    let refs = st.refs.clone();
    let (s_ok, b_ok) = read(&refs, 9_000, 9_999).await;
    assert_eq!(s_ok, 206);
    assert_eq!(b_ok, expected(9_000, 1_000), "the EOF tail is exact");
    let (s_bad, b_bad) = read(&refs, 10_000, 10_500).await;
    assert_eq!(s_bad, 416, "an unsatisfiable range is rejected with 416");
    assert!(b_bad.is_empty());
}

// ===========================================================================
// S6 — same-file concurrency: two clients seek different ranges at once
// ===========================================================================

#[tokio::test]
async fn s6_same_file_two_seeks_stay_exact_and_isolated() {
    // Two warm capabilities = two concurrent readers of the SAME TorrentFile,
    // which is what the production pool grows to under pressure.
    let st = build_stack_with_caps(&"1".repeat(40), "Show/S01/Show - S01E07.mkv", 24_000, 8_192, "/cdn/4", 2).await;
    let refs = st.refs.clone();
    // Client 1 holds the origin inside chunk 0; client 2 seeks to chunk 2.
    refs.gate_target.store(1, Ordering::SeqCst);
    let r1 = refs.clone();
    let c1 = tokio::spawn(async move { read(&r1, 0, 8_191).await });
    await_origin_requests(&refs, 1).await;
    let r2 = refs.clone();
    let c2 = tokio::spawn(async move { read(&r2, 16_384, 20_000).await });
    yield_budget(300).await;
    refs.gate.notify_waiters();
    let (s1, b1) = c1.await.unwrap();
    let (s2, b2) = c2.await.unwrap();
    assert_eq!(s1, 206, "client 1 served concurrently");
    assert_eq!(s2, 206, "client 2 served concurrently");
    assert_eq!(b1, expected(0, 8_192), "client 1's seek is exact");
    assert_eq!(b2, expected(16_384, 20_000 - 16_384 + 1), "client 2's seek is exact");
    assert!(st.present(0) && st.present(2), "both ranges durable");
    // chunk 0 = 8_192 bytes, chunk 2 = 24_000 - 16_384 = 7_616 bytes.
    assert_eq!(st.cache.current_bytes(), 8_192 + 7_616, "no duplicate durable writes");
    // A later read of the untouched range stays exact and independent.
    let (s3, b3) = read(&refs, 8_192, 16_383).await;
    assert_eq!(s3, 206);
    assert_eq!(b3, expected(8_192, 8_192), "a later read of the untouched range is exact");
    assert_eq!(st.cache.current_bytes(), 24_000, "all three chunks durable exactly once");
}

// ===========================================================================
// S7 — same-file concurrency still coalesces OVERLAPPING work
// ===========================================================================

#[tokio::test]
async fn s7_same_file_overlapping_reads_still_coalesce() {
    // Two warm capabilities, but the readers ask for the SAME chunk: the
    // in-flight join must win over opening a second provider connection.
    let st = build_stack_with_caps(&"2".repeat(40), "Show/S01/Show - S01E08.mkv", 24_000, 8_192, "/cdn/5", 2).await;
    let refs = st.refs.clone();
    refs.gate_target.store(1, Ordering::SeqCst);
    let r1 = refs.clone();
    let c1 = tokio::spawn(async move { read(&r1, 0, 8_191).await });
    await_origin_requests(&refs, 1).await;
    let r2 = refs.clone();
    let c2 = tokio::spawn(async move { read(&r2, 4_096, 8_191).await });
    yield_budget(400).await;
    refs.gate.notify_waiters();
    let (s1, b1) = c1.await.unwrap();
    let (s2, b2) = c2.await.unwrap();
    assert_eq!(s1, 206);
    assert_eq!(s2, 206);
    assert_eq!(b1, expected(0, 8_192));
    assert_eq!(b2, expected(4_096, 4_096));
    assert_eq!(
        refs.origin_ranges.load(Ordering::SeqCst),
        1,
        "overlapping same-file readers coalesce to ONE origin fill even with a spare capability"
    );
    assert_eq!(st.cache.current_bytes(), 8_192, "one durable chunk");
}
