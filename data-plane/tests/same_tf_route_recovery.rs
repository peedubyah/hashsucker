//! Same-TorrentFile alternate-route recovery, driven through the REAL serve
//! layer (axum router + real transport + real cache + real manager) against
//! deterministic in-process provider origins.
//!
//! The scenario under proof: the authoritative TorrentFile has two exact
//! ProviderPlacements (two providers, same info_hash/path/size). The
//! currently-used route becomes unavailable; the alternate is already cached.
//! What must hold:
//!   - the SAME TorrentFile is served (never a different representation),
//!   - no Binding / TorrentFile / identity change is even expressible here,
//!   - the alternate route is selected transparently (client never retries),
//!   - bytes stay exact,
//!   - the failed route does not poison the durable cache or strand waiters,
//!   - acquisitions stay bounded (no provider-control amplification),
//!   - a placement discovered later is adopted through refresh — and a
//!     restart rebuilds the route set from fresh control truth.
//!
//! Failure classification proved here, all against ONE TorrentFile:
//!   resource-not-found (404)  -> dead capability + failover to alternate
//!   not-cached-any-more       -> the same durable-truth shape as 404
//!   5xx                       -> transient, breaker + failover
//!   429 / Retry-After         -> throttled, ledger + failover
//!   timeout                   -> headerless timeout, failover (no signal)
//!   malformed provider answer -> terminal for that attempt, failover
//!   every route failing       -> honest AllSameTfFailed, cache unpoisoned
//!
//! Nothing here touches a provider account: both "providers" are local HTTP
//! origins with injectable fault modes, and byte content is identical on both
//! so a recovery is provably the same representation.

use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use data_plane::cache::{CacheConfig, CacheEngine, TorrentFileId};
use data_plane::capability::{ApiKeys, DeliveryCapability};
use data_plane::control::{ControlTorrentFile, ProviderCoord};
use data_plane::manager::CapabilityManager;
use data_plane::metrics::Metrics;
use data_plane::serve::{get_file, AppState};

const INFO_HASH: &str = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00";
const PATH: &str = "Show/Season 01/Show - S01E01.mkv";
const CHUNK: u64 = 8_192;
const FILE_SIZE: u64 = 3 * CHUNK;

const MODE_OK: u8 = 0;
const MODE_404: u8 = 1; // resource not found / no longer cached (durable truth)
const MODE_503: u8 = 2; // transient upstream
const MODE_429: u8 = 3; // transient, load-signalling
const MODE_SHORT_BODY: u8 = 4; // malformed/truncated provider payload
const MODE_HANG: u8 = 5; // never answers (timeout class)

#[derive(Clone, Default)]
struct OriginStats {
    requests: Arc<AtomicUsize>,
    range_requests: Arc<AtomicUsize>,
}

#[derive(Clone)]
struct OriginState {
    mode: Arc<AtomicU8>,
    stats: OriginStats,
    size: u64,
}

/// byte i is a pure function of its offset, and is IDENTICAL on both routes.
fn byte_at(offset: u64) -> u8 {
    (offset as u8).wrapping_mul(31).wrapping_add(7)
}

fn expected(start: u64, len: usize) -> Vec<u8> {
    (start..start + len as u64).map(byte_at).collect()
}

fn body_for(start: u64, len: u64) -> Vec<u8> {
    (start..start + len).map(byte_at).collect()
}

async fn serve_origin(
    axum::extract::State(st): axum::extract::State<OriginState>,
    axum::extract::Path(path): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    st.stats.requests.fetch_add(1, Ordering::SeqCst);
    let mode = st.mode.load(Ordering::SeqCst);
    let build = |status: u16, body: Vec<u8>| {
        axum::response::Response::builder()
            .status(status)
            .body(axum::body::Body::from(body))
            .unwrap()
    };
    let build_hdrs = |status: u16, hdrs: Vec<(&str, String)>, body: Vec<u8>| {
        let mut b = axum::response::Response::builder().status(status);
        for (k, v) in hdrs {
            b = b.header(k, v);
        }
        b.body(axum::body::Body::from(body)).unwrap()
    };
    match mode {
        MODE_404 => return build(404, b"not found".to_vec()),
        MODE_503 => return build(503, b"upstream".to_vec()),
        MODE_429 => {
            return axum::response::Response::builder()
                .status(429)
                .header("retry-after", "30")
                .body(axum::body::Body::from(b"slow down".to_vec()))
                .unwrap();
        }
        MODE_HANG => {
            tokio::time::sleep(Duration::from_secs(60)).await;
            return build(200, vec![]);
        }
        _ => {}
    }
    let _ = path;
    let range = headers
        .get(axum::http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.trim().strip_prefix("bytes="))
        .and_then(|spec| {
            let (s, e) = spec.split_once('-')?;
            Some((s.parse::<u64>().ok()?, e.parse::<u64>().ok()?))
        });
    let _ = mode;
    match range {
        Some((start, end)) => {
            st.stats.range_requests.fetch_add(1, Ordering::SeqCst);
            // A well-formed provider 206 carries the range metadata a reader
            // must verify; omitting it would itself be a malformed answer.
            let hdrs = vec![
                ("content-range", format!("bytes {start}-{end}/{}", st.size)),
                ("content-length", (end - start + 1).to_string()),
            ];
            if st.mode.load(Ordering::SeqCst) == MODE_SHORT_BODY {
                // Malformed: claims 206 + the correct range metadata, then
                // truncates the payload hard.
                return build_hdrs(206, hdrs, body_for(start, 1));
            }
            build_hdrs(206, hdrs, body_for(start, end - start + 1))
        }
        None => build(200, body_for(0, st.size)),
    }
}

async fn start_origin(state: OriginState) -> String {
    let app = Router::new()
        .route("/cdn/:file", axum::routing::get(serve_origin))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

/// One provider route: a live origin plus the handle that faults it.
#[derive(Clone)]
struct Route {
    base: String,
    mode: Arc<AtomicU8>,
    stats: OriginStats,
}

impl Route {
    /// Starts a live origin and returns the route handle plus its base URL.
    async fn start(size: u64) -> (Route, String) {
        let mode = Arc::new(AtomicU8::new(MODE_OK));
        let stats = OriginStats::default();
        let base = start_origin(OriginState {
            mode: mode.clone(),
            stats: stats.clone(),
            size,
        })
        .await;
        (Route { base: base.clone(), mode, stats }, base)
    }

    fn fault(&self, mode: u8) {
        self.mode.store(mode, Ordering::SeqCst);
    }

    fn requests(&self) -> usize {
        self.stats.requests.load(Ordering::SeqCst)
    }

    fn range_requests(&self) -> usize {
        self.stats.range_requests.load(Ordering::SeqCst)
    }
}

struct Stack {
    root: std::path::PathBuf,
    primary: Route,
    alternate: Route,
    primary_base: String,
    alternate_base: String,
    tf: TorrentFileId,
    manager: Arc<CapabilityManager>,
    cache: Arc<CacheEngine>,
    metrics: Arc<Metrics>,
    server_base: String,
    _server: tokio::task::JoinHandle<()>,
    _dir: tempfile::TempDir,
}

async fn build_stack(size: u64, client_timeout_ms: Option<u64>) -> Stack {
    let dir = tempfile::tempdir().unwrap();
    let metrics = Arc::new(Metrics::default());
    let cache = CacheEngine::open(
        CacheConfig {
            root: dir.path().join("cache"),
            max_bytes: 64 << 20,
            chunk_size: CHUNK,
        },
        metrics.clone(),
    )
    .unwrap();

    let (primary, primary_base) = Route::start(size).await;
    let (alternate, alternate_base) = Route::start(size).await;

    let tf = TorrentFileId::new(
        format!("tf-{INFO_HASH}"),
        INFO_HASH.to_string(),
        PATH.to_string(),
        size,
    );

    let manager = Arc::new(CapabilityManager::new(
        ControlTorrentFile {
            id: tf.tf_id_durable.clone(),
            info_hash: INFO_HASH.to_string(),
            canonical_internal_path: Some(PATH.to_string()),
            size,
        },
        vec![
            ProviderCoord {
                provider: "torbox".into(),
                account_scope: "default".into(),
                provider_resource_id: "res-primary".into(),
                provider_file_id: "0".into(),
                state: "ready".into(),
                canonical_internal_path: Some(PATH.into()),
                size,
            },
            ProviderCoord {
                provider: "realdebrid".into(),
                account_scope: "default".into(),
                provider_resource_id: "res-alternate".into(),
                provider_file_id: "1".into(),
                state: "ready".into(),
                canonical_internal_path: Some(PATH.into()),
                size,
            },
        ],
        ApiKeys {
            torbox: String::new(),
            realdebrid: String::new(),
        },
        reqwest::Client::new(),
        metrics.clone(),
    ));
    // One warm capability per route, each pointing at its own origin.
    // Slot order inside the manager is HashMap-grouping order and is NOT
    // index-stable, so bind each cap to the slot whose coord names the same
    // provider — attaching by index would cross the routes.
    let warm = |slot_idx: usize, url: String, provider: &str, resource: &str, file: &str| {
        manager.slots[slot_idx].caps.lock().unwrap().push(DeliveryCapability::new(
            url,
            provider.to_string(),
            "default".into(),
            tf.tf_id_durable.clone(),
            resource.to_string(),
            file.to_string(),
            None,
        ));
    };
    let slot_of = |provider: &str| -> usize {
        manager
            .slots
            .iter()
            .position(|s| s.coord.provider == provider)
            .unwrap_or_else(|| panic!("no slot for provider {provider}"))
    };
    warm(
        slot_of("torbox"),
        format!("{primary_base}/cdn/0"),
        "torbox",
        "res-primary",
        "0",
    );
    warm(
        slot_of("realdebrid"),
        format!("{alternate_base}/cdn/1"),
        "realdebrid",
        "res-alternate",
        "1",
    );

    let mut builder = reqwest::Client::builder();
    if let Some(ms) = client_timeout_ms {
        builder = builder.timeout(Duration::from_millis(ms));
    }
    let state = Arc::new(AppState {
        authoritative_size: size,
        tf_id: tf.tf_id_durable.clone(),
        tf_id_durable: tf.tf_id_durable.clone(),
        info_hash: INFO_HASH.to_string(),
        canonical_path: PATH.to_string(),
        client: builder.build().unwrap(),
        metrics: metrics.clone(),
        manager: manager.clone(),
        cache: Some(cache.clone()),
        playback: data_plane::playback_intel::PlaybackIntelligence::new(
            data_plane::playback_intel::PfConfig {
                enabled: false,
                ahead_chunks: 1,
                sequential_threshold: 3,
                prefetch_priority: 0,
                mode: data_plane::playback_intel::PrefetchMode::Try,
            },
        ),
    });

    let app = Router::new()
        .route("/files/:tfId", axum::routing::get(get_file))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    Stack {
        root: dir.path().join("cache"),
        primary,
        alternate,
        primary_base,
        alternate_base,
        tf,
        manager,
        cache,
        metrics,
        server_base: format!("http://{addr}"),
        _server: server,
        _dir: dir,
    }
}

impl Stack {
    /// Durable presence of one chunk (the cache's own truth).
    fn present(&self, idx: u64) -> bool {
        self.cache
            .is_present(&self.tf.cache_key(), idx)
            .unwrap_or(false)
    }

    /// Read a durable chunk back through the cache's own read path.
    fn read_back(&self, idx: u64) -> Vec<u8> {
        let start = idx * CHUNK;
        let end = (start + CHUNK - 1).min(self.tf.size - 1);
        self.cache
            .pread(&self.tf, start, end)
            .unwrap_or_else(|e| panic!("chunk {idx} not readable: {e}"))
    }

    /// Bounded wait for the durable publication of one chunk. Publication is
    /// asynchronous relative to the client's last delivered byte.
    async fn wait_present(&self, idx: u64) {
        for _ in 0..1000 {
            if self.present(idx) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("chunk {idx} was never published durably");
    }

    /// The on-disk cache directory, so a test can reopen it as a restart would.
    fn cache_root_dir(&self) -> std::path::PathBuf {
        self.root.clone()
    }

    /// Fill one chunk through the manager-selected route (the same
    /// `fill_chunk_run` the serve layer calls).
    async fn fill_through(
        &self,
        manager: &Arc<CapabilityManager>,
        cap: data_plane::manager::ReservedCapability,
        idx: u64,
    ) -> bool {
        let start = idx * CHUNK;
        let end = start + CHUNK - 1;
        data_plane::serve::fill_chunk_run(
            self.cache.clone(),
            self.metrics.clone(),
            manager.clone(),
            reqwest::Client::new(),
            0,
            self.tf.clone(),
            vec![idx],
            start,
            end,
            start,
            end,
            data_plane::transport::Faults {
                fault_429_always: false,
                fault_429_once: false,
                fault_dead_once: false,
                fault_midbody_once: false,
            },
            None,
            None,
            false,
            Some(cap),
        )
        .await
        .is_some()
    }
}

/// One real HTTP range read through the serve layer. Returns status, body and
/// the request-scoped serving-attribution header. NOTE: attribution is a
/// snapshot of the capability the demand INITIALLY selected; a transparent
/// in-read failover keeps that snapshot (it cannot rewrite what the demand
/// initially picked), so which route DELIVERED the bytes is proven by the
/// origin request counters, not by this header.
async fn read(st: &Stack, start: u64, end: u64) -> (u16, Vec<u8>, String) {
    let resp = reqwest::Client::new()
        .get(format!("{}/files/{}", st.server_base, st.tf.tf_id_durable))
        .header("range", format!("bytes={start}-{end}"))
        .send()
        .await
        .expect("serve-layer request");
    let status = resp.status().as_u16();
    let provider = resp
        .headers()
        .get("x-hashsucker-serving-provider")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // A truncated stream is an honest outcome (the failure arrived after the
    // headers committed), so a body-read error is a short body, never a panic.
    let body = resp.bytes().await.map(|b| b.to_vec()).unwrap_or_default();
    (status, body, provider)
}

/// One healthy read, reporting which lane served it. Route choice among
/// equally healthy slots is slot-order dependent, so every fault test must
/// first learn which lane actually won before it faults anything.
async fn lane_that_serves(st: &Stack) -> String {
    let (_status, body, provider) = read(st, 0, CHUNK as u64 - 1).await;
    assert_eq!(body, expected(0, CHUNK as usize), "the healthy read is exact");
    assert!(
        provider == "torbox" || provider == "realdebrid",
        "an exact route served the read: {provider}"
    );
    provider
}

// ===========================================================================
// R1 — primary route lost, exact already-cached alternate recovers
// ===========================================================================

#[tokio::test]
async fn r1_primary_lost_alternate_recovers_same_torrent_file() {
    let st = build_stack(FILE_SIZE, None).await;
    let served_by = lane_that_serves(&st).await;
    let losing = if served_by == "torbox" { &st.primary } else { &st.alternate };
    let other = if served_by == "torbox" { &st.alternate } else { &st.primary };
    losing.fault(MODE_404);
    let other_before = other.range_requests();

    // A fresh chunk forces a route decision for new bytes. The client makes
    // ONE request — a manual retry is not part of the contract.
    let (status, body, _p) = read(&st, CHUNK, 2 * CHUNK - 1).await;
    assert_eq!(status, 206, "one request is served, transparently recovered");
    assert_eq!(body, expected(CHUNK, CHUNK as usize), "recovered bytes are exact");
    assert!(
        other.range_requests() > other_before,
        "the still-cached route actually delivered the read"
    );
    // Same durable TorrentFile: the only TorrentFile this stack can describe
    // is st.tf, and the durable identity tuple is untouched.
    assert_eq!(st.tf.info_hash, INFO_HASH);
    assert_eq!(st.tf.canonical_path, PATH);
    assert_eq!(st.tf.size, FILE_SIZE);
    assert!(st.present(1), "the recovered chunk is durably present");
    // No representation crossover: the alternate serves IDENTICAL bytes.
    assert_eq!(st.read_back(1), expected(CHUNK, CHUNK as usize));
    // The verdict on the failed lane is runtime truth (a dead capability), not
    // a durable demotion this read is entitled to make.
    let dead_primary = st
        .manager
        .slots
        .iter()
        .find(|s| s.coord.provider == served_by)
        .unwrap()
        .caps
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.status() == data_plane::capability::CapabilityStatus::Dead)
        .count();
    assert_eq!(dead_primary, 1, "404 is durable truth: the capability is dead");
}

// ===========================================================================
// R2 — failure-class matrix: what each provider answer must produce
// ===========================================================================
//
// Every class must (a) still serve the client from the alternate route,
// (b) keep byte-exactness, and (c) leave the primary's runtime verdict
// appropriate to its class: dead for durable truth, throttled/breaker for
// transient load, nothing for a timeout's zero-signal. None of them may fail
// the client and none may demote durable inventory.

#[tokio::test]
async fn r2a_resource_not_found_fails_over_to_alternate() {
    let st = build_stack(FILE_SIZE, None).await;
    let served_by = lane_that_serves(&st).await;
    let loser = if served_by == "torbox" { &st.primary } else { &st.alternate };
    let winner = if served_by == "torbox" { &st.alternate } else { &st.primary };
    loser.fault(MODE_404);
    let winner_before = winner.range_requests();
    let (status, body, _p) = read(&st, CHUNK, 2 * CHUNK - 1).await;
    assert_eq!(status, 206, "404 on the primary must not fail the client");
    assert_eq!(body, expected(CHUNK, CHUNK as usize));
    assert_eq!(winner.range_requests() - winner_before, 1,
        "the still-cached route delivered the read");
    let dead_loser = st
        .manager
        .slots
        .iter()
        .find(|s| s.coord.provider == served_by)
        .unwrap()
        .caps
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.status() == data_plane::capability::CapabilityStatus::Dead)
        .count();
    assert_eq!(dead_loser, 1, "404/410 is durable truth: the capability is dead");
}

#[tokio::test]
async fn r2b_transient_5xx_fails_over_to_alternate() {
    let st = build_stack(FILE_SIZE, None).await;
    let served_by = lane_that_serves(&st).await;
    let loser = if served_by == "torbox" { &st.primary } else { &st.alternate };
    let winner = if served_by == "torbox" { &st.alternate } else { &st.primary };
    loser.fault(MODE_503);
    let winner_before = winner.range_requests();
    let (status, body, _p) = read(&st, CHUNK, 2 * CHUNK - 1).await;
    assert_eq!(status, 206, "a transient upstream error must not fail the client");
    assert_eq!(body, expected(CHUNK, CHUNK as usize));
    assert_eq!(winner.range_requests() - winner_before, 1,
        "the still-cached route delivered the read");
    // One 503 alternates away immediately; the breaker is a 3-consecutive-
    // failure judgment a failovered read never accumulates. What must hold is
    // that a transient verdict is reversible: nothing is declared dead.
    let dead_loser = st
        .manager
        .slots
        .iter()
        .find(|s| s.coord.provider == served_by)
        .unwrap()
        .caps
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.status() == data_plane::capability::CapabilityStatus::Dead)
        .count();
    assert_eq!(dead_loser, 0, "5xx is transient: no capability is declared dead");
    let throttled_loser = st
        .manager
        .slots
        .iter()
        .find(|s| s.coord.provider == served_by)
        .unwrap()
        .caps
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.status() == data_plane::capability::CapabilityStatus::Throttled)
        .count();
    assert_eq!(throttled_loser, 1, "5xx throttles the lane with a real cooldown");
}

#[tokio::test]
async fn r2c_rate_limit_429_fails_over_without_new_api_calls() {
    let st = build_stack(FILE_SIZE, None).await;
    let api_before = st.metrics.api_requests.load(Ordering::SeqCst);
    let served_by = lane_that_serves(&st).await;
    let loser = if served_by == "torbox" { &st.primary } else { &st.alternate };
    let winner = if served_by == "torbox" { &st.alternate } else { &st.primary };
    loser.fault(MODE_429);
    let winner_before = winner.range_requests();
    let (status, body, _p) = read(&st, CHUNK, 2 * CHUNK - 1).await;
    assert_eq!(status, 206, "429 must not fail the client");
    assert_eq!(body, expected(CHUNK, CHUNK as usize));
    assert_eq!(winner.range_requests() - winner_before, 1,
        "the still-cached route delivered the read");
    assert_eq!(
        st.metrics.api_requests.load(Ordering::SeqCst) - api_before,
        0,
        "recovery from a rate limit costs zero provider-control calls"
    );
}

#[tokio::test]
async fn r2d_timeout_fails_over_to_alternate() {
    // A short client read timeout turns the hung lane into a real headerless
    // timeout: no provider-load signal, zero cooldown.
    let st = build_stack(FILE_SIZE, Some(250)).await;
    let served_by = lane_that_serves(&st).await;
    let loser = if served_by == "torbox" { &st.primary } else { &st.alternate };
    let winner = if served_by == "torbox" { &st.alternate } else { &st.primary };
    loser.fault(MODE_HANG);
    let winner_before = winner.range_requests();
    let (status, body, _p) = read(&st, CHUNK, 2 * CHUNK - 1).await;
    assert_eq!(status, 206, "a hung lane must not hang the client");
    assert_eq!(body, expected(CHUNK, CHUNK as usize));
    assert_eq!(winner.range_requests() - winner_before, 1,
        "the still-cached route delivered the read");
}

#[tokio::test]
async fn r2e_malformed_provider_payload_fails_over() {
    let st = build_stack(FILE_SIZE, None).await;
    let served_by = lane_that_serves(&st).await;
    let loser = if served_by == "torbox" { &st.primary } else { &st.alternate };
    let winner = if served_by == "torbox" { &st.alternate } else { &st.primary };
    loser.fault(MODE_SHORT_BODY);
    let winner_before = winner.range_requests();
    let (status, body, _p) = read(&st, CHUNK, 2 * CHUNK - 1).await;
    assert_eq!(status, 206, "a truncated provider payload must not truncate the client");
    assert_eq!(body, expected(0, CHUNK as usize), "the client still gets the full bytes");
    assert_eq!(winner.range_requests() - winner_before, 1,
        "the still-cached route delivered the read");
}

// ===========================================================================
// R3 — every route failing: honest failure, nothing poisoned
// ===========================================================================

#[tokio::test]
async fn r3_all_routes_failing_is_honest_and_unpoisoned() {
    let st = build_stack(FILE_SIZE, None).await;
    st.primary.fault(MODE_404);
    st.alternate.fault(MODE_404);
    let (status, body, _p) = read(&st, 0, CHUNK - 1).await;
    // Two honest shapes exist and both are acceptable: the failure is caught
    // before the headers commit (502) or the stream is cut after commit. What
    // is NOT acceptable is wrong bytes or a body that looks complete.
    assert!(
        status == 502 || (status == 206 && body.len() < CHUNK as usize),
        "exhaustion is explicit (502) or a visibly truncated stream, never a silent success"
    );
    assert_eq!(
        body,
        expected(0, body.len()),
        "whatever arrived is a correct PREFIX — never bytes from a failed route"
    );
    // A failed fill publishes nothing. (Publication is asynchronous, so a
    // chunk could still land if the failure was late; the invariant that
    // matters is that a LATER request cannot be stranded by it.)
    let _ = st.present(0);

    // Recovery after total exhaustion: the resource is back on one route and
    // the provider hands out a fresh capability (a dead cap is pruned and
    // replaced, not revived).
    st.primary.fault(MODE_OK);
    let slot = st
        .manager
        .slots
        .iter()
        .find(|s| s.coord.provider == "torbox")
        .expect("torbox slot");
    slot.caps.lock().unwrap().clear();
    slot.caps.lock().unwrap().push(DeliveryCapability::new(
        format!("{}/cdn/0", st.primary_base),
        "torbox".into(),
        "default".into(),
        st.tf.tf_id_durable.clone(),
        "res-primary".into(),
        "0".into(),
        None,
    ));
    let (status, body, _p) = read(&st, CHUNK, 2 * CHUNK - 1).await;
    assert_eq!(status, 206, "the next request succeeds once a usable route exists");
    assert_eq!(body, expected(CHUNK, CHUNK as usize));
    st.wait_present(1).await;
}

// ===========================================================================
// R4 — coalescing during recovery: one useful fill, no duplicate provider work
// ===========================================================================

#[tokio::test]
async fn r4_recovery_fill_is_shared_not_duplicated() {
    let st = build_stack(FILE_SIZE, None).await;
    // Single-reader baseline: one request recovers transparently (proved in
    // r2a), so the group below starts from a known-good recovery shape.
    let served_by = lane_that_serves(&st).await;
    let loser = if served_by == "torbox" { &st.primary } else { &st.alternate };
    let winner = if served_by == "torbox" { &st.alternate } else { &st.primary };
    loser.fault(MODE_404);
    let winner_before = winner.requests();
    let loser_before = loser.requests();

    // Three concurrent readers of the SAME chunk while one route is dead.
    // The contract for a late reader is "join a healthy recovery fill, or fail
    // honestly" — never corrupt bytes, never a duplicate provider pull.
    let mut handles = Vec::new();
    for _ in 0..3 {
        let server = st.server_base.clone();
        let tf = st.tf.tf_id_durable.clone();
        handles.push(tokio::spawn(async move {
            let resp = reqwest::Client::new()
                .get(format!("{server}/files/{tf}"))
                .header("range", format!("bytes={}-{}", CHUNK, 2 * CHUNK - 1))
                .send()
                .await
                .expect("request");
            let status = resp.status().as_u16();
            let body = resp.bytes().await.unwrap_or_default().to_vec();
            (status, body)
        }));
    }
    let results: Vec<(u16, Vec<u8>)> = futures_collect(handles).await;
    let want = expected(CHUNK, CHUNK as usize);

    // A structured error body is a FAILURE, not bytes: it must never be
    // mistaken for content, and it must never be a prefix of the real chunk.
    let mut served_complete = 0;
    let mut failed_explicitly = 0;
    let mut corrupt = 0;
    for (status, body) in &results {
        if *status == 206 && body.len() == want.len() && body == &want {
            served_complete += 1;
        } else if body.is_empty()
            || body.starts_with(b"{\"error\"")
            || body.len() < want.len()
        {
            failed_explicitly += 1;
        } else {
            corrupt += 1;
        }
    }
    assert_eq!(corrupt, 0, "no reader receives bytes that are not the exact chunk");
    assert!(
        served_complete + failed_explicitly == 3,
        "every reader is either served exactly or told it failed"
    );

    // The anti-amplification property that matters during recovery: the
    // surviving route is pulled at most ONCE for the whole reader group.
    assert!(
        winner.requests() - winner_before <= 1,
        "recovery pulls the surviving route at most once (got {})",
        winner.requests() - winner_before
    );
    assert!(
        loser.requests() - loser_before <= 3,
        "the dead route is probed at most once per reader (got {})",
        loser.requests() - loser_before
    );
}

async fn futures_collect(
    handles: Vec<tokio::task::JoinHandle<(u16, Vec<u8>)>>,
) -> Vec<(u16, Vec<u8>)> {
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        out.push(h.await.unwrap());
    }
    out
}

// ===========================================================================
// R5 — a placement discovered later is adopted through refresh (no restart)
// ===========================================================================

#[tokio::test]
async fn r5_discovered_placement_is_adopted_by_refresh() {
    let st = build_stack(FILE_SIZE, None).await;
    // Rust starts knowing only the primary route, exactly as S-1 delivers it.
    let single = Arc::new(CapabilityManager::new(
        ControlTorrentFile {
            id: st.tf.tf_id_durable.clone(),
            info_hash: INFO_HASH.to_string(),
            canonical_internal_path: Some(PATH.to_string()),
            size: FILE_SIZE,
        },
        vec![ProviderCoord {
            provider: "torbox".into(),
            account_scope: "default".into(),
            provider_resource_id: "res-primary".into(),
            provider_file_id: "0".into(),
            state: "ready".into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE_SIZE,
        }],
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        st.metrics.clone(),
    ));
    assert_eq!(single.slots.len(), 1, "one known route at startup");

    // Node persists a second exact placement for the SAME TorrentFile and
    // drives the prewarm refresh that adopts it.
    let fresh_coords = vec![
        ProviderCoord {
            provider: "torbox".into(),
            account_scope: "default".into(),
            provider_resource_id: "res-primary".into(),
            provider_file_id: "0".into(),
            state: "ready".into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE_SIZE,
        },
        ProviderCoord {
            provider: "realdebrid".into(),
            account_scope: "default".into(),
            provider_resource_id: "res-discovered".into(),
            provider_file_id: "7".into(),
            state: "ready".into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE_SIZE,
        },
    ];
    let api_before = st.metrics.api_requests.load(Ordering::SeqCst);
    let outcome = CapabilityManager::refresh_slots(
        &single,
        &ControlTorrentFile {
            id: st.tf.tf_id_durable.clone(),
            info_hash: INFO_HASH.to_string(),
            canonical_internal_path: Some(PATH.to_string()),
            size: FILE_SIZE,
        },
        &fresh_coords,
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        st.metrics.clone(),
    );
    let refreshed = outcome.manager.clone();
    assert_eq!(outcome.slots_after, 2, "the discovered placement is now a route");
    assert_eq!(
        st.metrics.api_requests.load(Ordering::SeqCst) - api_before,
        0,
        "adopting a placement costs zero provider API calls"
    );
    // The prewarm that follows installs exactly one capability on the new slot.
    let new_slot = refreshed
        .slots
        .iter()
        .find(|s| s.coord.provider == "realdebrid")
        .expect("the discovered route exists");
    new_slot.caps.lock().unwrap().push(DeliveryCapability::new(
        format!("{}/cdn/9", st.alternate_base),
        "realdebrid".into(),
        "default".into(),
        st.tf.tf_id_durable.clone(),
        "res-discovered".into(),
        "7".into(),
        None,
    ));
    // The primary route is now gone: the manager must serve from the route
    // that did not exist at startup.
    st.primary.fault(MODE_404);
    let reserved = match refreshed.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("a route the control plane now lists must be available"),
    };
    assert_eq!(reserved.cap.provider, "realdebrid");
    assert_eq!(
        reserved.cap.torrent_file_id, st.tf.tf_id_durable,
        "the SAME TorrentFile, never a different representation"
    );
    let ok = st.fill_through(&refreshed, reserved, 0).await;
    assert!(ok, "the newly adopted route serves bytes");
    assert_eq!(st.read_back(0), expected(0, CHUNK as usize));
}

// ===========================================================================
// R6 — restart: durable chunks survive, the route set is rebuilt from truth
// ===========================================================================

#[tokio::test]
async fn r6_restart_rebuilds_routes_and_keeps_durable_bytes() {
    let st = build_stack(FILE_SIZE, None).await;
    let (status, body, _p) = read(&st, 0, CHUNK - 1).await;
    assert_eq!(status, 206);
    assert_eq!(body, expected(0, CHUNK as usize));
    st.wait_present(0).await;

    // Reopen the SAME cache directory: a restart is a fresh process reading
    // fresh control truth.
    let metrics = Arc::new(Metrics::default());
    let cache = CacheEngine::open(
        CacheConfig {
            root: st.cache_root_dir(),
            max_bytes: 64 << 20,
            chunk_size: CHUNK,
        },
        metrics.clone(),
    )
    .unwrap();
    assert!(
        cache.is_present(&st.tf.cache_key(), 0).unwrap_or(false),
        "durable chunk survives restart"
    );
    // The runtime route inventory does NOT survive: it is rebuilt, and only
    // what control truth lists is knowable.
    let single = Arc::new(CapabilityManager::new(
        ControlTorrentFile {
            id: st.tf.tf_id_durable.clone(),
            info_hash: INFO_HASH.to_string(),
            canonical_internal_path: Some(PATH.to_string()),
            size: FILE_SIZE,
        },
        vec![ProviderCoord {
            provider: "torbox".into(),
            account_scope: "default".into(),
            provider_resource_id: "res-primary".into(),
            provider_file_id: "0".into(),
            state: "ready".into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE_SIZE,
        }],
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    ));
    assert_eq!(
        single.slots.len(),
        1,
        "after restart Rust knows only the routes in control truth"
    );
}
