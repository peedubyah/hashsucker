//! Warm same-TorrentFile standby reservation.
//!
//! Unit-level, no I/O, no provider acquisition. A caller holding one
//! capability reserves a second already-warm capability for the exact
//! same TorrentFile. Provider identity is execution metadata only and
//! never participates in eligibility or in the returned identity.
//!
//! T1: held A + warm same-provider B -> B reserved, A never returned.
//! T2: held A + same-provider B + cross-provider C -> B preferred.
//! T3: held A + no same-provider standby + warm cross-provider C for the
//!     same TF -> C reserved.
//! T4: warm capability for another TF -> not eligible.
//! T5: standby reservation causes zero provider acquisition and holds
//!     the normal per-cap permit.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::capability::{ApiKeys, DeliveryCapability};
use crate::control::{ControlTorrentFile, ProviderCoord};
use crate::manager::CapabilityManager;
use crate::metrics::Metrics;

const INFO_HASH: &str = "06bfe49fdc99ad0c6fef1f761382a8181490e456";
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

fn build(coords: Vec<ProviderCoord>) -> (Arc<CapabilityManager>, Arc<Metrics>) {
    // Phase-2 gate: always ON here, never removed, so parallel tests
    // cannot interfere through the process-global env.
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
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

/// Push a warm cap into the slot holding (provider, resource).
fn add_cap(
    mgr: &CapabilityManager,
    provider: &str,
    resource: &str,
    file: &str,
) -> Arc<DeliveryCapability> {
    let slot = mgr
        .slots
        .iter()
        .find(|s| s.coord.provider == provider && s.coord.provider_resource_id == resource)
        .expect("slot for coord");
    let cap = warm_cap(provider, resource, file);
    slot.caps.lock().unwrap().push(cap.clone());
    cap
}

fn slot_key(mgr: &CapabilityManager, provider: &str, resource: &str) -> String {
    mgr.slots
        .iter()
        .find(|s| s.coord.provider == provider && s.coord.provider_resource_id == resource)
        .expect("slot for coord")
        .durable_key
        .clone()
}

#[test]
fn t1_same_slot_standby_reserved_primary_never_returned() {
    let (mgr, _) = build(vec![
        coord("torbox", "res-a", "file-a"),
        coord("torbox", "res-a", "file-b"),
    ]);
    let a = add_cap(&mgr, "torbox", "res-a", "file-a");
    let b = add_cap(&mgr, "torbox", "res-a", "file-b");
    let _held = a.limiter.clone().try_acquire_owned().expect("hold A");
    let (r, key) = mgr.reserve_standby(&a).expect("T1: standby reserved");
    assert!(Arc::ptr_eq(&r.cap, &b), "T1: warm same-provider B reserved");
    assert!(!Arc::ptr_eq(&r.cap, &a), "T1: held primary never returned");
    assert_eq!(key, slot_key(&mgr, "torbox", "res-a"), "T1: slot-authoritative key");
    assert!(key.contains(INFO_HASH), "T1: key is infoHash-based, got {key:?}");
    assert!(!key.contains("torbox"), "T1: provider plays no part in the key, got {key:?}");
}

#[test]
fn t2_same_provider_preferred_over_cross_provider() {
    let (mgr, _) = build(vec![
        coord("torbox", "res-a", "file-a"),
        coord("torbox", "res-a", "file-b"),
        coord("realdebrid", "res-b", "file-c"),
    ]);
    let a = add_cap(&mgr, "torbox", "res-a", "file-a");
    let b = add_cap(&mgr, "torbox", "res-a", "file-b");
    let _c = add_cap(&mgr, "realdebrid", "res-b", "file-c");
    let _held = a.limiter.clone().try_acquire_owned().expect("hold A");
    let (r, _) = mgr.reserve_standby(&a).expect("T2: standby reserved");
    assert!(Arc::ptr_eq(&r.cap, &b), "T2: same-provider B preferred over cross-provider C");
}

#[test]
fn t3_cross_provider_same_tf_reserved() {
    let (mgr, _) = build(vec![
        coord("torbox", "res-a", "file-a"),
        coord("realdebrid", "res-b", "file-c"),
    ]);
    let a = add_cap(&mgr, "torbox", "res-a", "file-a");
    let c = add_cap(&mgr, "realdebrid", "res-b", "file-c");
    let _held = a.limiter.clone().try_acquire_owned().expect("hold A");
    let (r, key) = mgr.reserve_standby(&a).expect("T3: cross-provider standby reserved");
    assert!(Arc::ptr_eq(&r.cap, &c), "T3: warm same-TF cross-provider C reserved");
    assert_eq!(key, slot_key(&mgr, "realdebrid", "res-b"), "T3: standby slot's own key");
}

#[test]
fn t4_wrong_tf_never_eligible() {
    std::env::set_var("HY4_CROSS_PROVIDER_STANDBY", "1");
    let metrics = Arc::new(Metrics::default());
    let mut mgr = CapabilityManager::new(
        tf(),
        vec![
            coord("torbox", "res-a", "file-a"),
            coord("realdebrid", "res-b", "file-c"),
        ],
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics,
    );
    // White-box simulation of another-TF placement: same manager shape,
    // foreign durable identity on the cross-provider slot.
    mgr.slots
        .iter_mut()
        .find(|s| s.coord.provider == "realdebrid")
        .expect("rd slot")
        .durable_key = "tfkv\x1fother-info-hash\x1f7000000000\x1fShow/Season 01/file.mkv".into();
    let mgr = Arc::new(mgr);
    let a = add_cap(&mgr, "torbox", "res-a", "file-a");
    let _c = add_cap(&mgr, "realdebrid", "res-b", "file-c");
    let _held = a.limiter.clone().try_acquire_owned().expect("hold A");
    assert!(
        mgr.reserve_standby(&a).is_none(),
        "T4: wrong-TF warm cap is never eligible"
    );
}

#[test]
fn t5_standby_reservation_causes_zero_acquisition() {
    let (mgr, metrics) = build(vec![
        coord("torbox", "res-a", "file-a"),
        coord("torbox", "res-a", "file-b"),
    ]);
    let a = add_cap(&mgr, "torbox", "res-a", "file-a");
    let _b = add_cap(&mgr, "torbox", "res-a", "file-b");
    let _held = a.limiter.clone().try_acquire_owned().expect("hold A");
    let api0 = metrics.api_requests.load(Ordering::SeqCst);
    let (r, _) = mgr.reserve_standby(&a).expect("T5: standby reserved");
    assert_eq!(
        metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "T5: zero provider acquisition"
    );
    assert_eq!(
        r.cap.limiter.available_permits(),
        0,
        "T5: returned reservation holds the normal per-cap permit"
    );
}
