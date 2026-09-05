// HY4 south data plane -- production multi-TorrentFile binary.
//
// P3 step 2. Replaces the single-TorrentFile lab bootstrap (which
// required process-global TORRENT_FILE_ID, fetched control ONCE at boot,
// and exited 2 on the first failure) with a per-request service.
//
// What this binary does:
//   * Reads CONTROL_URL and binds the listening socket.
//   * Constructs a per-process ServiceState: one reqwest::Client, one
//     Arc<Metrics>, one optional Slice 4 cache engine, and a
//     CapabilityManager factory. Everything that is genuinely process-
//     global lives here.
//   * Routes:
//       GET /files/:tfId   per-request S-1 fetch -> per-request AppState
//                          -> get_file (the proven serving core)
//       GET /metrics       per-process AppState -> metrics_handler
//
// What this binary explicitly does NOT do:
//   * Hold a process-global TORRENT_FILE_ID. The lab main.rs took it
//     from env and exited if missing. /files/:tfId carries it on the URL.
//   * Fetch S-1 once at boot. The lab main.rs did and exited if the
//     torrent file was unknown to Node. The new service can start with
//     zero requested TorrentFiles and serve any valid tfId later.
//   * Open host SQLite. The north (media-search) is the only thing that
//     opens the durable DBs. Rust reads only what S-1 projects.
//   * Read any of the legacy Node provider paths. They are still on disk
//     but Rust does not import them and does not depend on them.

use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use hy4_data_plane::{
    cache::{CacheConfig, CacheEngine},
    capability::ApiKeys,
    control::{fetch_control, ControlTorrentFile},
    manager::CapabilityManager,
    metrics::Metrics,
    playback_intel::{PfConfig, PlaybackIntelligence},
    serve::{
        data_plane_error, get_file, metrics_handler, AppState, SUPPORTED_SCHEMA_VERSION,
    },
};

#[derive(Debug, Clone)]
struct ServiceConfig {
    /// Base URL of the north control endpoint, e.g. http://media-search:3000/api
    control_url: String,
    /// Where the Slice 4 cache lives. None disables the cache (cold-proxy mode).
    cache_root: Option<PathBuf>,
    /// Listen address.
    listen: String,
    /// TorBox API key (lab supports account-scoped via TORBOX_API_KEY_<scope>;
    /// this binary takes a single key for now and the rest of the scope
    /// plumbing lands with the multi-account S-1 row in a later tranche).
    torbox_api_key: String,
    /// Real-Debrid API key, if any. May be empty.
    realdebrid_api_key: String,
}

impl ServiceConfig {
    fn from_env() -> Result<Self, String> {
        let control_url = env::var("CONTROL_URL")
            .unwrap_or_else(|_| "http://media-search:3000/api".into());
        let listen = env::var("LISTEN").unwrap_or_else(|_| "0.0.0.0:3001".into());
        let cache_root = env::var("CACHE_ROOT")
            .ok()
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty());
        let torbox_api_key = env::var("TORBOX_API_KEY").unwrap_or_default();
        let realdebrid_api_key = env::var("REALDEBRID_API_KEY").unwrap_or_default();
        Ok(Self {
            control_url,
            cache_root,
            listen,
            torbox_api_key,
            realdebrid_api_key,
        })
    }
}

struct ServiceState {
    cfg: ServiceConfig,
    client: reqwest::Client,
    metrics: Arc<Metrics>,
    cache: Option<Arc<CacheEngine>>,
    /// P9 playback-intelligence subsystem (shared, runtime-only). Constructed once
    /// per process from env; disabled by default.
    playback: Arc<PlaybackIntelligence>,
    /// Cache of per-tfId CapabilityManagers. The lab constructs one
    /// per process; we construct one per tfId and cache it. The keys
    /// here are S-1-projected identity; identity bleed would require
    /// two distinct tfIds to hash to the same key, which the keying
    /// (tf_id string itself, since S-1 is the only source of truth) is
    /// engineered to prevent -- the host assigns tf_ids once at
    /// torrent_files insert time and never reuses them.
    managers: tokio::sync::Mutex<HashMap<String, Arc<CapabilityManager>>>,
}

impl ServiceState {
    async fn new(cfg: ServiceConfig) -> Result<Arc<Self>, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(|e| format!("reqwest client build: {e}"))?;
        let metrics = Arc::new(Metrics::default());
        let playback = PlaybackIntelligence::new(PfConfig::from_env());
        let cache = if let Some(root) = cfg.cache_root.as_ref() {
            let engine = CacheEngine::open(
                CacheConfig {
                    root: root.clone(),
                    max_bytes: 8 * 1024 * 1024 * 1024,
                    // 8 MiB is the donor default. Hard-coding here matches
                    // CACHE_FORMAT_VERSION = 2 in cache.rs; the value is
                    // persisted alongside the format version, so changing it
                    // invalidates the grid and triggers a reset.
                    chunk_size: 8 * 1024 * 1024,
                },
                metrics.clone(),
            )
            .map_err(|e| format!("cache open: {e}"))?;
            // CacheEngine::open already returns Arc<Self>; do not double-wrap.
            Some(engine)
        } else {
            None
        };
        Ok(Arc::new(Self {
            cfg,
            client,
            metrics,
            cache,
            playback,
            managers: tokio::sync::Mutex::new(HashMap::new()),
        }))
    }

    /// Per-tfId CapabilityManager. Constructed on the first request for a
    /// given tfId; cached for subsequent requests.
    async fn manager_for(
        self: &Arc<Self>,
        tf_id: &str,
        control: &hy4_data_plane::control::ControlResponse,
    ) -> Result<Arc<CapabilityManager>, String> {
        if let Some(m) = self.managers.lock().await.get(tf_id).cloned() {
            return Ok(m);
        }
        let keys = ApiKeys {
            torbox: self.cfg.torbox_api_key.clone(),
            realdebrid: self.cfg.realdebrid_api_key.clone(),
        };
        let mgr = Arc::new(CapabilityManager::new(
            control.torrent_file.clone(),
            control.providers.clone(),
            keys,
            self.client.clone(),
            self.metrics.clone(),
        ));
        self.managers
            .lock()
            .await
            .insert(tf_id.to_string(), mgr.clone());
        Ok(mgr)
    }
}

async fn handle_files(
    AxumState(svc): AxumState<Arc<ServiceState>>,
    Path(tf_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    // Per-request identity: fetch S-1, build a request-local AppState.
    // The lab's AppState carried the same five fields the new one does,
    // but the lab built it ONCE at boot. We build it PER REQUEST, so a
    // single process can serve any tfId, not one.
    let resp = match fetch_control(
        &svc.client,
        &svc.cfg.control_url,
        &tf_id,
        SUPPORTED_SCHEMA_VERSION,
    )
    .await
    {
        Ok(r) => r,
        Err(msg) => {
            // P5 class B: S-1 could not resolve this tfId (unknown / not-found /
            // control unreachable). NOT fallback-eligible: emit a classified
            // `S1_FETCH_FAILED` so the Node VFS does not blindly try unrelated
            // candidates. See docs/hy4/S1-CONTROL-CONTRACT.md (byte error contract).
            return data_plane_error(
                StatusCode::BAD_GATEWAY,
                "S1_FETCH_FAILED",
                &tf_id,
                None,
            );
        }
    };

    // Acquire (or fetch) the per-tfId CapabilityManager. The cache lives
    // in ServiceState; the manager itself is built from S-1 coordinates,
    // so identity bleed would require S-1 to lie about the tf_id.
    let manager = match svc.manager_for(&tf_id, &resp).await {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("capability manager: {e}"),
            )
                .into_response();
        }
    };

    // Per-request AppState. The lab's main() built this once with a
    // process-global tf_id. We rebuild it here, per request, with the
    // S-1-projected identity for THIS tfId.
    let state = Arc::new(AppState {
        authoritative_size: resp.torrent_file.size,
        // Host tf_id is the URL path segment. Carried for logging.
        tf_id: resp.torrent_file.id.clone(),
        // Exact durable PK from S-1 (torrent_files.id). The cache and
        // the capability single-flight are keyed on this. See
        // docs/hy4/CROSS-FILE-KEYING-AUDIT.md (P3 correction).
        tf_id_durable: resp.torrent_file.id.clone(),
        info_hash: resp.torrent_file.info_hash.clone(),
        canonical_path: resp
            .torrent_file
            .canonical_internal_path
            .clone()
            .unwrap_or_default(),
        client: svc.client.clone(),
        metrics: svc.metrics.clone(),
        manager,
        cache: svc.cache.as_ref().map(Arc::clone),
        playback: svc.playback.clone(),
    });

    get_file(axum::extract::State(state), headers).await
}

async fn handle_metrics(AxumState(svc): AxumState<Arc<ServiceState>>) -> Response {
    // /metrics uses a service-level AppState with empty per-file
    // identity. The metrics payload reports the running counters, not
    // any single file. The lab's metrics_handler calls
    // `state.manager.pool_summary()`, which returns [] for a manager
    // built with no coords, so an empty CapabilityManager is the right
    // snapshot for a freshly-booted process.
    let empty_mgr = Arc::new(CapabilityManager::new(
        ControlTorrentFile {
            id: String::new(),
            info_hash: String::new(),
            canonical_internal_path: None,
            size: 0,
        },
        vec![],
        ApiKeys {
            torbox: String::new(),
            realdebrid: String::new(),
        },
        svc.client.clone(),
        svc.metrics.clone(),
    ));
    let state = Arc::new(AppState {
        authoritative_size: 0,
        tf_id: String::new(),
        tf_id_durable: String::new(),
        info_hash: String::new(),
        canonical_path: String::new(),
        client: svc.client.clone(),
        metrics: svc.metrics.clone(),
        manager: empty_mgr,
        cache: svc.cache.as_ref().map(Arc::clone),
        playback: svc.playback.clone(),
    });

    metrics_handler(axum::extract::State(state)).await
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let cfg = ServiceConfig::from_env().map_err(|e| format!("config: {e}"))?;
    eprintln!(
        "[hy4-data-plane] booting: control_url={} listen={} cache_root={:?}",
        cfg.control_url, cfg.listen, cfg.cache_root
    );

    let svc = ServiceState::new(cfg.clone()).await?;
    eprintln!(
        "[hy4-data-plane] S-1 reachable test skipped -- the service is allowed to \
         start with zero requested TorrentFiles. S-1 is fetched per request."
    );

    let app = Router::new()
        .route("/files/:tfId", get(handle_files))
        .route("/metrics", get(handle_metrics))
        .with_state(svc);

    let listener = tokio::net::TcpListener::bind(&cfg.listen)
        .await
        .map_err(|e| format!("bind {}: {e}", cfg.listen))?;
    eprintln!("[hy4-data-plane] listening on http://{}", cfg.listen);
    axum::serve(listener, app)
        .await
        .map_err(|e| format!("serve: {e}"))?;
    Ok(())
}
