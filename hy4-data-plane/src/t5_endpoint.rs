//! T5 transplant proof: Rust prewarm endpoint with one refresh/retry.
//!
//! Async unit-level through the real lib orchestration
//! (`serve::prewarm_placement`): fresh S-1 truth comes from a localhost
//! mock control endpoint, acquisition from the `#[cfg(test)]`-gated
//! stub — zero live I/O, zero keys, zero durable writes.
//!
//! T1: known existing slot -> prewarm succeeds, no refresh, no swap.
//! T2: fresh truth holds a placement the old manager lacks -> exactly
//!     one refresh, then prewarm succeeds on the swapped manager.
//! T3: placement absent from fresh exact-TF truth -> invalid, zero
//!     acquisition, no swap.
//! T4: refresh/retry is one bounded cycle: global acquisition delta is
//!     exactly one, the new slot holds exactly one cap, nothing else is
//!     created.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::{extract::State, routing::get, Json};

use crate::capability::ApiKeys;
use crate::control::{ControlTorrentFile, ProviderCoord};
use crate::manager::CapabilityManager;
use crate::metrics::Metrics;
use crate::serve::{prewarm_placement, PrewarmRequest};

const TF_ID: &str = "tf_t5_det";
const INFO_HASH: &str = "06bfe49fdc99ad0c6fef1f761382a8181490e456";
const PATH: &str = "Show/Season 01/file.mkv";
const SIZE: u64 = 7_000_000_000;

fn tf() -> ControlTorrentFile {
    ControlTorrentFile {
        id: TF_ID.into(),
        info_hash: INFO_HASH.into(),
        canonical_internal_path: Some(PATH.into()),
        size: SIZE,
    }
}

fn coord(provider: &str, resource: &str, file: &str) -> ProviderCoord {
    ProviderCoord {
        provider: provider.into(),
        account_scope: "default".into(),
        provider_resource_id: resource.into(),
        provider_file_id: file.into(),
        state: "ready".into(),
        canonical_internal_path: Some(PATH.into()),
        size: SIZE,
    }
}

fn truth_json(coords: &[ProviderCoord]) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "torrentFile": {
            "id": TF_ID,
            "infoHash": INFO_HASH,
            "canonicalInternalPath": PATH,
            "size": SIZE,
        },
        "providers": coords.iter().map(|c| serde_json::json!({
            "provider": c.provider,
            "accountScope": c.account_scope,
            "providerResourceId": c.provider_resource_id,
            "providerFileId": c.provider_file_id,
            "state": c.state,
            "canonicalInternalPath": c.canonical_internal_path,
            "size": c.size,
        })).collect::<Vec<_>>(),
    })
}

async fn mock_s1(truth: serde_json::Value) -> (String, tokio::task::JoinHandle<()>) {
    let app = axum::Router::new()
        .route(
            "/data-plane/files/:tfId",
            get(|State(v): State<serde_json::Value>| async { Json(v) }),
        )
        .with_state(truth);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, handle)
}

fn build(coords: Vec<ProviderCoord>) -> (Arc<CapabilityManager>, Arc<Metrics>) {
    // Stub-acquire base: set-only discipline (same value as the T3/T4
    // proofs), so parallel tests cannot interfere via process env.
    std::env::set_var("HY4_TEST_ACQUIRE_BASE_URL", "http://127.0.0.1:9");
    let metrics = Arc::new(Metrics::default());
    let mgr = Arc::new(CapabilityManager::new(
        tf(),
        coords,
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    ));
    (mgr, metrics)
}

fn req(provider: &str, resource: &str) -> PrewarmRequest {
    PrewarmRequest {
        torrent_file_id: TF_ID.into(),
        provider: provider.into(),
        provider_resource_id: resource.into(),
        provider_file_id: None,
        account_scope: None,
    }
}

fn keys() -> ApiKeys {
    ApiKeys { torbox: String::new(), realdebrid: String::new() }
}

#[tokio::test]
async fn t1_known_slot_prewarm_no_refresh() {
    let (mgr, metrics) = build(vec![coord("torbox", "res-a", "file-a")]);
    let (url, server) = mock_s1(truth_json(&[coord("torbox", "res-a", "file-a")])).await;
    let client = reqwest::Client::new();
    let api0 = metrics.api_requests.load(Ordering::SeqCst);
    let out = prewarm_placement(&client, &url, &keys(), &metrics, Some(mgr.clone()), req("torbox", "res-a")).await;
    assert_eq!(out.status_code, 200);
    assert_eq!(out.body["status"], "warmed", "T1: known slot warms, got {}", out.body);
    assert!(out.store_manager.is_none(), "T1: live manager stays, no swap");
    assert_eq!(
        metrics.api_requests.load(Ordering::SeqCst) - api0,
        1,
        "T1: exactly one acquisition"
    );
    server.abort();
}

#[tokio::test]
async fn t2_missing_slot_refresh_then_prewarm() {
    let (mgr, metrics) = build(vec![coord("torbox", "res-a", "file-a")]);
    let (url, server) = mock_s1(truth_json(&[
        coord("torbox", "res-a", "file-a"),
        coord("realdebrid", "res-b", "file-c"),
    ])).await;
    let client = reqwest::Client::new();
    let out = prewarm_placement(&client, &url, &keys(), &metrics, Some(mgr), req("realdebrid", "res-b")).await;
    assert_eq!(out.status_code, 200);
    assert_eq!(out.body["status"], "warmed", "T2: refresh+retry warms, got {}", out.body);
    let swapped = out.store_manager.expect("T2: refreshed manager returned for swap");
    assert_eq!(swapped.slots.len(), 2, "T2: refreshed inventory cached");
    server.abort();
}

#[tokio::test]
async fn t3_unknown_placement_rejected_zero_acquisition() {
    let (mgr, metrics) = build(vec![coord("torbox", "res-a", "file-a")]);
    let (url, server) = mock_s1(truth_json(&[coord("torbox", "res-a", "file-a")])).await;
    let client = reqwest::Client::new();
    let api0 = metrics.api_requests.load(Ordering::SeqCst);
    let out = prewarm_placement(&client, &url, &keys(), &metrics, Some(mgr), req("realdebrid", "res-x")).await;
    assert_eq!(out.status_code, 200);
    assert_eq!(out.body["status"], "invalid", "T3: unknown placement rejected, got {}", out.body);
    assert!(out.store_manager.is_none(), "T3: nothing to cache");
    assert_eq!(
        metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "T3: zero acquisition"
    );
    server.abort();
}

#[tokio::test]
async fn t4_refresh_retry_is_one_bounded_cycle() {
    let (mgr, metrics) = build(vec![coord("torbox", "res-a", "file-a")]);
    let (url, server) = mock_s1(truth_json(&[
        coord("torbox", "res-a", "file-a"),
        coord("realdebrid", "res-b", "file-c"),
    ])).await;
    let client = reqwest::Client::new();
    let api0 = metrics.api_requests.load(Ordering::SeqCst);
    let out = prewarm_placement(&client, &url, &keys(), &metrics, Some(mgr), req("realdebrid", "res-b")).await;
    assert_eq!(out.body["status"], "warmed");
    // Bounded: refresh acquires nothing, the single retry acquires once.
    assert_eq!(
        metrics.api_requests.load(Ordering::SeqCst) - api0,
        1,
        "T4: global acquisition delta is exactly one"
    );
    let swapped = out.store_manager.expect("T4: one swap");
    let rd_caps = swapped.slots.iter()
        .find(|s| s.coord.provider == "realdebrid")
        .expect("rd slot").caps.lock().unwrap().len();
    let tb_caps = swapped.slots.iter()
        .find(|s| s.coord.provider == "torbox")
        .expect("tb slot").caps.lock().unwrap().len();
    assert_eq!((tb_caps, rd_caps), (0, 1), "T4: only the retried slot gained a cap");
    assert!(out.body.get("error").is_none(), "T4: result state, not an exception");
    server.abort();
}
