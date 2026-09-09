//! Explicit runtime prewarm primitive.
//!
//! Async unit-level; acquisition itself runs through the REAL
//! single-flight `resolve_internal`, with the provider call answered by
//! the `#[cfg(test)]`-gated `HY4_TEST_ACQUIRE_BASE_URL` stub (compiled
//! out of production builds — zero live I/O, zero keys).
//!
//! T1: cold existing slot prewarms exactly one capability via the
//!     existing acquisition machinery (status warmed, api_delta 1).
//! T2: repeating prewarm reuses the warm cap (already_warm, delta 0).
//! T3: prewarm returns with the permit free, so T2 `reserve_standby`
//!     can subsequently reserve the warmed cap.
//! T4: missing slot fails cleanly (invalid_slot, delta 0, nothing made).

use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::capability::{ApiKeys, DeliveryCapability};
use crate::control::{ControlTorrentFile, ProviderCoord};
use crate::manager::{CapabilityManager, PrewarmStatus};
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

fn build(coords: Vec<ProviderCoord>) -> (Arc<CapabilityManager>, Arc<Metrics>) {
    // Stub-acquire base: always set, never removed, so parallel tests
    // cannot interfere through the process-global env.
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

fn slot_caps(mgr: &CapabilityManager, provider: &str, resource: &str) -> usize {
    mgr.slots
        .iter()
        .find(|s| s.coord.provider == provider && s.coord.provider_resource_id == resource)
        .expect("slot for coord")
        .caps
        .lock()
        .unwrap()
        .len()
}

#[tokio::test]
async fn t1_cold_slot_prewarms_one_capability() {
    let (mgr, _) = build(vec![coord("torbox", "res-a", "file-a")]);
    assert_eq!(slot_caps(&mgr, "torbox", "res-a"), 0, "T1: slot starts cold");
    let out = mgr.prewarm_slot("torbox", "res-a").await;
    assert!(
        matches!(out.status, PrewarmStatus::Warmed),
        "T1: cold slot warms, got {}",
        out.status.name()
    );
    assert_eq!(out.status.name(), "warmed");
    assert_eq!(out.api_delta, 1, "T1: exactly one acquisition");
    assert!(out.cap_id.is_some(), "T1: warmed cap reported");
    assert_eq!(slot_caps(&mgr, "torbox", "res-a"), 1, "T1: one cap installed");
}

#[tokio::test]
async fn t2_repeat_prewarm_reuses_zero_acquisition() {
    let (mgr, metrics) = build(vec![coord("torbox", "res-a", "file-a")]);
    let first = mgr.prewarm_slot("torbox", "res-a").await;
    assert!(matches!(first.status, PrewarmStatus::Warmed));
    let api0 = metrics.api_requests.load(Ordering::SeqCst);
    let second = mgr.prewarm_slot("torbox", "res-a").await;
    assert!(
        matches!(second.status, PrewarmStatus::AlreadyWarm),
        "T2: repeat reuses, got {}",
        second.status.name()
    );
    assert_eq!(second.api_delta, 0, "T2: zero additional acquisition");
    assert_eq!(
        metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "T2: counter untouched"
    );
    assert_eq!(second.cap_id, first.cap_id, "T2: same warm cap reused");
    assert_eq!(slot_caps(&mgr, "torbox", "res-a"), 1, "T2: still exactly one cap");
}

#[tokio::test]
async fn t3_warmed_cap_permit_free_for_standby() {
    let (mgr, _) = build(vec![coord("torbox", "res-a", "file-a")]);
    let out = mgr.prewarm_slot("torbox", "res-a").await;
    assert!(matches!(out.status, PrewarmStatus::Warmed));
    // The warmed cap sits free: full permit available, no holder.
    let warmed = mgr.slots.iter()
        .find(|s| s.coord.provider == "torbox")
        .expect("slot")
        .caps.lock().unwrap()
        .iter().find(|c| Some(c.cap_id.clone()) == out.cap_id)
        .expect("warmed cap installed")
        .clone();
    assert_eq!(
        warmed.limiter.available_permits(),
        1,
        "T3: prewarm holds no permit"
    );
    // A held primary in the same slot can subsequently reserve it via T2.
    let primary = DeliveryCapability::new(
        "http://cdn.invalid/torbox/primary".into(),
        "torbox".into(),
        "default".into(),
        "tf_routing_uuid".into(),
        "res-a".into(),
        "file-p".into(),
        None,
    );
    mgr.slots.iter()
        .find(|s| s.coord.provider == "torbox")
        .expect("slot")
        .caps.lock().unwrap()
        .push(primary.clone());
    let _held = primary.limiter.clone().try_acquire_owned().expect("hold primary");
    let (r, _) = mgr
        .reserve_standby(&primary)
        .expect("T3: warmed cap reservable as standby");
    assert!(
        Arc::ptr_eq(&r.cap, &warmed),
        "T3: standby reservation returns the prewarmed cap"
    );
}

#[tokio::test]
async fn t4_missing_slot_fails_clean_without_creating() {
    let (mgr, metrics) = build(vec![coord("torbox", "res-a", "file-a")]);
    let slots_before = mgr.slots.len();
    let api0 = metrics.api_requests.load(Ordering::SeqCst);
    let out = mgr.prewarm_slot("torbox", "no-such-resource").await;
    assert!(
        matches!(out.status, PrewarmStatus::InvalidSlot(_)),
        "T4: missing slot fails cleanly, got {}",
        out.status.name()
    );
    assert_eq!(out.status.name(), "invalid_slot");
    assert_eq!(out.api_delta, 0, "T4: zero acquisition");
    assert_eq!(
        metrics.api_requests.load(Ordering::SeqCst),
        api0,
        "T4: counter untouched"
    );
    assert_eq!(mgr.slots.len(), slots_before, "T4: no slot created");
    assert!(
        out.cap_id.is_none(),
        "T4: no cap reported"
    );
}
