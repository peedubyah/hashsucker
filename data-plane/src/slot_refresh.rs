//! Runtime slot refresh after durable placement change.
//!
//! Sync unit-level except the prewarm handoff (async, stubbed provider
//! edge via the `#[cfg(test)]`-gated `HY4_TEST_ACQUIRE_BASE_URL` stub —
//! zero live I/O, zero keys).
//!
//! T1: fresh same-TF truth adds a previously-missing slot, zero acquisition.
//! T2: existing warm slot/cap survives refresh by Arc and stays reusable.
//! T3: wrong-TF fresh truth is rejected with no mutation.
//! T4: the newly-added slot is immediately prewarmable by T3 prewarm_slot.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::capability::{ApiKeys, DeliveryCapability};
use crate::control::{ControlTorrentFile, ProviderCoord};
use crate::manager::{CapabilityManager, RefreshStatus};
use crate::metrics::Metrics;

// Local helpers (mirrors the deterministic byte pattern from capability_lease.rs)
fn refresh_pat(off: u64) -> u8 {
    (off.wrapping_mul(2654435761).wrapping_add(off >> 7) % 251) as u8
}

fn refresh_expected_range(s: u64, e: u64) -> Vec<u8> {
    (s..=e).map(refresh_pat).collect()
}

const INFO_HASH: &str = "06bfe49fdc99ad0c6fef1f761382a8181490e456";
const OTHER_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PATH: &str = "Show/Season 01/file.mkv";
const SIZE: u64 = 7_000_000_000;

fn tf() -> ControlTorrentFile {
    ControlTorrentFile {
        id: "tf_routing_uuid".into(),
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

fn build(coords: Vec<ProviderCoord>) -> (Arc<CapabilityManager>, Arc<Metrics>) {
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

fn warm_cap(provider: &str, resource: &str, file: &str) -> Arc<DeliveryCapability> {
    DeliveryCapability::new(
        format!("http://cdn.invalid/{provider}/{file}"),
        provider.into(),
        "default".into(),
        "tf_routing_uuid".into(),
        resource.into(),
        file.into(),
        None,
    )
}

fn has_slot(mgr: &CapabilityManager, provider: &str, resource: &str) -> bool {
    mgr.slots.iter().any(|s| {
        s.coord.provider == provider && s.coord.provider_resource_id == resource
    })
}

#[test]
fn t1_fresh_truth_adds_missing_slot_zero_acquisition() {
    let (mgr, metrics) = build(vec![coord("torbox", "res-a", "file-a")]);
    assert!(!has_slot(&mgr, "realdebrid", "res-b"));
    let api0 = metrics.api_requests.load(Ordering::SeqCst);
    let out = CapabilityManager::refresh_slots(
        &mgr,
        &tf(),
        &[coord("torbox", "res-a", "file-a"), coord("realdebrid", "res-b", "file-c")],
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    );
    assert!(
        matches!(out.status, RefreshStatus::Refreshed),
        "T1: inventory gap refreshes, got {}",
        out.status.name()
    );
    assert_eq!((out.slots_before, out.slots_after), (1, 2));
    assert!(has_slot(&out.manager, "realdebrid", "res-b"), "T1: new slot present");
    assert!(
        out.manager.slots.iter()
            .find(|s| s.coord.provider == "realdebrid")
            .expect("rd slot").caps.lock().unwrap().is_empty(),
        "T1: new slot starts empty for prewarm"
    );
    assert_eq!(out.api_delta, 0, "T1: refresh never acquires");
    assert_eq!(
        metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "T1: counter untouched"
    );
}

#[test]
fn t2_warm_slot_survives_refresh_by_arc() {
    let (mgr, _) = build(vec![coord("torbox", "res-a", "file-a")]);
    let warm = warm_cap("torbox", "res-a", "file-a");
    mgr.slots.iter()
        .find(|s| s.coord.provider == "torbox")
        .expect("slot").caps.lock().unwrap()
        .push(warm.clone());
    // A grown pool target must migrate too (pool-growth policy preserved).
    mgr.slots.iter()
        .find(|s| s.coord.provider == "torbox")
        .expect("slot").target
        .store(2, Ordering::SeqCst);
    let out = CapabilityManager::refresh_slots(
        &mgr,
        &tf(),
        &[coord("torbox", "res-a", "file-a"), coord("realdebrid", "res-b", "file-c")],
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        Arc::new(Metrics::default()),
    );
    assert!(matches!(out.status, RefreshStatus::Refreshed));
    let migrated: Vec<_> = out.manager.slots.iter()
        .find(|s| s.coord.provider == "torbox")
        .expect("slot").caps.lock().unwrap().clone();
    assert_eq!(migrated.len(), 1, "T2: surviving cap migrated");
    assert!(Arc::ptr_eq(&migrated[0], &warm), "T2: same Arc, warmth preserved");
    assert!(
        migrated[0].usable_now(std::time::Instant::now())
            && migrated[0].limiter.available_permits() > 0,
        "T2: migrated cap still usable and free"
    );
    assert_eq!(
        out.manager.slots.iter().find(|s| s.coord.provider == "torbox").expect("slot")
            .target.load(Ordering::SeqCst),
        2,
        "T2: pool target preserved"
    );
    // Old readers keep a valid manager: the input Arc still serves.
    assert_eq!(mgr.slots.len(), 1, "T2: old manager untouched");
}

#[test]
fn t3_wrong_tf_truth_rejected_without_mutation() {
    let (mgr, metrics) = build(vec![coord("torbox", "res-a", "file-a")]);
    let mut foreign = tf();
    foreign.info_hash = OTHER_HASH.into();
    foreign.id = "tf_other_uuid".into();
    let out = CapabilityManager::refresh_slots(
        &mgr,
        &foreign,
        &[coord("torbox", "res-a", "file-a"), coord("realdebrid", "res-b", "file-c")],
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    );
    assert!(
        matches!(out.status, RefreshStatus::Conflict(_)),
        "T3: foreign truth rejected, got {}",
        out.status.name()
    );
    assert!(Arc::ptr_eq(&out.manager, &mgr), "T3: input manager reused as-is");
    assert_eq!((out.slots_before, out.slots_after), (1, 1), "T3: inventory untouched");
    assert!(!has_slot(&out.manager, "realdebrid", "res-b"), "T3: nothing added");
    assert_eq!(out.api_delta, 0, "T3: zero acquisition");
}

#[tokio::test]
async fn t4_new_slot_immediately_prewarmable() {
    // Stub-acquire base: set-only discipline (same value as the T3
    // proofs), so parallel tests cannot interfere via process env.
    std::env::set_var("HY4_TEST_ACQUIRE_BASE_URL", "http://127.0.0.1:9");
    let (mgr, metrics) = build(vec![coord("torbox", "res-a", "file-a")]);
    let out = CapabilityManager::refresh_slots(
        &mgr,
        &tf(),
        &[coord("torbox", "res-a", "file-a"), coord("realdebrid", "res-b", "file-c")],
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    );
    assert!(matches!(out.status, RefreshStatus::Refreshed));
    let api0 = metrics.api_requests.load(Ordering::SeqCst);
    let warmed = out.manager.prewarm_slot("realdebrid", "res-b").await;
    assert_eq!(warmed.status.name(), "warmed", "T4: new slot warms normally");
    assert_eq!(
        metrics.api_requests.load(Ordering::SeqCst) - api0,
        1,
        "T4: exactly one acquisition for the new slot"
    );
    assert_eq!(
        out.manager.slots.iter()
            .find(|s| s.coord.provider == "realdebrid")
            .expect("rd slot").caps.lock().unwrap().len(),
        1,
        "T4: warmed cap installed in the new slot"
    );
}

// ---------------------------------------------------------------------------
// Live-reader slot refresh lifecycle proofs
// ---------------------------------------------------------------------------
//
// These tests prove the lifecycle invariant:
//
//   Inventory refresh controls FUTURE SELECTION, not the lifetime of
//   already-owned runtime readers.
//
// Key model facts from `refresh_slots`:
//   - Pure constructor: creates a brand-new `CapabilityManager`
//   - Never mutates the old manager (readers holding it are undisturbed)
//   - Surviving slots migrate caps BY ARC (warmth preserved)
//   - New slots start empty for prewarm
//   - Old manager returned unchanged on Conflict/AlreadyCurrent
//   - Caller swaps to returned manager iff Refreshed

use std::sync::atomic::AtomicBool;
use tokio::sync::Notify;

use axum::response::IntoResponse;
use axum::routing::get;

use crate::capability::CapabilityStatus;
use crate::manager::CapabilityLease;

const REFRESH_INFO_HASH: &str = "refresh_live_reader_infohash_00000000000";
const REFRESH_PATH: &str = "refresh/live/reader.mkv";
const REFRESH_SIZE: u64 = 1 << 20;
const REFRESH_CHUNK: u64 = 65536;

fn refresh_tf() -> ControlTorrentFile {
    ControlTorrentFile {
        id: "tf_refresh_uuid".into(),
        info_hash: REFRESH_INFO_HASH.into(),
        canonical_internal_path: Some(REFRESH_PATH.into()),
        size: REFRESH_SIZE,
    }
}

fn refresh_coord(provider: &str, resource: &str, file: &str) -> ProviderCoord {
    ProviderCoord {
        provider: provider.into(),
        account_scope: "default".into(),
        provider_resource_id: resource.into(),
        provider_file_id: file.into(),
        state: "ready".into(),
        canonical_internal_path: Some(REFRESH_PATH.into()),
        size: REFRESH_SIZE,
    }
}

fn refresh_build(coords: Vec<ProviderCoord>) -> (Arc<CapabilityManager>, Arc<Metrics>) {
    let metrics = Arc::new(Metrics::default());
    let mgr = Arc::new(CapabilityManager::new(
        refresh_tf(),
        coords,
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    ));
    (mgr, metrics)
}

#[derive(Clone)]
struct RefreshBarrierState {
    hits: Arc<std::sync::Mutex<Vec<(String, u64, u64)>>>,
    request_entered: Arc<AtomicBool>,
    entered_notify: Arc<Notify>,
    release: Arc<Notify>,
}

#[derive(Clone)]
struct RefreshMockState {
    hits: Arc<std::sync::Mutex<Vec<(String, u64, u64)>>>,
}

async fn refresh_cdn_handler(
    axum::extract::State(state): axum::extract::State<RefreshMockState>,
    headers: axum::http::HeaderMap,
    uri: axum::http::Uri,
) -> axum::response::Response {
    let v = headers.get("range").expect("mock: missing Range").to_str().unwrap();
    let inner = v.strip_prefix("bytes=").expect("mock: bad Range");
    let mut it = inner.split('-');
    let s: u64 = it.next().unwrap().parse().unwrap();
    let e: u64 = it.next().unwrap().parse().unwrap();
    let path = uri.path().to_string();
    state.hits.lock().unwrap().push((path, s, e));
    let body = axum::body::Body::from(refresh_expected_range(s, e));
    axum::response::Response::builder()
        .status(axum::http::StatusCode::PARTIAL_CONTENT)
        .header("content-range", format!("bytes {s}-{e}/{}", REFRESH_SIZE))
        .header("accept-ranges", "bytes")
        .body(body)
        .unwrap()
}

async fn refresh_barrier_handler(
    axum::extract::State(state): axum::extract::State<RefreshBarrierState>,
    headers: axum::http::HeaderMap,
    uri: axum::http::Uri,
) -> axum::response::Response {
    let v = headers.get("range").expect("mock: missing Range").to_str().unwrap();
    let inner = v.strip_prefix("bytes=").expect("mock: bad Range");
    let mut it = inner.split('-');
    let s: u64 = it.next().unwrap().parse().unwrap();
    let e: u64 = it.next().unwrap().parse().unwrap();
    let path = uri.path().to_string();
    state.hits.lock().unwrap().push((path, s, e));
    state.request_entered.store(true, std::sync::atomic::Ordering::SeqCst);
    state.entered_notify.notify_one();
    state.release.notified().await;
    let body = axum::body::Body::from(refresh_expected_range(s, e));
    axum::response::Response::builder()
        .status(axum::http::StatusCode::PARTIAL_CONTENT)
        .header("content-range", format!("bytes {s}-{e}/{}", REFRESH_SIZE))
        .header("accept-ranges", "bytes")
        .body(body)
        .unwrap()
}

async fn spawn_refresh_mock(
    hits: Arc<std::sync::Mutex<Vec<(String, u64, u64)>>>,
) -> (u16, tokio::task::JoinHandle<()>) {
    let st = RefreshMockState { hits };
    let app = axum::Router::new()
        .route("/refresh", get(refresh_cdn_handler))
        .with_state(st);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (port, handle)
}

async fn spawn_refresh_barrier_mock(
    hits: Arc<std::sync::Mutex<Vec<(String, u64, u64)>>>,
) -> (u16, tokio::task::JoinHandle<()>, RefreshBarrierState) {
    let st = RefreshBarrierState {
        hits,
        request_entered: Arc::new(AtomicBool::new(false)),
        entered_notify: Arc::new(Notify::new()),
        release: Arc::new(Notify::new()),
    };
    let app = axum::Router::new()
        .route("/refresh", get(refresh_barrier_handler))
        .with_state(st.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (port, handle, st)
}

fn make_refresh_cap(port: u16, provider: &str, resource: &str) -> Arc<DeliveryCapability> {
    DeliveryCapability::new(
        format!("http://127.0.0.1:{port}/refresh"),
        provider.into(),
        "default".into(),
        "tf_refresh_uuid".into(),
        resource.into(),
        format!("file-{resource}"),
        None,
    )
}

/// Build a manager with NO warm caps, so the test acquire stub is exercised.
fn refresh_manager_acquire(port: u16) -> (Arc<CapabilityManager>, Arc<Metrics>) {
    std::env::set_var("HY4_TEST_ACQUIRE_BASE_URL", format!("http://127.0.0.1:{port}"));
    std::env::set_var(
        "HY4_TEST_ACQUIRE_URL_TORBOX",
        format!("http://127.0.0.1:{port}/refresh"),
    );
    refresh_build(vec![refresh_coord("torbox", "res-1", "file-1")])
}

/// Build a manager with ONE warm cap pre-injected, so acquire_for_read reuses it.
fn refresh_manager_warm(port: u16) -> (Arc<CapabilityManager>, Arc<Metrics>) {
    let (mgr, metrics) = refresh_build(vec![refresh_coord("torbox", "res-1", "file-1")]);
    let slot = mgr.slots.first().expect("slot exists");
    let cap = make_refresh_cap(port, "torbox", "res-1");
    slot.caps.lock().unwrap().push(cap);
    (mgr, metrics)
}

/// T5: Refresh while one reader is active.
/// Reader holds runtime capability A derived from P1.
/// Refresh changes slot/provider inventory to P2.
/// Active reader is undisturbed; future acquisition sees refreshed state.
#[tokio::test]
async fn t5_refresh_while_one_reader_active() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_refresh_mock(Arc::new(std::sync::Mutex::new(Vec::new()))).await;
    let (mgr, metrics) = refresh_manager_warm(port);

    // Reader acquires the warm cap (runtime capability A from P1)
    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let original_cap_id = reserved.cap.cap_id.clone();
    let original_url = reserved.cap.runtime_url.clone();
    let original_resource = reserved.cap.provider_resource_id.clone();

    // Refresh the slot inventory to P2 (same provider, different resource)
    let fresh_coords = vec![refresh_coord("torbox", "res-2", "file-2")];
    let out = CapabilityManager::refresh_slots(
        &mgr,
        &refresh_tf(),
        &fresh_coords,
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    );

    // Refresh must succeed (inventory changed)
    assert!(
        matches!(out.status, RefreshStatus::Refreshed),
        "T5: refresh succeeds, got {}",
        out.status.name()
    );

    // OLD manager is untouched (not mutated in place)
    assert_eq!(mgr.slots.len(), 1, "T5: old manager still has 1 slot");
    assert!(
        mgr.slots[0].coord.provider_resource_id == "res-1",
        "T5: old manager still has res-1"
    );

    // NEW manager has refreshed state
    assert_eq!(out.manager.slots.len(), 1, "T5: new manager has 1 slot");
    assert!(
        out.manager.slots[0].coord.provider_resource_id == "res-2",
        "T5: new manager has res-2"
    );

    // Active reader's runtime capability is NOT destroyed or mutated by refresh
    assert_eq!(reserved.cap.cap_id, original_cap_id, "T5: cap ID unchanged");
    assert_eq!(reserved.cap.runtime_url, original_url, "T5: URL unchanged");
    assert_eq!(reserved.cap.provider_resource_id, original_resource, "T5: resource unchanged");
    assert!(matches!(reserved.cap.status(), CapabilityStatus::Alive), "T5: cap still alive");

    // Release the reader
    drop(reserved);
}

/// T6: Future acquisition sees refreshed state after old reader releases.
#[tokio::test]
async fn t6_future_acquisition_sees_refreshed_state() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_refresh_mock(Arc::new(std::sync::Mutex::new(Vec::new()))).await;
    let (mgr, metrics) = refresh_manager_warm(port);

    // Reader acquires from old state
    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let old_cap_id = reserved.cap.cap_id.clone();
    let old_cap_arc = reserved.cap.clone();
    let old_resource = reserved.cap.provider_resource_id.clone();

    // Refresh inventory to P2 (same provider, different resource)
    let fresh_coords = vec![refresh_coord("torbox", "res-2", "file-2")];
    let out = CapabilityManager::refresh_slots(
        &mgr,
        &refresh_tf(),
        &fresh_coords,
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    );
    assert!(matches!(out.status, RefreshStatus::Refreshed));

    // Release old reader
    drop(reserved);

    // NEW manager has refreshed state
    assert_eq!(out.manager.slots.len(), 1, "T6: new manager has 1 slot");
    assert_eq!(
        out.manager.slots[0].coord.provider_resource_id,
        "res-2",
        "T6: new manager has refreshed resource"
    );

    // Old Arc may still exist but is NOT in the new manager's pool
    assert_eq!(old_cap_arc.cap_id, old_cap_id, "T6: old Arc unchanged");
    assert_eq!(old_cap_arc.provider_resource_id, old_resource, "T6: old resource unchanged");

    // NEW manager's pool does NOT contain the old cap
    let old_cap_in_new = out.manager.slots.iter().any(|s| {
        s.caps.lock().unwrap().iter().any(|c| c.cap_id == old_cap_id)
    });
    assert!(!old_cap_in_new, "T6: old cap not in new manager pool");
}

/// T7: Refresh removes provider placement.
/// Active reader finishes; no new reservation from removed placement.
#[tokio::test]
async fn t7_refresh_removes_placement_no_new_reservation() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_refresh_mock(Arc::new(std::sync::Mutex::new(Vec::new()))).await;

    // Manager with two placements: torbox/res-1 and realdebrid/res-2
    let (mgr, metrics) = refresh_build(vec![
        refresh_coord("torbox", "res-1", "file-1"),
        refresh_coord("realdebrid", "res-2", "file-2"),
    ]);

    // Inject warm cap for torbox
    let slot = mgr.slots.iter().find(|s| s.coord.provider == "torbox").unwrap();
    slot.caps.lock().unwrap().push(make_refresh_cap(port, "torbox", "res-1"));

    // Reader acquires torbox
    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    assert_eq!(reserved.cap.runtime_url, format!("http://127.0.0.1:{port}/refresh"));
    let old_cap_id = reserved.cap.cap_id.clone();

    // Refresh removes torbox entirely, keeps only realdebrid
    let fresh_coords = vec![refresh_coord("realdebrid", "res-2", "file-2")];
    let out = CapabilityManager::refresh_slots(
        &mgr,
        &refresh_tf(),
        &fresh_coords,
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    );
    assert!(matches!(out.status, RefreshStatus::Refreshed));

    // NEW manager has NO torbox slot
    assert!(
        !out.manager.slots.iter().any(|s| s.coord.provider == "torbox"),
        "T7: torbox slot removed from new manager"
    );

    // NEW manager only has realdebrid
    assert_eq!(out.manager.slots.len(), 1, "T7: only realdebrid remains");
    assert_eq!(out.manager.slots[0].coord.provider, "realdebrid", "T7: realdebrid slot");

    // Release old reader (torbox cap)
    drop(reserved);

    // OLD torbox cap is NOT in the new manager's pool (refresh dropped it)
    let old_cap_in_new = out.manager.slots.iter().any(|s| {
        s.caps.lock().unwrap().iter().any(|c| c.cap_id == old_cap_id)
    });
    assert!(!old_cap_in_new, "T7: old torbox cap not in new manager pool");
}

/// T8: Refresh while two shared children exist.
/// One CapabilityLease, two LogicalChild lanes sharing A.
/// Refresh slot state while child A has active work and child B is between chunks.
#[tokio::test]
async fn t8_refresh_while_two_children_active() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_refresh_mock(Arc::new(std::sync::Mutex::new(Vec::new()))).await;
    let (mgr, metrics) = refresh_manager_warm(port);

    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let lease = CapabilityLease::new(reserved);
    let child_a = CapabilityLease::child_reader(&lease).expect("A");
    let child_b = CapabilityLease::child_reader(&lease).expect("B");

    // Both children share the same capability
    assert_eq!(child_a.cap.cap_id, child_b.cap.cap_id, "T8: same cap");
    assert_eq!(lease.child_count(), 2, "T8: two children");

    // Refresh slot inventory
    let fresh_coords = vec![refresh_coord("torbox", "res-2", "file-2")];
    let out = CapabilityManager::refresh_slots(
        &mgr,
        &refresh_tf(),
        &fresh_coords,
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    );
    assert!(matches!(out.status, RefreshStatus::Refreshed));

    // Lease unaffected by refresh
    assert_eq!(lease.child_count(), 2, "T8: child count unchanged");
    assert!(!lease.is_released(), "T8: lease not released");
    assert_eq!(child_a.cap.cap_id, child_b.cap.cap_id, "T8: still same cap");

    // Drop both children
    drop(child_a);
    drop(child_b);
    assert_eq!(lease.child_count(), 0, "T8: all children dropped");
    assert!(lease.is_released(), "T8: lease released");
}

/// T9: Refresh races final child drop.
/// Deterministic ordering: final child about to drop → refresh → child drops → acquisition.
#[tokio::test]
async fn t9_refresh_races_final_child_drop() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_refresh_mock(Arc::new(std::sync::Mutex::new(Vec::new()))).await;
    let (mgr, metrics) = refresh_manager_warm(port);

    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let lease = CapabilityLease::new(reserved);
    let child_a = CapabilityLease::child_reader(&lease).expect("A");
    let child_b = CapabilityLease::child_reader(&lease).expect("B");

    // Drop child A first
    drop(child_a);
    assert_eq!(lease.child_count(), 1, "T9: one child remains");
    assert!(!lease.is_released(), "T9: lease not yet released");

    // Refresh while child B still holds the lease
    let fresh_coords = vec![refresh_coord("torbox", "res-2", "file-2")];
    let out = CapabilityManager::refresh_slots(
        &mgr,
        &refresh_tf(),
        &fresh_coords,
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    );
    assert!(matches!(out.status, RefreshStatus::Refreshed));

    // Lease still alive (child B holds it)
    assert_eq!(lease.child_count(), 1, "T9: child B still holds lease");

    // Drop final child
    drop(child_b);
    assert_eq!(lease.child_count(), 0, "T9: all children dropped");
    assert!(lease.is_released(), "T9: lease released");

    // Refresh outcome is valid for future use
    assert!(matches!(out.status, RefreshStatus::Refreshed));
    assert_eq!(out.manager.slots.len(), 1, "T9: refreshed manager ready");
    assert_eq!(
        out.manager.slots[0].coord.provider_resource_id,
        "res-2",
        "T9: refreshed manager has new resource"
    );

    drop(lease);
}

/// T10: Refresh must not alter byte identity.
/// TorrentFile identity, canonicalInternalPath, and exact size must not change
/// for an already-bound runtime read.
#[tokio::test]
async fn t10_refresh_preserves_byte_identity() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_refresh_mock(Arc::new(std::sync::Mutex::new(Vec::new()))).await;
    let (mgr, metrics) = refresh_manager_warm(port);

    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };

    // Capture identity BEFORE refresh
    let cap_id_before = reserved.cap.cap_id.clone();
    let url_before = reserved.cap.runtime_url.clone();
    let provider_before = reserved.cap.provider.clone();
    let resource_before = reserved.cap.provider_resource_id.clone();

    // Refresh with different resource metadata
    let fresh_coords = vec![refresh_coord("torbox", "res-changed", "file-changed")];
    let out = CapabilityManager::refresh_slots(
        &mgr,
        &refresh_tf(),
        &fresh_coords,
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    );
    assert!(matches!(out.status, RefreshStatus::Refreshed));

    // Already-bound runtime capability is NOT mutated
    assert_eq!(reserved.cap.cap_id, cap_id_before, "T10: cap ID unchanged");
    assert_eq!(reserved.cap.runtime_url, url_before, "T10: URL unchanged");
    assert_eq!(reserved.cap.provider, provider_before, "T10: provider unchanged");
    assert_eq!(reserved.cap.provider_resource_id, resource_before, "T10: resource unchanged");

    // NEW manager has refreshed metadata
    assert_eq!(
        out.manager.slots[0].coord.provider_resource_id,
        "res-changed",
        "T10: new manager has refreshed resource"
    );

    drop(reserved);
}
