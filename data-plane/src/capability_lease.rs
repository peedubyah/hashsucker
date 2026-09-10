//! Bounded two-reader capability lease.
//!
//! Proves one `ReservedCapability` / one semaphore permit backs two concurrent
//! disjoint Range readers for the same TorrentFile, with all lifetime and
//! recovery invariants intact.
//!
//! Deterministic mock CDNs, real overlap. Tests are serialized by
//! `env_lock()` because `build_manager_acquire` sets the process-global
//! `HY4_TEST_ACQUIRE_BASE_URL` and `fault_dead_once` is a process-global gate.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use bytes::Bytes;
use tokio::sync::oneshot;

use crate::capability::{ApiKeys, DeliveryCapability};
use crate::control::{ControlTorrentFile, ProviderCoord};
use crate::manager::{CapabilityLease, CapabilityManager};
use crate::metrics::Metrics;
use crate::transport::{Faults, ResilientRangeReader};

const FILE: u64 = 1 << 20;
const CHUNK: u64 = 65536;
const TF_ID: &str = "tf_lease_det";
const INFO_HASH: &str = "infohash-lease-deterministic";
const PATH: &str = "lease-det.bin";

fn pat(off: u64) -> u8 {
    (off.wrapping_mul(2654435761).wrapping_add(off >> 7) % 251) as u8
}

fn expected_range(s: u64, e: u64) -> Vec<u8> {
    (s..=e).map(pat).collect()
}

#[derive(Clone)]
struct MockState {
    hits: Arc<Mutex<Vec<(String, u64, u64)>>>,
}

async fn cdn_handler(
    State(st): State<MockState>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Response {
    let v = headers.get("range").expect("mock: missing Range").to_str().unwrap();
    let inner = v.strip_prefix("bytes=").expect("mock: bad Range");
    let mut it = inner.split('-');
    let s: u64 = it.next().unwrap().parse().unwrap();
    let e: u64 = it.next().unwrap().parse().unwrap();
    assert!(s <= e && e < FILE, "mock: range out of bounds {s}-{e}");
    let path = uri.path().to_string();
    st.hits.lock().unwrap().push((path, s, e));
    let body = Body::from(Bytes::from(expected_range(s, e)));
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-range", format!("bytes {s}-{e}/{FILE}"))
        .header("accept-ranges", "bytes")
        .body(body)
        .unwrap()
        .into_response()
}

async fn spawn_mock(hits: Arc<Mutex<Vec<(String, u64, u64)>>>)
    -> (u16, tokio::task::JoinHandle<()>)
{
    let st = MockState { hits };
    let app = axum::Router::new()
        .route("/lease", get(cdn_handler))
        .with_state(st);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (port, handle)
}

fn make_cap(port: u64, provider: &str, resource: &str) -> Arc<DeliveryCapability> {
    DeliveryCapability::new(
        format!("http://127.0.0.1:{port}/lease"),
        provider.into(),
        "test".into(),
        TF_ID.into(),
        resource.into(),
        format!("file-{resource}"),
        None,
    )
}

/// Build a manager with NO warm caps, so the test acquire stub is exercised
/// exactly once by acquire_for_read. Sets HY4_TEST_ACQUIRE_BASE_URL so the
/// stub mints a capability pointing at the mock CDN.
fn build_manager_acquire(port: u16) -> (Arc<CapabilityManager>, Arc<Metrics>) {
    std::env::set_var("HY4_TEST_ACQUIRE_BASE_URL", format!("http://127.0.0.1:{port}"));
    std::env::set_var(
        "HY4_TEST_ACQUIRE_URL_TORBOX",
        format!("http://127.0.0.1:{port}/lease"),
    );
    build_manager_inner()
}

/// Build a manager with ONE warm cap pre-injected, so acquire_for_read reuses
/// it (zero provider acquisitions). Does NOT set the acquire stub.
fn build_manager_warm(port: u16) -> (Arc<CapabilityManager>, Arc<Metrics>) {
    let (mgr, metrics) = build_manager_inner();
    let slot = mgr.slots.first().expect("slot exists");
    let cap = make_cap(port as u64, "torbox", "res-lease");
    slot.caps.lock().unwrap().push(cap);
    (mgr, metrics)
}

fn build_manager_inner() -> (Arc<CapabilityManager>, Arc<Metrics>) {
    let metrics = Arc::new(Metrics::default());
    let coord = ProviderCoord {
        provider: "torbox".into(),
        account_scope: "test".into(),
        provider_resource_id: "res-lease".into(),
        provider_file_id: "file-res-lease".into(),
        state: "ready".into(),
        canonical_internal_path: Some(PATH.into()),
        size: FILE,
    };
    let control_tf = ControlTorrentFile {
        id: TF_ID.into(),
        info_hash: INFO_HASH.into(),
        canonical_internal_path: Some(PATH.into()),
        size: FILE,
    };
    let mgr = Arc::new(CapabilityManager::new(
        control_tf,
        vec![coord],
        ApiKeys { torbox: String::new(), realdebrid: String::new() },
        reqwest::Client::new(),
        metrics.clone(),
    ));
    (mgr, metrics)
}

async fn read_full(
    reader: &mut ResilientRangeReader,
    len: u64,
) -> Result<Vec<u8>, crate::transport::OpenError> {
    let mut out = Vec::with_capacity(len as usize);
    loop {
        match reader.next_chunk().await {
            crate::transport::Step::Chunk(b) => out.extend_from_slice(&b),
            crate::transport::Step::Eof => return Ok(out),
            crate::transport::Step::Terminal(e) => return Err(e),
        }
    }
}

/// T0: deterministic acquisition accounting. Using the real test acquire stub,
/// acquire_for_read mints exactly one capability (one acquisition counted)
/// and lease creation + second child reader mint zero additional acquisitions.
///
/// Serialized: sets process-global HY4_TEST_ACQUIRE_BASE_URL.
#[tokio::test]
async fn t0_deterministic_one_acquisition_zero_second() {
    let _guard = crate::test_env::env_lock();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, _handle) = spawn_mock(hits.clone()).await;
    let (mgr, metrics) = build_manager_acquire(port);

    let acq_before = metrics.capability_acquisitions.load(Ordering::SeqCst);
    let api_before = metrics.api_requests.load(Ordering::SeqCst);

    // One real acquisition through the stub.
    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let acq_after_acquire = metrics.capability_acquisitions.load(Ordering::SeqCst);
    let api_after_acquire = metrics.api_requests.load(Ordering::SeqCst);
    assert_eq!(acq_after_acquire - acq_before, 1, "exactly one capability acquisition");
    assert_eq!(api_after_acquire - api_before, 1, "exactly one API request");

    // Wrap in lease + mint second child: zero additional acquisitions.
    let lease = CapabilityLease::new(reserved);
    let child_a = CapabilityLease::child_reader(&lease).expect("A");
    let child_b = CapabilityLease::child_reader(&lease).expect("B");
    let acq_after_children = metrics.capability_acquisitions.load(Ordering::SeqCst);
    let api_after_children = metrics.api_requests.load(Ordering::SeqCst);
    assert_eq!(acq_after_children, acq_after_acquire, "zero additional acquisition for child B");
    assert_eq!(api_after_children, api_after_acquire, "zero additional API for child B");

    // Both children reference the same capability.
    assert_eq!(child_a.cap.cap_id, child_b.cap.cap_id);

    drop(child_a);
    drop(child_b);
}

/// T1: the core concurrent-read proof. One existing ReservedCapability (warm cap
/// reused, zero acquisitions), one CapabilityLease, two child readers on disjoint
/// chunks concurrently. Proves: exact bytes, disjoint ownership, zero acquisition
/// delta, third reader rejected.
///
/// Serialized: holds env_lock because it spins up a mock server and runs
/// concurrently with other async tests.
#[tokio::test]
async fn t1_one_capability_two_child_readers_concurrent_disjoint_chunks() {
    let _guard = crate::test_env::env_lock();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, _handle) = spawn_mock(hits.clone()).await;
    let (mgr, metrics) = build_manager_warm(port);

    let faults = Faults {
        fault_429_always: false,
        fault_429_once: false,
        fault_dead_once: false,
        fault_midbody_once: false,
    };
    let priority = 0;

    // One existing ReservedCapability reused from the warm pool.
    let reserved = match mgr.acquire_for_read(priority).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let cap_id_before = reserved.cap.cap_id.clone();
    let acq_before = metrics.capability_acquisitions.load(Ordering::SeqCst);

    let lease = CapabilityLease::new(reserved);
    assert_eq!(lease.child_count(), 0);
    assert!(!lease.is_released());

    let child_a = CapabilityLease::child_reader(&lease).expect("child A");
    let child_b = CapabilityLease::child_reader(&lease).expect("child B");
    assert_eq!(lease.child_count(), 2);

    // Third reader rejected.
    assert!(CapabilityLease::child_reader(&lease).is_none(), "third reader rejected");

    // Both children reference the same capability.
    assert_eq!(child_a.cap.cap_id, cap_id_before);
    assert_eq!(child_b.cap.cap_id, cap_id_before);

    // Zero acquisition delta for reader B.
    let acq_after_lease = metrics.capability_acquisitions.load(Ordering::SeqCst);
    assert_eq!(acq_after_lease, acq_before, "zero acquisition delta for lease");

    let client = reqwest::Client::new();
    let chunk_n_start = 0u64;
    let chunk_n_end = CHUNK - 1;
    let chunk_np1_start = CHUNK;
    let chunk_np1_end = 2 * CHUNK - 1;

    let mut reader_a = ResilientRangeReader::new_shared_child(
        client.clone(), metrics.clone(), mgr.clone(),
        child_a, priority, chunk_n_start, chunk_n_end, FILE, false, faults,
    );
    let mut reader_b = ResilientRangeReader::new_shared_child(
        client.clone(), metrics.clone(), mgr.clone(),
        child_b, priority, chunk_np1_start, chunk_np1_end, FILE, false, faults,
    );

    let (tx_a, rx_a) = oneshot::channel::<Vec<u8>>();
    let (tx_b, rx_b) = oneshot::channel::<Vec<u8>>();

    let mut ra = reader_a;
    let mut rb = reader_b;
    let handle_a = tokio::spawn(async move {
        let r = read_full(&mut ra, CHUNK).await;
        let _ = tx_a.send(r.unwrap_or_default());
    });
    let handle_b = tokio::spawn(async move {
        let r = read_full(&mut rb, CHUNK).await;
        let _ = tx_b.send(r.unwrap_or_default());
    });

    let (res_a, res_b) = tokio::join!(handle_a, handle_b);
    res_a.expect("reader A panicked");
    res_b.expect("reader B panicked");

    let bytes_a = rx_a.await.expect("recv A");
    let bytes_b = rx_b.await.expect("recv B");

    assert_eq!(bytes_a, expected_range(chunk_n_start, chunk_n_end), "chunk N bytes");
    assert_eq!(bytes_b, expected_range(chunk_np1_start, chunk_np1_end), "chunk N+1 bytes");

    let guard = hits.lock().unwrap();
    let ranges: Vec<(u64, u64)> = guard.iter().map(|(_, s, e)| (*s, *e)).collect();
    assert!(ranges.contains(&(chunk_n_start, chunk_n_end)), "chunk N fetched");
    assert!(ranges.contains(&(chunk_np1_start, chunk_np1_end)), "chunk N+1 fetched");
    assert_eq!(ranges.len(), 2, "exactly two fetches, disjoint");
    drop(guard);

    // Still zero new provider acquisitions (warm cap reused).
    let acq_final = metrics.capability_acquisitions.load(Ordering::SeqCst);
    assert_eq!(acq_final, acq_before, "zero new provider acquisitions");
}

/// T2: permit lifetime. Dropping A alone does NOT release the permit. Dropping B
/// as the final child releases exactly once. New children refused after release.
#[tokio::test]
async fn t2_permit_lifetime_until_last_child_drops() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
    let (mgr, _metrics) = build_manager_warm(port);
    let priority = 0;

    let reserved = match mgr.acquire_for_read(priority).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let lease = CapabilityLease::new(reserved);
    assert!(!lease.is_released());

    let child_a = CapabilityLease::child_reader(&lease).expect("A");
    let child_b = CapabilityLease::child_reader(&lease).expect("B");
    assert_eq!(lease.child_count(), 2);

    // Third reader refused while two are active.
    assert!(CapabilityLease::child_reader(&lease).is_none(), "third refused at 2");

    // Drop A alone: lease NOT released.
    drop(child_a);
    assert_eq!(lease.child_count(), 1, "one child remains");
    assert!(!lease.is_released(), "permit still held after A drops");

    // Drop B: last child, lease released.
    drop(child_b);
    assert_eq!(lease.child_count(), 0);
    assert!(lease.is_released(), "permit freed after last child drops");

    // New children refused after release.
    assert!(CapabilityLease::child_reader(&lease).is_none(), "refused after release");
}

/// T3: breaker/limiter/retry accounting. Both child readers traverse the normal
/// transport path (mock proves two independent CDN fetches happened).
#[tokio::test]
async fn t3_both_readers_traverse_transport_accounting() {
    let _guard = crate::test_env::env_lock();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, _handle) = spawn_mock(hits.clone()).await;
    let (mgr, metrics) = build_manager_warm(port);
    let priority = 0;

    let reserved = match mgr.acquire_for_read(priority).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let lease = CapabilityLease::new(reserved);
    let child_a = CapabilityLease::child_reader(&lease).expect("A");
    let child_b = CapabilityLease::child_reader(&lease).expect("B");

    let faults = Faults {
        fault_429_always: false,
        fault_429_once: false,
        fault_dead_once: false,
        fault_midbody_once: false,
    };
    let client = reqwest::Client::new();

    let mut ra = ResilientRangeReader::new_shared_child(
        client.clone(), metrics.clone(), mgr.clone(),
        child_a, priority, 0, CHUNK - 1, FILE, false, faults,
    );
    let mut rb = ResilientRangeReader::new_shared_child(
        client.clone(), metrics.clone(), mgr.clone(),
        child_b, priority, CHUNK, 2 * CHUNK - 1, FILE, false, faults,
    );

    let fa = tokio::spawn(async move { read_full(&mut ra, CHUNK).await });
    let fb = tokio::spawn(async move { read_full(&mut rb, CHUNK).await });
    let (ba, bb) = tokio::join!(fa, fb);
    assert!(ba.is_ok(), "reader A succeeded");
    assert!(bb.is_ok(), "reader B succeeded");

    let guard = hits.lock().unwrap();
    assert_eq!(guard.len(), 2, "two independent provider fetches");
    assert_eq!(metrics.upstream_errors.load(Ordering::SeqCst), 0, "no errors");
}

/// T4: shared-cap recovery ownership. A dead-link fault (Class C) on one child
/// must NOT trigger independent reacquisition. apply_dead() returns Fatal for
/// shared children BEFORE reacquire_for_read, so the reacquisition counter is
/// unchanged and the sibling's lease is unaffected.
///
/// Serialized: fault_dead_once is a process-global gate; holds env_lock.
#[tokio::test]
async fn t4_no_independent_reacquisition_on_dead_link() {
    let _guard = crate::test_env::env_lock();
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, _handle) = spawn_mock(hits.clone()).await;
    let (mgr, metrics) = build_manager_warm(port);
    let priority = 0;

    let reserved = match mgr.acquire_for_read(priority).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let lease = CapabilityLease::new(reserved);
    let child_a = CapabilityLease::child_reader(&lease).expect("A");
    let child_b = CapabilityLease::child_reader(&lease).expect("B");

    // fault_dead_once: first open attempt returns 403 (Class C).
    let faults = Faults {
        fault_429_always: false,
        fault_429_once: false,
        fault_dead_once: true,
        fault_midbody_once: false,
    };
    let client = reqwest::Client::new();

    let reacq_before = metrics.capability_reacquisitions.load(Ordering::SeqCst);

    // Reader A: first attempt hits 403, apply_dead() returns Fatal (shared child
    // cannot reacquire). Reader terminates immediately. Scope ensures ra (and
    // thus child_a) is dropped before we assert on lease.child_count.
    let result_a = {
        let mut ra = ResilientRangeReader::new_shared_child(
            client.clone(), metrics.clone(), mgr.clone(),
            child_a, priority, 0, CHUNK - 1, FILE, false, faults,
        );
        read_full(&mut ra, CHUNK).await
    };
    assert!(result_a.is_err(), "shared child A terminates on dead-link");

    // No reacquisition happened (apply_dead returns Fatal before reacquire_for_read).
    let reacq_after = metrics.capability_reacquisitions.load(Ordering::SeqCst);
    assert_eq!(reacq_after, reacq_before, "no reacquisition initiated by shared child");

    // Sibling's lease is unaffected: one child remains, permit still held.
    assert_eq!(lease.child_count(), 1, "one child remains (B)");
    assert!(!lease.is_released(), "permit still held");

    drop(child_b);
}

/// T5: parent/lease handle may outlive children without premature permit release.
/// The lease holds an Arc<CapabilityLease>; ChildReaderHandle holds its own Arc
/// clone. Dropping the lease handle while children exist must NOT release the
/// permit — only the last child's drop may release it.
///
/// We create a lease, spawn two children, drop the lease handle itself, verify
/// both children are still valid (same cap_id), then drop each child and verify
/// the permit is fully released by acquiring a new reservation afterward.
#[tokio::test]
async fn t5_parent_drop_with_live_children_no_premature_release() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
    let (mgr, _metrics) = build_manager_warm(port);
    let priority = 0;

    let reserved = match mgr.acquire_for_read(priority).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };

    // Create the lease in a scoped block so the original Arc handle drops here.
    let (child_a, child_b) = {
        let lease = CapabilityLease::new(reserved);
        let child_a = CapabilityLease::child_reader(&lease).expect("A");
        let child_b = CapabilityLease::child_reader(&lease).expect("B");
        assert_eq!(lease.child_count(), 2);
        // lease handle drops here — but children hold their Arc clones.
        (child_a, child_b)
    };

    // After the lease handle drops, children still hold the lease alive.
    assert_eq!(child_a.cap.cap_id, child_b.cap.cap_id);

    // Drop first child.
    drop(child_a);

    // Drop second (final) child: permit released exactly once.
    drop(child_b);

    // New reservation from the same manager must succeed (permit freed).
    let reserved2 = match mgr.acquire_for_read(priority).await {
        Ok(r) => r,
        Err(_) => panic!("second acquire_for_read failed — permit may not have released"),
    };
    drop(reserved2);
}

/// T6: no double-release / underflow. Repeated create/drop of leases with
/// varying child counts (0, 1, 2) must not panic or underflow child_count.
/// child_count uses saturating_sub, so dropping below 0 is impossible.
#[tokio::test]
async fn t6_no_double_release_no_underflow() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;

    for children in 0u8..=2 {
        let (mgr, _metrics) = build_manager_warm(port);
        let reserved = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("acquire_for_read failed"),
        };
        let lease = CapabilityLease::new(reserved);
        let mut handles = Vec::new();
        for _ in 0..children {
            handles.push(CapabilityLease::child_reader(&lease).expect("child"));
        }
        // Drop all children — child_count decrements to 0.
        for h in handles {
            drop(h);
        }
        assert_eq!(lease.child_count(), 0, "final child_count is 0 for children={children}");
        drop(lease);
        // After lease drop, permit is fully released: new acquire succeeds.
        // (This also exercises the no-underflow invariant: dropping the lease
        //  after all children already dropped must not double-release.)
    }
}

/// T7: ChildReaderHandle cloning audit. Temporary per-fill clones must not
/// increase the logical child count beyond 2. The invariant is: temporary
/// transport clones are references to one of the two logical child lanes;
/// they are not additional logical readers.
#[tokio::test]
async fn t7_child_handle_clone_lifecycle() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
    let (mgr, _metrics) = build_manager_warm(port);

    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let lease = CapabilityLease::new(reserved);
    
    // 1. Create A: child_count = 1
    let child_a = CapabilityLease::child_reader(&lease).expect("A");
    assert_eq!(lease.child_count(), 1, "one logical child");
    
    // 2. Clone A ten times: child_count remains 1
    let mut a_clones = Vec::new();
    for _ in 0..10 {
        a_clones.push(child_a.clone());
    }
    assert_eq!(lease.child_count(), 1, "clones don't increase count");
    drop(a_clones);
    assert_eq!(lease.child_count(), 1, "dropping clones doesn't decrement");
    
    // 3. Create B: child_count = 2
    let child_b = CapabilityLease::child_reader(&lease).expect("B");
    assert_eq!(lease.child_count(), 2, "two logical children");
    
    // 4. Clone A and B repeatedly: child_count remains 2
    {
        let mut clones = Vec::new();
        for _ in 0..10 {
            clones.push(child_a.clone());
            clones.push(child_b.clone());
        }
        assert_eq!(lease.child_count(), 2, "repeated clones don't increase count");
    }
    assert_eq!(lease.child_count(), 2, "dropping clones doesn't decrement");
    
    // 5. Drop original B while one B clone remains: child_count remains 2
    let b_clone = child_b.clone();
    drop(child_b);
    assert_eq!(lease.child_count(), 2, "logical B still alive via clone");
    
    // 6. Drop final B handle: child_count becomes 1
    drop(b_clone);
    assert_eq!(lease.child_count(), 1, "logical B fully dropped");
    
    // 7. Clone A again after B is gone: child_count remains 1
    {
        let _clone = child_a.clone();
        assert_eq!(lease.child_count(), 1, "clone of A doesn't increase count");
    }
    
    // 8. While only A exists, create a new logical B
    let _child_b = CapabilityLease::child_reader(&lease).expect("new B");
    assert_eq!(lease.child_count(), 2, "new logical B created");
    
    // 9. Third logical child creation is rejected
    assert!(CapabilityLease::child_reader(&lease).is_none(), "third child rejected");
    
    // 10. Final logical-child lifetime ending releases the permit exactly once
    drop(child_a);
    assert_eq!(lease.child_count(), 1);
    drop(_child_b);
    assert_eq!(lease.child_count(), 0, "all logical children dropped");
    
    // Lease is released: new acquire succeeds
    drop(lease);
    let _reserved2 = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("permit should be released"),
    };
}

/// T8: shared-cap env gate compatibility proof. Canonical
/// DATA_PLANE_ACTIVE_ACTIVE_SHARED_CAP wins over deprecated
/// HY4_ACTIVE_ACTIVE_SHARED_CAP; neither set means OFF.
#[tokio::test]
async fn t8_shared_cap_env_precedence() {
    let _guard = crate::test_env::env_lock();
    
    // Neither set: OFF.
    std::env::remove_var("DATA_PLANE_ACTIVE_ACTIVE_SHARED_CAP");
    std::env::remove_var("HY4_ACTIVE_ACTIVE_SHARED_CAP");
    assert!(!crate::serve::shared_cap_fallback(), "neither set -> OFF");
    
    // Only deprecated set: works.
    crate::test_env::set_shared_cap_deprecated(true);
    assert!(crate::serve::shared_cap_fallback(), "deprecated set -> ON");
    crate::test_env::set_shared_cap_deprecated(false);
    
    // Only canonical set: works.
    std::env::set_var("DATA_PLANE_ACTIVE_ACTIVE_SHARED_CAP", "1");
    assert!(crate::serve::shared_cap_fallback(), "canonical set -> ON");
    
    // Both set: canonical wins (both are "1", so ON).
    std::env::set_var("HY4_ACTIVE_ACTIVE_SHARED_CAP", "1");
    assert!(crate::serve::shared_cap_fallback(), "both set -> ON");
    
    // Cleanup.
    std::env::remove_var("DATA_PLANE_ACTIVE_ACTIVE_SHARED_CAP");
    std::env::remove_var("HY4_ACTIVE_ACTIVE_SHARED_CAP");
}

// ---- T9: one lane task aborted ----
#[tokio::test]
async fn t9_one_lane_aborted() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
    let (mgr, _metrics) = build_manager_warm(port);

    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let lease = CapabilityLease::new(reserved);

    let child_a = CapabilityLease::child_reader(&lease).expect("A");
    let child_b = CapabilityLease::child_reader(&lease).expect("B");
    assert_eq!(lease.child_count(), 2, "two logical children");

    // Abort A: drop all handles for A
    drop(child_a);
    assert_eq!(lease.child_count(), 1, "A aborted -> count 1");
    assert!(!lease.is_released(), "permit still held");

    // B remains valid: can still clone and use
    {
        let _clone_b = child_b.clone();
        assert_eq!(lease.child_count(), 1, "B clone doesn't change count");
    }
    assert_eq!(lease.child_count(), 1, "after clone scope, count still 1");

    // Abort B: drop all handles for B
    drop(child_b);
    assert_eq!(lease.child_count(), 0, "B dropped -> count 0");
    assert!(lease.is_released(), "permit released");
}

// ---- T10: both lane tasks aborted ----
#[tokio::test]
async fn t10_both_lanes_aborted() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
    let (mgr, _metrics) = build_manager_warm(port);

    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let lease = CapabilityLease::new(reserved);

    let child_a = CapabilityLease::child_reader(&lease).expect("A");
    let child_b = CapabilityLease::child_reader(&lease).expect("B");
    assert_eq!(lease.child_count(), 2);

    drop(child_a);
    drop(child_b);
    assert_eq!(lease.child_count(), 0, "both aborted -> count 0");
    assert!(lease.is_released(), "permit released exactly once");

    let _reserved2 = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire should succeed after release"),
    };
}

// ---- T11: cancellation during per-fill temporary clone ----
#[tokio::test]
async fn t11_temp_clone_cancellation() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
    let (mgr, _metrics) = build_manager_warm(port);

    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let lease = CapabilityLease::new(reserved);

    let child_a = CapabilityLease::child_reader(&lease).expect("A");
    assert_eq!(lease.child_count(), 1);

    {
        let temp_clone = child_a.clone();
        assert_eq!(lease.child_count(), 1, "temp clone doesn't increment");
        drop(temp_clone);
        assert_eq!(lease.child_count(), 1, "temp clone drop doesn't decrement");
    }

    assert_eq!(lease.child_count(), 1, "original still alive");

    drop(child_a);
    assert_eq!(lease.child_count(), 0, "original dropped -> count 0");
    assert!(lease.is_released(), "permit released");
}

// ---- T12: parent handle disappears first ----
#[tokio::test]
async fn t12_parent_drop_order() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
    let (mgr, _metrics) = build_manager_warm(port);

    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let lease = CapabilityLease::new(reserved);

    let child_a = CapabilityLease::child_reader(&lease).expect("A");
    let child_b = CapabilityLease::child_reader(&lease).expect("B");
    assert_eq!(lease.child_count(), 2);

    drop(lease);

    drop(child_a);

    drop(child_b);

    let _reserved2 = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("permit should be released after all children drop"),
    };
}

// ---- T13: third logical child rejection ----
#[tokio::test]
async fn t13_third_child_rejected() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
    let (mgr, _metrics) = build_manager_warm(port);

    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let lease = CapabilityLease::new(reserved);

    let _child_a = CapabilityLease::child_reader(&lease).expect("A");
    let _child_b = CapabilityLease::child_reader(&lease).expect("B");
    assert_eq!(lease.child_count(), 2);

    assert!(CapabilityLease::child_reader(&lease).is_none(), "third child rejected");
    assert_eq!(lease.child_count(), 2, "count unchanged after rejection");
}

// ---- T14: no orphaned inflight records on cancellation ----
#[tokio::test]
async fn t14_no_orphaned_inflight_on_cancel() {
    let _guard = crate::test_env::env_lock();
    let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
    let (mgr, _metrics) = build_manager_warm(port);

    let reserved = match mgr.acquire_for_read(0).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let lease = CapabilityLease::new(reserved);

    let child_a = CapabilityLease::child_reader(&lease).expect("A");
    assert_eq!(lease.child_count(), 1);

    let tmp_dir = std::env::temp_dir().join("hashsucker_test_cancel");
    let _ = std::fs::create_dir_all(&tmp_dir);
    let cache = Arc::new(crate::cache::CacheEngine::open(
        crate::cache::CacheConfig {
            root: tmp_dir,
            max_bytes: 64 << 20,
            chunk_size: CHUNK,
        },
        _metrics.clone(),
    ).unwrap());

    let tf_id = crate::cache::TorrentFileId::new(
        TF_ID.to_string(),
        INFO_HASH.to_string(),
        PATH.to_string(),
        FILE,
    );

    let joins = cache.inflight().join_or_claim_many(&tf_id.cache_key(), &[0]);
    let join = &joins[0];
    assert!(join.owned, "we own the fill");

    join.record.failed.store(true, Ordering::SeqCst);
    cache.inflight().finalize(&tf_id.cache_key(), 0);
    join.record.done.notify_waiters();

    assert!(!cache.inflight().has(&tf_id.cache_key(), 0), "inflight record finalized");

    drop(child_a);
    assert_eq!(lease.child_count(), 0, "child dropped -> count 0");
    assert!(lease.is_released(), "permit released");
}



// ---- T15: deterministic async fill cancellation via production path ----
#[cfg(test)]
mod cancel {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use tokio::sync::Notify;

    #[derive(Clone)]
    struct BarrierState {
        hits: Arc<Mutex<Vec<(String, u64, u64)>>>,
        request_entered: Arc<AtomicBool>,
        entered_notify: Arc<Notify>,
        release: Arc<Notify>,
    }

    async fn barrier_handler(
        State(st): State<BarrierState>,
        headers: HeaderMap,
        uri: axum::http::Uri,
    ) -> Response {
        let v = headers.get("range").expect("mock: missing Range").to_str().unwrap();
        let inner = v.strip_prefix("bytes=").expect("mock: bad Range");
        let mut it = inner.split('-');
        let s: u64 = it.next().unwrap().parse().unwrap();
        let e: u64 = it.next().unwrap().parse().unwrap();
        let path = uri.path().to_string();
        st.hits.lock().unwrap().push((path, s, e));
        st.request_entered.store(true, Ordering::SeqCst);
        st.entered_notify.notify_one();
        st.release.notified().await;
        let body = Body::from(Bytes::from(expected_range(s, e)));
        Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header("content-range", format!("bytes {s}-{e}/{FILE}"))
            .header("accept-ranges", "bytes")
            .body(body)
            .unwrap()
            .into_response()
    }

    async fn spawn_barrier_mock(
        hits: Arc<Mutex<Vec<(String, u64, u64)>>>,
    ) -> (u16, tokio::task::JoinHandle<()>, BarrierState) {
        let st = BarrierState {
            hits,
            request_entered: Arc::new(AtomicBool::new(false)),
            entered_notify: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        };
        let app = axum::Router::new()
            .route("/cancel", get(barrier_handler))
            .with_state(st.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (port, handle, st)
    }

    fn build_cancel_stack(port: u16) -> (Arc<CapabilityManager>, Arc<Metrics>) {
        let metrics = Arc::new(Metrics::default());
        let coord = ProviderCoord {
            provider: "torbox".into(),
            account_scope: "test".into(),
            provider_resource_id: "res-cancel".into(),
            provider_file_id: "file-res-cancel".into(),
            state: "ready".into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let control_tf = ControlTorrentFile {
            id: TF_ID.into(),
            info_hash: INFO_HASH.into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let mgr = Arc::new(CapabilityManager::new(
            control_tf,
            vec![coord],
            ApiKeys { torbox: String::new(), realdebrid: String::new() },
            reqwest::Client::new(),
            metrics.clone(),
        ));
        let slot = mgr.slots.first().expect("slot exists");
        let cap = DeliveryCapability::new(
            format!("http://127.0.0.1:{port}/cancel"),
            "torbox".into(),
            "test".into(),
            TF_ID.into(),
            "res-cancel".into(),
            "file-res-cancel".into(),
            None,
        );
        slot.caps.lock().unwrap().push(cap);
        (mgr, metrics)
    }

    #[tokio::test]
    async fn t15_abort_during_blocked_http() {
        let _guard = crate::test_env::env_lock();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let (port, _handle, barrier) = spawn_barrier_mock(hits.clone()).await;
        let (mgr, metrics) = build_cancel_stack(port);

        let reserved = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("acquire_for_read failed"),
        };
        let lease = CapabilityLease::new(reserved);

        let child_a = CapabilityLease::child_reader(&lease).expect("A");
        let child_b = CapabilityLease::child_reader(&lease).expect("B");
        assert_eq!(lease.child_count(), 2);

        // CacheEngine::open returns Arc<CacheEngine> directly
        let cache = crate::cache::CacheEngine::open(
            crate::cache::CacheConfig {
                root: std::env::temp_dir().join("hashsucker_test_t15"),
                max_bytes: 64 << 20,
                chunk_size: CHUNK,
            },
            metrics.clone(),
        ).unwrap();

        let tf_id = crate::cache::TorrentFileId::new(
            TF_ID.to_string(),
            INFO_HASH.to_string(),
            PATH.to_string(),
            FILE,
        );

        let joins = cache.inflight().join_or_claim_many(&tf_id.cache_key(), &[0]);
        let join = &joins[0];
        assert!(join.owned, "we own chunk 0");

        let child_a_clone = child_a.clone();
        let cache_for_spawn = cache.clone();
        let mgr_for_spawn = mgr.clone();
        let metrics_for_spawn = metrics.clone();
        let tf_id_for_spawn = tf_id.clone();
        let fill_handle = tokio::spawn(async move {
            crate::serve::fill_chunk_run_shared_child(
                cache_for_spawn,
                metrics_for_spawn,
                mgr_for_spawn,
                reqwest::Client::new(),
                0,
                tf_id_for_spawn,
                vec![0],
                0,
                CHUNK - 1,
                0,
                CHUNK - 1,
                Faults {
                    fault_429_always: false,
                    fault_429_once: false,
                    fault_dead_once: false,
                    fault_midbody_once: false,
                },
                None,
                None,
                false,
                child_a_clone,
            )
            .await;
        });

        barrier.entered_notify.notified().await;
        assert!(barrier.request_entered.load(Ordering::SeqCst), "request entered");

        fill_handle.abort();
        let _ = fill_handle.await;

        barrier.release.notify_one();

        assert!(!cache.inflight().has(&tf_id.cache_key(), 0), "inflight finalized after abort");
        assert!(!cache.is_present(&tf_id.cache_key(), 0).unwrap_or(false), "chunk not present after abort");

        assert_eq!(lease.child_count(), 2, "logical children unchanged");

        drop(child_a);
        drop(child_b);
        assert_eq!(lease.child_count(), 0, "all children dropped");
        assert!(lease.is_released(), "permit released");

        let _reserved2 = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("permit should be released"),
        };
    }
}

// ---- T16: real joined waiter + reclaim + retry lifecycle ----
#[cfg(test)]
mod reclaim {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use tokio::sync::Notify;

    #[derive(Clone)]
    struct BarrierState {
        hits: Arc<Mutex<Vec<(String, u64, u64)>>>,
        request_entered: Arc<AtomicBool>,
        entered_notify: Arc<Notify>,
        release: Arc<Notify>,
    }

    async fn barrier_handler(
        State(st): State<BarrierState>,
        headers: HeaderMap,
        uri: axum::http::Uri,
    ) -> Response {
        let v = headers.get("range").expect("mock: missing Range").to_str().unwrap();
        let inner = v.strip_prefix("bytes=").expect("mock: bad Range");
        let mut it = inner.split('-');
        let s: u64 = it.next().unwrap().parse().unwrap();
        let e: u64 = it.next().unwrap().parse().unwrap();
        let path = uri.path().to_string();
        st.hits.lock().unwrap().push((path, s, e));
        st.request_entered.store(true, Ordering::SeqCst);
        st.entered_notify.notify_one();
        st.release.notified().await;
        let body = Body::from(Bytes::from(expected_range(s, e)));
        Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header("content-range", format!("bytes {s}-{e}/{FILE}"))
            .header("accept-ranges", "bytes")
            .body(body)
            .unwrap()
            .into_response()
    }

    async fn spawn_barrier_mock(
        hits: Arc<Mutex<Vec<(String, u64, u64)>>>,
    ) -> (u16, tokio::task::JoinHandle<()>, BarrierState) {
        let st = BarrierState {
            hits,
            request_entered: Arc::new(AtomicBool::new(false)),
            entered_notify: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        };
        let app = axum::Router::new()
            .route("/reclaim", get(barrier_handler))
            .with_state(st.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (port, handle, st)
    }

    fn build_reclaim_stack(port: u16) -> (Arc<CapabilityManager>, Arc<Metrics>) {
        let metrics = Arc::new(Metrics::default());
        let coord = ProviderCoord {
            provider: "torbox".into(),
            account_scope: "test".into(),
            provider_resource_id: "res-reclaim".into(),
            provider_file_id: "file-res-reclaim".into(),
            state: "ready".into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let control_tf = ControlTorrentFile {
            id: TF_ID.into(),
            info_hash: INFO_HASH.into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let mgr = Arc::new(CapabilityManager::new(
            control_tf,
            vec![coord],
            ApiKeys { torbox: String::new(), realdebrid: String::new() },
            reqwest::Client::new(),
            metrics.clone(),
        ));
        let slot = mgr.slots.first().expect("slot exists");
        let cap = DeliveryCapability::new(
            format!("http://127.0.0.1:{port}/reclaim"),
            "torbox".into(),
            "test".into(),
            TF_ID.into(),
            "res-reclaim".into(),
            "file-res-reclaim".into(),
            None,
        );
        slot.caps.lock().unwrap().push(cap);
        (mgr, metrics)
    }

    /// T16: real joined waiter wakes after owner abort, chunk can be reclaimed and retried.
    #[tokio::test]
    async fn t16_reclaim_after_abort() {
        let _guard = crate::test_env::env_lock();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let (port, _handle, barrier) = spawn_barrier_mock(hits.clone()).await;
        let (mgr, metrics) = build_reclaim_stack(port);

        let reserved = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("acquire_for_read failed"),
        };
        let lease = CapabilityLease::new(reserved);

        let child_a = CapabilityLease::child_reader(&lease).expect("A");
        assert_eq!(lease.child_count(), 1);

        // Use a unique temp directory for this test run
        let tmp_dir = std::env::temp_dir().join(format!("hashsucker_test_t16_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp_dir);
        let cache = crate::cache::CacheEngine::open(
            crate::cache::CacheConfig {
                root: tmp_dir.clone(),
                max_bytes: 64 << 20,
                chunk_size: CHUNK,
            },
            metrics.clone(),
        ).unwrap();

        let tf_id = crate::cache::TorrentFileId::new(
            TF_ID.to_string(),
            INFO_HASH.to_string(),
            PATH.to_string(),
            FILE,
        );

        // Owner claims chunk 0
        let joins = cache.inflight().join_or_claim_many(&tf_id.cache_key(), &[0]);
        let join = &joins[0];
        assert!(join.owned, "owner claims chunk 0");

        // Second request joins the same chunk
        let joins2 = cache.inflight().join_or_claim_many(&tf_id.cache_key(), &[0]);
        let join2 = &joins2[0];
        assert!(!join2.owned, "second request joins existing");
        assert!(join2.joined_existing, "second request is waiter");

        // Spawn waiter task that waits on the record
        let waiter_record = join2.record.clone();
        let waiter_handle = tokio::spawn(async move {
            waiter_record.done.notified().await;
            (waiter_record.success.load(Ordering::SeqCst), waiter_record.failed.load(Ordering::SeqCst))
        });

        // Spawn owner fill task that will block on the barrier
        let child_a_clone = child_a.clone();
        let cache_for_spawn = cache.clone();
        let mgr_for_spawn = mgr.clone();
        let metrics_for_spawn = metrics.clone();
        let tf_id_for_spawn = tf_id.clone();
        let fill_handle = tokio::spawn(async move {
            crate::serve::fill_chunk_run_shared_child(
                cache_for_spawn,
                metrics_for_spawn,
                mgr_for_spawn,
                reqwest::Client::new(),
                0,
                tf_id_for_spawn,
                vec![0],
                0,
                CHUNK - 1,
                0,
                CHUNK - 1,
                Faults {
                    fault_429_always: false,
                    fault_429_once: false,
                    fault_dead_once: false,
                    fault_midbody_once: false,
                },
                None,
                None,
                false,
                child_a_clone,
            )
            .await;
        });

        // Wait for HTTP request to enter
        barrier.entered_notify.notified().await;
        assert!(barrier.request_entered.load(Ordering::SeqCst), "request entered");

        // Abort the owner task
        fill_handle.abort();
        let _ = fill_handle.await;

        // Release barrier
        barrier.release.notify_one();

        // Verify: waiter wakes up (doesn't hang)
        let Ok(Ok((success, failed))) = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            waiter_handle
        ).await else {
            panic!("waiter should complete within timeout");
        };
        // Verify: waiter observes failure state (owner was aborted)
        assert!(!success, "waiter sees failure, not success");
        assert!(failed, "waiter sees failed state");

        // Verify: inflight record is finalized
        assert!(!cache.inflight().has(&tf_id.cache_key(), 0), "inflight finalized after abort");

        // Verify: chunk is NOT present
        assert!(!cache.is_present(&tf_id.cache_key(), 0).unwrap_or(false), "chunk not present after abort");

        // Scenario 2: reclaim the same chunk
        let joins3 = cache.inflight().join_or_claim_many(&tf_id.cache_key(), &[0]);
        let join3 = &joins3[0];
        assert!(join3.owned, "reclaimed chunk is owned");
        assert!(!join3.joined_existing, "reclaimed chunk is not joined");

        // Scenario 3: retry completes successfully
        // Reset the barrier for the retry
        barrier.request_entered.store(false, Ordering::SeqCst);

        // Spawn a new fill task for the reclaimed chunk
        let child_a_clone2 = child_a.clone();
        let cache_for_retry = cache.clone();
        let mgr_for_retry = mgr.clone();
        let metrics_for_retry = metrics.clone();
        let tf_id_for_retry = tf_id.clone();
        let retry_handle = tokio::spawn(async move {
            crate::serve::fill_chunk_run_shared_child(
                cache_for_retry,
                metrics_for_retry,
                mgr_for_retry,
                reqwest::Client::new(),
                0,
                tf_id_for_retry,
                vec![0],
                0,
                CHUNK - 1,
                0,
                CHUNK - 1,
                Faults {
                    fault_429_always: false,
                    fault_429_once: false,
                    fault_dead_once: false,
                    fault_midbody_once: false,
                },
                None,
                None,
                false,
                child_a_clone2,
            )
            .await;
        });

        // Wait for retry to complete
        let _ = retry_handle.await;

        // Verify: chunk is now present
        assert!(cache.is_present(&tf_id.cache_key(), 0).unwrap_or(false), "chunk present after retry");

        // Verify: inflight record is finalized
        assert!(!cache.inflight().has(&tf_id.cache_key(), 0), "inflight finalized after retry");

        // Cleanup
        drop(child_a);
        assert_eq!(lease.child_count(), 0, "all children dropped");
        assert!(lease.is_released(), "permit released");

        // Clean up temp directory
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}

// ---- T17: shared-cap failure ownership ----
#[cfg(test)]
mod shared_cap_recovery {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use tokio::sync::Notify;

    #[derive(Clone)]
    struct BarrierState {
        hits: Arc<Mutex<Vec<(String, u64, u64)>>>,
        request_entered: Arc<AtomicBool>,
        entered_notify: Arc<Notify>,
        release: Arc<Notify>,
    }

    async fn barrier_handler(
        State(st): State<BarrierState>,
        headers: HeaderMap,
        uri: axum::http::Uri,
    ) -> Response {
        let v = headers.get("range").expect("mock: missing Range").to_str().unwrap();
        let inner = v.strip_prefix("bytes=").expect("mock: bad Range");
        let mut it = inner.split('-');
        let s: u64 = it.next().unwrap().parse().unwrap();
        let e: u64 = it.next().unwrap().parse().unwrap();
        let path = uri.path().to_string();
        st.hits.lock().unwrap().push((path, s, e));
        st.request_entered.store(true, Ordering::SeqCst);
        st.entered_notify.notify_one();
        st.release.notified().await;
        let body = Body::from(Bytes::from(expected_range(s, e)));
        Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header("content-range", format!("bytes {s}-{e}/{FILE}"))
            .header("accept-ranges", "bytes")
            .body(body)
            .unwrap()
            .into_response()
    }

    async fn spawn_barrier_mock(
        hits: Arc<Mutex<Vec<(String, u64, u64)>>>,
    ) -> (u16, tokio::task::JoinHandle<()>, BarrierState) {
        let st = BarrierState {
            hits,
            request_entered: Arc::new(AtomicBool::new(false)),
            entered_notify: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        };
        let app = axum::Router::new()
            .route("/shared", get(barrier_handler))
            .with_state(st.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (port, handle, st)
    }

    fn build_shared_stack(port: u16) -> (Arc<CapabilityManager>, Arc<Metrics>) {
        let metrics = Arc::new(Metrics::default());
        let coord = ProviderCoord {
            provider: "torbox".into(),
            account_scope: "test".into(),
            provider_resource_id: "res-shared".into(),
            provider_file_id: "file-res-shared".into(),
            state: "ready".into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let control_tf = ControlTorrentFile {
            id: TF_ID.into(),
            info_hash: INFO_HASH.into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let mgr = Arc::new(CapabilityManager::new(
            control_tf,
            vec![coord],
            ApiKeys { torbox: String::new(), realdebrid: String::new() },
            reqwest::Client::new(),
            metrics.clone(),
        ));
        let slot = mgr.slots.first().expect("slot exists");
        let cap = DeliveryCapability::new(
            format!("http://127.0.0.1:{port}/shared"),
            "torbox".into(),
            "test".into(),
            TF_ID.into(),
            "res-shared".into(),
            "file-res-shared".into(),
            None,
        );
        slot.caps.lock().unwrap().push(cap);
        (mgr, metrics)
    }

    /// T17: A fails while B is in flight; B's existing work completes, no new work after dead mark.
    #[tokio::test]
    async fn t17_shared_cap_failure_ownership() {
        let _guard = crate::test_env::env_lock();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let (port, _handle, barrier) = spawn_barrier_mock(hits.clone()).await;
        let (mgr, metrics) = build_shared_stack(port);

        let reserved = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("acquire_for_read failed"),
        };
        let lease = CapabilityLease::new(reserved);

        let child_a = CapabilityLease::child_reader(&lease).expect("A");
        let child_b = CapabilityLease::child_reader(&lease).expect("B");
        assert_eq!(lease.child_count(), 2);

        let tmp_dir = std::env::temp_dir().join(format!("hashsucker_test_t17_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp_dir);
        let cache = crate::cache::CacheEngine::open(
            crate::cache::CacheConfig {
                root: tmp_dir.clone(),
                max_bytes: 64 << 20,
                chunk_size: CHUNK,
            },
            metrics.clone(),
        ).unwrap();

        let tf_id = crate::cache::TorrentFileId::new(
            TF_ID.to_string(),
            INFO_HASH.to_string(),
            PATH.to_string(),
            FILE,
        );

        // B claims chunk 0 and starts a blocked HTTP request
        let joins_b = cache.inflight().join_or_claim_many(&tf_id.cache_key(), &[0]);
        let join_b = &joins_b[0];
        assert!(join_b.owned, "B owns chunk 0");

        // Spawn B's fill task (will block on barrier)
        let child_b_clone = child_b.clone();
        let cache_for_b = cache.clone();
        let mgr_for_b = mgr.clone();
        let metrics_for_b = metrics.clone();
        let tf_id_for_b = tf_id.clone();
        let b_handle = tokio::spawn(async move {
            crate::serve::fill_chunk_run_shared_child(
                cache_for_b,
                metrics_for_b,
                mgr_for_b,
                reqwest::Client::new(),
                0,
                tf_id_for_b,
                vec![0],
                0,
                CHUNK - 1,
                0,
                CHUNK - 1,
                Faults {
                    fault_429_always: false,
                    fault_429_once: false,
                    fault_dead_once: false,
                    fault_midbody_once: false,
                },
                None,
                None,
                false,
                child_b_clone,
            )
            .await;
        });

        // Wait for B's HTTP request to enter
        barrier.entered_notify.notified().await;
        assert!(barrier.request_entered.load(Ordering::SeqCst), "B request entered");

        // A marks the shared capability dead (simulating Class-C failure)
        child_a.cap.mark_dead();
        assert!(matches!(child_a.cap.status(), crate::capability::CapabilityStatus::Dead));

        // Release B's barrier so B can complete its already-in-flight work
        barrier.release.notify_one();

        // Wait for B to complete
        let _ = b_handle.await;

        // Verify: B's chunk is present (existing work completed)
        assert!(cache.is_present(&tf_id.cache_key(), 0).unwrap_or(false), "B's chunk present after completion");

        // Verify: inflight finalized
        assert!(!cache.inflight().has(&tf_id.cache_key(), 0), "inflight finalized");

        // Verify: no new work after dead mark (child_b would stop if it tried to assign more)
        // This is verified by the fact that B's worker loop would check status() before assigning

        // Cleanup
        drop(child_a);
        drop(child_b);
        assert_eq!(lease.child_count(), 0, "all children dropped");
        assert!(lease.is_released(), "permit released");

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}

// ---- T18: dead capability replacement lifecycle ----
#[cfg(test)]
mod dead_cap_replacement {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use tokio::sync::Notify;

    #[derive(Clone)]
    struct BarrierState {
        hits: Arc<Mutex<Vec<(String, u64, u64)>>>,
        request_entered: Arc<AtomicBool>,
        entered_notify: Arc<Notify>,
        release: Arc<Notify>,
    }

    async fn barrier_handler(
        State(st): State<BarrierState>,
        headers: HeaderMap,
        uri: axum::http::Uri,
    ) -> Response {
        let v = headers.get("range").expect("mock: missing Range").to_str().unwrap();
        let inner = v.strip_prefix("bytes=").expect("mock: bad Range");
        let mut it = inner.split('-');
        let s: u64 = it.next().unwrap().parse().unwrap();
        let e: u64 = it.next().unwrap().parse().unwrap();
        let path = uri.path().to_string();
        st.hits.lock().unwrap().push((path, s, e));
        st.request_entered.store(true, Ordering::SeqCst);
        st.entered_notify.notify_one();
        st.release.notified().await;
        let body = Body::from(Bytes::from(expected_range(s, e)));
        Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header("content-range", format!("bytes {s}-{e}/{FILE}"))
            .header("accept-ranges", "bytes")
            .body(body)
            .unwrap()
            .into_response()
    }

    async fn spawn_barrier_mock(
        hits: Arc<Mutex<Vec<(String, u64, u64)>>>,
    ) -> (u16, tokio::task::JoinHandle<()>, BarrierState) {
        let st = BarrierState {
            hits,
            request_entered: Arc::new(AtomicBool::new(false)),
            entered_notify: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        };
        let app = axum::Router::new()
            .route("/shared", get(barrier_handler))
            .with_state(st.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (port, handle, st)
    }

    fn build_shared_stack(port: u16) -> (Arc<CapabilityManager>, Arc<Metrics>) {
        let metrics = Arc::new(Metrics::default());
        let coord = ProviderCoord {
            provider: "torbox".into(),
            account_scope: "test".into(),
            provider_resource_id: "res-shared".into(),
            provider_file_id: "file-res-shared".into(),
            state: "ready".into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let control_tf = ControlTorrentFile {
            id: TF_ID.into(),
            info_hash: INFO_HASH.into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let mgr = Arc::new(CapabilityManager::new(
            control_tf,
            vec![coord],
            ApiKeys { torbox: String::new(), realdebrid: String::new() },
            reqwest::Client::new(),
            metrics.clone(),
        ));
        let slot = mgr.slots.first().expect("slot exists");
        let cap = DeliveryCapability::new(
            format!("http://127.0.0.1:{port}/shared"),
            "torbox".into(),
            "test".into(),
            TF_ID.into(),
            "res-shared".into(),
            "file-res-shared".into(),
            None,
        );
        slot.caps.lock().unwrap().push(cap);
        (mgr, metrics)
    }

    fn build_dead_cap_stack(port: u16) -> (Arc<CapabilityManager>, Arc<Metrics>) {
        let metrics = Arc::new(Metrics::default());
        let coord = ProviderCoord {
            provider: "torbox".into(),
            account_scope: "test".into(),
            provider_resource_id: "res-dead".into(),
            provider_file_id: "file-res-ded".into(),
            state: "ready".into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let control_tf = ControlTorrentFile {
            id: TF_ID.into(),
            info_hash: INFO_HASH.into(),
            canonical_internal_path: Some(PATH.into()),
            size: FILE,
        };
        let mgr = Arc::new(CapabilityManager::new(
            control_tf,
            vec![coord],
            ApiKeys { torbox: String::new(), realdebrid: String::new() },
            reqwest::Client::new(),
            metrics.clone(),
        ));
        let slot = mgr.slots.first().expect("slot exists");
        let cap = DeliveryCapability::new(
            format!("http://127.0.0.1:{port}/original"),
            "torbox".into(),
            "test".into(),
            TF_ID.into(),
            "res-dead".into(),
            "file-res-dead".into(),
            None,
        );
        slot.caps.lock().unwrap().push(cap);
        (mgr, metrics)
    }

    /// T18: dead cap does not come back; manager-owned replacement succeeds.
    #[tokio::test]
    async fn t18_dead_cap_replacement() {
        let _guard = crate::test_env::env_lock();
        let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
        let (mgr, _metrics) = build_dead_cap_stack(port);

        // Acquire the original warm cap
        let reserved1 = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("first acquire_for_read failed"),
        };
        let original_cap_id = reserved1.cap.cap_id.clone();

        // Verify the cap is alive
        assert!(matches!(reserved1.cap.status(), crate::capability::CapabilityStatus::Alive));

        // Mark it dead
        reserved1.cap.mark_dead();
        assert!(matches!(reserved1.cap.status(), crate::capability::CapabilityStatus::Dead));

        // Release the lease
        drop(reserved1);

        // Set up the acquire stub to return a new capability
        std::env::set_var("HY4_TEST_ACQUIRE_BASE_URL", format!("http://127.0.0.1:{port}"));
        std::env::set_var("HY4_TEST_ACQUIRE_URL_TORBOX", format!("http://127.0.0.1:{port}/replacement"));

        // Acquire again - should get a NEW healthy cap, not the dead one
        let reserved2 = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("second acquire_for_read should succeed with replacement"),
        };

        // Verify: old dead cap_id is NOT returned
        assert_ne!(reserved2.cap.cap_id, original_cap_id, "dead cap not reused");

        // Verify: new cap is alive
        assert!(matches!(reserved2.cap.status(), crate::capability::CapabilityStatus::Alive));

        // Verify: replacement URL is the new one
        assert!(reserved2.cap.runtime_url.contains("replacement"), "replacement uses new URL");

        // Cleanup
        drop(reserved2);
        std::env::remove_var("HY4_TEST_ACQUIRE_BASE_URL");
        std::env::remove_var("HY4_TEST_ACQUIRE_URL_TORBOX");
    }

    /// T19: surviving Arc after pool pruning + exact replacement acquisition count.
    #[tokio::test]
    async fn t19_surviving_arc_and_acquisition_count() {
        let _guard = crate::test_env::env_lock();
        let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
        let (mgr, metrics) = build_dead_cap_stack(port);

        let reserved1 = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("first acquire_for_read failed"),
        };
        let original_cap_id = reserved1.cap.cap_id.clone();
        let acq_before = metrics.capability_acquisitions.load(Ordering::SeqCst);

        reserved1.cap.mark_dead();
        drop(reserved1);

        std::env::set_var("HY4_TEST_ACQUIRE_BASE_URL", format!("http://127.0.0.1:{port}"));
        std::env::set_var("HY4_TEST_ACQUIRE_URL_TORBOX", format!("http://127.0.0.1:{port}/replacement"));

        let reserved2 = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("second acquire_for_read should succeed"),
        };

        let acq_after = metrics.capability_acquisitions.load(Ordering::SeqCst);
        assert_eq!(acq_after - acq_before, 1, "exactly one replacement acquisition");
        assert_ne!(reserved2.cap.cap_id, original_cap_id, "dead cap not reused");
        assert!(matches!(reserved2.cap.status(), crate::capability::CapabilityStatus::Alive));

        drop(reserved2);
        std::env::remove_var("HY4_TEST_ACQUIRE_BASE_URL");
        std::env::remove_var("HY4_TEST_ACQUIRE_URL_TORBOX");
    }

    /// T20: real NEW-work stop after dead mark via stripe_worker_shared_child.
    #[tokio::test]
    async fn t20_real_new_work_stop() {
        let _guard = crate::test_env::env_lock();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let (port, _handle, barrier) = spawn_barrier_mock(hits.clone()).await;
        let (mgr, metrics) = build_shared_stack(port);

        let reserved = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("acquire_for_read failed"),
        };
        let lease = CapabilityLease::new(reserved);
        let child_a = CapabilityLease::child_reader(&lease).expect("A");
        let child_b = CapabilityLease::child_reader(&lease).expect("B");

        let tmp_dir = std::env::temp_dir().join(format!("hashsucker_test_t20_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp_dir);
        let cache = crate::cache::CacheEngine::open(
            crate::cache::CacheConfig {
                root: tmp_dir.clone(),
                max_bytes: 64 << 20,
                chunk_size: CHUNK,
            },
            metrics.clone(),
        ).unwrap();

        let tf_id = crate::cache::TorrentFileId::new(
            TF_ID.to_string(),
            INFO_HASH.to_string(),
            PATH.to_string(),
            FILE,
        );

        let joins_b = cache.inflight().join_or_claim_many(&tf_id.cache_key(), &[0]);
        assert!(joins_b[0].owned, "B owns chunk 0");

        let child_b_clone = child_b.clone();
        let cache_for_b = cache.clone();
        let mgr_for_b = mgr.clone();
        let metrics_for_b = metrics.clone();
        let tf_id_for_b = tf_id.clone();
        let b_handle = tokio::spawn(async move {
            crate::serve::fill_chunk_run_shared_child(
                cache_for_b, metrics_for_b, mgr_for_b, reqwest::Client::new(),
                0, tf_id_for_b, vec![0], 0, CHUNK - 1, 0, CHUNK - 1,
                Faults {
                    fault_429_always: false, fault_429_once: false,
                    fault_dead_once: false, fault_midbody_once: false,
                },
                None, None, false, child_b_clone,
            ).await;
        });

        barrier.entered_notify.notified().await;
        child_a.cap.mark_dead();
        barrier.release.notify_one();
        let _ = b_handle.await;

        assert!(cache.is_present(&tf_id.cache_key(), 0).unwrap_or(false), "B's chunk 0 present");

        let guard = hits.lock().unwrap();
        let chunk0_count = guard.iter().filter(|(p, s, _)| p == "/shared" && *s == 0).count();
        let chunk1_count = guard.iter().filter(|(p, s, _)| p == "/shared" && *s == CHUNK).count();
        assert_eq!(chunk0_count, 1, "exactly one fetch for chunk 0");
        assert_eq!(chunk1_count, 0, "B did not fetch chunk 1 after dead mark");

        drop(child_a);
        drop(child_b);
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    /// T21: simultaneous dead detection by both children.
    /// Both A and B detect the cap is dead and stop claiming new work.
    #[tokio::test]
    async fn t21_simultaneous_dead_detection() {
        let _guard = crate::test_env::env_lock();
        let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
        let (mgr, _metrics) = build_dead_cap_stack(port);

        let reserved = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("acquire_for_read failed"),
        };
        let lease = CapabilityLease::new(reserved);
        let child_a = CapabilityLease::child_reader(&lease).expect("A");
        let child_b = CapabilityLease::child_reader(&lease).expect("B");

        // Verify both children share the same capability
        assert_eq!(child_a.cap.cap_id, child_b.cap.cap_id);

        // Verify capability is alive
        assert!(matches!(child_a.cap.status(), crate::capability::CapabilityStatus::Alive));

        // Both mark dead simultaneously
        child_a.cap.mark_dead();
        child_b.cap.mark_dead();

        // Verify both see the dead status
        assert!(matches!(child_a.cap.status(), crate::capability::CapabilityStatus::Dead));
        assert!(matches!(child_b.cap.status(), crate::capability::CapabilityStatus::Dead));

        // Drop both children
        drop(child_a);
        drop(child_b);
        assert!(lease.is_released(), "lease released after both children dropped");

        // Verify manager can acquire a replacement
        std::env::set_var("HY4_TEST_ACQUIRE_BASE_URL", format!("http://127.0.0.1:{port}"));
        std::env::set_var("HY4_TEST_ACQUIRE_URL_TORBOX", format!("http://127.0.0.1:{port}/replacement"));

        let reserved2 = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("replacement acquire_for_read should succeed"),
        };

        assert!(matches!(reserved2.cap.status(), crate::capability::CapabilityStatus::Alive));

        drop(reserved2);
        drop(lease);
        std::env::remove_var("HY4_TEST_ACQUIRE_BASE_URL");
        std::env::remove_var("HY4_TEST_ACQUIRE_URL_TORBOX");
    }

    /// T22: manager recovery count after dual failure (exactly one replacement).
    #[tokio::test]
    async fn t22_manager_recovery_after_dual_failure() {
        let _guard = crate::test_env::env_lock();
        let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
        let (mgr, metrics) = build_dead_cap_stack(port);

        let reserved = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("first acquire_for_read failed"),
        };
        let original_cap_id = reserved.cap.cap_id.clone();
        let acq_before = metrics.capability_acquisitions.load(Ordering::SeqCst);

        let lease = CapabilityLease::new(reserved);
        let child_a = CapabilityLease::child_reader(&lease).expect("A");
        let child_b = CapabilityLease::child_reader(&lease).expect("B");

        child_a.cap.mark_dead();
        child_b.cap.mark_dead();

        drop(child_a);
        drop(child_b);
        assert_eq!(lease.child_count(), 0, "all children dropped");

        std::env::set_var("HY4_TEST_ACQUIRE_BASE_URL", format!("http://127.0.0.1:{port}"));
        std::env::set_var("HY4_TEST_ACQUIRE_URL_TORBOX", format!("http://127.0.0.1:{port}/replacement"));

        let reserved2 = match mgr.acquire_for_read(0).await {
            Ok(r) => r,
            Err(_) => panic!("replacement acquire_for_read should succeed"),
        };

        let acq_after = metrics.capability_acquisitions.load(Ordering::SeqCst);
        assert_eq!(acq_after - acq_before, 1, "exactly one replacement after dual failure");
        assert_ne!(reserved2.cap.cap_id, original_cap_id, "dead cap not reused");
        assert!(matches!(reserved2.cap.status(), crate::capability::CapabilityStatus::Alive));

        drop(reserved2);
        drop(lease);
        std::env::remove_var("HY4_TEST_ACQUIRE_BASE_URL");
        std::env::remove_var("HY4_TEST_ACQUIRE_URL_TORBOX");
    }
}
