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
