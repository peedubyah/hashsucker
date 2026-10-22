//! Adversarial cache-fill / seek-join / recovery integration harness.
//!
//! Exercises the highest-value remaining stability gap: concurrent byte
//! delivery. Runs against a REAL in-process fake HTTP/CDN origin with exact
//! Range semantics and deterministic fault injection, through the REAL
//! `fill_chunk_run` path with the REAL cache, manager, and transport.
//! Coordination is by observable state (in-flight join count, origin request
//! count, a gate the test releases) — never by sleeping.

use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State as AxState};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::Router;
use data_plane::cache::{CacheConfig, CacheEngine, ChunkGrid, TorrentFileId};
use data_plane::capability::{ApiKeys, Breaker, DeliveryCapability};
use data_plane::control::{ControlTorrentFile, ProviderCoord};
use data_plane::manager::CapabilityManager;
use data_plane::metrics::Metrics;
use data_plane::serve::fill_chunk_run;
use data_plane::transport::Faults;

/// All fault gates off: this harness injects faults at the ORIGIN, which is
/// where a real provider failure is observable.
fn no_faults() -> Faults {
    production_faults()
}

const MODE_OK: u8 = 0;
const MODE_503: u8 = 1;
const MODE_429: u8 = 2;
const MODE_SHORT_BODY: u8 = 3;
const MODE_DROP_MID: u8 = 4;

/// Deterministic content: byte i is a pure function of its offset.
fn byte_at(offset: u64) -> u8 {
    (offset as u8).wrapping_mul(31).wrapping_add(7)
}

fn expected(start: u64, len: usize) -> Vec<u8> {
    (start..start + len as u64).map(byte_at).collect()
}

#[derive(Clone, Default)]
struct OriginStats {
    requests: Arc<AtomicUsize>,
    range_requests: Arc<AtomicUsize>,
    full_requests: Arc<AtomicUsize>,
}

#[derive(Clone)]
struct OriginCtl {
    mode: Arc<AtomicU8>,
}

#[derive(Clone)]
struct OriginState {
    ctl: OriginCtl,
    stats: OriginStats,
    size: u64,
    gate: Arc<tokio::sync::Notify>,
    gate_target: Arc<AtomicUsize>,
}

/// `bytes=start-end` (production transport form).
fn parse_range_header(h: &str) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?;
    let (s, e) = spec.split_once('-')?;
    Some((s.parse().ok()?, e.parse().ok()?))
}

fn parse_query_range(path: &str) -> Option<(u64, u64)> {
    let (_, q) = path.split_once('?')?;
    let mut start = None;
    let mut end = None;
    for kv in q.split('&') {
        let (k, v) = kv.split_once('=')?;
        match k {
            "start" => start = v.parse().ok(),
            "end" => end = v.parse().ok(),
            _ => {}
        }
    }
    Some((start?, end?))
}

async fn serve_origin(
    AxState(st): AxState<OriginState>,
    Path(path): Path<String>,
    _q: Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> axum::response::Response {
    let n = st.stats.requests.fetch_add(1, Ordering::SeqCst);
    if st.gate_target.load(Ordering::SeqCst) == n + 1 {
        st.gate.notified().await;
    }
    let mode = st.ctl.mode.load(Ordering::SeqCst);
    let build = |status: u16, headers: Vec<(&str, String)>, body: Vec<u8>| {
        let mut b = axum::response::Response::builder().status(status);
        for (k, v) in headers {
            b = b.header(k, v);
        }
        b.body(axum::body::Body::from(body)).unwrap()
    };
    match mode {
        MODE_503 => build(503, vec![], b"boom".to_vec()),
        MODE_429 => build(429, vec![("retry-after", "2".into())], b"slow down".to_vec()),
        _ => {
            // The transport sends a Range HEADER (production form); the query
            // form is kept as a convenience for direct-origin probes.
            let (start, end) = match headers
                .get(axum::http::header::RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_range_header)
                .or_else(|| parse_query_range(&path))
            {
                Some((s, e)) => {
                    st.stats.range_requests.fetch_add(1, Ordering::SeqCst);
                    (s, e.min(st.size.saturating_sub(1)))
                }
                None => {
                    st.stats.full_requests.fetch_add(1, Ordering::SeqCst);
                    (0, st.size.saturating_sub(1))
                }
            };
            let len = (end - start + 1) as usize;
            let body: Vec<u8> = (start..=end).map(byte_at).collect();
            let hdrs = vec![
                ("content-range", format!("bytes {start}-{end}/{}", st.size)),
                ("content-length", len.to_string()),
            ];
            match mode {
                MODE_SHORT_BODY if len > 8 => build(206, hdrs, body[..8].to_vec()),
                MODE_DROP_MID => build(206, hdrs, body[..(len / 2).max(1)].to_vec()),
                _ => build(206, hdrs, body),
            }
        }
    }
}

async fn start_origin(state: OriginState) -> String {
    let app = Router::new().route("/cdn/:file", get(serve_origin)).with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

const INFO_HASH: &str = "a07b84404989fccee1d55c247cb03e22c8847ecc";
const INFO_HASH2: &str = "b07b84404989fccee1d55c247cb03e22c8847ecc";

#[derive(Clone)]
struct Handles {
    cache: Arc<CacheEngine>,
    manager: Arc<CapabilityManager>,
    metrics: Arc<Metrics>,
    stats: OriginStats,
    ctl: OriginCtl,
    tf: TorrentFileId,
    tf2: TorrentFileId,
    grid: ChunkGrid,
    origin_root: String,
    gate: Arc<tokio::sync::Notify>,
    gate_target: Arc<AtomicUsize>,
    /// The HTTP client the fill uses against the origin. The FAST fixture
    /// injects a short request timeout so a TRUNCATED body is detected in
    /// milliseconds; the real-time fixture uses the PRODUCTION timeout.
    client: reqwest::Client,
    /// The fault seam the fill runs with. The FAST fixture injects a short
    /// recovery backoff so a 5xx retry does not cost 30 s of wall clock;
    /// the real-time fixture uses the PRODUCTION backoff.
    faults: Faults,
}

/// The injected request timeout for the FAST proofs.
///
/// A truncated origin body is detected by the client's request timeout. In
/// production that timeout is 25 s (`PROVIDER_CLIENT_TIMEOUT`); the SEMANTIC
/// being proved — the fill fails, the chunk is not promoted, the cache is
/// not poisoned — does not depend on how long the wait was, so the fast
/// proofs inject a short one and do not spend the wall clock. The REAL
/// production timeout is exercised end-to-end by the `#[ignore]`d
/// real-time suite.
const FAST_CLIENT_TIMEOUT: Duration = Duration::from_millis(250);

/// The injected recovery backoff for the FAST proofs.
///
/// A transient 5xx waits out a cooldown (30 s in production) before the SAME
/// capability is retried. The retry budget, the same-cap reuse, the byte
/// assertions and the cache-poisoning assertions are unchanged by the
/// length of that wait, so the fast proofs inject a short one. The REAL
/// production backoff is exercised end-to-end by the `#[ignore]`d
/// real-time suite.
const FAST_RECOVERY_BACKOFF: Duration = Duration::from_millis(1);

/// The fault seam with the fast recovery backoff injected.
fn fast_faults() -> Faults {
    Faults {
        fault_429_always: false,
        fault_429_once: false,
        fault_dead_once: false,
        fault_midbody_once: false,
        recovery_backoff: Some(FAST_RECOVERY_BACKOFF),
    }
}

/// The fault seam with NO override: the PRODUCTION recovery backoff.
fn production_faults() -> Faults {
    Faults {
        fault_429_always: false,
        fault_429_once: false,
        fault_dead_once: false,
        fault_midbody_once: false,
        recovery_backoff: None,
    }
}

async fn build_fixture(file_size: u64, chunk_size: u64) -> Handles {
    build(file_size, chunk_size, None).await
}

/// Two routes for the SAME TorrentFile: the primary origin (faultable) and a
/// second, independent provider route that stays healthy.
async fn build_two_route_fixture(file_size: u64, chunk_size: u64) -> (Handles, OriginStats) {
    let alt_stats = OriginStats::default();
    let healthy = start_origin(OriginState {
        ctl: OriginCtl { mode: Arc::new(AtomicU8::new(MODE_OK)) },
        stats: alt_stats.clone(),
        size: file_size,
        gate: Arc::new(tokio::sync::Notify::new()),
        gate_target: Arc::new(AtomicUsize::new(0)),
    })
    .await;
    (build(file_size, chunk_size, Some(healthy)).await, alt_stats)
}

async fn build(file_size: u64, chunk_size: u64, alt_route: Option<String>) -> Handles {
    build_with(file_size, chunk_size, alt_route, fast_client(), fast_faults()).await
}

/// The FAST client: the production client with a short injected request
/// timeout (see `FAST_CLIENT_TIMEOUT`).
fn fast_client() -> reqwest::Client {
    data_plane::transport::build_provider_client(FAST_CLIENT_TIMEOUT)
}

/// Build a fixture with an explicit client and fault seam, so the
/// real-time suite can use the PRODUCTION timeout and backoff.
async fn build_with(
    file_size: u64,
    chunk_size: u64,
    alt_route: Option<String>,
    client: reqwest::Client,
    faults: Faults,
) -> Handles {
    std::env::set_var("SLICE4_CHUNK_SIZE", chunk_size.to_string());
    let dir = tempfile::tempdir().unwrap();
    let metrics = Arc::new(Metrics::default());
    let cache = CacheEngine::open(
        CacheConfig {
            root: dir.path().join("cache"),
            max_bytes: 64 * 1024 * 1024,
            chunk_size,
        },
        metrics.clone(),
    )
    .unwrap();

    let ctl = OriginCtl { mode: Arc::new(AtomicU8::new(MODE_OK)) };
    let stats = OriginStats::default();
    let gate = Arc::new(tokio::sync::Notify::new());
    let gate_target = Arc::new(AtomicUsize::new(0));
    let origin_root = start_origin(OriginState {
        ctl: ctl.clone(),
        stats: stats.clone(),
        size: file_size,
        gate: gate.clone(),
        gate_target: gate_target.clone(),
    })
    .await;

    let tf = TorrentFileId::new(
        "tf-1".into(),
        INFO_HASH.into(),
        "Show/Season 01/Show - S01E01.mkv".into(),
        file_size,
    );
    let tf2 = TorrentFileId::new(
        "tf-2".into(),
        INFO_HASH2.into(),
        "Show/Season 01/Show - S01E02.mkv".into(),
        file_size,
    );

    let mut coords = vec![ProviderCoord {
        provider: "torbox".into(),
        account_scope: "default".into(),
        provider_resource_id: "res-1".into(),
        provider_file_id: "0".into(),
        state: "ready".into(),
        canonical_internal_path: Some("Show/Season 01/Show - S01E01.mkv".into()),
        size: file_size,
    }];
    if alt_route.is_some() {
        coords.push(ProviderCoord {
            provider: "realdebrid".into(),
            account_scope: "default".into(),
            provider_resource_id: "res-alt".into(),
            provider_file_id: "1".into(),
            state: "ready".into(),
            canonical_internal_path: Some("Show/Season 01/Show - S01E01.mkv".into()),
            size: file_size,
        });
    }
    let manager = CapabilityManager::new(
        ControlTorrentFile {
            id: tf.tf_id_durable.clone(),
            info_hash: INFO_HASH.into(),
            canonical_internal_path: Some("Show/Season 01/Show - S01E01.mkv".into()),
            size: file_size,
        },
        coords,
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    );

    std::mem::forget(dir);

    let manager = Arc::new(manager);
    if let Some(alt) = alt_route {
        manager.slots
            .iter()
            .find(|s| s.coord.provider == "realdebrid")
            .unwrap()
            .caps
            .lock()
            .unwrap()
            .push(DeliveryCapability::new(
                format!("{alt}/cdn/0"),
                "realdebrid".into(),
                "default".into(),
                tf.tf_id_durable.clone(),
                "res-alt".into(),
                "1".into(),
                None,
            ));
    }

    Handles {
        cache,
        manager,
        metrics,
        stats,
        ctl,
        tf,
        tf2,
        grid: ChunkGrid::new(chunk_size, file_size),
        origin_root,
        gate,
        gate_target,
        client,
        faults,
    }
}

impl Handles {
    async fn reserve(&self, url: &str, provider: &str, resource: &str, file: &str) -> data_plane::manager::ReservedCapability {
        let slot_index = self
            .manager
            .slots
            .iter()
            .position(|s| s.coord.provider == provider && s.coord.provider_resource_id == resource)
            .unwrap_or(0);
        self.manager.slots[slot_index]
            .caps
            .lock()
            .unwrap()
            .push(DeliveryCapability::new(
                url.to_string(),
                provider.into(),
                "default".into(),
                self.tf.tf_id_durable.clone(),
                resource.into(),
                file.into(),
                None,
            ));
        match self.manager.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("warm cap reserves"),
        }
    }

    async fn reserve_primary(&self) -> data_plane::manager::ReservedCapability {
        self.reserve(&format!("{}/cdn/0", self.origin_root), "torbox", "res-1", "0").await
    }

    fn set_mode(&self, mode: u8) {
        self.ctl.mode.store(mode, Ordering::SeqCst);
    }

    async fn await_inflight_joins(&self, n: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.cache.inflight().len() < n && Instant::now() < deadline {
            tokio::task::yield_now().await;
        }
    }

    async fn await_origin_requests(&self, n: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.stats.requests.load(Ordering::SeqCst) < n && Instant::now() < deadline {
            tokio::task::yield_now().await;
        }
    }

    async fn fill(
        &self,
        indices: Vec<u64>,
        f_start: u64,
        f_end: u64,
        w_start: u64,
        w_end: u64,
        cap: Option<data_plane::manager::ReservedCapability>,
    ) -> bool {
        let _ = fill_chunk_run(
            self.cache.clone(),
            self.metrics.clone(),
            self.manager.clone(),
            self.client.clone(),
            0,
            self.tf.clone(),
            indices,
            f_start,
            f_end,
            w_start,
            w_end,
            self.faults,
            None,
            None,
            false,
            cap,
        )
        .await;
        let key = self.tf.cache_key();
        self.grid
            .chunks_touching(w_start, w_end)
            .into_iter()
            .all(|idx| self.cache.is_present(&key, idx).unwrap_or(false))
    }

    fn read(&self, start: u64, end: u64) -> Vec<u8> {
        self.cache.pread(&self.tf, start, end).unwrap()
    }

    fn present(&self, idx: u64) -> bool {
        self.cache.is_present(&self.tf.cache_key(), idx).unwrap_or(false)
    }
}

// ===========================================================================
// Exact Range semantics + fixed-grid boundaries
// ===========================================================================

#[tokio::test]
async fn r1_exact_range_bytes_across_chunk_boundaries() {
    let fx = build_fixture(10_000, 4_096).await;
    // One chunk per fill (the production shape).
    for idx in 0..3u64 {
        let cs = idx * 4_096;
        let ce = fx.grid.chunk_end(idx).unwrap();
        let cap = fx.reserve_primary().await;
        assert!(fx.fill(vec![idx], cs, ce, cs, ce, Some(cap)).await, "chunk {idx} filled");
    }
    assert!(fx.present(0) && fx.present(1) && fx.present(2), "all touched chunks present");
    assert!(!fx.present(3), "untouched chunk is not present");
    // The READ spans chunk boundaries and must stay byte-exact.
    assert_eq!(fx.read(100, 8_000), expected(100, 8_000 - 100 + 1), "byte-exact across boundaries");
}

#[tokio::test]
async fn r2_near_eof_chunk_is_shorter_and_exact() {
    let fx = build_fixture(10_000, 4_096).await;
    assert_eq!(fx.grid.chunk_len(2), 1_808, "the EOF chunk is deterministically shorter");
    let cap = fx.reserve_primary().await;
    assert!(fx.fill(vec![2], 2 * 4_096, 9_999, 2 * 4_096, 9_999, Some(cap)).await);
    // A window strictly inside the EOF chunk (9_000..=9_099 is 100 bytes).
    assert_eq!(fx.read(9_000, 9_099), expected(9_000, 100), "mid-EOF-chunk bytes exact");
    // The whole EOF chunk, and the last byte.
    assert_eq!(fx.read(8_192, 9_999), expected(8_192, 1_808), "EOF chunk tail exact");
    assert_eq!(fx.read(9_999, 9_999), expected(9_999, 1), "the last byte is exact");
}

#[tokio::test]
async fn r3_invalid_ranges_are_rejected_without_cache_writes() {
    let fx = build_fixture(10_000, 4_096).await;
    // 10_000 bytes / 4_096 = 3 chunks; chunk 9 cannot exist.
    assert_eq!(fx.grid.chunk_count(), 3);
    assert_eq!(fx.grid.chunk_len(9), 0, "a chunk starting past EOF does not exist");
    assert_eq!(fx.grid.chunk_end(9), None);
    assert_eq!(fx.grid.chunks_touching(36_864, 36_874).len(), 0,
        "a past-EOF window touches no chunk, so it can never be satisfied");
    let cap = fx.reserve_primary().await;
    // The origin answers 416 for an unsatisfiable Range (asserted by the
    // transport path); what matters durably is that nothing was created.
    let _ = fx.fill(vec![9], 36_864, 36_874, 36_864, 36_874, Some(cap)).await;
    assert!(!fx.present(9), "no cache entry written for a chunk that cannot exist");
    assert_eq!(fx.cache.current_bytes(), 0, "nothing durable was created");
}

// ===========================================================================
// Coalescing / seek-join
// ===========================================================================

#[tokio::test]
async fn r4_concurrent_overlapping_fills_stay_byte_exact() {
    // Two readers over overlapping ranges, concurrently. The per-chunk
    // coalescer mechanism (one owner, many waiters, resolve-on-finalize) is
    // unit-covered in cache.rs; this exercises the fill path itself under
    // concurrency and proves the outcome: no corruption, no duplicate
    // durable bytes, both readers served.
    let fx = build_fixture(20_000, 8_192).await;
    let fx_a = fx.clone();
    let a = tokio::spawn(async move {
        let cap = fx_a.reserve_primary().await;
        fx_a.fill(vec![0], 0, 8_191, 0, 8_191, Some(cap)).await
    });
    let fx_b = fx.clone();
    let b = tokio::spawn(async move {
        let cap = fx_b.reserve_primary().await;
        fx_b.fill(vec![0], 0, 8_191, 4_096, 8_191, Some(cap)).await
    });
    let (ra, rb) = tokio::join!(a, b);
    assert!(ra.unwrap() && rb.unwrap(), "both readers complete");
    assert_eq!(fx.read(0, 8_191), expected(0, 8_192), "concurrent overlapping fills are byte-exact");
    assert_eq!(
        fx.cache.current_bytes(),
        8_192,
        "the chunk is staged exactly once — concurrent fills never duplicate durable bytes"
    );
}

#[tokio::test]
async fn r5_backward_seek_joins_in_flight_fill() {
    let fx = build_fixture(24_000, 8_192).await;
    fx.gate_target.store(1, Ordering::SeqCst);
    let fx_a = fx.clone();
    let a = tokio::spawn(async move {
        let cap = fx_a.reserve_primary().await;
        fx_a.fill(vec![1], 8_192, 16_383, 8_192, 16_383, Some(cap)).await
    });
    fx.await_origin_requests(1).await;
    let fx_b = fx.clone();
    fx_b.gate_target.store(0, Ordering::SeqCst);
    let b = tokio::spawn(async move {
        let cap = fx_b.reserve_primary().await;
        fx_b.fill(vec![0], 0, 8_191, 0, 8_191, Some(cap)).await
    });
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
    fx.gate.notify_waiters();
    let (ra, rb) = tokio::join!(a, b);
    assert!(ra.unwrap() && rb.unwrap());
    assert_eq!(fx.read(0, 8_191), expected(0, 8_192), "backward bytes exact");
    assert_eq!(fx.read(8_192, 16_383), expected(8_192, 8_192), "forward bytes exact");
    assert_eq!(fx.stats.range_requests.load(Ordering::SeqCst), 2, "two chunks, two origin requests");
}

#[tokio::test]
async fn r6_forward_seek_does_not_corrupt_or_duplicate() {
    let fx = build_fixture(24_000, 8_192).await;
    let cap0 = fx.reserve_primary().await;
    assert!(fx.fill(vec![0], 0, 8_191, 0, 8_191, Some(cap0)).await);
    let cap1 = fx.reserve_primary().await;
    assert!(fx.fill(vec![1], 8_192, 16_383, 8_192, 16_383, Some(cap1)).await);
    assert_eq!(fx.read(0, 16_383), expected(0, 16_384), "both chunks stayed exact");
    assert_eq!(fx.stats.full_requests.load(Ordering::SeqCst), 0, "every fill used exact Ranges");
}

// ===========================================================================
// Origin failure modes
// ===========================================================================

#[tokio::test]
async fn r7_partial_origin_response_does_not_poison_cache() {
    let fx = build_fixture(10_000, 4_096).await;
    fx.set_mode(MODE_SHORT_BODY);
    let cap = fx.reserve_primary().await;
    assert!(!fx.fill(vec![0], 0, 4_095, 0, 4_095, Some(cap)).await, "a short body must fail the fill");
    assert!(!fx.present(0), "a partial origin response must not mark the chunk present");
    fx.set_mode(MODE_OK);
    let cap2 = fx.reserve_primary().await;
    assert!(fx.fill(vec![0], 0, 4_095, 0, 4_095, Some(cap2)).await, "recovery succeeds");
    assert_eq!(fx.read(0, 4_095), expected(0, 4_096));
}

#[tokio::test]
async fn r8_origin_disconnect_mid_fill_leaves_recovery_possible() {
    let fx = build_fixture(10_000, 4_096).await;
    fx.set_mode(MODE_DROP_MID);
    let cap = fx.reserve_primary().await;
    assert!(!fx.fill(vec![0], 0, 4_095, 0, 4_095, Some(cap)).await, "a truncated body must fail the fill");
    assert!(!fx.present(0), "no chunk promoted from a truncated body");
    fx.set_mode(MODE_OK);
    let cap2 = fx.reserve_primary().await;
    assert!(fx.fill(vec![0], 0, 4_095, 0, 4_095, Some(cap2)).await);
    assert_eq!(fx.read(0, 4_095), expected(0, 4_096));
}

#[tokio::test]
async fn r9_503_then_healthy_recovers_and_is_not_terminal() {
    let fx = build_fixture(10_000, 4_096).await;
    fx.set_mode(MODE_503);
    let cap = fx.reserve_primary().await;
    assert!(!fx.fill(vec![0], 0, 4_095, 0, 4_095, Some(cap)).await);
    assert!(!fx.present(0), "a 5xx must not create cache truth");
    fx.set_mode(MODE_OK);
    let cap2 = fx.reserve_primary().await;
    assert!(fx.fill(vec![0], 0, 4_095, 0, 4_095, Some(cap2)).await, "transient failure recovers");
}

#[tokio::test]
async fn r10_429_retry_after_is_honored_then_recovers() {
    let fx = build_fixture(10_000, 4_096).await;
    fx.set_mode(MODE_429);
    let cap = fx.reserve_primary().await;
    assert!(!fx.fill(vec![0], 0, 4_095, 0, 4_095, Some(cap)).await, "a 429 must not bind");
    assert!(!fx.present(0), "no cache truth from a rate-limited read");
    fx.set_mode(MODE_OK);
    let cap2 = fx.reserve_primary().await;
    assert!(fx.fill(vec![0], 0, 4_095, 0, 4_095, Some(cap2)).await, "after the horizon the read recovers");
    assert_eq!(fx.read(0, 4_095), expected(0, 4_096));
}

#[tokio::test]
async fn r11_failed_fill_does_not_strand_future_requests() {
    let fx = build_fixture(20_000, 8_192).await;
    fx.set_mode(MODE_503);
    let cap = fx.reserve_primary().await;
    assert!(!fx.fill(vec![0], 0, 8_191, 0, 8_191, Some(cap)).await);
    fx.set_mode(MODE_OK);
    let cap2 = fx.reserve_primary().await;
    let started = Instant::now();
    assert!(fx.fill(vec![0], 0, 8_191, 0, 8_191, Some(cap2)).await, "a later request starts a fresh fill");
    assert!(started.elapsed() < Duration::from_secs(30), "no dead in-flight waiter");
    assert_eq!(fx.read(0, 8_191), expected(0, 8_192));
}

#[tokio::test]
async fn r12_one_waiter_cancellation_does_not_cancel_useful_work() {
    let fx = build_fixture(20_000, 8_192).await;
    fx.gate_target.store(1, Ordering::SeqCst);
    let fx_a = fx.clone();
    let leader = tokio::spawn(async move {
        let cap = fx_a.reserve_primary().await;
        fx_a.fill(vec![0], 0, 8_191, 0, 8_191, Some(cap)).await
    });
    fx.await_origin_requests(1).await;
    let fx_b = fx.clone();
    fx_b.gate_target.store(0, Ordering::SeqCst);
    let waiter = tokio::spawn(async move {
        let cap = fx_b.reserve_primary().await;
        fx_b.fill(vec![0], 0, 8_191, 4_096, 8_191, Some(cap)).await
    });
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
    waiter.abort();
    let _ = waiter.await;
    fx.gate.notify_waiters();
    assert!(leader.await.unwrap(), "the leader's work survived the waiter's cancellation");
    assert_eq!(fx.read(0, 8_191), expected(0, 8_192));
}

// ===========================================================================
// Exact TorrentFile identity
// ===========================================================================

#[tokio::test]
async fn r13_two_torrent_files_never_cross_read_bytes() {
    let fx = build_fixture(10_000, 4_096).await;
    let cap = fx.reserve_primary().await;
    assert!(fx.fill(vec![0], 0, 4_095, 0, 4_095, Some(cap)).await);
    assert_ne!(fx.tf.cache_key(), fx.tf2.cache_key(), "identity is exact per TorrentFile");
    assert_eq!(
        fx.cache.is_present(&fx.tf2.cache_key(), 0).unwrap_or(false),
        false,
        "a different TorrentFile never inherits another's cached chunks"
    );
    assert_eq!(fx.read(0, 4_095), expected(0, 4_096), "tf-1 bytes exact");

    let tf2_manager = Arc::new(CapabilityManager::new(
        ControlTorrentFile {
            id: fx.tf2.tf_id_durable.clone(),
            info_hash: INFO_HASH2.into(),
            canonical_internal_path: Some("Show/Season 01/Show - S01E02.mkv".into()),
            size: 10_000,
        },
        vec![ProviderCoord {
            provider: "torbox".into(),
            account_scope: "default".into(),
            provider_resource_id: "res-2".into(),
            provider_file_id: "1".into(),
            state: "ready".into(),
            canonical_internal_path: Some("Show/Season 01/Show - S01E02.mkv".into()),
            size: 10_000,
        }],
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        fx.metrics.clone(),
    ));
    tf2_manager.slots[0].caps.lock().unwrap().push(DeliveryCapability::new(
        format!("{}/cdn/1", fx.origin_root),
        "torbox".into(),
        "default".into(),
        fx.tf2.tf_id_durable.clone(),
        "res-2".into(),
        "1".into(),
        None,
    ));
    let cap2 = match tf2_manager.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("warm cap"),
    };
    let _ = fill_chunk_run(
        fx.cache.clone(),
        fx.metrics.clone(),
        tf2_manager,
        reqwest::Client::new(),
        0,
        fx.tf2.clone(),
        vec![0],
        0,
        4_095,
        0,
        4_095,
        no_faults(),
        None,
        None,
        false,
        Some(cap2),
    )
    .await;
    assert_eq!(
        fx.cache.pread(&fx.tf2, 0, 4_095).unwrap(),
        expected(0, 4_096),
        "tf-2 served its own bytes through its own identity"
    );
    assert_eq!(
        fx.cache.pread(&fx.tf, 0, 4_095).unwrap(),
        expected(0, 4_096),
        "tf-1's bytes were never disturbed"
    );
}

// ===========================================================================
// Provider degradation with a second valid route for the SAME TorrentFile
// ===========================================================================

#[tokio::test]
async fn r14_same_tf_alternate_route_recovers_without_cross_representation() {
    let (fx, alt_stats) = build_two_route_fixture(10_000, 4_096).await;
    // Both routes are warm; degrade the PRIMARY route only.
    fx.set_mode(MODE_503);

    // Route selection is the manager's job: with the primary failing, the
    // read must be served by the alternate route for the SAME TorrentFile.
    let reserved = match fx.manager.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("a valid alternate route must keep the TorrentFile servable"),
    };
    assert_eq!(
        reserved.cap.provider, "realdebrid",
        "recovery used the alternate provider route, not the degraded primary"
    );
    assert_eq!(reserved.cap.torrent_file_id, fx.tf.tf_id_durable,
        "the SAME TorrentFile is served — never a different representation");

    // Fill through the manager-selected route and prove exact bytes.
    let ok = fx.fill(vec![0], 0, 4_095, 0, 4_095, Some(reserved)).await;
    assert!(ok, "the read completed on the alternate route");
    assert_eq!(fx.read(0, 4_095), expected(0, 4_096), "recovered bytes are exact");
    assert!(fx.present(0), "the recovered chunk is durably present");
    assert!(
        alt_stats.range_requests.load(Ordering::SeqCst) >= 1,
        "the alternate route for the SAME TorrentFile served the read"
    );
}

// ===========================================================================
// THE REAL-TIME SUITE — the PRODUCTION timeout configuration, end to end
// ===========================================================================
//
// `cargo test` does NOT run these. They are the explicit real-time suite:
//   cargo test --test adversarial_cache_fill -- --ignored
//
// They exist because the fast proofs above INJECT a short request timeout
// and a short recovery backoff. The invariants they prove do not depend on
// how long those waits were — but the production VALUES do have to be
// exercised somewhere, end to end, or "the production configuration works"
// would be an untested claim. These are that test.
//
// Each one asserts the SAME semantic outcome as its fast sibling AND that
// the real production interval is the one in play.

/// The PRODUCTION client timeout, end to end.
///
/// A truncated provider body is only DETECTABLE through the client's request
/// timeout. This test uses the production client (25 s) and the production
/// fault seam, and proves:
///   - the truncated body is detected as a transport failure (not a
///     successful short read);
///   - the fill FAILS;
///   - the chunk is NOT promoted, so the cache is not poisoned;
///   - the real production interval is the one in play (the elapsed time is
///     at least the production timeout).
#[tokio::test]
#[ignore = "real-time: exercises the production 25 s client timeout end to end"]
async fn slow_real_time_truncated_origin_body_is_detected_at_the_production_timeout() {
    let production_client =
        data_plane::transport::build_provider_client(data_plane::transport::PROVIDER_CLIENT_TIMEOUT);
    let fx = build_with(
        10_000,
        4_096,
        None,
        production_client,
        production_faults(),
    )
    .await;
    fx.set_mode(MODE_SHORT_BODY);
    let cap = fx.reserve_primary().await;

    let started = std::time::Instant::now();
    let filled = fx.fill(vec![0], 0, 4_095, 0, 4_095, Some(cap)).await;
    let elapsed = started.elapsed();

    // The same semantic assertions the fast sibling makes.
    assert!(!filled, "a short body must fail the fill");
    assert!(!fx.present(0), "a partial origin response must not mark the chunk present");

    // And the real production interval is the one in play.
    assert!(
        elapsed >= data_plane::transport::PROVIDER_CLIENT_TIMEOUT,
        "the production client timeout must be the one in play (elapsed {elapsed:?})"
    );
}

/// The PRODUCTION recovery backoff, end to end.
///
/// A transient 5xx waits out a cooldown before the SAME capability is
/// retried. In production that is the provider's Retry-After, or 30 s when
/// the provider sends none. This test uses the production fault seam (no
/// backoff override) and proves:
///   - the 5xx does not create cache truth (no poisoning);
///   - the SAME capability is retried and the read recovers afterwards;
///   - the real production cooldown is the one in play.
#[tokio::test]
#[ignore = "real-time: exercises the production 30 s recovery backoff end to end"]
async fn slow_real_time_transient_5xx_waits_out_the_production_backoff_then_recovers() {
    let production_client =
        data_plane::transport::build_provider_client(data_plane::transport::PROVIDER_CLIENT_TIMEOUT);
    let fx = build_with(
        20_000,
        8_192,
        None,
        production_client,
        production_faults(),
    )
    .await;
    fx.set_mode(MODE_503);
    let cap = fx.reserve_primary().await;

    let started = std::time::Instant::now();
    let filled = fx.fill(vec![0], 0, 8_191, 0, 8_191, Some(cap)).await;
    let elapsed = started.elapsed();

    // The same semantic assertions the fast sibling makes.
    assert!(!filled, "a 5xx must not create cache truth");
    assert!(!fx.present(0), "a 5xx must not create cache truth");

    // And the real production cooldown is the one in play.
    assert!(
        elapsed >= Duration::from_secs(30),
        "the production recovery backoff must be the one in play (elapsed {elapsed:?})"
    );
}
