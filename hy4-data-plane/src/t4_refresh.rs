//! T4 transplant proof: runtime slot refresh after durable placement change.
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
