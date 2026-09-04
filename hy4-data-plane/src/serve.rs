// Sliced from frankenstein/rust-data-plane/src/main.rs at commit ef5f33c,
// in P3 step 1. This file is the PROVEN serving core of the lab process,
// parameterized for per-request identity. No semantic change from the lab
// version is intended in this copy; the only differences are:
//
//   1. The lab's own `mod capability; ... mod transport;` block at the top
//      of the file is gone (those are declared `pub mod` in lib.rs).
//   2. The lab's `#[tokio::main] async fn main()` bootstrap is gone. The
//      new main.rs owns startup; this file is just the route handlers and
//      their helpers.
//   3. `AppState`, the request handlers, and a handful of helpers are now
//      `pub(crate)` so the new main.rs can call them.
//   4. Nothing else. The Slice 4.5 T0..T5 stage clock, the fixed-grid
//      chunk cache, the per-chunk single-flight coalescer, the
//      manager/slot/breaker/limiter, the ResilientRangeReader, the
//      metrics waterfalled over a single serde_json literal -- all
//      unchanged.
//
// `state.tf_id` and `state.authoritative_size` are still per-AppState,
// not per-call: the new main.rs constructs a fresh AppState PER REQUEST
// so that get_file sees the S-1-projected identity for that one tfId
// without any process-global. The cache keys and the capability
// single-flight keys are both already strongly keyed by TorrentFileId
// and (provider, account_scope, tf_id, resource_id, file_id) respectively
// -- this is recorded in docs/hy4/HY4-PHASE1-CLASSIFICATION.md step 3.
//
// Scope note: the lab main.rs was a binary crate root, so `cache::X` and
// `manager::X` resolved to its own `mod` declarations. In the new layout
// serve.rs is a library submodule, so we import the module paths
// explicitly with `use crate::cache;` / `use crate::manager;` so the
// bare `cache::` / `manager::` references in the body resolve to the
// same code they resolved to in the lab. The body itself is unchanged.
//
// Visibility note: get_file, metrics_handler, AppState, SpanMsg, and
// SUPPORTED_SCHEMA_VERSION are `pub` (not `pub(crate)`) because the new
// main.rs lives in a sibling binary crate, and `pub(crate)` would not
// be visible there. The donor main.rs kept these private; that was
// fine because donor main.rs WAS the entry point.

use crate::cache;
use crate::manager;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::Response,
};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::cache::{CacheEngine, ChunkPlan, RunKind, TorrentFileId};
use crate::metrics::{CacheDecision, Metrics, StageClock, StageReport};
use crate::transport::{Faults, OpenError, ResilientRangeReader, Step};

pub const SUPPORTED_SCHEMA_VERSION: u64 = 1;

/// Bytes of one chunk-fill span, forwarded from the fetch task to the client
/// emitter. The emitter consumes spans in ascending chunk order, so the client
/// still sees one ordered byte stream even when several spans fill concurrently.
pub enum SpanMsg {
    Chunk(bytes::Bytes),
    Eof,
    Failed,
}

#[derive(Clone)]
pub struct AppState {
    pub authoritative_size: u64,
    /// S-1 host-assigned TorrentFile id. Used for routing, logging, and the
    /// `pool` summary. NOT used for cache keying (see P3 final identity check).
    pub tf_id: String,
    /// Current host DB row id from S-1 (`torrentFile.id`, `torrent_files.id`
    /// PK). RETAINED for logging and forensics. NOT used for cache keying:
    /// the PK is a SQLite surrogate that can change when the same logical
    /// TorrentFile is reconstructed. The cache key is the deterministic
    /// `(info_hash, canonical_path, size)` tuple, computed by
    /// `TorrentFileId::new()`. See docs/hy4/CROSS-FILE-KEYING-AUDIT.md
    /// (P3 final identity check, conclusion B).
    pub tf_id_durable: String,
    /// S-1-projected BitTorrent info_hash (40-char hex). Carried for
    /// logging, magnet-link formatting, and capability fields. NOT the
    /// cache key.
    pub info_hash: String,
    pub canonical_path: String,
    pub client: reqwest::Client,
    pub metrics: Arc<Metrics>,
    pub manager: Arc<manager::CapabilityManager>,
    /// Optional Slice 4 cache engine. None when SLICE4_CACHE=0 is set (cold-proxy mode).
    pub cache: Option<Arc<CacheEngine>>,
}

// ---- range parsing (unchanged from Slice 2) ---------------------------------
pub fn parse_range(hdr: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let hdr = match hdr {
        Some(h) => h,
        None => return Ok(None),
    };
    if hdr.contains(',') {
        return Err(());
    }
    let h = hdr.trim();
    let lower = h.to_ascii_lowercase();
    let spec = lower.strip_prefix("bytes=").ok_or(())?;
    if spec.is_empty() || spec.starts_with('-') {
        return Err(());
    }
    let mut parts = spec.splitn(2, '-');
    let start: u64 = parts.next().ok_or(())?.parse().map_err(|_| ())?;
    let end = match parts.next() {
        Some("") | None => size.saturating_sub(1),
        Some(e) => e.parse().map_err(|_| ())?,
    };
    if start > end || start >= size || end >= size {
        return Err(());
    }
    Ok(Some((start, end)))
}

pub fn range_not_satisfiable(size: u64) -> Response<Body> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{size}"))
        .body(Body::empty())
        .unwrap()
}

pub fn bad_gateway(msg: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Body::from(format!("delivery failure: {msg}")))
        .unwrap()
}

pub fn rate_limited_response(ra: Option<Duration>) -> Response<Body> {
    let mut b = Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(header::CONTENT_TYPE, "text/plain");
    if let Some(d) = ra {
        b = b.header(header::RETRY_AFTER, d.as_secs().to_string());
    }
    b.body(Body::from(
        "delivery rate-limited: honor Retry-After; TorrentFile not poisoned",
    ))
    .unwrap()
}

pub fn delivery_error(e: manager::DeliveryError, m: &Metrics) -> Response<Body> {
    match e {
        manager::DeliveryError::AllSameTfFailed { last, retry_after } => {
            let mut b = Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .header(header::CONTENT_TYPE, "text/plain");
            if let Some(d) = retry_after {
                b = b.header(header::RETRY_AFTER, d.as_secs().to_string());
            }
            b.body(Body::from(format!(
                "AllSameTfDeliveryFailed: every Node-supplied provider for this TorrentFile is exhausted; no recovery in flight. last={last:?}"
            )))
            .unwrap()
        }
    }
}

pub async fn get_file(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response<Body> {
    // ---- Slice 4.5 T0: the read request is received. Every later stage is
    // measured relative to this instant. Stamped at handler entry, before range
    // parsing, so T0 is not quietly redefined to mean "after we did some work".
    let t0 = Instant::now();
    let size = state.authoritative_size;
    let range_hdr = headers.get(header::RANGE).and_then(|v| v.to_str().ok());

    let (start, end) = match parse_range(range_hdr, size) {
        Ok(Some((s, e))) => (s, e),
        Ok(None) => (0, size.saturating_sub(1)),
        Err(()) => return range_not_satisfiable(size),
    };

    // Shared stage clock for this request. T1/T2 are stamped here; T3/T4 are
    // stamped inside the transport, where the CDN request is actually dispatched
    // and the first body byte actually arrives.
    let stage = StageClock::new(t0);
    // Per-request provider-activity deltas. These are what let the benchmark tell
    // "the capability was reused" apart from "we paid for a fresh requestdl" —
    // the entire distinction between process-warm and process-cold.
    let api_before = state.metrics.api_requests.load(Ordering::SeqCst);
    let cdn_before = state.metrics.cdn_requests.load(Ordering::SeqCst);
    // Slice 4.5 F: the left-hand side of the byte-accounting identity. Counted
    // once per request at plan time, so bytes_local + bytes_upstream has a
    // denominator to be reconciled against.
    state
        .metrics
        .cache
        .bytes_requested_total
        .fetch_add(end - start + 1, Ordering::SeqCst);

    // RD_SINGLE_BYTE_WORKAROUND (Slice 3 §19): RD/TorBox CDNs stall on a single-byte
    // range (bytes=N-N). Request two upstream bytes and hand the client back exactly
    // the one byte it asked for. Keeps a standards-valid single-byte request working
    // without ever stalling the upstream.
    let is_single = start == end;
    let upstream_end = if is_single {
        (start + 1).min(size.saturating_sub(1))
    } else {
        end
    };
    let client_content_len: u64 = if is_single { 1 } else { end - start + 1 };

    // Stage timing (observational only, §15): when did acquire + first open happen?
    let cold = state.metrics.requests.load(Ordering::SeqCst) == 0;
    state.metrics.record_request(); // count every client GET (incl. ones that later 503)
    let open_start = Instant::now();

    // ---- Slice 4.75 plan (fixed-grid, cache-aware) ----
    // Compute the chunk plan only if the cache is enabled AND the request is not
    // a 1-byte single (the single-byte workaround bypasses the cache entirely,
    // exactly as it did in Slice 4.5).
    //
    // `plan == None` below therefore means "no cache", and is handled by the
    // upstream-only path — same contract as Slice 4.5.
    let plan: Option<ChunkPlan> = if !is_single {
        if let Some(cache) = state.cache.as_ref() {
            let tf_id = TorrentFileId::new(
                // Retained for logging/forensics; the cache key is
                // (info_hash, canonical_path, size) computed by
                // TorrentFileId::new. See docs/hy4/CROSS-FILE-KEYING-AUDIT.md
                // (P3 final identity check, conclusion B).
                state.tf_id_durable.clone(),
                state.info_hash.clone(),
                state.canonical_path.clone(),
                size,
            );
            match cache.plan_chunks(&tf_id, start, end) {
                Ok(p) => Some(p),
                Err(e) => {
                    eprintln!("[rust-proxy] cache plan failed: {e}; falling back to upstream");
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    // Priority for capability acquisition.
    let priority = headers
        .get("x-read-priority")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u8>().ok())
        .unwrap_or(1);

    // TEST-ONLY fault gates (default OFF). Validation scaffold only — never set in production.
    let faults = Faults {
        fault_429_always: std::env::var("SLICE3_FAULT_UPSTREAM_429")
            .map(|v| v == "1")
            .unwrap_or(false),
        fault_429_once: std::env::var("SLICE35_FAULT_CDN_429_ONCE")
            .map(|v| v == "1")
            .unwrap_or(false),
        fault_dead_once: std::env::var("SLICE35_FAULT_CDN_DEAD")
            .map(|v| v == "1")
            .unwrap_or(false),
        fault_midbody_once: std::env::var("SLICE35_FAULT_MIDBODY")
            .map(|v| v == "1")
            .unwrap_or(false),
    };

    let (tx, rx) = mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(8);
    let metrics = state.metrics.clone();
    let cache_clone = state.cache.clone();
    let tf_id_clone = state.tf_id.clone();
    let tf_id_durable_clone = state.tf_id_durable.clone();
    let canonical_clone = state.canonical_path.clone();
    let manager_clone = state.manager.clone();
    let client_clone = state.client.clone();

    tokio::spawn(async move {
        // 1-byte single: legacy path through ResilientRangeReader only.
        //
        // Slice 4.5 A.1 NOTE — this is the ONE path that does not enter the
        // in-flight coalescer. It is the RD_SINGLE_BYTE_WORKAROUND (Slice 3 §19):
        // the client asked for bytes=N-N, but we must fetch TWO upstream bytes
        // because RD/TorBox CDNs stall on a single-byte range, and we hand the
        // client back exactly the one byte it asked for. The upstream interval
        // [N, N+1] therefore does not correspond to any client-visible cache
        // extent, so there is no cache state to coalesce — this path never
        // writes to the cache. It still goes through the SAME Slice 3 scheduler
        // (`manager.acquire_for_read`), so A.4 is not affected.
        if is_single {
            let _ = serve_upstream_only(
                tx.clone(),
                metrics.clone(),
                manager_clone.clone(),
                client_clone.clone(),
                priority,
                start,
                upstream_end,
                size,
                true,
                faults,
                None,
                Some(stage.clone()),
            )
            .await;
            metrics.record_stage_report(StageReport {
                instants: stage.snapshot(),
                request: (start, end),
                cache_hit: false,
                api_requests_delta: metrics.api_requests.load(Ordering::SeqCst) - api_before,
                cdn_requests_delta: metrics.cdn_requests.load(Ordering::SeqCst) - cdn_before,
            });
            return;
        }

        // ---- Slice 4.75: fixed-grid, span-driven stream ----
        //
        // The plan tiles the client window EXACTLY. Each run is either Local
        // (already durable — pread it) or Fetch (nothing durable — fetch whole
        // chunks, stage every complete chunk, and stream the window as bytes
        // arrive).
        let plan = match plan {
            Some(p) => p,
            None => {
                // No cache. (A 1-byte single returned above.) Stream upstream
                // directly with no staging — identical to the Slice 4.5
                // no-cache fallback.
                let ok = serve_upstream_only(
                    tx.clone(),
                    metrics.clone(),
                    manager_clone.clone(),
                    client_clone.clone(),
                    priority,
                    start,
                    upstream_end,
                    size,
                    false,
                    faults,
                    None,
                    Some(stage.clone()),
                )
                .await;
                if !ok {
                    return;
                }
                metrics.record_stage_report(StageReport {
                    instants: stage.snapshot(),
                    request: (start, end),
                    cache_hit: false,
                    api_requests_delta: metrics.api_requests.load(Ordering::SeqCst) - api_before,
                    cdn_requests_delta: metrics.cdn_requests.load(Ordering::SeqCst) - cdn_before,
                });
                return;
            }
        };

        let tf_id = TorrentFileId::new(
            // tf_id_durable is the current host PK; the cache key is
            // (info_hash, canonical_path, size), computed by ::new().
            // The run-loop previously shadowed this with the URL label;
            // that is fixed (see P3 correction). See P3 final identity
            // check for the durable_key contract.
            tf_id_durable_clone.clone(),
            tf_id_clone.clone(),
            canonical_clone.clone(),
            size,
        );
        // `plan` is Some only when a cache engine exists.
        let cache = match cache_clone.as_ref() {
            Some(c) => c.clone(),
            None => return,
        };
        let key = tf_id.cache_key();
        let grid = plan.grid;
        let runs = plan.runs();

        // ---- Slice 4.5 A.1/A.2: prove every gap enters the SAME coalescer.
        //
        // `plan_origin` is decided from the plan, not from the request: a
        // request is a partial hit iff any of its segments is already durable.
        let plan_origin = if plan.segments.iter().any(|s| s.present) {
            "partial_hit"
        } else {
            "full_miss"
        };

        let mut first_byte = true;
        for run in &runs {
            match run.kind {
                RunKind::Local => {
                    let bytes = match cache.pread(&tf_id, run.start, run.end) {
                        Ok(b) => b,
                        Err(e) => {
                            eprintln!("[rust-proxy] cache pread failed: {e}");
                            return;
                        }
                    };
                    if first_byte {
                        first_byte = false;
                        // ---- Slice 4.5 T5: first byte handed to the client.
                        // On a local hit this is the only byte source, so
                        // T1..T4 never happen and stay null (never 0).
                        stage.set_t5(Instant::now());
                        metrics.record_first_byte(open_start.elapsed().as_millis() as u64);
                    }
                    if tx.send(Ok(bytes::Bytes::from(bytes))).await.is_err() {
                        metrics.client_cancellations.fetch_add(1, Ordering::SeqCst);
                        return;
                    }
                }
                RunKind::Fetch => {
                    let indices = plan.run_indices(run);
                    if indices.is_empty() {
                        continue;
                    }

                    // ---- Per-chunk single-flight ----
                    //
                    // The whole batch is claimed under ONE lock acquisition.
                    // Claiming indices one at a time is a deadlock: reader A
                    // could own chunk 10 while reader B owns 11 and 12 of the
                    // same run, and each would then wait for the other to drive
                    // the piece it does not own.
                    let joins = cache.inflight().join_or_claim_many(&key, &indices);

                    cache
                        .metrics
                        .cache
                        .coalescer_entries
                        .fetch_add(1, Ordering::SeqCst);
                    if plan_origin == "partial_hit" {
                        cache
                            .metrics
                            .cache
                            .gap_join_partial_hit
                            .fetch_add(1, Ordering::SeqCst);
                    } else {
                        cache.metrics.cache.gap_join_full_miss.fetch_add(1, Ordering::SeqCst);
                    }
                    for j in &joins {
                        if j.joined_existing {
                            // Another reader is already filling this chunk. The
                            // bytes avoided are the chunk's expected length —
                            // what we would have fetched naively.
                            cache.metrics.cache.inflight_joins.fetch_add(1, Ordering::SeqCst);
                            cache.metrics.cache.chunk_join_waits.fetch_add(1, Ordering::SeqCst);
                            cache
                                .metrics
                                .cache
                                .overlap_bytes_avoided
                                .fetch_add(grid.chunk_len(j.index), Ordering::SeqCst);
                        } else {
                            cache.metrics.cache.chunk_claims.fetch_add(1, Ordering::SeqCst);
                        }
                    }

                    // ---- Group consecutive OWNED chunks into fetch spans ----
                    //
                    // The chunk is the unit of DURABLE truth, not necessarily of
                    // NETWORK I/O: adjacent missing chunks collapse into ONE
                    // provider Range and are split back into chunks on arrival.
                    let present_before: Vec<(u64, u64)> = plan.segments[run.seg_from..run.seg_to]
                        .iter()
                        .filter(|s| s.present)
                        .map(|s| (s.start, s.end))
                        .collect();
                    let mut items: Vec<FetchItem> = Vec::new();
                    let mut i = 0usize;
                    while i < indices.len() {
                        if joins[i].owned {
                            let mut j = i;
                            while j + 1 < indices.len() && joins[j + 1].owned {
                                j += 1;
                            }
                            let sub: Vec<u64> = indices[i..=j].to_vec();
                            let f_start = grid.chunk_start(sub[0]);
                            let f_end = match grid.chunk_end(*sub.last().unwrap()) {
                                Some(e) => e,
                                None => {
                                    i = j + 1;
                                    continue;
                                }
                            };
                            let w_start = run.start.max(f_start);
                            let w_end = run.end.min(f_end);

                            // ---- Slice 4.5 G: record WHY this fetch happens,
                            // including the grid's effect on the Range we issue.
                            cache.metrics.cache_decisions.push(CacheDecision {
                                request: (start, end),
                                present_before: present_before.clone(),
                                missing: (w_start, w_end),
                                chunk_indices: sub.clone(),
                                fetch_span: Some((f_start, f_end)),
                                joined_inflight: joins[i..=j].iter().any(|x| x.joined_existing),
                                overlap_bytes_avoided: joins[i..=j]
                                    .iter()
                                    .filter(|x| x.joined_existing)
                                    .map(|x| grid.chunk_len(x.index))
                                    .sum(),
                                plan_origin,
                                evictions_before: cache.metrics.cache.evictions.load(Ordering::SeqCst),
                            });

                            let (stx, srx) = mpsc::channel::<SpanMsg>(32);
                            // Fill CONCURRENTLY with the other spans in this run.
                            // Sequential driving would deadlock whenever a run
                            // is split between two readers (see above).
                            tokio::spawn(fill_chunk_run(
                                cache.clone(),
                                metrics.clone(),
                                manager_clone.clone(),
                                client_clone.clone(),
                                priority,
                                tf_id.clone(),
                                sub,
                                f_start,
                                f_end,
                                w_start,
                                w_end,
                                faults,
                                Some(stx),
                                Some(stage.clone()),
                                cold,
                            ));
                            items.push(FetchItem::Owned { rx: srx });
                            i = j + 1;
                        } else {
                            items.push(FetchItem::Waiter {
                                index: indices[i],
                                record: joins[i].record.clone(),
                            });
                            i += 1;
                        }
                    }

                    // ---- Consume in ascending chunk order ----
                    //
                    // Each Owned span's channel delivers bytes in ascending
                    // offset order, and spans are consumed in index order, so
                    // the client sees ONE ordered byte stream even though the
                    // fills run concurrently.
                    for item in items {
                        match item {
                            FetchItem::Owned { mut rx } => loop {
                                match rx.recv().await {
                                    Some(SpanMsg::Chunk(b)) => {
                                        if first_byte {
                                            first_byte = false;
                                            // ---- Slice 4.5 T5: first byte handed
                                            // to the client. Streamed straight
                                            // through from the provider, so
                                            // whole-chunk fetching does NOT add a
                                            // wait-for-the-whole-chunk penalty to
                                            // first-byte latency.
                                            stage.set_t5(Instant::now());
                                            metrics.record_first_byte(
                                                open_start.elapsed().as_millis() as u64,
                                            );
                                        }
                                        if tx.send(Ok(b)).await.is_err() {
                                            metrics
                                                .client_cancellations
                                                .fetch_add(1, Ordering::SeqCst);
                                            return;
                                        }
                                    }
                                    Some(SpanMsg::Eof) => break,
                                    Some(SpanMsg::Failed) | None => return,
                                }
                            },
                            FetchItem::Waiter { index, record } => {
                                // `notify_waiters()` stores NO permit, so a
                                // `notified().await` registered after the
                                // notification was delivered blocks forever.
                                // Check the flags BEFORE awaiting.
                                let finished = record.success.load(Ordering::SeqCst)
                                    || record.failed.load(Ordering::SeqCst);
                                if !finished {
                                    record.done.notified().await;
                                }
                                if record.failed.load(Ordering::SeqCst) {
                                    return;
                                }
                                // The chunk is PRESENT and durable now; read just
                                // the part of it this request needs.
                                let cs = grid.chunk_start(index);
                                let ce = match grid.chunk_end(index) {
                                    Some(e) => e,
                                    None => return,
                                };
                                let s = run.start.max(cs);
                                let e = run.end.min(ce);
                                let bytes = match cache.pread(&tf_id, s, e) {
                                    Ok(b) => b,
                                    Err(err) => {
                                        eprintln!(
                                            "[rust-proxy] cache pread failed on joined chunk {index}: {err}"
                                        );
                                        return;
                                    }
                                };
                                if first_byte {
                                    first_byte = false;
                                    stage.set_t5(Instant::now());
                                    metrics.record_first_byte(
                                        open_start.elapsed().as_millis() as u64,
                                    );
                                }
                                if tx.send(Ok(bytes::Bytes::from(bytes))).await.is_err() {
                                    metrics.client_cancellations.fetch_add(1, Ordering::SeqCst);
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        }

        // ---- Slice 4.5: publish this request's stage waterfall.
        //
        // `cache_hit` is decided from the plan, not from whether bytes were
        // ultimately read from disk: on a partial hit the durable segments ARE
        // read locally, so "came from disk" would wrongly report nearly every
        // request as a hit. Every segment durable is the real definition, and it
        // is exactly "zero provider work".
        let cache_hit = plan.is_full_hit();
        metrics.record_stage_report(StageReport {
            instants: stage.snapshot(),
            request: (start, end),
            cache_hit,
            api_requests_delta: metrics.api_requests.load(Ordering::SeqCst) - api_before,
            cdn_requests_delta: metrics.cdn_requests.load(Ordering::SeqCst) - cdn_before,
        });
    });

    let body = Body::from_stream(ReceiverStream::new(rx));
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{size}"),
        )
        .header(header::CONTENT_LENGTH, client_content_len.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .body(body)
        .unwrap()
}

/// One item of a fetch run, in ascending chunk order.
enum FetchItem {
    /// A span of consecutive chunks WE own. Its bytes arrive on this channel in
    /// ascending offset order while the fill is still in progress.
    Owned {
        rx: mpsc::Receiver<SpanMsg>,
    },
    /// A chunk another reader is already filling. Wait for its record, then read
    /// the durable chunk locally.
    Waiter {
        index: u64,
        record: Arc<cache::ChunkInFlightRecord>,
    },
}

/// Fetch ONE span of consecutive chunks, stage every complete chunk durably, and
/// forward the client-window portion of the span to `sink`.
///
/// `f_start..=f_end` is the PROVIDER Range (whole chunks, possibly wider than the
/// client needs). `w_start..=w_end` is the part of it the client actually asked
/// for. The difference is intentional overfetch and is charged to
/// `chunk_overfetch_bytes`; it is NEVER delivered to the client.
///
/// Every fetch still goes through `manager.acquire_for_read` -> the Slice 3
/// limiter/breaker/capability path -> `ResilientRangeReader`, unchanged from
/// Slice 4.5. The cache may reshape DEMAND (which bytes, how wide a Range); it
/// never opens a second concurrency domain.
#[allow(clippy::too_many_arguments)]
/// The sub-slice of a fetch buffer `[cs, cs+n)` that falls inside the client
/// window `[w_start, w_end]`, as `(offset_within_buffer, length)`. `None` when
/// there is no overlap.
///
/// Extracted as a pure function purely so it can be unit-tested. The first
/// version of this arithmetic was written inline and computed the LENGTH from
/// `cs` instead of from `os`:
///
///     let a = (os - cs);          // start offset inside the buffer
///     let z = (oe - cs + 1);      // end offset, NOT a length
///     b.slice(a..a + z)           // overruns whenever os > cs
///
/// That is only wrong when the buffer straddles the window start, which is
/// exactly any non-chunk-aligned first byte — so it passed a chunk-aligned
/// smoke test and panicked on the first unaligned read. `a + z <= n` holds by
/// construction here (`oe <= ce`).
pub fn window_slice(cs: u64, n: u64, w_start: u64, w_end: u64) -> Option<(usize, usize)> {
    if n == 0 {
        return None;
    }
    let ce = cs + n - 1;
    let os = cs.max(w_start);
    let oe = ce.min(w_end);
    if os > oe {
        return None;
    }
    let a = (os - cs) as usize;
    let z = (oe - os + 1) as usize;
    Some((a, z))
}

pub async fn fill_chunk_run(
    cache: Arc<CacheEngine>,
    metrics: Arc<Metrics>,
    manager: Arc<manager::CapabilityManager>,
    client: reqwest::Client,
    priority: u8,
    tf: TorrentFileId,
    indices: Vec<u64>,
    f_start: u64,
    f_end: u64,
    w_start: u64,
    w_end: u64,
    faults: Faults,
    sink: Option<mpsc::Sender<SpanMsg>>,
    stage: Option<StageClock>,
    cold: bool,
) {
    let key = tf.cache_key();

    // ---- Byte accounting, counted ONCE at issue --------------------------
    //
    // `bytes_upstream` answers "how much demand did we place on the provider",
    // so a retry must not inflate it. `bytes_fetched_upstream` (measured in the
    // chunk callback) is what actually arrived, so the difference between them
    // is retry/recovery duplication — reported separately from overfetch.
    let span_bytes = f_end - f_start + 1;
    let window_bytes = w_end.saturating_sub(w_start).saturating_add(1);
    metrics
        .cache
        .bytes_upstream
        .fetch_add(span_bytes, Ordering::SeqCst);
    metrics
        .cache
        .bytes_upstream_issued
        .fetch_add(span_bytes, Ordering::SeqCst);
    metrics.cache.fetch_spans.fetch_add(1, Ordering::SeqCst);
    metrics
        .cache
        .spans_collapsed_chunks
        .fetch_add(indices.len() as u64, Ordering::SeqCst);
    if span_bytes > window_bytes {
        // The deliberate price of whole-chunk durable truth: bytes we fetched
        // because the chunk grid is coarser than the request, not because
        // anything asked for them.
        metrics
            .cache
            .chunk_overfetch_bytes
            .fetch_add(span_bytes - window_bytes, Ordering::SeqCst);
    }

    let records = cache.inflight().records_for(&key, &indices);

    // Resolve EVERY owned record, successful or not. Abandoning a fill without
    // this deadlocks every reader waiting on the chunk: their `notified().await`
    // would never be woken.
    let mark = |ok: bool, published: &[u64]| {
        for idx in &indices {
            let rec = match records.iter().find(|r| r.chunk_index == *idx) {
                Some(r) => r,
                None => continue,
            };
            if ok && published.contains(idx) {
                rec.success.store(true, Ordering::SeqCst);
            } else {
                rec.failed.store(true, Ordering::SeqCst);
                metrics.cache.chunk_fills_failed.fetch_add(1, Ordering::SeqCst);
            }
            cache.inflight().finalize(&key, *idx);
            rec.done.notify_waiters();
        }
    };

    let stager = match cache.begin_stage(tf.clone()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[rust-proxy] begin_stage failed: {e}");
            mark(false, &[]);
            if let Some(tx) = sink.as_ref() {
                let _ = tx.send(SpanMsg::Failed).await;
            }
            return;
        }
    };

    // The chunk callback stages bytes AND measures delivered volume. It fires
    // for every chunk the resilient reader has COMMITTED to delivering, i.e.
    // after internal recovery, with the authoritative offset — so Slice 3.5
    // retries never double-stage, and transport.rs needs no change for 4.75.
    let cb: Arc<dyn Fn(u64, &[u8]) + Send + Sync> = {
        let st = stager.clone();
        let m = metrics.clone();
        Arc::new(move |offset: u64, data: &[u8]| {
            m.cache
                .bytes_fetched_upstream
                .fetch_add(data.len() as u64, Ordering::SeqCst);
            if let Err(e) = st.stage(offset, data) {
                eprintln!("[rust-proxy] stage failed at {offset}: {e}");
            }
        })
    };

    // ---- Slice 4.5 T1: capability acquisition requested. ----
    // The SAME Slice 3 scheduling entry point the no-cache path uses. That is
    // the whole of the A.4 safety contract: the cache may reshape demand but
    // never opens a second concurrency domain.
    let acquire_start = Instant::now();
    if let Some(s) = stage.as_ref() {
        s.set_t1(acquire_start);
    }
    let reserved = match manager.acquire_for_read(priority).await {
        Ok(r) => r,
        Err(_) => {
            stager.abort();
            mark(false, &[]);
            if let Some(tx) = sink.as_ref() {
                let _ = tx.send(SpanMsg::Failed).await;
            }
            return;
        }
    };
    let acquire_ms = acquire_start.elapsed();
    // ---- Slice 4.5 T2: a DeliveryCapability is ready. ----
    if let Some(s) = stage.as_ref() {
        s.set_t2(Instant::now());
    }
    if cold {
        *metrics.cold_acquire_ms.lock().unwrap() = Some(acquire_ms.as_millis() as u64);
    }

    let mut reader = ResilientRangeReader::new_with_chunk_cb(
        client,
        metrics.clone(),
        manager.clone(),
        reserved,
        priority,
        f_start,
        f_end,
        tf.size,
        false,
        faults,
        Some(cb),
    );
    // Hand the stage clock to the transport so T3/T4 are stamped at the real
    // dispatch / first-body-byte instants.
    if let Some(s) = stage.as_ref() {
        reader.set_stage_clock(s.clone());
    }

    let sub_open = Instant::now();
    if reader.ensure_open().await.is_err() {
        stager.abort();
        mark(false, &[]);
        if let Some(tx) = sink.as_ref() {
            let _ = tx.send(SpanMsg::Failed).await;
        }
        return;
    }
    if cold {
        *metrics.cold_cdn_first_byte_ms.lock().unwrap() =
            Some(sub_open.elapsed().as_millis() as u64);
    }

    let mut ok = true;
    let mut client_gone = false;
    // The resilient reader delivers [f_start, f_end] contiguously and in
    // ascending order, including across internal recovery (a mid-body resume
    // restarts at mid+1, so no byte is delivered twice). Tracking `pos` here
    // therefore gives the authoritative offset of every chunk without the
    // transport having to expose one.
    let mut pos = f_start;
    loop {
        match reader.next_chunk().await {
            Step::Chunk(b) => {
                let n = b.len() as u64;
                if n == 0 {
                    continue;
                }
                let cs = pos;
                let ce = pos + n - 1;
                pos = ce + 1;
                // Forward ONLY the part of this chunk inside the client window.
                // Bytes outside it are still staged — that is the whole point of
                // whole-chunk fetching — but they are never DELIVERED. The chunk
                // grid may make us fetch more than was asked for; it must never
                // make us return more.
                if !client_gone {
                    if let Some((a, z)) = window_slice(cs, n, w_start, w_end) {
                        if let Some(tx) = sink.as_ref() {
                            // Defensive: `window_slice` guarantees `a + z <= n`,
                            // but a transport that ever handed back more bytes
                            // than it announced must not take the process down.
                            let z = z.min(b.len().saturating_sub(a));
                            if tx.send(SpanMsg::Chunk(b.slice(a..a + z))).await.is_err() {
                                // Client hung up. Keep filling: the chunk is
                                // still worth having, and waiters depend on
                                // these records being resolved.
                                client_gone = true;
                                metrics.client_cancellations.fetch_add(1, Ordering::SeqCst);
                            }
                        }
                    }
                }
            }
            Step::Eof => break,
            Step::Terminal(_) => {
                ok = false;
                metrics.client_truncated.fetch_add(1, Ordering::SeqCst);
                break;
            }
        }
    }

    // ---- Publication ----
    //
    // `finish()` promotes the trailing chunk if it is complete; earlier chunks
    // were promoted the moment their staged length reached the grid's expected
    // length. `abort()` discards any incomplete staging file, so a failed read
    // can never leave a partial chunk advertised as PRESENT.
    let published = if ok {
        let p = stager.finish();
        // Budget is enforced AT REST: candidates are PRESENT chunks only, and a
        // chunk with a live fill is skipped. Our own just-published chunks are
        // still in the in-flight map here, so they cannot evict themselves.
        let _ = cache.maybe_evict();
        p
    } else {
        stager.abort();
        Vec::new()
    };
    mark(ok, &published);
    if let Some(tx) = sink.as_ref() {
        let _ = tx.send(if ok { SpanMsg::Eof } else { SpanMsg::Failed }).await;
    }
}

/// Legacy upstream-only serve (used by the 1-byte single path and the no-cache fallback).
/// Returns true on clean EOF, false on terminal failure.
pub async fn serve_upstream_only(
    tx: tokio::sync::mpsc::Sender<Result<bytes::Bytes, std::io::Error>>,
    metrics: Arc<Metrics>,
    manager: Arc<manager::CapabilityManager>,
    client: reqwest::Client,
    priority: u8,
    start: u64,
    upstream_end: u64,
    size: u64,
    is_single: bool,
    faults: Faults,
    on_chunk: Option<Arc<dyn Fn(u64, &[u8]) + Send + Sync>>,
    stage: Option<StageClock>,
) -> bool {
    let acquire_start = Instant::now();
    // Slice 4.5 T1 — capability acquisition requested, through the same Slice 3
    // scheduler the cache path uses.
    if let Some(s) = stage.as_ref() {
        s.set_t1(acquire_start);
    }
    let reserved = match manager.acquire_for_read(priority).await {
        Ok(r) => r,
        Err(_) => return false,
    };
    let acquire_ms = acquire_start.elapsed();
    // Slice 4.5 T2 — capability ready.
    if let Some(s) = stage.as_ref() {
        s.set_t2(Instant::now());
    }
    let cold = metrics.requests.load(Ordering::SeqCst) == 1;
    if cold {
        *metrics.cold_acquire_ms.lock().unwrap() = Some(acquire_ms.as_millis() as u64);
    }
    let mut reader = ResilientRangeReader::new_with_chunk_cb(
        client,
        metrics.clone(),
        manager,
        reserved,
        priority,
        start,
        upstream_end,
        size,
        is_single,
        faults,
        on_chunk,
    );
    // T3/T4 are stamped inside the transport at the real dispatch / first-body-byte
    // instants.
    if let Some(s) = stage.as_ref() {
        reader.set_stage_clock(s.clone());
    }
    let open_start = Instant::now();
    if let Err(e) = reader.ensure_open().await {
        match e {
            OpenError::Client503 => {
                metrics.client_503.fetch_add(1, Ordering::SeqCst);
                metrics.rate_limited.fetch_add(1, Ordering::SeqCst);
            }
            OpenError::Client502 => {
                metrics.client_502.fetch_add(1, Ordering::SeqCst);
            }
            OpenError::Client416 => {
                metrics.client_416.fetch_add(1, Ordering::SeqCst);
            }
        }
        return false;
    }
    if cold {
        *metrics.cold_cdn_first_byte_ms.lock().unwrap() =
            Some(open_start.elapsed().as_millis() as u64);
    }
    let mut first_byte = true;
    loop {
        match reader.next_chunk().await {
            Step::Chunk(b) => {
                if first_byte {
                    first_byte = false;
                    // Slice 4.5 T5 — first byte handed to the client.
                    if let Some(s) = stage.as_ref() {
                        s.set_t5(Instant::now());
                    }
                    metrics.record_first_byte(open_start.elapsed().as_millis() as u64);
                }
                if tx.send(Ok(b)).await.is_err() {
                    metrics.client_cancellations.fetch_add(1, Ordering::SeqCst);
                    return true;
                }
            }
            Step::Eof => return true,
            Step::Terminal(_) => {
                metrics.client_truncated.fetch_add(1, Ordering::SeqCst);
                return false;
            }
        }
    }
}

pub async fn metrics_handler(State(state): State<Arc<AppState>>) -> Response<Body> {
    let m = &state.metrics;
    let pool = state.manager.pool_summary();
    // §8 — average latencies are OBSERVATIONAL only (§12: no TTFB optimization this slice).
    let api_avg = Metrics::avg(
        m.api_latency_ms.load(Ordering::SeqCst),
        m.api_latency_n.load(Ordering::SeqCst),
    );
    let cdn_avg = Metrics::avg(
        m.cdn_latency_ms.load(Ordering::SeqCst),
        m.cdn_latency_n.load(Ordering::SeqCst),
    );
    // Live chunk-state counts: (complete PRESENT chunks, chunks with a live
    // fill). Derived from the chunk map + the in-flight map on demand. The
    // Slice 4 `extents_present` / `extents_filling` atomics were never written,
    // so they read a permanent 0 and made every assertion about published state
    // unfalsifiable — deriving the counts means they cannot drift.
    let (chunks_present, chunks_inflight) = state
        .cache
        .as_ref()
        .map(|c| c.chunk_counts())
        .unwrap_or((0, 0));
    let body = serde_json::json!({
        "authoritative_size": state.authoritative_size,
        "torrent_file_id": state.tf_id,
        "acquisition_mode": m.acquisition_mode.lock().unwrap().clone(),
        // request-facing
        "requests": m.requests.load(Ordering::SeqCst),
        "bytes_streamed": m.bytes_streamed.load(Ordering::SeqCst),
        "client_cancellations": m.client_cancellations.load(Ordering::SeqCst),
        "upstream_errors": m.upstream_errors.load(Ordering::SeqCst),
        // Layer A — requestdl / TorBox API acquisition (the only legitimate provider API call)
        "layer_A_api": {
            "requests": m.api_requests.load(Ordering::SeqCst),
            "2xx": m.api_2xx.load(Ordering::SeqCst),
            "4xx": m.api_4xx.load(Ordering::SeqCst),
            "5xx": m.api_5xx.load(Ordering::SeqCst),
            "429": m.api_429.load(Ordering::SeqCst),
            "redirect_true_used": m.api_redirect_true.load(Ordering::SeqCst),
            "latency_ms_avg": api_avg,
        },
        // Layer B — redirect layer (must be 0 in 3.5: no redirect hop)
        "layer_B_redirect": {
            "hops": m.redirect_hops.load(Ordering::SeqCst),
            "429": m.redirect_429.load(Ordering::SeqCst),
        },
        // Layer C — CDN Range layer (all media bytes land here, directly on the final host)
        "layer_C_cdn": {
            "requests": m.cdn_requests.load(Ordering::SeqCst),
            "2xx": m.cdn_2xx.load(Ordering::SeqCst),
            "206": m.cdn_206.load(Ordering::SeqCst),
            "4xx": m.cdn_4xx.load(Ordering::SeqCst),
            "5xx": m.cdn_5xx.load(Ordering::SeqCst),
            "429": m.cdn_429.load(Ordering::SeqCst),
            "latency_ms_avg": cdn_avg,
            "final_cdn_host": m.final_cdn_host.lock().unwrap().clone(),
        },
        // Capability lifecycle (§3 reuse / §5 reacquire / §7 negative)
        "capability": {
            "acquisitions": m.capability_acquisitions.load(Ordering::SeqCst),
            "reuses": m.capability_reuses.load(Ordering::SeqCst),
            "evictions": m.capability_evictions.load(Ordering::SeqCst),
            "reacquisitions": m.capability_reacquisitions.load(Ordering::SeqCst),
            "negative_hits": m.capability_negative_hits.load(Ordering::SeqCst),
        },
        // §10 — recovery budgets (reported SEPARATELY, never collapsed)
        "recovery": {
            "attempts": m.recovery_attempts.load(Ordering::SeqCst),
            "max_same_cap_retries": m.max_same_cap_retries.load(Ordering::SeqCst),
            "max_reacquires": m.max_reacquires.load(Ordering::SeqCst),
            "wall_ms_total": m.recovery_wall_ms.load(Ordering::SeqCst),
            "internal_recoveries_ok": m.internal_recoveries.load(Ordering::SeqCst),
            "mid_body_resumes": m.mid_body_resumes.load(Ordering::SeqCst),
            "client_503": m.client_503.load(Ordering::SeqCst),
            "client_502": m.client_502.load(Ordering::SeqCst),
            "client_416": m.client_416.load(Ordering::SeqCst),
            "client_truncated": m.client_truncated.load(Ordering::SeqCst),
        },
        // §11 — Retry-After observability (surface BOTH)
        "retry_after": {
            "provider_secs": *m.retry_after_provider_secs.lock().unwrap(),
            "applied_secs": *m.retry_after_applied_secs.lock().unwrap(),
        },
        // rate-limit / failover
        "rate_limited": m.rate_limited.load(Ordering::SeqCst),
        "all_same_tf": m.all_same_tf.load(Ordering::SeqCst),
        "pool_growths": m.pool_growths.load(Ordering::SeqCst),
        // Two kinds of "wait behind the limiter", reported separately. See the
        // field comment in metrics.rs. A bare `limiter_waits: 0` must never be
        // read as "no contention" — check `limiter_permit_waits` too.
        "limiter_waits": m.limiter_waits.load(Ordering::SeqCst),
        "limiter_permit_waits": m.limiter_permit_waits.load(Ordering::SeqCst),
        "breaker_opens": m.breaker_opens.load(Ordering::SeqCst),
        // §15 — shared-limiter vs internal-recovery timing (observational)
        "timing": {
            "limiter_wait_ms_total": m.limiter_wait_ms_total.load(Ordering::SeqCst),
            "internal_recovery_ms_total": m.internal_recovery_ms_total.load(Ordering::SeqCst),
        },
        // Other TorBox APIs (expected 0 — proves they never enter the Range hot path)
        "other_api_calls": {
            "mylist": m.mylist_calls.load(Ordering::SeqCst),
            "checkcached": m.checkcached_calls.load(Ordering::SeqCst),
            "search": m.search_calls.load(Ordering::SeqCst),
        },
        // pool snapshot
        "pool": pool.iter().map(|(k, len, tgt)| serde_json::json!({"slot": k, "caps": len, "target": tgt})).collect::<Vec<_>>(),
        // stage timing (observational only; preserved for a future TTFB waterfall)
        "stage_timing": {
            "cold_ttfb_ms": *m.cold_ttfb_ms.lock().unwrap(),
            "warm_ttfb_ms": *m.warm_ttfb_ms.lock().unwrap(),
            "cold_acquire_ms": *m.cold_acquire_ms.lock().unwrap(),
            "cold_cdn_first_byte_ms": *m.cold_cdn_first_byte_ms.lock().unwrap(),
        },
        // Slice 4 / 4.5 / 4.75 cache metrics
        //
        // chunks_present / chunks_inflight are counted live from the chunk map
        // and the in-flight map, NOT read from CacheMetrics atomics: the Slice 4
        // atomics of the same role were never written, so they reported a
        // permanent 0. See CacheEngine::chunk_counts.
        "cache": {
            "format_version": state.cache.as_ref().map(|_| cache::CACHE_FORMAT_VERSION),
            "chunk_size": state.cache.as_ref().map(|c| c.chunk_size()),
            "full_hits": m.cache.full_hits.load(Ordering::SeqCst),
            "partial_hits": m.cache.partial_hits.load(Ordering::SeqCst),
            "misses": m.cache.misses.load(Ordering::SeqCst),
            "bytes_local": m.cache.bytes_local.load(Ordering::SeqCst),
            "bytes_upstream": m.cache.bytes_upstream.load(Ordering::SeqCst),
            "chunks_present": chunks_present,
            "chunks_inflight": chunks_inflight,
            // Durability cost of the fsync barrier in publish_present, in
            // microseconds. The brief: "Keep any durability cost visible in
            // metrics/waterfall; do not optimize it yet." The counter was
            // being incremented but never surfaced, which made the cost
            // invisible and the requirement unverifiable.
            "durable_sync_us": m.cache.durable_sync_us.load(Ordering::SeqCst),
            "inflight_joins": m.cache.inflight_joins.load(Ordering::SeqCst),
            "overlap_bytes_avoided": m.cache.overlap_bytes_avoided.load(Ordering::SeqCst),
            "evictions": m.cache.evictions.load(Ordering::SeqCst),
            "bytes_evicted": m.cache.bytes_evicted.load(Ordering::SeqCst),
            // LIVE value from the engine, not the CacheMetrics atomic. The
            // atomic was never written and read a permanent 0, which made
            // Slice 4's proof F budget assertion vacuous — it could not fail
            // even if the cache blew past its budget.
            "current_bytes": state.cache.as_ref().map(|c| c.current_bytes()).unwrap_or(0),
            "max_bytes": state.cache.as_ref().map(|c| c.cfg.max_bytes).unwrap_or(0),
            // ---- Slice 4.5: coalescer origin accounting (A.1 / A.2) ----
            "coalescer_entries": m.cache.coalescer_entries.load(Ordering::SeqCst),
            "gap_join_full_miss": m.cache.gap_join_full_miss.load(Ordering::SeqCst),
            "gap_join_partial_hit": m.cache.gap_join_partial_hit.load(Ordering::SeqCst),
            // ---- Slice 4.5 A.3: eviction guard observability ----
            // `evict_skipped_filling` proves the FILLING guard fires;
            // `publish_noop` is always a bug if nonzero (phantom budget bytes).
            "evict_skipped_filling": m.cache.evict_skipped_filling.load(Ordering::SeqCst),
            "publish_noop": m.cache.publish_noop.load(Ordering::SeqCst),
            // ---- Slice 4.5 F: byte-accounting identity LHS ----
            "bytes_requested_total": m.cache.bytes_requested_total.load(Ordering::SeqCst),
            // ---- Slice 4.75: chunk + overfetch accounting ----
            // bytes_upstream / bytes_upstream_issued are provider DEMAND
            // (counted once per fetch span, retries excluded).
            // bytes_fetched_upstream is what actually ARRIVED (measured in the
            // chunk callback), so `bytes_fetched_upstream - bytes_upstream_issued`
            // is retry/recovery duplication, kept distinct from overfetch.
            "bytes_upstream_issued": m.cache.bytes_upstream_issued.load(Ordering::SeqCst),
            "bytes_fetched_upstream": m.cache.bytes_fetched_upstream.load(Ordering::SeqCst),
            // Intentional overfetch: bytes fetched only because the fixed chunk
            // grid is coarser than the request.
            "chunk_overfetch_bytes": m.cache.chunk_overfetch_bytes.load(Ordering::SeqCst),
            "overfetch_ratio": Metrics::ratio(
                m.cache.chunk_overfetch_bytes.load(Ordering::SeqCst),
                m.cache.bytes_requested_total.load(Ordering::SeqCst),
            ),
            "fetch_spans": m.cache.fetch_spans.load(Ordering::SeqCst),
            "spans_collapsed_chunks": m.cache.spans_collapsed_chunks.load(Ordering::SeqCst),
            // >1 means adjacent missing chunks were fetched as ONE provider Range.
            "collapse_ratio": Metrics::ratio(
                m.cache.spans_collapsed_chunks.load(Ordering::SeqCst),
                m.cache.fetch_spans.load(Ordering::SeqCst),
            ),
            "chunk_claims": m.cache.chunk_claims.load(Ordering::SeqCst),
            "chunk_join_waits": m.cache.chunk_join_waits.load(Ordering::SeqCst),
            "chunk_fills": m.cache.chunk_fills.load(Ordering::SeqCst),
            "chunk_fills_failed": m.cache.chunk_fills_failed.load(Ordering::SeqCst),
        },
        // Slice 4.5 G: every upstream fetch decision, with the present coverage
        // the planner actually saw. This is the evidence for "no unexplained
        // warm CDN traffic" — attribution reads these, it does not guess.
        "cache_decisions": state
            .cache
            .as_ref()
            .map(|c| {
                c.metrics
                    .cache_decisions
                    .snapshot()
                    .iter()
                    .map(|d| {
                        serde_json::json!({
                            "request": {"start": d.request.0, "end": d.request.1},
                            "present_before": d.present_before.iter()
                                .map(|(s,e)| serde_json::json!({"start": s, "end": e}))
                                .collect::<Vec<_>>(),
                            "missing": {"start": d.missing.0, "end": d.missing.1},
                            "missing_bytes": d.missing.1 - d.missing.0 + 1,
                            // Slice 4.75: the chunk grid behind this fetch, and
                            // the provider Range actually issued. `fetch_span`
                            // is wider than `missing` whenever whole-chunk
                            // fetching overfetches — that difference is the
                            // evidence for the overfetch figure, not an
                            // inference from totals.
                            "chunk_indices": d.chunk_indices,
                            "fetch_span": d.fetch_span.map(|(s,e)| serde_json::json!({"start": s, "end": e})),
                            "fetch_span_bytes": d.fetch_span.map(|(s,e)| e - s + 1),
                            "overfetch_bytes": d.fetch_span.map(|(s,e)| (e - s + 1).saturating_sub(d.missing.1.saturating_sub(d.missing.0).saturating_add(1))),
                            "joined_inflight": d.joined_inflight,
                            "overlap_bytes_avoided": d.overlap_bytes_avoided,
                            "plan_origin": d.plan_origin,
                            "evictions_before": d.evictions_before,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        // Slice 4.5 C: T0..T5 cold-open decomposition.
        // `stages_last` is the most recent request; `stages_recent` keeps the
        // last 64 so concurrent bursts stay attributable.
        "stages_last": m.stage_last.lock().unwrap().as_ref().map(|r| r.to_json()),
        "stages_recent": m.stage_reports_json(),
    })
    .to_string();
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap()
}

