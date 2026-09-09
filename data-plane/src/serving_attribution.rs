//! Request-scoped serving-primary attribution.
//!
//! Async end-to-end through the real `get_file` path against a localhost
//! mock CDN (patterned bytes, real 206 handling) — zero live I/O, zero
//! keys. A second localhost mock stands in for the other provider.
//!
//! T1: provider-backed Range reports the actual initially selected
//!     provider/resource/file/cap.
//! T2: cache-only repeat reports no provider attribution (and the same
//!     exact bytes).
//! T3: two concurrent demands on different providers attribute
//!     independently — no bleed, no global state.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};

use crate::cache::{CacheConfig, CacheEngine};
use crate::capability::{ApiKeys, DeliveryCapability};
use crate::control::{ControlTorrentFile, ProviderCoord};
use crate::manager::CapabilityManager;
use crate::metrics::Metrics;
use crate::playback_intel::{PfConfig, PlaybackIntelligence, PrefetchMode};
use crate::serve::{get_file, AppState, ServingAttribution};

const FILE: u64 = 4096;
const INFO_HASH: &str = "06bfe49fdc99ad0c6fef1f761382a8181490e456";
const PATH: &str = "Show/Season 01/file.mkv";

fn pat(off: u64) -> u8 {
    (off % 251) as u8
}

fn expected_range(s: u64, e: u64) -> Vec<u8> {
    (s..=e).map(pat).collect()
}

#[derive(Clone)]
struct MockState {
    data: Arc<Vec<u8>>,
}

async fn cdn_handler(State(st): State<MockState>, headers: HeaderMap) -> Response {
    let v = headers.get("range").expect("mock: missing Range").to_str().unwrap();
    let inner = v.strip_prefix("bytes=").expect("mock: bad Range");
    let mut it = inner.split('-');
    let s: usize = it.next().unwrap().parse().unwrap();
    let e: usize = it.next().unwrap().parse().unwrap();
    assert!(s <= e && (e as u64) < st.data.len() as u64, "mock: range out of bounds");
    let body = Body::from(st.data[s..=e].to_vec());
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-range", format!("bytes {s}-{e}/{}", st.data.len()))
        .header("accept-ranges", "bytes")
        .body(body)
        .unwrap()
        .into_response()
}

async fn spawn_mock() -> (u16, tokio::task::JoinHandle<()>) {
    let data: Vec<u8> = (0..FILE).map(pat).collect();
    let st = MockState { data: Arc::new(data) };
    let app = axum::Router::new().route("/cdn", get(cdn_handler)).with_state(st);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    (port, handle)
}

struct Stack {
    state: Arc<AppState>,
    cap: Arc<DeliveryCapability>,
    _tmp: Option<tempfile::TempDir>,
}

fn build_stack(
    port: u16,
    provider: &str,
    resource: &str,
    file: &str,
    with_cache: bool,
) -> Stack {
    let tmp = tempfile::tempdir().unwrap();
    let metrics = Arc::new(Metrics::default());
    let cache = if with_cache {
        Some(
            CacheEngine::open(
                CacheConfig { root: tmp.path().join("c"), max_bytes: 64 << 20, chunk_size: 65536 },
                metrics.clone(),
            )
            .unwrap(),
        )
    } else {
        None
    };
    let tf = ControlTorrentFile {
        id: "tf_t8_det".into(),
        info_hash: INFO_HASH.into(),
        canonical_internal_path: Some(PATH.into()),
        size: FILE,
    };
    let coord = ProviderCoord {
        provider: provider.into(),
        account_scope: "test".into(),
        provider_resource_id: resource.into(),
        provider_file_id: file.into(),
        state: "ready".into(),
        canonical_internal_path: Some(PATH.into()),
        size: FILE,
    };
    let client = reqwest::Client::new();
    let manager = Arc::new(CapabilityManager::new(
        tf,
        vec![coord],
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        client.clone(),
        metrics.clone(),
    ));
    let cap = DeliveryCapability::new(
        format!("http://127.0.0.1:{port}/cdn"),
        provider.into(),
        "test".into(),
        "tf_t8_det".into(),
        resource.into(),
        file.into(),
        None,
    );
    manager.slots.iter()
        .find(|s| s.coord.provider == provider)
        .expect("slot")
        .caps.lock().unwrap()
        .push(cap.clone());
    let playback =
        PlaybackIntelligence::new(PfConfig { enabled: false, ahead_chunks: 1, sequential_threshold: 3, prefetch_priority: 0, mode: PrefetchMode::Try });
    let state = Arc::new(AppState {
        authoritative_size: FILE,
        tf_id: "tf_t8_det".into(),
        tf_id_durable: "tf_t8_det".into(),
        info_hash: INFO_HASH.into(),
        canonical_path: PATH.into(),
        client,
        metrics,
        manager,
        cache,
        playback,
    });
    let tmp_hold = if with_cache { Some(tmp) } else { None };
    Stack { state, cap, _tmp: tmp_hold }
}

async fn demand(state: &Arc<AppState>, s: u64, e: u64) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut headers = HeaderMap::new();
    headers.insert("range", format!("bytes={s}-{e}").parse().unwrap());
    let fut = async {
        let resp = get_file(State(state.clone()), headers).await;
        let status = resp.status();
        let h = resp.headers().clone();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap().to_vec();
        (status, h, bytes)
    };
    tokio::time::timeout(std::time::Duration::from_secs(60), fut)
        .await
        .expect("T8: demand did not terminate")
}

fn header<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

#[tokio::test]
async fn t1_provider_backed_range_reports_initial_selection() {
    let (port, server) = spawn_mock().await;
    let stack = build_stack(port, "torbox", "res-a", "file-a", false);
    let (status, h, bytes) = demand(&stack.state, 0, 1023).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(bytes, expected_range(0, 1023), "T1: exact bytes");
    assert_eq!(header(&h, ServingAttribution::HDR_PROVIDER), Some("torbox"), "T1: provider");
    assert_eq!(header(&h, ServingAttribution::HDR_RESOURCE_ID), Some("res-a"), "T1: resource");
    assert_eq!(header(&h, ServingAttribution::HDR_FILE_ID), Some("file-a"), "T1: file");
    assert_eq!(
        header(&h, ServingAttribution::HDR_CAP_ID),
        Some(stack.cap.cap_id.as_str()),
        "T1: cap id is the actually selected capability"
    );
    server.abort();
}

#[tokio::test]
async fn t2_cache_only_repeat_reports_no_attribution() {
    let (port, server) = spawn_mock().await;
    let stack = build_stack(port, "torbox", "res-a", "file-a", true);
    let (s1, h1, b1) = demand(&stack.state, 0, 1023).await;
    assert_eq!(s1, StatusCode::PARTIAL_CONTENT);
    assert_eq!(b1, expected_range(0, 1023));
    assert_eq!(header(&h1, ServingAttribution::HDR_PROVIDER), Some("torbox"), "T2: first demand served by provider");
    // Repeat: fully durable now, served locally with identical bytes and
    // truthfully no provider attribution (nothing was acquired).
    let (s2, h2, b2) = demand(&stack.state, 0, 1023).await;
    assert_eq!(s2, StatusCode::PARTIAL_CONTENT);
    assert_eq!(b2, expected_range(0, 1023), "T2: identical bytes from cache");
    for name in [
        ServingAttribution::HDR_PROVIDER,
        ServingAttribution::HDR_RESOURCE_ID,
        ServingAttribution::HDR_FILE_ID,
        ServingAttribution::HDR_CAP_ID,
    ] {
        assert!(header(&h2, name).is_none(), "T2: cache hit fabricates no {name}");
    }
    server.abort();
}

#[tokio::test]
async fn t3_concurrent_demands_attribute_independently() {
    let (port_a, server_a) = spawn_mock().await;
    let (port_b, server_b) = spawn_mock().await;
    let stack_a = build_stack(port_a, "torbox", "res-a", "file-a", false);
    let stack_b = build_stack(port_b, "realdebrid", "res-b", "file-b", false);
    let ((sa, ha, ba), (sb, hb, bb)) = tokio::join!(
        demand(&stack_a.state, 0, 511),
        demand(&stack_b.state, 0, 511),
    );
    assert_eq!((sa, sb), (StatusCode::PARTIAL_CONTENT, StatusCode::PARTIAL_CONTENT));
    assert_eq!((ba, bb), (expected_range(0, 511), expected_range(0, 511)));
    assert_eq!(header(&ha, ServingAttribution::HDR_PROVIDER), Some("torbox"));
    assert_eq!(header(&ha, ServingAttribution::HDR_RESOURCE_ID), Some("res-a"));
    assert_eq!(
        header(&ha, ServingAttribution::HDR_CAP_ID),
        Some(stack_a.cap.cap_id.as_str())
    );
    assert_eq!(header(&hb, ServingAttribution::HDR_PROVIDER), Some("realdebrid"));
    assert_eq!(header(&hb, ServingAttribution::HDR_RESOURCE_ID), Some("res-b"));
    assert_eq!(
        header(&hb, ServingAttribution::HDR_CAP_ID),
        Some(stack_b.cap.cap_id.as_str())
    );
    server_a.abort();
    server_b.abort();
}
