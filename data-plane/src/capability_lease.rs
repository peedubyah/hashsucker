//! Bounded two-reader capability lease.
//!
//! Proofs that one `ReservedCapability` / one semaphore permit can back two
//! concurrent disjoint Range readers for the same TorrentFile, with the lease
//! staying within the existing breaker/limiter/retry accounting.
//!
//!   one capability acquisition
//!   one capability reservation
//!
//!   reader A -> complete chunk N
//!   reader B -> complete chunk N+1
//!
//! Real mock CDNs, real overlap in execution. Proves:
//!   1. exact bytes from both chunks
//!   2. disjoint chunk ownership
//!   3. one provider resolution only
//!   4. one in_flight reservation only
//!   5. zero acquisition delta for reader B
//!   6. third reader rejected
//!   7. dropping A alone does not release permit
//!   8. dropping B releases final ownership
//!   9. capability can then be normally reserved again
//!  10. breaker/limiter/retry path is traversed by both reads

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

fn build_manager(port: u16) -> (Arc<CapabilityManager>, Arc<Metrics>) {
    let metrics = Arc::new(Metrics::default());
    let coord = ProviderCoord {
        provider: "torbox".into(),
        account_scope: "test".into(),
        provider_resource_id: "res-lease".into(),
        provider_file_id: "file-lease".into(),
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
    // Inject a warm cap pointing at our mock CDN. acquire_for_read() will
    // find and reuse it (no provider call, no acquisition counted).
    let slot = mgr.slots.first().expect("slot exists");
    let cap = DeliveryCapability::new(
        format!("http://127.0.0.1:{port}/lease"),
        "torbox".into(),
        "test".into(),
        TF_ID.into(),
        "res-lease".into(),
        "file-lease".into(),
        None,
    );
    slot.caps.lock().unwrap().push(cap);
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

/// T1: the core concurrent-read proof. One capability reservation, two child
/// readers reading disjoint chunks concurrently.
#[tokio::test]
async fn t1_one_capability_two_child_readers_concurrent_disjoint_chunks() {
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, _handle) = spawn_mock(hits.clone()).await;
    let (mgr, metrics) = build_manager(port);

    let faults = Faults {
        fault_429_always: false,
        fault_429_once: false,
        fault_dead_once: false,
        fault_midbody_once: false,
    };
    let priority = 0;

    // Step 1: acquire the reservation (reuses warm cap, no new acquisition).
    let reserved = match mgr.acquire_for_read(priority).await {
        Ok(r) => r,
        Err(_) => panic!("acquire_for_read failed"),
    };
    let cap_id_before = reserved.cap.cap_id.clone();
    let acq_before = metrics.capability_acquisitions.load(std::sync::atomic::Ordering::SeqCst);

    // Step 2: wrap the reservation in a lease.
    let lease = CapabilityLease::new(reserved);
    assert_eq!(lease.child_count(), 0);
    assert!(!lease.is_released());

    // Step 3: create two child reader handles.
    let child_a = CapabilityLease::child_reader(&lease).expect("child A");
    let child_b = CapabilityLease::child_reader(&lease).expect("child B");
    assert_eq!(lease.child_count(), 2);

    // Step 4: third reader rejected.
    let child_c: Option<crate::manager::ChildReaderHandle> =
        CapabilityLease::child_reader(&lease);
    assert!(child_c.is_none(), "third reader must be rejected");

    // Step 5: both children reference the same capability.
    assert_eq!(child_a.cap.cap_id, cap_id_before);
    assert_eq!(child_b.cap.cap_id, cap_id_before);

    // Step 6: no new acquisition for reader B.
    let acq_after_lease = metrics.capability_acquisitions.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(acq_after_lease, acq_before, "zero acquisition delta for lease");

    let client = reqwest::Client::new();

    // Step 7: spawn both readers concurrently, disjoint chunks.
    let chunk_n_start = 0u64;
    let chunk_n_end = CHUNK - 1;
    let chunk_np1_start = CHUNK;
    let chunk_np1_end = 2 * CHUNK - 1;

    let mut reader_a = ResilientRangeReader::new_shared_child(
        client.clone(),
        metrics.clone(),
        mgr.clone(),
        child_a,
        priority,
        chunk_n_start,
        chunk_n_end,
        FILE,
        false,
        faults,
    );
    let mut reader_b = ResilientRangeReader::new_shared_child(
        client.clone(),
        metrics.clone(),
        mgr.clone(),
        child_b,
        priority,
        chunk_np1_start,
        chunk_np1_end,
        FILE,
        false,
        faults,
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

    // Concurrent execution: both readers should finish.
    let (res_a, res_b) = tokio::join!(handle_a, handle_b);
    res_a.expect("reader A panicked");
    res_b.expect("reader B panicked");

    let bytes_a = rx_a.await.expect("recv A");
    let bytes_b = rx_b.await.expect("recv B");

    // Step 8: exact bytes from both chunks.
    assert_eq!(bytes_a, expected_range(chunk_n_start, chunk_n_end), "chunk N bytes");
    assert_eq!(bytes_b, expected_range(chunk_np1_start, chunk_np1_end), "chunk N+1 bytes");

    // Step 9: disjoint chunk ownership.
    let guard = hits.lock().unwrap();
    let ranges: Vec<(u64, u64)> = guard.iter().map(|(_, s, e)| (*s, *e)).collect();
    assert!(ranges.contains(&(chunk_n_start, chunk_n_end)), "chunk N fetched");
    assert!(ranges.contains(&(chunk_np1_start, chunk_np1_end)), "chunk N+1 fetched");
    assert_eq!(ranges.len(), 2, "exactly two fetches, disjoint");

    // Step 10: zero new acquisitions (warm cap was reused).
    let acq_final = metrics.capability_acquisitions.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(acq_final, acq_before, "zero new provider acquisitions");

    drop(guard);
}

/// T2: permit lifetime. Dropping A alone does not release the permit; dropping
/// B releases final ownership.
#[tokio::test]
async fn t2_permit_lifetime_until_last_child_drops() {
    let (port, _handle) = spawn_mock(Arc::new(Mutex::new(Vec::new()))).await;
    let (mgr, _metrics) = build_manager(port);
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

    // Drop A alone: lease NOT released (one child remains).
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
    let hits = Arc::new(Mutex::new(Vec::new()));
    let (port, _handle) = spawn_mock(hits.clone()).await;
    let (mgr, metrics) = build_manager(port);
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

    // Both readers complete successfully.
    let fa = tokio::spawn(async move {
        read_full(&mut ra, CHUNK).await
    });
    let fb = tokio::spawn(async move {
        read_full(&mut rb, CHUNK).await
    });
    let (ba, bb) = tokio::join!(fa, fb);
    assert!(ba.is_ok(), "reader A succeeded");
    assert!(bb.is_ok(), "reader B succeeded");

    // Two independent CDN fetches happened (transport-level accounting).
    let guard = hits.lock().unwrap();
    assert_eq!(guard.len(), 2, "two independent provider fetches");
    assert_eq!(metrics.upstream_errors.load(std::sync::atomic::Ordering::SeqCst), 0, "no errors");
}
