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
// -- this is recorded in docs/architecture.md.
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
use crate::manager::CapabilityLease;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
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

use crate::cache::{CacheEngine, ChunkGrid, ChunkPlan, RunKind, TorrentFileId};
use crate::capability::{ApiKeys, CapabilityStatus};
use crate::control::fetch_control;
use crate::metrics::{CacheDecision, Metrics, MetricsExt, StageClock, StageReport, WorkClass};
use crate::playback_intel::{PlaybackIntelligence, PrefetchMode};
use crate::throughput::{
    config_from_env as low_throughput_config, LowObservationPolicy, ThroughputEstimator,
};
use crate::transport::{Faults, OpenError, ReaderCapability, ResilientRangeReader, Step};

pub const SUPPORTED_SCHEMA_VERSION: u64 = 1;

/// Request-scoped
/// serving-primary attribution.
///
/// The initially selected upstream provider for ONE /files/:tfId
/// demand's fetch work, snapshotted from the pre-acquire reservation
/// (`first_reserved`) before the 206 commits. Runtime execution metadata
/// only: never byte identity, never cache identity, never durable, and
/// never the delivery URL (which stays private). Production caps carry
/// `cap_id` (not the later HY4 generation), so the fourth header is
/// `x-hashsucker-serving-cap-id`.
///
/// Scope and honesty rules:
/// - Request-scoped: a handler-local Option, no global state. Consecutive
///   demands attribute independently; a later demand never sees an
///   earlier demand's provider.
/// - Emitted only when the demand actually needs a provider. Pure cache
///   hits acquire nothing and carry NO attribution headers (truthful
///   absence, never a guess).
/// - Pins the INITIAL selection. Owned strings snapshotted before the
///   reservation moves into the producer task: later promotion/reacquire
///   cannot rewrite what this demand initially selected.
#[derive(Clone)]
pub struct ServingAttribution {
    pub provider: String,
    pub provider_resource_id: String,
    pub provider_file_id: String,
    pub cap_id: String,
}

impl ServingAttribution {
    pub const HDR_PROVIDER: &'static str = "x-hashsucker-serving-provider";
    pub const HDR_RESOURCE_ID: &'static str = "x-hashsucker-serving-resource-id";
    pub const HDR_FILE_ID: &'static str = "x-hashsucker-serving-file-id";
    pub const HDR_CAP_ID: &'static str = "x-hashsucker-serving-cap-id";

    /// Snapshot the initially selected capability's execution identity.
    /// Owned strings: later promotion/reacquire cannot mutate this.
    pub fn from_reserved(r: &manager::ReservedCapability) -> Self {
        Self {
            provider: r.cap.provider.clone(),
            provider_resource_id: r.cap.provider_resource_id.clone(),
            provider_file_id: r.cap.provider_file_id.clone(),
            cap_id: r.cap.cap_id.clone(),
        }
    }

    /// Header pairs for the 206 response. Empty when the demand needs no
    /// provider (pure cache hit). Values are validated at apply time.
    pub fn header_pairs_for(opt: Option<&ServingAttribution>) -> Vec<(&'static str, String)> {
        match opt {
            None => Vec::new(),
            Some(a) => vec![
                (Self::HDR_PROVIDER, a.provider.clone()),
                (Self::HDR_RESOURCE_ID, a.provider_resource_id.clone()),
                (Self::HDR_FILE_ID, a.provider_file_id.clone()),
                (Self::HDR_CAP_ID, a.cap_id.clone()),
            ],
        }
    }
}

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
    /// `TorrentFileId::new()`. See docs/CROSS-FILE-KEYING-AUDIT.md
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
    /// P9 playback-intelligence subsystem (sequential detection / bounded prefetch
    /// / seek reprioritization / hot-range observation). Shared per process.
    pub playback: Arc<PlaybackIntelligence>,
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

/// P5 southbound error contract.
///
/// Emits a structured JSON error so the Node VFS can CLASSIFY the failure
/// instead of guessing from a plain-text body:
///   - `PROVIDER_EXHAUSTED`  (502) — every Node-supplied provider for this
///     TorrentFile is exhausted AND no same-TorrentFile recovery is in flight.
///     This is the ONLY fallback-eligible class: Node may switch to the next
///     persisted alternate candidate (different TorrentFile) and re-forward
///     to Rust.
///   - `S1_FETCH_FAILED`      (502) — Rust could not resolve this tfId via the
///     S-1 control plane (unknown / not-found / control unreachable). NOT
///     fallback-eligible: do not blindly try unrelated candidates.
///   - `INTERNAL_ERROR`      (500/502) — transient Rust/infra failure. NOT
///     fallback-eligible and MUST NOT silently fall through to the legacy
///     Node provider byte path.
///
/// The `PROVIDER_EXHAUSTED` code is produced BEFORE any 206 is committed, so
/// the client receives a clean 5xx rather than a truncated 206. See
/// docs/S1-CONTROL-CONTRACT.md (byte error contract). TEST-ONLY fault
/// gates never set this in production.
pub fn data_plane_error(
    status: StatusCode,
    code: &str,
    tf_id: &str,
    retry_after: Option<Duration>,
) -> Response<Body> {
    let mut b = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(d) = retry_after {
        b = b.header(header::RETRY_AFTER, d.as_secs().to_string());
    }
    let body = serde_json::json!({ "error": { "code": code, "torrent_file_id": tf_id } }).to_string();
    b.body(Body::from(body)).unwrap()
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

/// HY4 P2E.1 — the ONE fill/plan TorrentFile identity constructor.
///
/// The cache/coalescing/staging namespace MUST be the durable
/// `(info_hash, canonical_path, size)` tuple. The routing UUID
/// (`tf_id`/`tf_id_durable`, a mutable SQLite surrogate) is forensic-only
/// here: it rides along in `tf_id_durable` but MUST NOT enter the
/// `info_hash` position, or the plan namespace (correct) and the fill
/// namespace diverge and cross-read cache reuse silently dies while
/// coalescing keeps working (deterministic wrongness — the failure mode
/// this helper exists to prevent). Both call sites (plan + fill) go
/// through here so they cannot drift apart again.
pub(crate) fn fill_torrent_file_id(
    tf_id_durable: String,
    info_hash: String,
    canonical_path: String,
    size: u64,
) -> TorrentFileId {
    TorrentFileId::new(tf_id_durable, info_hash, canonical_path, size)
}

/// Two-lane disjoint fill.
/// Experimental, default OFF (`DATA_PLANE_ACTIVE_ACTIVE_TWO_SPAN=1` arms it; deprecated `HY4_ACTIVE_ACTIVE_TWO_SPAN` also accepted).
/// One qualifying missing run of the same exact TorrentFile is fetched
/// concurrently by two already-warm capabilities, each owning a disjoint
/// half of the run. Warm-only: both reservations must be in hand before
/// either lane spawns, and no cold acquisition is ever performed to make
/// the second lane exist. Maximum lanes: 2.
fn striping_armed() -> bool {
    crate::env_canonical("DATA_PLANE_ACTIVE_ACTIVE_TWO_SPAN", "HY4_ACTIVE_ACTIVE_TWO_SPAN")
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// Bounded same-TorrentFile hedge election (first-valid-wins,
/// 
///
/// Experimental, default OFF (`DATA_PLANE_HEDGE_ENABLED=1` arms it; deprecated `HY4_HEDGE_ENABLED` also accepted). The election
/// is duplicate EXECUTION under the fill task's single logical claim: one
/// primary attempt plus at most one hedge attempt, same exact
/// TorrentFile, same exact remaining range. Warm-only: the hedge consumes
/// an already-reserved warm standby, zero acquisition API calls. Trigger
/// and ordering follow the proven source (low-throughput arming + knob +
/// one-per-fill bound); no new hedge policy or threshold is invented here.
fn hedge_enabled() -> bool {
    crate::env_canonical("DATA_PLANE_HEDGE_ENABLED", "HY4_HEDGE_ENABLED")
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// Two-lane work stealing.
///
/// Experimental, default OFF (`DATA_PLANE_ACTIVE_ACTIVE_STEAL=1` arms it, and
/// only together with `DATA_PLANE_ACTIVE_ACTIVE_TWO_SPAN=1`). After the T11
/// split, the two pinned producers share one runtime-only coordinator
/// instead of fixed halves: each lane works its own queue front-to-back,
/// and a lane that exhausts its own queue may steal unstarted chunks from
/// the far end of the other queue, one at a time. Steal gate OFF leaves
/// the fixed two-lane ownership unchanged.
fn stealing_armed() -> bool {
    striping_armed() && steal_flag()
}

/// Bounded two-lane activation policy
/// m3-north-db).
///
/// Experimental, default OFF (`DATA_PLANE_ACTIVE_ACTIVE_AUTO=1`; deprecated `HY4_ACTIVE_ACTIVE_AUTO` also accepted). Decides whether
/// an ordinary missing run uses the existing single-fill path or the
/// proven two-lane scheduler. No new scheduling mechanism.
///
/// Policy inputs only:
/// - number of missing fixed-grid chunks in this fetch span;
/// - whether two distinct warm capabilities for the same exact TF are
///   already available (proven by actually reserving the standby -- the
///   reservation REMAINS the availability check; no pool peek);
/// - whether active-active is enabled (explicit TWO_SPAN or AUTO).
///
/// Experimental minimum-work threshold `DATA_PLANE_ACTIVE_ACTIVE_MIN_CHUNKS` (deprecated `HY4_ACTIVE_ACTIVE_MIN_CHUNKS` also accepted)
/// (proven default 4, test-injectable): runs below it stay single-fill
/// even with two warm caps. No production threshold decision here, and no
/// cold acquisition is ever performed to satisfy the policy.
fn auto_armed() -> bool {
    crate::env_canonical("DATA_PLANE_ACTIVE_ACTIVE_AUTO", "HY4_ACTIVE_ACTIVE_AUTO")
        .map(|v| v == "1")
        .unwrap_or(false)
}

fn auto_min_chunks() -> u64 {
    crate::env_canonical("DATA_PLANE_ACTIVE_ACTIVE_MIN_CHUNKS", "HY4_ACTIVE_ACTIVE_MIN_CHUNKS")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(4)
}

/// AUTO size gate for a fetch span of `n` missing chunks.
fn auto_go(n: usize) -> bool {
    auto_armed() && (n as u64) >= auto_min_chunks()
}

fn steal_flag() -> bool {
    crate::env_canonical("DATA_PLANE_ACTIVE_ACTIVE_STEAL", "HY4_ACTIVE_ACTIVE_STEAL")
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// T22: shared-cap two-reader lease fallback. When AUTO engagement wants two
/// lanes but no distinct warm standby capability exists, the scheduler can
/// use one CapabilityLease over the already-held primary capability instead
/// of falling back to single-fill. Default OFF: existing single-lane
/// fallback is preserved unless explicitly opted in.
pub(crate) fn shared_cap_fallback() -> bool {
    crate::env_canonical("DATA_PLANE_ACTIVE_ACTIVE_SHARED_CAP", "HY4_ACTIVE_ACTIVE_SHARED_CAP")
        .map(|v| v == "1")
        .unwrap_or(false)
}

fn retire_flag() -> bool {
    crate::env_canonical("DATA_PLANE_ACTIVE_ACTIVE_RETIRE_SLOW_LANE", "HY4_ACTIVE_ACTIVE_RETIRE_SLOW_LANE")
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// Coherent runtime entry point: explicit TWO_SPAN (frozen proofs) or AUTO
/// size gate. The T2 reservation still decides warm availability below.
fn stripe_wanted(n: usize) -> bool {
    striping_armed() || auto_go(n)
}

/// Steal variant selector: explicit steal path or AUTO + STEAL flag.
/// AUTO alone without STEAL yields the frozen fixed 50/50 path.
fn steal_wanted(n: usize) -> bool {
    stealing_armed() || (auto_go(n) && steal_flag())
}

/// T13: retire a persistently slow lane.
///
/// Experimental, default OFF (`DATA_PLANE_ACTIVE_ACTIVE_RETIRE_SLOW_LANE=1` arms
/// it, only together with the T12 steal path). When armed, per-worker
/// useful-throughput observations across chunk fills may retire one lane:
/// the retired side gets no new chunks after its active chunk finishes,
/// and the healthy side steals/drains its remaining unstarted queue.
/// Active chunks are never stolen or canceled by retirement. Zero new
/// capability acquisition (both workers keep their pinned warm caps; the
/// retired cap is released on worker exit).
///
/// T14: also arms on the coherent AUTO steal path (explicit steal path OR
/// AUTO + STEAL flag, size already gated at engagement; `observe()` only
/// ever runs on live two-lane workers).
fn retire_armed() -> bool {
    // Frozen explicit path OR coherent AUTO steal path.
    (stealing_armed() || (auto_armed() && steal_flag())) && retire_flag()
}

/// T13: experimental slow-lane ratio threshold (test-injectable).
/// A lane retires only when the sibling's clean useful throughput exceeds
/// `ratio * slow`. No production threshold decision here: unset or
/// unparseable falls back to the proven experimental measurement default,
/// and the whole mechanism stays OFF unless `retire_armed()`.
fn retire_ratio() -> f64 {
    crate::env_canonical("DATA_PLANE_ACTIVE_ACTIVE_RETIRE_RATIO", "HY4_ACTIVE_ACTIVE_RETIRE_RATIO")
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|r| r.is_finite() && *r > 1.0)
        .unwrap_or(4.0)
}

/// T18: replace a retired lane with another already-warm same-TF cap
/// (proven as HY4 P2T on m3-north-db).
///
/// Experimental, default OFF (`DATA_PLANE_ACTIVE_ACTIVE_REPLACE_LANE=1`, and only
/// on the active two-lane steal path). While a two-lane run is active, if
/// lane A or B retires under T13, then after its current active chunk is
/// finished the vacant lane tries EXACTLY ONCE to reserve another warm
/// same-TF capability excluding the survivor's current cap and every
/// retired cap id. On success the same worker task rebinds to the fresh
/// cap and resumes taking unstarted work -- never three concurrent lanes
/// (the retired task continues; nothing new spawns), no cold acquisition,
/// same exact TorrentFile only. This slice handles retirement vacancy
/// only (no terminal-failure vacancy).
fn replace_armed() -> bool {
    retire_armed()
        && crate::env_canonical("DATA_PLANE_ACTIVE_ACTIVE_REPLACE_LANE", "HY4_ACTIVE_ACTIVE_REPLACE_LANE")
            .map(|v| v == "1")
            .unwrap_or(false)
}

/// T12: shutdown guard for steal-path workers. Held by the demand task;
/// dropping it (every early return) stops assignment so workers exit
/// between fills. Permits free on worker/fill drops either way.
struct StripeShutdownGuard(Option<Arc<TwoStripeWork>>);

impl Drop for StripeShutdownGuard {
    fn drop(&mut self) {
        if let Some(c) = self.0.as_ref() {
            c.shutdown();
        }
    }
}

/// T12: which lane a stripe worker belongs to. Only used for steal
/// direction; fetch responsibility is per-chunk either way.
/// `pub(crate)` so the T13 unit proofs can drive the coordinator directly.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum StripeSide {
    A,
    B,
}

/// T12: runtime-only work sharing for one striped run.
///
/// Two unstarted-chunk queues (the T11 ceil/floor halves), one shutdown
/// flag, one fail-fast latch. Never persisted; never touches the durable
/// cache format. The full missing set stays under the demand's single
/// upfront InFlight claim -- this moves only fetch responsibility,
/// atomically, one chunk per decision. A chunk leaves its queue exactly
/// once (Mutex-held pop), so two ordinary producers for one chunk are
/// structurally impossible.
///
/// T13 adds runtime-only retirement state (retired flags, active-chunk
/// tracking, per-lane observation history). Retirement moves no bytes and
/// persists nothing.
/// `pub(crate)` so the T13 unit proofs can drive the coordinator directly.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub(crate) struct ClaimRecord {
    pub(crate) side: StripeSide,
    pub(crate) chunk: u64,
    pub(crate) stolen: bool,
}

pub(crate) struct TwoStripeWork {
    state: std::sync::Mutex<TwoStripeState>,
}

struct TwoStripeState {
    left: VecDeque<u64>,
    right: VecDeque<u64>,
    shutdown: bool,
    continent_failed: bool,
    /// T13: runtime-only retirement. Index 0 = A, 1 = B.
    /// Retirement means the lane is alive but not worth assigning new work.
    retired: [bool; 2],
    /// T19: lane-terminal failure. Index 0 = A, 1 = B. Set when the lane's
    /// fill failed terminally after existing same-lane recovery ran (or
    /// correctly declined a hard error) -- the existing failure path
    /// resolved the active chunk's record, so the lane holds nothing.
    /// Distinct from `retired` (alive-but-slow): both create the same
    /// downstream vacancy shape, but their causes must not be conflated.
    terminal: [bool; 2],
    /// Active chunk per side (chunk idx + assignment instant). Set on
    /// `next()`, cleared on `finish()`. Popped => active => unstealable by
    /// construction, retirement included.
    active: [Option<(u64, Instant)>; 2],
    /// Per-lane useful-throughput history across chunk fills.
    obs: [LaneObs; 2],
    /// T18: lane rebound to a fresh warm cap after vacancy (re-enables
    /// assignment for that side). Index 0 = A, 1 = B.
    replaced: [bool; 2],
    /// T18: one bounded replacement attempt per vacancy event. Set when the
    /// attempt runs (hit or miss); a later independent vacancy on the other
    /// side gets its own attempt.
    replace_tried: [bool; 2],
    /// T18: `cap_id`s of retired lane caps. A retired cap must never be
    /// immediately reselected by a replacement attempt.
    dead_cap_ids: Vec<String>,
    /// Last-known (provider, cap_id) per lane, refreshed on every `next()`
    /// assignment. Sources the dead-cap record at retirement time (the
    /// throughput history may hold no sample for a still-active slow lane).
    lane_cap: [Option<(String, String)>; 2],
    /// T22: test-only claim history. Records each (side, chunk, stolen) triple
    /// from `next()` so shared-cap work-stealing proofs can verify which lane
    /// claimed which chunk and whether it was stolen. Not used by production.
    claims: Vec<ClaimRecord>,
}

/// T13: one lane's cross-fill useful-throughput history.
///
/// One sample per completed chunk fill: useful upstream bytes over
/// monotonic time. Measurement rules:
/// - useful upstream bytes only (chunk body length; headers/retries never enter);
/// - monotonic `Instant` durations;
/// - downstream-contaminated samples are invalid (dropped, never counted);
/// - producer (provider + cap id) change resets history.
#[derive(Clone, Default)]
struct LaneObs {
    provider: Option<String>,
    cap_id: Option<String>,
    /// Clean samples only, oldest first. Each is (bytes, elapsed, bps).
    samples: Vec<(u64, Duration, u64)>,
    /// Latch after a downstream-contaminated drop. Blocks early
    /// active-overrun retirement until a fresh clean epoch rebuilds.
    tainted: bool,
}

impl LaneObs {
    fn avg_bps(&self) -> Option<f64> {
        if self.samples.is_empty() {
            return None;
        }
        // Average of the last two clean samples when present (two
        // independent observations); else the single sample. Using the
        // recent window keeps a transient single dip from retiring.
        let n = self.samples.len().min(2);
        let sum: u128 = self.samples[self.samples.len() - n..]
            .iter()
            .map(|(_, _, b)| *b as u128)
            .sum();
        Some(sum as f64 / n as f64)
    }

    fn avg_duration(&self) -> Option<Duration> {
        if self.samples.is_empty() {
            return None;
        }
        let n = self.samples.len().min(2);
        let sum = self.samples[self.samples.len() - n..]
            .iter()
            .map(|(_, d, _)| d.as_nanos())
            .sum::<u128>()
            / n as u128;
        Some(Duration::from_nanos(sum as u64))
    }
}

fn lane_idx(side: StripeSide) -> usize {
    match side {
        StripeSide::A => 0,
        StripeSide::B => 1,
    }
}

/// T20: why a lane went vacant. Retirement (alive-but-slow, T13) and
/// terminal failure (unusable-after-exhaustion, T19) stay distinct causes;
/// the vacancy mechanics -- mark, dead-cap exclusion, one bounded warm
/// replacement attempt, same-lane rebind -- are shared through
/// `declare_vacancy` + `claim_replacement`. No N-way abstraction: exactly
/// these two causes exist.
#[derive(Clone, Copy, PartialEq, Eq)]
enum VacancyCause {
    Retired,
    Terminal,
}

impl TwoStripeWork {
    /// T20: the single vacancy state transition. Marks the cause
    /// (retirement vs terminal stay distinct flags) and preserves the
    /// dead-cap exclusion feeding the one bounded replacement attempt.
    /// Bit-for-bit the former per-cause blocks in `observe()` /
    /// `finish_terminal()`; callers already hold the lock.
    fn declare_vacancy(
        st: &mut TwoStripeState,
        side: StripeSide,
        cause: VacancyCause,
        dead_cap_id: Option<String>,
    ) {
        let i = lane_idx(side);
        match cause {
            VacancyCause::Retired => {
                st.retired[i] = true;
            }
            VacancyCause::Terminal => {
                st.terminal[i] = true;
            }
        }
        if let Some(g) = dead_cap_id {
            if !st.dead_cap_ids.contains(&g) {
                st.dead_cap_ids.push(g);
            }
        }
    }

    /// A side is vacant when retired or terminal and not yet rebound.
    fn is_vacant(st: &TwoStripeState, idx: usize) -> bool {
        (st.retired[idx] || st.terminal[idx]) && !st.replaced[idx]
    }
}

impl TwoStripeWork {
    /// `pub(crate)` so the T13 unit proofs can construct a coordinator directly.
    pub(crate) fn new(left: Vec<u64>, right: Vec<u64>) -> Self {
        Self {
            state: std::sync::Mutex::new(TwoStripeState {
                left: left.into(),
                right: right.into(),
                shutdown: false,
                continent_failed: false,
                retired: [false, false],
                terminal: [false, false],
                active: [None, None],
                obs: [LaneObs::default(), LaneObs::default()],
                replaced: [false, false],
                replace_tried: [false, false],
                dead_cap_ids: Vec::new(),
                lane_cap: [None, None],
                claims: Vec::new(),
            }),
        }
    }

    /// Next unstarted chunk for `side`, or `None` (own queue empty with
    /// nothing stealable, shutdown, retired, or a sibling chunk already failed).
    /// Steal policy (dumb, deterministic): own front first; else the far
    /// end (back) of the donor queue iff it still holds >= 2 unstarted --
    /// the donor's last unstarted chunk (and always its active chunk, long
    /// popped) stays theirs. One chunk per decision; no prediction.
    /// An already-active chunk is never stealable: it left the deque at
    /// assignment, so a steal can never duplicate an existing producer.
    ///
    /// T13: a retired side gets no new work and does not steal (returns
    /// None even with own queue non-empty; its remaining unstarted queue
    /// stays for the healthy side). A healthy side stealing from a retired
    /// donor may take the donor's last unstarted chunk (>= 1 gate) so the
    /// retired queue fully drains; against a live donor the frozen >= 2
    /// gate holds. Active chunks remain unstealable as today (popped).
    ///
    /// T18: a side rebound by lane replacement (`replaced`) takes work
    /// again exactly like a live lane (frozen >= 2 steal gate against it);
    /// only a still-vacant retired side stays closed and drainable. Gate
    /// OFF behaves exactly like T13 (`replaced` never sets).
    ///
    /// T19: a lane-terminal side (`terminal`) is vacant exactly like a
    /// retired one -- no new work, no stealing, remaining unstarted queue
    /// stealable by the survivor under the same >= 1 gate -- until a
    /// replacement rebinds it. Gate OFF (or plain `finish`) never sets
    /// `terminal`, so frozen failure behavior is untouched.
    /// `pub(crate)` so the unit proofs can drive the coordinator directly.
    pub(crate) fn next(
        &self,
        side: StripeSide,
        provider: &str,
        cap_id: &str,
    ) -> Option<(u64, bool)> {
        let mut st = self.state.lock().unwrap();
        if st.shutdown || st.continent_failed {
            return None;
        }
        let i = lane_idx(side);
        if Self::is_vacant(&st, i) {
            return None;
        }
        let (own_len, donor_len, donor_vacant) = {
            let (o, d) = match side {
                StripeSide::A => (&st.left, &st.right),
                StripeSide::B => (&st.right, &st.left),
            };
            let donor_side = match side {
                StripeSide::A => StripeSide::B,
                StripeSide::B => StripeSide::A,
            };
            let di = lane_idx(donor_side);
            (o.len(), d.len(), Self::is_vacant(&st, di))
        };
        if own_len > 0 {
            let idx = match side {
                StripeSide::A => st.left.pop_front().unwrap(),
                StripeSide::B => st.right.pop_front().unwrap(),
            };
            st.active[i] = Some((idx, Instant::now()));
            st.lane_cap[i] = Some((provider.to_string(), cap_id.to_string()));
            st.claims.push(ClaimRecord { side, chunk: idx, stolen: false });
            return Some((idx, false));
        }
        let gate = if donor_vacant { 1 } else { 2 };
        if donor_len >= gate {
            let idx = match side {
                StripeSide::A => st.right.pop_back().unwrap(),
                StripeSide::B => st.left.pop_back().unwrap(),
            };
            st.active[i] = Some((idx, Instant::now()));
            st.lane_cap[i] = Some((provider.to_string(), cap_id.to_string()));
            st.claims.push(ClaimRecord { side, chunk: idx, stolen: true });
            return Some((idx, true));
        }
        None
    }

    #[allow(dead_code)]
    pub(crate) fn claim_history(&self) -> Vec<ClaimRecord> {
        self.state.lock().unwrap().claims.clone()
    }

    /// T13: worker-level useful-throughput observation across chunk fills.
    ///
    /// One call per completed chunk fill (bytes = chunk body length, elapsed
    /// = monotonic fill wall time). Rules:
    /// - `contaminated` (downstream-blocked) samples are dropped, clear the
    ///   lane's epoch, and latch taint so an overrun active cannot retire on
    ///   contaminated time; fresh clean samples rebuild afterwards;
    /// - zero bytes / zero time (silence) never classifies;
    /// - producer (provider + cap id) change resets that lane's history and
    ///   drops the mixed sample.
    /// Retirement needs two independent clean observations showing one lane
    /// materially slower (sibling avg > ratio * slow avg, or a slow active
    /// chunk running longer than ratio * fast avg chunk time once the fast
    /// lane owns two clean samples). One-way, first slow lane wins. No-op
    /// unless the retire gate is armed, so T12 behavior is unchanged when
    /// retirement is OFF.
    /// `pub(crate)` so the T13 unit proofs can drive the coordinator directly.
    pub(crate) fn observe(
        &self,
        side: StripeSide,
        bytes: u64,
        elapsed: Duration,
        contaminated: bool,
        provider: &str,
        cap_id: &str,
    ) {
        if !retire_armed() {
            return;
        }
        if contaminated {
            // Downstream-contaminated: invalid, never counts. Clear the
            // epoch and latch taint so an overrun active cannot retire on
            // contaminated time. Fresh cleans rebuild afterwards.
            if let Ok(mut st) = self.state.try_lock() {
                let idx = lane_idx(side);
                st.obs[idx].samples.clear();
                st.obs[idx].tainted = true;
            }
            return;
        }
        if bytes == 0 || elapsed.is_zero() {
            return;
        }
        let bps = (bytes as f64 / elapsed.as_secs_f64()).round() as u64;
        if bps == 0 {
            return;
        }
        let ratio = retire_ratio();
        let mut st = self.state.lock().unwrap();
        if st.retired[0] || st.retired[1] {
            return;
        }
        // T19: freeze retirement once any lane terminally failed -- the
        // survivor's post-failure samples must never retire anyone on stale
        // pre-failure history. Terminal vacancy is handled by replacement.
        if st.terminal[0] || st.terminal[1] {
            return;
        }
        let idx = lane_idx(side);
        // Producer change resets history (old samples never contaminate).
        match (&st.obs[idx].provider, &st.obs[idx].cap_id) {
            (Some(p), Some(g)) if p == provider && g == cap_id => {}
            (None, None) => {
                st.obs[idx].provider = Some(provider.to_string());
                st.obs[idx].cap_id = Some(cap_id.to_string());
            }
            _ => {
                st.obs[idx].provider = Some(provider.to_string());
                st.obs[idx].cap_id = Some(cap_id.to_string());
                st.obs[idx].samples.clear();
                return;
            }
        }
        // Init producer on first sample (None case above already set).
        if st.obs[idx].provider.is_none() {
            st.obs[idx].provider = Some(provider.to_string());
            st.obs[idx].cap_id = Some(cap_id.to_string());
        }
        st.obs[idx].samples.push((bytes, elapsed, bps));
        if st.obs[idx].samples.len() > 16 {
            st.obs[idx].samples.remove(0);
        }
        let now = Instant::now();
        // Case 1: both lanes own >= 2 clean samples -- compare recent avgs.
        if st.obs[0].samples.len() >= 2 && st.obs[1].samples.len() >= 2 {
            if let (Some(a), Some(b)) = (st.obs[0].avg_bps(), st.obs[1].avg_bps()) {
                if a > 0.0 && b > 0.0 {
                    if b * ratio < a {
                        let dead_cap_id = st.lane_cap[1].clone().map(|(_, g)| g);
                        Self::declare_vacancy(&mut *st, StripeSide::B, VacancyCause::Retired, dead_cap_id);
                        eprintln!(
                            "[t13] lane_retired: slow=B fast=A avg_bps_a={:.0} avg_bps_b={:.0} ratio={}",
                            a, b, ratio,
                        );
                        return;
                    }
                    if a * ratio < b {
                        let dead_cap_id = st.lane_cap[0].clone().map(|(_, g)| g);
                        Self::declare_vacancy(&mut *st, StripeSide::A, VacancyCause::Retired, dead_cap_id);
                        eprintln!(
                            "[t13] lane_retired: slow=A fast=B avg_bps_a={:.0} avg_bps_b={:.0} ratio={}",
                            a, b, ratio,
                        );
                        return;
                    }
                }
            }
        }
        // Case 2 (early): fast lane owns >= 2 clean samples while the slow
        // lane is still on an active chunk -- compare the slow active's
        // elapsed against the fast avg chunk time. This retires before the
        // slow lane completes its second chunk, so the healthy lane is still
        // alive to drain. Silence alone never retires: needs two fast
        // clean samples plus a materially overrun active. A tainted
        // (recently downstream-contaminated) slow never retires here.
        for (fast, slow) in [(0usize, 1usize), (1usize, 0usize)] {
            if st.retired[slow] {
                continue;
            }
            if st.obs[fast].samples.len() < 2 {
                continue;
            }
            // Don't early-retire on a slow lane that already proved itself
            // with >= 2 samples unless Case 1 above fired (avgs close).
            // Early path is for slow with under 2 samples.
            if st.obs[slow].samples.len() >= 2 {
                continue;
            }
            if st.obs[slow].tainted {
                continue;
            }
            let Some(fast_avg_dur) = st.obs[fast].avg_duration() else {
                continue;
            };
            if fast_avg_dur.is_zero() {
                continue;
            }
            let Some((_, t_assign)) = st.active[slow] else {
                continue;
            };
            let elapsed_active = now.duration_since(t_assign);
            let threshold = fast_avg_dur.mul_f64(ratio);
            if elapsed_active >= threshold {
                let dead_cap_id = st.lane_cap[slow].clone().map(|(_, g)| g);
                let slow_side = if slow == 0 { StripeSide::A } else { StripeSide::B };
                Self::declare_vacancy(&mut *st, slow_side, VacancyCause::Retired, dead_cap_id);
                let slow_name = if slow == 0 { "A" } else { "B" };
                let fast_name = if fast == 0 { "A" } else { "B" };
                eprintln!(
                    "[t13] lane_retired: slow={slow_name} fast={fast_name} fast_avg_ms={} active_ms={} ratio={}",
                    fast_avg_dur.as_millis(),
                    elapsed_active.as_millis(),
                    ratio,
                );
                return;
            }
        }
    }

    /// T13: which side (if any) has retired. Test query only; retirement
    /// itself is decided inside `observe()`. Test-only helper, compiled
    /// under `cfg(test)` so production carries no dead query surface.
    #[cfg(test)]
    pub(crate) fn retired_side(&self) -> Option<StripeSide> {
        let st = self.state.lock().unwrap();
        for (i, side) in [(0, StripeSide::A), (1, StripeSide::B)] {
            if st.retired[i] {
                return Some(side);
            }
        }
        None
    }

    /// T18: bind a fresh warm cap to a vacant retired lane.
    ///
    /// Called exactly once per vacancy event, by the retired side's own
    /// worker after its active chunk resolved (`finish()` already ran, so
    /// the old active owns nothing) and before it would otherwise exit.
    /// The survivor keeps running throughout -- untouched, unblocked.
    ///
    /// Bounded: one attempt per side (`replace_tried`); a later independent
    /// vacancy on the other side gets its own attempt. No-ops (None) when
    /// the gate is off, the side was never vacant, an attempt already ran,
    /// the run is shutting down/failed, the old active still owns work, or
    /// no unstarted work remains (rebinding an idle lane is pointless; the
    /// survivor's drain is the T13-identical path).
    ///
    /// T19: the same entry covers terminal-failure vacancy (`terminal`):
    /// the failed lane's worker calls after the existing failure path
    /// resolved its active chunk. Causes stay distinct (`retired` vs
    /// `terminal`); the downstream vacancy -- and its one bounded
    /// warm-replacement attempt -- is shared.
    /// Reservation is warm-only via `reserve_standby_excluding` (the
    /// survivor's held permit excludes it structurally; the retired id list
    /// additionally excludes every retired cap), then same-TF-checked
    /// against `tf_durable_key` exactly like the spawn path. Zero
    /// acquisition by construction.
    ///
    /// On success the lane reopens (`replaced`, fresh observation epoch)
    /// and the caller continues its loop with the new cap -- the same
    /// worker task, so concurrent lanes never exceed 2. The old cap drops
    /// at the caller's reassignment (permit released, lane reusable).
    /// `pub(crate)` so the T18 unit proof can drive the coordinator directly.
    pub(crate) fn claim_replacement(
        &self,
        side: StripeSide,
        old_cap: &manager::ReservedCapability,
        manager: &manager::CapabilityManager,
        tf_durable_key: &str,
    ) -> Option<manager::ReservedCapability> {
        if !replace_armed() {
            return None;
        }
        let mut st = self.state.lock().unwrap();
        let i = lane_idx(side);
        if !Self::is_vacant(&st, i) || st.replaced[i] || st.replace_tried[i] {
            return None;
        }
        if st.shutdown || st.continent_failed {
            return None;
        }
        if st.active[i].is_some() {
            // Old active still owns work -- never replace under it.
            return None;
        }
        if st.left.is_empty() && st.right.is_empty() {
            // No unstarted work remains; rebinding would idle-exit
            // immediately. Stay on the T13 drain path (and don't consume
            // the one bounded attempt on a no-op).
            return None;
        }
        st.replace_tried[i] = true;
        let (new_cap, slot_key) =
            manager.reserve_standby_excluding(&old_cap.cap, &st.dead_cap_ids)?;
        if slot_key != tf_durable_key {
            eprintln!("[t18] replacement_refused: standby TF mismatch (same-TF invariant)");
            drop(new_cap);
            return None;
        }
        let (old_provider, old_id) = st.lane_cap[i]
            .clone()
            .unwrap_or((old_cap.cap.provider.clone(), old_cap.cap.cap_id.clone()));
        eprintln!(
            "[t18] lane_replaced: side={} old={}/{} new={}/{}",
            match side {
                StripeSide::A => "A",
                StripeSide::B => "B",
            },
            old_provider,
            old_id,
            new_cap.cap.provider,
            new_cap.cap.cap_id,
        );
        st.replaced[i] = true;
        // Fresh observation epoch for the new producer (mirrors the
        // producer-change rule in observe(); post-retirement observations
        // are inert anyway -- first retirement wins, once).
        st.obs[i] = LaneObs::default();
        st.obs[i].provider = Some(new_cap.cap.provider.clone());
        st.obs[i].cap_id = Some(new_cap.cap.cap_id.clone());
        Some(new_cap)
    }

    /// Record a chunk fill's outcome (cache authority decides `ok`).
    /// `pub(crate)` so the T13 unit proofs can drive the coordinator directly.
    pub(crate) fn finish(&self, chunk: u64, ok: bool) {
        let mut st = self.state.lock().unwrap();
        // Active chunk resolved (completed or terminal): clear whichever
        // side owned it. Retirement never clears another side's active.
        for slot in st.active.iter_mut() {
            if matches!(slot, Some((c, _)) if *c == chunk) {
                *slot = None;
            }
        }
        if !ok {
            // Fail fast: no more assignments after a terminal chunk failure.
            // In-flight fills still complete durably; unstarted chunks stay
            // unstarted (their records were never driven).
            st.continent_failed = true;
        }
    }

    /// T19: record a lane-terminal chunk-fill failure.
    ///
    /// The fill's own existing failure path ran first (recovery had first
    /// refusal: retries, same-cap resume, reacquire, or a correctly-declined
    /// hard error; the chunk record resolved failed through `mark`, so the
    /// failed chunk is never refetched and in-order delivery truncates at it
    /// exactly as before). This records the same per-chunk facts as
    /// `finish(idx, false)` -- active cleared -- and additionally:
    /// - marks this side `terminal` (lane vacancy, distinct from T13
    ///   `retired`: unusable-after-exhaustion vs alive-but-slow);
    /// - bans the failed cap id from immediate reselection;
    /// - does NOT set `continent_failed` while the sibling lane is still
    ///   viable, so the survivor (and a warm replacement) keeps draining
    ///   remaining unstarted work durably instead of abandoning it;
    /// - sets `continent_failed` when BOTH lanes are terminal (second
    ///   terminal failure with the sibling already terminal), restoring the
    ///   frozen drain-and-truncate path so no unstarted record can leak.
    ///
    /// Gate OFF delegates to frozen `finish(idx, false)` bit-for-bit
    /// (continent set immediately): frozen failure behavior unchanged.
    /// `pub(crate)` so the T19 unit proof can drive the coordinator directly.
    pub(crate) fn finish_terminal(&self, side: StripeSide, chunk: u64, failed_cap_id: &str) {
        if !replace_armed() {
            self.finish(chunk, false);
            return;
        }
        let mut st = self.state.lock().unwrap();
        for slot in st.active.iter_mut() {
            if matches!(slot, Some((c, _)) if *c == chunk) {
                *slot = None;
            }
        }
        Self::declare_vacancy(&mut *st, side, VacancyCause::Terminal, Some(failed_cap_id.to_string()));
        let other = lane_idx(match side {
            StripeSide::A => StripeSide::B,
            StripeSide::B => StripeSide::A,
        });
        if st.terminal[other] {
            // Both lanes terminally exhausted: no worker remains to drain,
            // so fail fast exactly like the frozen path (leftovers resolve
            // through `drain()`, delivery truncates at the first failure).
            st.continent_failed = true;
        }
    }

    /// Stop assignment (client cancel / terminal demand failure). In-flight
    /// fills notice via the existing sink-send failure (channeled fills) or
    /// run at most to their chunk end (stage-only fills); workers exit
    /// between fills. Bounded under the same contract as frozen fills.
    fn shutdown(&self) {
        self.state.lock().unwrap().shutdown = true;
    }

    /// True when workers must drain leftovers instead of exiting politely:
    /// shutdown (cancel) or a sibling chunk already failed. A polite exit
    /// (other worker still owns active work) must NOT drain.
    fn should_drain(&self) -> bool {
        let st = self.state.lock().unwrap();
        st.shutdown || st.continent_failed
    }

    /// Pop every still-unstarted chunk, exactly once across workers, for
    /// terminal resolution by the exiting worker. Called only when
    /// `should_drain()`; the normal path drains nothing (empty by then).
    fn drain(&self) -> Vec<u64> {
        let mut st = self.state.lock().unwrap();
        let mut out = Vec::with_capacity(st.left.len() + st.right.len());
        out.extend(st.left.drain(..));
        out.extend(st.right.drain(..));
        out
    }
}

/// T12: one pinned stripe producer.
///
/// Owns exactly one warm reservation for its whole lifetime and fetches
/// one chunk per loop iteration from the shared coordinator (own queue
/// first, far-end steals after exhaustion). The reservation threads
/// through each per-chunk fill via the existing `existing_cap` handoff and
/// `fill_chunk_run`'s returned final reservation -- zero acquisition, same
/// lane, never two concurrent uses (maxInFlight=1 holds structurally: one
/// worker, one cap, one live fill). Per-chunk fills are ordinary fills
/// (same limiter/breaker/retry/reacquire inside each fill).
///
/// T13: after each chunk fill the worker reports one cross-fill
/// useful-throughput observation (chunk body bytes over monotonic fill
/// wall time) to the coordinator. Stage-only fills are never downstream-
/// contaminated; the head streaming fill runs against the normal demand
/// emitter (fast in every deterministic proof) and is treated as clean.
/// Producer identity is post-fill so a mid-fill change resets that lane's
/// history via `observe()`. A retired side exits after its active chunk
/// (`next()` returns None); its cap drops here (permit released, lane
/// reusable).
#[allow(clippy::too_many_arguments)]
async fn stripe_worker(
    coord: Arc<TwoStripeWork>,
    side: StripeSide,
    mut cap: manager::ReservedCapability,
    cache: Arc<CacheEngine>,
    metrics: Arc<Metrics>,
    manager: Arc<manager::CapabilityManager>,
    client: reqwest::Client,
    priority: u8,
    tf: TorrentFileId,
    grid: ChunkGrid,
    run_start: u64,
    run_end: u64,
    // Per-chunk downstream senders. Only the demand's head chunk has one
    // (streaming first-byte path); every other chunk is stage-only and the
    // emitter preads it durably later -- disk, not mpsc, is the reorder
    // boundary, so a thief can never block behind a future chunk's buffer.
    chunk_sinks: Arc<HashMap<u64, mpsc::Sender<SpanMsg>>>,
    stage: StageClock,
    cold: bool,
    faults: Faults,
) {
    let key = tf.cache_key();
    loop {
        let (idx, _stolen) = match coord.next(side, &cap.cap.provider, &cap.cap.cap_id) {
            Some(job) => job,
            // Retired (or exhausted/shutdown): exit after the active chunk.
            // Remaining unstarted work stays queued for the healthy side.
            //
            // T18: that same exit point first tries one bounded warm
            // replacement (`claim_replacement`): on success this task
            // rebinds to the fresh cap and keeps draining unstarted work
            // as the same lane -- no third task, no active-chunk
            // cancellation, survivor untouched. Otherwise exit and let the
            // healthy side drain the remainder through existing stealing.
            None => {
                if let Some(new_cap) =
                    coord.claim_replacement(side, &cap, &manager, &tf.durable_key)
                {
                    cap = new_cap;
                    continue;
                }
                break;
            }
        };
        let cs = grid.chunk_start(idx);
        let ce = match grid.chunk_end(idx) {
            Some(e) => e,
            None => {
                coord.finish(idx, false);
                continue;
            }
        };
        let ws = run_start.max(cs);
        let we = run_end.min(ce);
        let sink = chunk_sinks.get(&idx).cloned();
        let fill_start = Instant::now();
        let span_bytes = ce.saturating_sub(cs).saturating_add(1);
        let ret = fill_chunk_run(
            cache.clone(),
            metrics.clone(),
            manager.clone(),
            client.clone(),
            priority,
            tf.clone(),
            vec![idx],
            cs,
            ce,
            ws,
            we,
            faults,
            sink,
            Some(stage.clone()),
            cold,
            Some(cap),
        )
        .await;
        // Cache authority decides the outcome (present == success), exactly
        // as the fill's own mark() does for its waiters.
        let present = cache.is_present(&key, idx).unwrap_or(false);
        // T13 cross-fill observation: useful bytes (whole-chunk body length)
        // over monotonic fill time. Stage-only fills are clean by
        // construction (no downstream channel); the head fill is clean in
        // every deterministic proof (fast emitter). Contaminated samples are
        // dropped inside observe(); silence (zero) never classifies.
        // Producer identity is post-fill so a mid-fill change resets.
        match ret {
            Some(c) => {
                if present {
                    coord.finish(idx, true);
                    let elapsed = fill_start.elapsed();
                    coord.observe(
                        side,
                        span_bytes,
                        elapsed,
                        false,
                        &c.cap.provider,
                        &c.cap.cap_id,
                    );
                    cap = c;
                } else {
                    // T19: terminal lane failure. The fill's existing
                    // failure path already ran (recovery had first refusal;
                    // the chunk record resolved failed, so the failed chunk
                    // is never duplicated and delivery truncates at it).
                    // Record the lane-terminal vacancy (never continent here:
                    // the survivor keeps draining) and loop on: next()
                    // yields None for the vacant lane and the exit point
                    // tries one bounded warm replacement. Failed fills
                    // carry no useful throughput signal, so no sample.
                    coord.finish_terminal(side, idx, &c.cap.cap_id);
                    cap = c;
                }
            }
            // No reservation to continue with (only when the fill had none
            // to begin with -- workers always pass one). Remaining unstarted
            // chunks stay queued for the sibling worker.
            None => {
                coord.finish(idx, present);
                break;
            }
        }
    }
    // Terminal exit: fail any still-unstarted claimed chunks so their
    // records resolve (never leak, never hang a follower). Each chunk is
    // drained exactly once across workers; a polite exit (sibling still
    // owns active work) drains nothing. Mirrors the fill's own failed-mark
    // for one chunk: present == success, else failed + finalize + wake.
    if coord.should_drain() {
        for idx in coord.drain() {
            for rec in cache.inflight().records_for(&key, &[idx]) {
                if cache.is_present(&key, idx).unwrap_or(false) {
                    rec.success.store(true, Ordering::SeqCst);
                } else {
                    rec.failed.store(true, Ordering::SeqCst);
                    metrics.cache.chunk_fills_failed.fetch_add(1, Ordering::SeqCst);
                }
                cache.inflight().finalize(&key, idx);
                rec.done.notify_waiters();
            }
        }
    }
    // `cap` drops here: permit released, lane reusable. No leak by
    // construction on every exit path above.
}

/// T22: shared-cap work-stealing worker. Same coordinator semantics as
/// `stripe_worker` (own queue first, steal from donor tail when empty),
/// but the worker holds a `ChildReaderHandle` instead of a `ReservedCapability`.
/// The handle is cloned per fill so the lease permit stays valid across
/// multiple chunk fills. Retirement/replacement are intentionally NOT extended
/// to shared-cap mode: those mechanisms assume two independent capabilities,
/// and a shared-cap lease has only one. A dead-link on one child surfaces as
/// a terminal error (no independent reacquire); the sibling keeps draining.
pub(crate) async fn stripe_worker_shared_child(
    coord: Arc<TwoStripeWork>,
    side: StripeSide,
    child: manager::ChildReaderHandle,
    cache: Arc<CacheEngine>,
    metrics: Arc<Metrics>,
    manager: Arc<manager::CapabilityManager>,
    client: reqwest::Client,
    priority: u8,
    tf: TorrentFileId,
    grid: ChunkGrid,
    run_start: u64,
    run_end: u64,
    chunk_sinks: Arc<HashMap<u64, mpsc::Sender<SpanMsg>>>,
    stage: StageClock,
    cold: bool,
    faults: Faults,
) {
    let key = tf.cache_key();
    let provider = child.cap.provider.clone();
    let cap_id = child.cap.cap_id.clone();
    loop {
        // T23: stop assigning new work when the shared capability is dead.
        // A dead-link on one child marks the shared DeliveryCapability dead;
        // the sibling must not start arbitrary new work on a known-dead cap.
        if matches!(child.cap.status(), CapabilityStatus::Dead) {
            break;
        }
        let (idx, _stolen) = match coord.next(side, &provider, &cap_id) {
            Some(job) => job,
            None => break,
        };
        let cs = grid.chunk_start(idx);
        let ce = match grid.chunk_end(idx) {
            Some(e) => e,
            None => {
                coord.finish(idx, false);
                continue;
            }
        };
        let ws = run_start.max(cs);
        let we = run_end.min(ce);
        let sink = chunk_sinks.get(&idx).cloned();
        let child_clone = child.clone();
        fill_chunk_run_shared_child(
            cache.clone(),
            metrics.clone(),
            manager.clone(),
            client.clone(),
            priority,
            tf.clone(),
            vec![idx],
            cs,
            ce,
            ws,
            we,
            faults,
            sink,
            Some(stage.clone()),
            cold,
            child_clone,
        )
        .await;
        let present = cache.is_present(&key, idx).unwrap_or(false);
        if present {
            coord.finish(idx, true);
        } else {
            coord.finish(idx, false);
            break;
        }
    }
    if coord.should_drain() {
        for idx in coord.drain() {
            for rec in cache.inflight().records_for(&key, &[idx]) {
                if cache.is_present(&key, idx).unwrap_or(false) {
                    rec.success.store(true, Ordering::SeqCst);
                } else {
                    rec.failed.store(true, Ordering::SeqCst);
                    metrics.cache.chunk_fills_failed.fetch_add(1, Ordering::SeqCst);
                }
                cache.inflight().finalize(&key, idx);
                rec.done.notify_waiters();
            }
        }
    }
}

pub async fn get_file(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response<Body> {
    // ---- Slice 4.5 T0: the read request is received. Every later stage is
    // measured relative to this instant. Stamped at handler entry, before range
    // parsing, so T0 is not quietly redefined to mean "after we did some work".
    let t0 = Instant::now();
    let size = state.authoritative_size;
    // P5 TEST-ONLY fault gate: force provider-exhaustion for specific tfIds so
    // the persisted-candidate fallback path can be exercised in a bounded,
    // reversible way (set DATA_PLANE_FORCE_EXHAUST_TFID=tf_xxx on the container, unset
    // to disable). Never set in production. Returns the classified 502 BEFORE
    // any 206 is committed, exactly as a real AllSameTfFailed would.
    if let Some(list) = crate::env_canonical("DATA_PLANE_FORCE_EXHAUST_TFID", "HY4_FORCE_EXHAUST_TFID") {
        let forced: Vec<&str> = list.split(',').map(|s| s.trim()).collect();
        if forced.iter().any(|t| *t == state.tf_id) {
            return data_plane_error(
                StatusCode::BAD_GATEWAY,
                "PROVIDER_EXHAUSTED",
                &state.tf_id,
                None,
            );
        }
    }
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
            // HY4 P2E.1: single shared constructor with the fill site below.
            let tf_id = fill_torrent_file_id(
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

    // ---- P5: classify provider-exhaustion BEFORE committing the 206 --------
    // The byte stream is opened lazily inside the spawned task below. If every
    // Node-supplied provider for this TorrentFile is exhausted, `acquire_for_read`
    // returns `AllSameTfFailed` BEFORE any byte is produced. By acquiring here
    // (and short-circuiting to a typed 502) we turn "this TorrentFile cannot be
    // delivered" into a clean, classified 5xx instead of a truncated 206.
    //
    // The acquired capability is handed to the first provider-requiring span so
    // the actual byte stream reuses it (no double acquire / limiter loss). Pure
    // cache hits (no Fetch run) skip acquire entirely and stream locally.
    let needs_provider = is_single
        || plan.is_none()
        || plan
            .as_ref()
            .map_or(true, |p| p.runs().iter().any(|r| matches!(r.kind, RunKind::Fetch)));
    let first_reserved: Option<manager::ReservedCapability> = if needs_provider {
        match state.manager.acquire_for_read(priority).await {
            Ok(r) => Some(r),
            Err(manager::DeliveryError::AllSameTfFailed { retry_after, .. }) => {
                return data_plane_error(
                    StatusCode::BAD_GATEWAY,
                    "PROVIDER_EXHAUSTED",
                    &state.tf_id,
                    retry_after,
                );
            }
        }
    } else {
        None
    };
    // GAP 2 (§15 Phase 2): RAII guard increments concurrent_demand_current
    // on acquire and decrements on drop (all exit paths covered).
    let _demand_guard = first_reserved
        .as_ref()
        .map(|_| state.metrics.start_demand());
    let mut first_reserved = first_reserved;
    // Observability-only: extract provider attribution from the reserved capability
    // before it's consumed by the read path. Provider is execution metadata, NOT
    // part of TorrentFile/cache byte identity.
    let provider_attribution = first_reserved.as_ref().map(|r| {
        (
            r.cap.provider.clone(),
            r.cap.cap_id.clone(),
            r.cap.account_scope.clone(),
        )
    });
    // Snapshot the initially selected serving provider for
    // request-scoped attribution headers. Cloned here because
    // `first_reserved` moves into the producer task below; the snapshot
    // is immutable from this point, so later promotion/reacquire can
    // never rewrite what this demand initially selected.
    let serving_attribution: Option<ServingAttribution> = first_reserved
        .as_ref()
        .map(ServingAttribution::from_reserved);
    // Observability-only: runtime correlation id. Same id will appear on the
    // StageReport and every CdnAttempt for this demand/fill.
    let corr_id = stage.corr_id();

    let (tx, rx) = mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(8);
    let metrics = state.metrics.clone();
    let cache_clone = state.cache.clone();
    let tf_id_durable_clone = state.tf_id_durable.clone();
    // HY4 P2E.1: the fill namespace needs the REAL infoHash (not the
    // routing UUID) — this clone is what the old code was missing.
    let info_hash_clone = state.info_hash.clone();
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
                first_reserved.take(),
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
                work_class: WorkClass::Demand,
                cdn_attempts: stage.take_attempts(),
                provider: provider_attribution.as_ref().map(|(p, _, _)| p.clone()).unwrap_or_default(),
                cap_id: provider_attribution.as_ref().map(|(_, c, _)| c.clone()).unwrap_or_default(),
                account_scope: provider_attribution.as_ref().map(|(_, _, a)| a.clone()).unwrap_or_default(),
                corr_id: corr_id.clone(),
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
                first_reserved.take(),
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
                    work_class: WorkClass::Demand,
                    cdn_attempts: stage.take_attempts(),
                    provider: provider_attribution.as_ref().map(|(p, _, _)| p.clone()).unwrap_or_default(),
                    cap_id: provider_attribution.as_ref().map(|(_, c, _)| c.clone()).unwrap_or_default(),
                    account_scope: provider_attribution.as_ref().map(|(_, _, a)| a.clone()).unwrap_or_default(),
                    corr_id: corr_id.clone(),
                });
                return;
            }
        };

        // HY4 P2E.1 repair: this previously passed the URL/routing UUID
        // (`tf_id_clone`) in the info_hash position, forking a UUID-based
        // fill namespace that could never intersect the plan's durable
        // namespace — cross-read cache reuse silently died while
        // coalescing kept working. Now unified via the shared constructor.
        let tf_id = fill_torrent_file_id(
            tf_id_durable_clone.clone(),
            info_hash_clone.clone(),
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

        // ---- P9: playback intelligence (sequential prefetch) ----
        // Observe this demand read. If sequential confidence is armed, CLAIM the
        // next `ahead_chunks` chunks via the SAME in-flight coalescer the demand
        // path uses (so a later demand read that needs them joins as a waiter and
        // reads locally — never a duplicate upstream fetch), then fill them with
        // the SAME fill_chunk_run (same capability pool/limiter/breaker, same cache
        // staging). Runs as background tasks: it never holds the client's reserved
        // capability and never blocks the client byte stream. Failure shielding is
        // inherent — a prefetch failure stays inside the background task and never
        // reaches the client or triggers Node's candidate fallback.
        if state.playback.config.enabled {
            let pf_plan = state
                .playback
                .observe_and_claim_prefetch(&cache, &tf_id, &grid, start, end);
            for idx in pf_plan.targets {
                let c = cache.clone();
                let m = metrics.clone();
                let mg = manager_clone.clone();
                let cl = client_clone.clone();
                let t = tf_id.clone();
                let pf = state.playback.clone();
                tokio::spawn(async move {
                    // Speculative capability acquire, gated by the configured mode.
                    //  * Auto (default): use Wait-style read-ahead ONLY when the capability
                    //    manager reports a HEALTHY IDLE LANE (spare_capacity > 0); otherwise
                    //    fall back to Try (non-blocking no-op). This keeps prefetch strictly
                    //    safe under saturated demand — Wait is only ever chosen when a lane is
                    //    provably idle, so demand can never be delayed by speculative work.
                    //  * Wait : bounded wait for a busy capability to free (idle gaps),
                    //           delivering real read-ahead; bounded so demand is never
                    //           delayed beyond one chunk fill.
                    //  * Try  : non-blocking — only fills when a capability is IMMEDIATELY
                    //           free, so it can never delay demand or amplify provider API.
                    // Either way: never grows the pool (no 2nd capability / extra requestdl)
                    // and never waits out a Throttle cooldown.
                    let spare = mg.spare_capacity();
                    let use_wait = match pf.config.mode {
                        PrefetchMode::Wait => true,
                        PrefetchMode::Try => false,
                        PrefetchMode::Auto => spare > 0,
                    };
                    pf.record_auto_decision(spare, use_wait);
                    let prefetch_start = Instant::now();
                    let cap = if use_wait {
                        match mg.acquire_for_read_prefetch(pf.config.prefetch_priority).await {
                            Some(c) => c,
                            // Wait budget exceeded — demand is saturating the lane; correctly defer.
                            None => {
                                pf.prefetches_bailed.fetch_add(1, Ordering::SeqCst);
                                return;
                            }
                        }
                    } else {
                        match mg.acquire_for_read_try(pf.config.prefetch_priority) {
                            Some(c) => c,
                            // No idle lane; correctly defer to demand.
                            None => {
                                pf.prefetches_bailed.fetch_add(1, Ordering::SeqCst);
                                return;
                            }
                        }
                    };
                    // Now — and only now — claim via the SAME single-flight coalescer the
                    // demand path uses, so a simultaneous demand read joins us instead of
                    // double-fetching. If demand already owns it, release the cap (we don't
                    // need it) and let demand drive the fill.
                    let joins = c.inflight().join_or_claim_many(&t.cache_key(), &[idx]);
                    if joins[0].joined_existing {
                        pf.joined_inflight.fetch_add(1, Ordering::SeqCst);
                        drop(cap);
                        return;
                    }
                    // Claimed (owned) the coalescer record for this chunk: attribute it to
                    // prefetch so a later demand read can observe & count it as prefetch-served.
                    pf.mark_prefetch_inflight(&t.cache_key(), idx);
                    pf.chunks_requested.fetch_add(1, Ordering::SeqCst);
                    let g = c.grid_for(&t);
                    let f_start = g.chunk_start(idx);
                    let f_end = match g.chunk_end(idx) {
                        Some(e) => e,
                        None => {
                            drop(cap);
                            return;
                        }
                    };
                    let faults = Faults {
                        fault_429_always: false,
                        fault_429_once: false,
                        fault_dead_once: false,
                        fault_midbody_once: false,
                    };
                    // Observability-only: extract provider attribution from the prefetch cap.
                    let pf_provider = (cap.cap.provider.clone(), cap.cap.cap_id.clone(), cap.cap.account_scope.clone());
                    // Lowest priority; existing_cap=Some means fill_chunk_run reuses the
                    // pre-acquired capability and never calls the blocking acquire.
                    let pf_stage = StageClock::new(prefetch_start);
                    // T12: the returned reservation is intentionally dropped
                    // here (prefetch holds no lane; the cap frees on drop).
                    let _ = fill_chunk_run(
                        c.clone(),
                        m.clone(),
                        mg.clone(),
                        cl.clone(),
                        pf.config.prefetch_priority,
                        t.clone(),
                        vec![idx],
                        f_start,
                        f_end,
                        f_start,
                        f_end,
                        faults,
                        None,
                        None,
                        false,
                        Some(cap),
                    )
                    .await;
                    let ok = c.is_present(&t.cache_key(), idx).unwrap_or(false);
                    if ok {
                        pf.mark_prefetch_completed(&t.cache_key(), idx);
                        pf.chunks_completed.fetch_add(1, Ordering::SeqCst);
                    } else {
                        // P11 §6 — clear stale attribution on failed prefetch so a
                        // later demand read does not falsely count this chunk as
                        // `joined_by_demand`. The cache itself is the authority (the
                        // P11 demand-path seam re-checks `is_present`), but leaving
                        // a chunk in `prefetched_inflight` forever would lie about
                        // what actually happened. Narrowest possible cleanup.
                        pf.clear_prefetch_inflight(&t.cache_key(), idx);
                        pf.failures.fetch_add(1, Ordering::SeqCst);
                    }
                    // Record prefetch stage timing alongside demand in stages_recent so
                    // a stalled demand can be correlated against in-flight prefetch work.
                    m.record_stage_report(StageReport {
                        instants: pf_stage.snapshot(),
                        request: (f_start, f_end),
                        cache_hit: false,
                        api_requests_delta: 0,
                        cdn_requests_delta: 1,
                        work_class: WorkClass::Prefetch,
                        cdn_attempts: pf_stage.take_attempts(),
                        provider: pf_provider.0.clone(),
                        cap_id: pf_provider.1.clone(),
                        account_scope: pf_provider.2.clone(),
                        corr_id: pf_stage.corr_id(),
                    });
                });
            }
        }

        // ---- P10: record demand-side prefetch usefulness ----
        // For each chunk this demand will read, check whether it is ALREADY durable
        // because of speculative prefetch (served_demand) or currently in-flight as a
        // prefetch fill this demand joined (joined_by_demand). Purely observational —
        // never blocks and never acquires a capability. Placed AFTER the prefetch spawn
        // above so it observes prefetch state from *prior* requests, not this one.
        if state.playback.config.enabled {
            let last = grid.file_size.saturating_sub(1);
            let d0 = grid.index_of(start);
            let d1 = grid.index_of(end.min(last));
            for di in d0..=d1 {
                state.playback.record_demand_chunk(&key, di);
            }
        }

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
        let mut first_consumed = false;
        // T12 steal-path worker handles (joined on the normal path before
        // the stage report) plus a shutdown guard covering EVERY early
        // return: dropping it stops assignment so workers exit between
        // fills and in-flight fills settle through the existing
        // sink/abandon paths. No joining on early exits (client already
        // gone); permits free on worker/fill drops either way.
        let mut stripe_workers: Vec<tokio::task::JoinHandle<()>> = Vec::new();
        let mut stripe_guard = StripeShutdownGuard(None);
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

                    // ---- P11: completed-prefetch handoff ----
                    // The plan marked these chunks MISSING at request start, before
                    // any speculative prefetch could complete them. If prefetch has
                    // since made a chunk durable in the cache, the cache — NOT the
                    // attribution bit — is authoritative: serve it locally and do NOT
                    // issue a duplicate upstream fill. This closes the duplicate-fetch
                    // inflation P10 measured (+72 MiB in Condition B). In-flight
                    // prefetch is handled below by the coalescer: demand JOINS an
                    // existing fill, never double-fetches.
                    //
                    // P11 §6 opportunistic cleanup: if a chunk is in the
                    // `prefetched_done` set but the cache says it's NOT present
                    // (e.g. it was evicted between the prefetch completion and
                    // this demand), remove it from the attribution set so the
                    // telemetry does not lie. The cache itself is authoritative,
                    // so this is purely an attribution hygiene pass — byte
                    // delivery is already correct via the `is_present` check.
                    let mut present_now: HashSet<u64> = HashSet::new();
                    let mut missing: Vec<u64> = Vec::new();
                    for &idx in &indices {
                        match cache.is_present(&key, idx) {
                            Ok(true) => {
                                present_now.insert(idx);
                            }
                            _ => {
                                missing.push(idx);
                                // Eviction / invalidation / cache-reset:
                                // the cache is the authority, not the
                                // attribution bit. Opportunistic cleanup so
                                // `prefetched_done` does not lie forever about
                                // a chunk that is no longer durable.
                                state.playback.clear_prefetched_done(&key, idx);
                            }
                        }
                    }

                    // Already-durable chunks (prefetch-completed or otherwise) -> serve
                    // locally. Keyed by chunk index for a final ascending sort.
                    let mut ordered: Vec<(u64, FetchItem)> = Vec::new();
                    for &idx in &present_now {
                        ordered.push((idx, FetchItem::Local { index: idx }));
                    }

                    let joins = if missing.is_empty() {
                        Vec::new()
                    } else {
                        cache.inflight().join_or_claim_many(&key, &missing)
                    };

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

                    // ---- Group consecutive OWNED missing chunks into fetch spans ----
                    //
                    // The chunk is the unit of DURABLE truth, not necessarily of
                    // NETWORK I/O: adjacent missing chunks collapse into ONE
                    // provider Range and are split back into chunks on arrival.
                    // A present (prefetch-durable) chunk may sit BETWEEN two missing
                    // ones, so group only CONSECUTIVE chunk indices.
                    let present_before: Vec<(u64, u64)> = plan.segments[run.seg_from..run.seg_to]
                        .iter()
                        .filter(|s| s.present)
                        .map(|s| (s.start, s.end))
                        .collect();
                    let mut k = 0usize;
                    while k < missing.len() {
                        if joins[k].owned {
                            let mut j = k;
                            while j + 1 < missing.len()
                                && joins[j + 1].owned
                                && missing[j + 1] == missing[j] + 1
                            {
                                j += 1;
                            }
                            let sub: Vec<u64> = missing[k..=j].to_vec();
                            let sub_start = sub[0];
                            let f_start = grid.chunk_start(sub[0]);
                            let f_end = match grid.chunk_end(*sub.last().unwrap()) {
                                Some(e) => e,
                                None => {
                                    k = j + 1;
                                    continue;
                                }
                            };
                            let w_start = run.start.max(f_start);
                            let w_end = run.end.min(f_end);

                            // Reuse the pre-acquired capability for the FIRST fetch
                            // span only (first_consumed guards a single take).
                            let fr = if !first_consumed {
                                first_consumed = true;
                                first_reserved.take()
                            } else {
                                None
                            };
                            // ---- T11 two-lane disjoint fill (proven as HY4 P2O
                            // on m3-north-db). Behind the existing/default-OFF
                            // experimental active-active gate: the normal
                            // first capability (fr, first span only so it is
                            // pinnable without serializing acquisition) plus
                            // one second already-warm same-TF capability via
                            // the existing T2 standby path (same-slot first,
                            // then same-TF cross-provider when
                            // DATA_PLANE_CROSS_PROVIDER_STANDBY=1 -- never an
                            // acquisition). Both in hand or no striping: the
                            // fallback below is the exact existing path.
                            // The one consecutive OWNED run splits
                            // deterministically into two disjoint halves
                            // (ceil/floor); each half recomputes its
                            // fetch/window bounds with the same clamping as
                            // the single path. Maximum lanes: 2. Each logical
                            // chunk has exactly one producer; ordered client
                            // output flows through the existing
                            // cache/staging boundary unchanged.
                            // T14: coherent entry is explicit TWO_SPAN
                            // (frozen) or AUTO size gate; the reservation
                            // below REMAINS the warm-availability check (no
                            // pool peek, no cold acquisition to activate).
                            let stripe_b: Option<(
                                manager::ReservedCapability,
                                String,
                            )> = if stripe_wanted(sub.len())
                                && fr.is_some()
                                && sub.len() >= 2
                            {
                                manager_clone.reserve_standby(&fr.as_ref().unwrap().cap)
                            } else {
                                None
                            };
                            // Defense in depth: the standby slot's durable
                            // key must equal this fill's TorrentFile identity
                            // (the manager already enforces it cross-slot;
                            // same-slot is trivially equal). On mismatch drop
                            // the reservation (permit freed, reusable) and
                            // take the single-fill path -- never stripe
                            // across TorrentFiles. Provider is execution
                            // metadata only; both capabilities represent the
                            // exact same TorrentFile.
                            let stripe_b = match stripe_b {
                                Some((bres, bslot_key))
                                    if bslot_key != tf_id.durable_key =>
                                {
                                    eprintln!(
                                        "[t11] stripe_refused: standby TF mismatch (same-TF invariant)"
                                    );
                                    drop(bres);
                                    None
                                }
                                other => other,
                            };
                            if let Some((bres, _bslot_key)) = stripe_b {
                                // ---- T12 steal path (proven as HY4 P2P on
                                // m3-north-db). Per-chunk fills driven by two
                                // pinned workers over one shared coordinator
                                // (own halves first, far-end steals after
                                // exhaustion). Only the demand's head chunk
                                // streams (today's Owned path); every other
                                // chunk is stage-only and emitted durably
                                // later -- disk, never a future chunk's mpsc
                                // buffer, is the reorder boundary. Takes over
                                // here and `continue`s; otherwise falls
                                // through to the exact T11 fixed path below.
                                // T14: explicit steal path or AUTO + STEAL
                                // flag; AUTO alone without STEAL yields the
                                // frozen fixed 50/50 path.
                                if steal_wanted(sub.len())
                                    && sub.iter().all(|idx| grid.chunk_end(*idx).is_some())
                                {
                                    if let Some(frcap) = fr {
                                        let half = (sub.len() + 1) / 2;
                                        // Per-chunk bounds + decisions. t
                                        // aligns with joins[k+t] (sub ==
                                        // missing[k..=j]); grid ends were
                                        // checked by the arming guard above.
                                        let mut pieces: Vec<(usize, u64)> =
                                            Vec::with_capacity(sub.len());
                                        for (t, &idx) in sub.iter().enumerate() {
                                            let cs = grid.chunk_start(idx);
                                            // Guarded Some above; the fallback
                                            // is unreachable but keeps byte
                                            // identity total.
                                            let ce = grid.chunk_end(idx).unwrap_or(f_end);
                                            let ws = run.start.max(cs);
                                            let we = run.end.min(ce);
                                            cache.metrics.cache_decisions.push(CacheDecision {
                                                request: (start, end),
                                                present_before: present_before.clone(),
                                                missing: (ws, we),
                                                chunk_indices: vec![idx],
                                                fetch_span: Some((cs, ce)),
                                                joined_inflight: joins[k + t].joined_existing,
                                                overlap_bytes_avoided: if joins[k + t].joined_existing {
                                                    grid.chunk_len(idx)
                                                } else {
                                                    0
                                                },
                                                plan_origin,
                                                evictions_before: cache
                                                    .metrics
                                                    .cache
                                                    .evictions
                                                    .load(Ordering::SeqCst),
                                            });
                                            pieces.push((t, idx));
                                        }
                                        // Head streams; the rest wait durably.
                                        let head_idx = sub[0];
                                        let (htx, hrx) = mpsc::channel::<SpanMsg>(32);
                                        let mut sinks = HashMap::new();
                                        sinks.insert(head_idx, htx);
                                        let sinks = Arc::new(sinks);
                                        ordered.push((head_idx, FetchItem::Owned { rx: hrx }));
                                        // Initial split remains the T11
                                        // ceil/floor: the head already has its
                                        // streaming Owned item above, but it
                                        // still belongs to the left queue
                                        // (backs are stolen first, so worker A
                                        // always pops it first).
                                        let mut left: Vec<u64> = Vec::new();
                                        let mut right: Vec<u64> = Vec::new();
                                        for (t, idx) in &pieces {
                                            if *idx == head_idx {
                                                left.push(*idx);
                                            } else {
                                                ordered.push((
                                                    *idx,
                                                    FetchItem::Staged {
                                                        index: *idx,
                                                        record: joins[k + *t].record.clone(),
                                                    },
                                                ));
                                                if left.len() < half {
                                                    left.push(*idx);
                                                } else {
                                                    right.push(*idx);
                                                }
                                            }
                                        }
                                        // NOTE: ordered gets a final ascending
                                        // sort below with everything else, so
                                        // push order here is irrelevant.
                                        eprintln!(
                                            "[t12] workshare_spawned: chunks={} left={} right={}",
                                            sub.len(),
                                            left.len(),
                                            right.len(),
                                        );
                                        let coord = Arc::new(TwoStripeWork::new(left, right));
                                        stripe_guard.0 = Some(coord.clone());
                                        stripe_workers.push(tokio::spawn(stripe_worker(
                                            coord.clone(),
                                            StripeSide::A,
                                            frcap,
                                            cache.clone(),
                                            metrics.clone(),
                                            manager_clone.clone(),
                                            client_clone.clone(),
                                            priority,
                                            tf_id.clone(),
                                            grid,
                                            run.start,
                                            run.end,
                                            sinks.clone(),
                                            stage.clone(),
                                            cold,
                                            faults,
                                        )));
                                        stripe_workers.push(tokio::spawn(stripe_worker(
                                            coord.clone(),
                                            StripeSide::B,
                                            bres,
                                            cache.clone(),
                                            metrics.clone(),
                                            manager_clone.clone(),
                                            client_clone.clone(),
                                            priority,
                                            tf_id.clone(),
                                            grid,
                                            run.start,
                                            run.end,
                                            sinks,
                                            stage.clone(),
                                            cold,
                                            faults,
                                        )));
                                        k = j + 1;
                                        continue;
                                    }
                                    // Unreachable in practice (stripe_b
                                    // required fr.is_some()): fall through to
                                    // the exact T11 fixed path with fr == None.
                                }
                                let half = (sub.len() + 1) / 2;
                                let (sub_a, sub_b) =
                                    (sub[..half].to_vec(), sub[half..].to_vec());
                                let fa_start = grid.chunk_start(sub_a[0]);
                                let fa_end = match grid
                                    .chunk_end(*sub_a.last().unwrap())
                                {
                                    Some(e) => e,
                                    None => f_end,
                                };
                                let fb_start = grid.chunk_start(sub_b[0]);
                                let fb_end = match grid
                                    .chunk_end(*sub_b.last().unwrap())
                                {
                                    Some(e) => e,
                                    None => f_end,
                                };
                                let wa_start = run.start.max(fa_start);
                                let wa_end = run.end.min(fa_end);
                                let wb_start = run.start.max(fb_start);
                                let wb_end = run.end.min(fb_end);
                                // Two CacheDecisions (one per disjoint half)
                                // so the §15 decision log stays truthful
                                // about the two provider Ranges issued.
                                for (half_sub, hf_start, hf_end, hw_start, hw_end, hjoins) in [
                                    (&sub_a, fa_start, fa_end, wa_start, wa_end, &joins[k..k + half]),
                                    (&sub_b, fb_start, fb_end, wb_start, wb_end, &joins[k + half..=j]),
                                ] {
                                    cache.metrics.cache_decisions.push(CacheDecision {
                                        request: (start, end),
                                        present_before: present_before.clone(),
                                        missing: (hw_start, hw_end),
                                        chunk_indices: half_sub.clone(),
                                        fetch_span: Some((hf_start, hf_end)),
                                        joined_inflight: hjoins
                                            .iter()
                                            .any(|x| x.joined_existing),
                                        overlap_bytes_avoided: hjoins
                                            .iter()
                                            .filter(|x| x.joined_existing)
                                            .map(|x| grid.chunk_len(x.index))
                                            .sum(),
                                        plan_origin,
                                        evictions_before: cache
                                            .metrics
                                            .cache
                                            .evictions
                                            .load(Ordering::SeqCst),
                                    });
                                }
                                let (atx, arx) = mpsc::channel::<SpanMsg>(32);
                                let (btx, brx) = mpsc::channel::<SpanMsg>(32);
                                // sub_b[0] sorts after every sub_a index:
                                // capture it before the spawns move the vecs.
                                let sub_b0 = sub_b[0];
                                // Stripe A reuses the pre-acquired cap
                                // through the existing handoff; stripe B the
                                // pinned warm standby. No new acquisition
                                // mode: fill_chunk_run sees two ordinary
                                // owned fills (same limiter/breaker/retry
                                // behavior inside each fill).
                                tokio::spawn(fill_chunk_run(
                                    cache.clone(),
                                    metrics.clone(),
                                    manager_clone.clone(),
                                    client_clone.clone(),
                                    priority,
                                    tf_id.clone(),
                                    sub_a,
                                    fa_start,
                                    fa_end,
                                    wa_start,
                                    wa_end,
                                    faults,
                                    Some(atx),
                                    Some(stage.clone()),
                                    cold,
                                    fr,
                                ));
                                tokio::spawn(fill_chunk_run(
                                    cache.clone(),
                                    metrics.clone(),
                                    manager_clone.clone(),
                                    client_clone.clone(),
                                    priority,
                                    tf_id.clone(),
                                    sub_b,
                                    fb_start,
                                    fb_end,
                                    wb_start,
                                    wb_end,
                                    faults,
                                    Some(btx),
                                    Some(stage.clone()),
                                    cold,
                                    Some(bres),
                                ));
                                ordered.push((sub_start, FetchItem::Owned { rx: arx }));
                                // The existing ascending emitter needs no
                                // change to keep A||B delivery order.
                                ordered.push((
                                    sub_b0,
                                    FetchItem::Owned { rx: brx },
                                ));
                                k = j + 1;
                                continue;
                            }

                            // ---- T22 shared-cap fallback (proven on m3-north-db).
                            // When active-arm engagement wants two lanes but no
                            // distinct warm standby capability exists, use one
                            // CapabilityLease over the already-held primary
                            // capability. Two child readers serve disjoint
                            // halves; one reservation, zero new acquisition.
                            // Preference: distinct warm standby > shared-cap lease
                            // > single-lane. Engages only behind the existing
                            // active-active gates (never by default).
                                                        // ---- T22 shared-cap work-stealing path (proven on m3-north-db).
                            // Same shared-cap lease as the T22 fallback, but the
                            // two child readers use the existing two-lane
                            // work-stealing coordinator rather than fixed 50/50.
                            // One reservation, zero new acquisition.
                            // Retirement/replacement are NOT extended to shared-cap
                            // mode (they assume two independent capabilities).
                            else if steal_wanted(sub.len())
                                && shared_cap_fallback()
                                && fr.is_some()
                                && sub.iter().all(|idx| grid.chunk_end(*idx).is_some())
                            {
                                let half = (sub.len() + 1) / 2;
                                let mut pieces: Vec<(usize, u64)> =
                                    Vec::with_capacity(sub.len());
                                for (t, &idx) in sub.iter().enumerate() {
                                    let cs = grid.chunk_start(idx);
                                    let ce = grid.chunk_end(idx).unwrap_or(f_end);
                                    let ws = run.start.max(cs);
                                    let we = run.end.min(ce);
                                    cache.metrics.cache_decisions.push(CacheDecision {
                                        request: (start, end),
                                        present_before: present_before.clone(),
                                        missing: (ws, we),
                                        chunk_indices: vec![idx],
                                        fetch_span: Some((cs, ce)),
                                        joined_inflight: joins[k + t].joined_existing,
                                        overlap_bytes_avoided: if joins[k + t].joined_existing {
                                            grid.chunk_len(idx)
                                        } else {
                                            0
                                        },
                                        plan_origin,
                                        evictions_before: cache
                                            .metrics
                                            .cache
                                            .evictions
                                            .load(Ordering::SeqCst),
                                    });
                                    pieces.push((t, idx));
                                }
                                let head_idx = sub[0];
                                let (htx, hrx) = mpsc::channel::<SpanMsg>(32);
                                let mut sinks = HashMap::new();
                                sinks.insert(head_idx, htx);
                                let sinks = Arc::new(sinks);
                                ordered.push((head_idx, FetchItem::Owned { rx: hrx }));
                                let mut left: Vec<u64> = Vec::new();
                                let mut right: Vec<u64> = Vec::new();
                                for (t, idx) in &pieces {
                                    if *idx == head_idx {
                                        left.push(*idx);
                                    } else {
                                        ordered.push((
                                            *idx,
                                            FetchItem::Staged {
                                                index: *idx,
                                                record: joins[k + *t].record.clone(),
                                            },
                                        ));
                                        if left.len() < half {
                                            left.push(*idx);
                                        } else {
                                            right.push(*idx);
                                        }
                                    }
                                }
                                eprintln!(
                                    "[t22] shared_cap_steal_spawned: chunks={} left={} right={}",
                                    sub.len(),
                                    left.len(),
                                    right.len(),
                                );
                                let lease =
                                    CapabilityLease::new(fr.unwrap());
                                let child_a =
                                    CapabilityLease::child_reader(&lease).expect("T22: child A");
                                let child_b =
                                    CapabilityLease::child_reader(&lease).expect("T22: child B");
                                let coord = Arc::new(TwoStripeWork::new(left, right));
                                stripe_guard.0 = Some(coord.clone());
                                stripe_workers.push(tokio::spawn(stripe_worker_shared_child(
                                    coord.clone(),
                                    StripeSide::A,
                                    child_a,
                                    cache.clone(),
                                    metrics.clone(),
                                    manager_clone.clone(),
                                    client_clone.clone(),
                                    priority,
                                    tf_id.clone(),
                                    grid,
                                    run.start,
                                    run.end,
                                    sinks.clone(),
                                    stage.clone(),
                                    cold,
                                    faults,
                                )));
                                stripe_workers.push(tokio::spawn(stripe_worker_shared_child(
                                    coord.clone(),
                                    StripeSide::B,
                                    child_b,
                                    cache.clone(),
                                    metrics.clone(),
                                    manager_clone.clone(),
                                    client_clone.clone(),
                                    priority,
                                    tf_id.clone(),
                                    grid,
                                    run.start,
                                    run.end,
                                    sinks,
                                    stage.clone(),
                                    cold,
                                    faults,
                                )));
                                k = j + 1;
                                continue;
                            }

else if auto_go(sub.len())
                                && shared_cap_fallback()
                                && fr.is_some()
                                && sub.len() >= 2
                            {
                                let half = (sub.len() + 1) / 2;
                                let (sub_a, sub_b) =
                                    (sub[..half].to_vec(), sub[half..].to_vec());
                                let lease =
                                    CapabilityLease::new(fr.unwrap());
                                let child_a =
                                    CapabilityLease::child_reader(&lease).expect("T22: child A");
                                let child_b =
                                    CapabilityLease::child_reader(&lease).expect("T22: child B");
                                let fa_start = grid.chunk_start(sub_a[0]);
                                let fa_end =
                                    grid.chunk_end(*sub_a.last().unwrap()).unwrap_or(f_end);
                                let fb_start = grid.chunk_start(sub_b[0]);
                                let fb_end =
                                    grid.chunk_end(*sub_b.last().unwrap()).unwrap_or(f_end);
                                let wa_start = run.start.max(fa_start);
                                let wa_end = run.end.min(fa_end);
                                let wb_start = run.start.max(fb_start);
                                let wb_end = run.end.min(fb_end);
                                for (half_sub, hf_start, hf_end, hw_start, hw_end) in [
                                    (&sub_a, fa_start, fa_end, wa_start, wa_end),
                                    (&sub_b, fb_start, fb_end, wb_start, wb_end),
                                ] {
                                    cache.metrics.cache_decisions.push(CacheDecision {
                                        request: (start, end),
                                        present_before: present_before.clone(),
                                        missing: (hw_start, hw_end),
                                        chunk_indices: half_sub.clone(),
                                        fetch_span: Some((hf_start, hf_end)),
                                        joined_inflight: half_sub
                                            .iter()
                                            .any(|idx| joins[k..=j].iter().any(|x| x.index == *idx && x.joined_existing)),
                                        overlap_bytes_avoided: half_sub
                                            .iter()
                                            .filter(|idx| joins[k..=j].iter().any(|x| x.index == **idx && x.joined_existing))
                                            .map(|x| grid.chunk_len(*x))
                                            .sum(),
                                        plan_origin,
                                        evictions_before: cache.metrics.cache.evictions.load(Ordering::SeqCst),
                                    });
                                }
                                let (atx, arx) = mpsc::channel::<SpanMsg>(32);
                                let (btx, brx) = mpsc::channel::<SpanMsg>(32);
                                let sub_b0 = sub_b[0];
                                tokio::spawn(fill_chunk_run_shared_child(
                                    cache.clone(),
                                    metrics.clone(),
                                    manager_clone.clone(),
                                    client_clone.clone(),
                                    priority,
                                    tf_id.clone(),
                                    sub_a,
                                    fa_start,
                                    fa_end,
                                    wa_start,
                                    wa_end,
                                    faults,
                                    Some(atx),
                                    Some(stage.clone()),
                                    cold,
                                    child_a,
                                ));
                                tokio::spawn(fill_chunk_run_shared_child(
                                    cache.clone(),
                                    metrics.clone(),
                                    manager_clone.clone(),
                                    client_clone.clone(),
                                    priority,
                                    tf_id.clone(),
                                    sub_b,
                                    fb_start,
                                    fb_end,
                                    wb_start,
                                    wb_end,
                                    faults,
                                    Some(btx),
                                    Some(stage.clone()),
                                    cold,
                                    child_b,
                                ));
                                ordered.push((sub_start, FetchItem::Owned { rx: arx }));
                                ordered.push((sub_b0, FetchItem::Owned { rx: brx }));
                                k = j + 1;
                                continue;
                            }

                            // ---- Slice 4.5 G: record WHY this fetch happens,
                            // including the grid's effect on the Range we issue.
                            // Exact existing single-fill path (gate OFF, or
                            // gate ON without a second warm cap).
                            cache.metrics.cache_decisions.push(CacheDecision {
                                request: (start, end),
                                present_before: present_before.clone(),
                                missing: (w_start, w_end),
                                chunk_indices: sub.clone(),
                                fetch_span: Some((f_start, f_end)),
                                joined_inflight: joins[k..=j].iter().any(|x| x.joined_existing),
                                overlap_bytes_avoided: joins[k..=j]
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
                                fr,
                            ));
                            ordered.push((sub_start, FetchItem::Owned { rx: srx }));
                            k = j + 1;
                        } else {
                            ordered.push((
                                missing[k],
                                FetchItem::Waiter {
                                    index: missing[k],
                                    record: joins[k].record.clone(),
                                },
                            ));
                            k += 1;
                        }
                    }

                    // Ascending chunk order so the client sees one ordered byte stream.
                    ordered.sort_by_key(|(idx, _)| *idx);
                    let items: Vec<FetchItem> = ordered.into_iter().map(|(_, it)| it).collect();

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
                                    // T19: terminal span failure -- join
                                    // stripe workers (no-op for non-striped
                                    // demands, whose fills are detached
                                    // tasks) so the survivor (and a warm
                                    // replacement) still drains durably;
                                    // delivery already truncated at this
                                    // chunk per the existing in-order
                                    // contract. Terminal fills never come
                                    // from cancel paths (abandon sends Eof),
                                    // and the join is bounded (workers exit
                                    // at queue exhaustion), but a gone
                                    // client still returns at once.
                                    Some(SpanMsg::Failed) => {
                                        if !tx.is_closed() {
                                            for h in stripe_workers.drain(..) {
                                                let _ = h.await;
                                            }
                                        }
                                        return;
                                    }
                                    None => return,
                                }
                            },
                            FetchItem::Waiter { index, record } => {
                                // Demand arrived while a fill was already in-flight: demand waits
                                // on the coalescer, possibly behind prefetch or another demand.
                                // Record this so the "demand blocked behind prefetch" question
                                // is answered with evidence, not silence.
                                metrics.record_demand_joined_fill();
                                // Emit a stage report at the join moment. T2/T4 are the fill
                                // owner's timestamps; the join clock captures when demand arrived.
                                // A later correlating pass can match this report against the
                                // prefetch stage report for the same chunk to establish causality.
                                let join_clock = StageClock::new(Instant::now());
                                let join_stage = join_clock.snapshot();
                                let join_report = StageReport {
                                    instants: join_stage,
                                    // The client Range this demand read needed (approximate from run).
                                    request: (run.start, run.end),
                                    cache_hit: false,
                                    api_requests_delta: 0,
                                    cdn_requests_delta: 0,
                                    work_class: WorkClass::DemandJoinedFill,
                                    // DemandJoinedFill: CDN attempts are attributed to the fill owner.
                                    cdn_attempts: vec![],
                                    // Provider attribution is on the fill owner's stage report.
                                    provider: String::new(),
                                    cap_id: String::new(),
                                    account_scope: String::new(),
                                    corr_id: join_clock.corr_id(),
                                };
                                metrics.record_stage_report(join_report);
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
                                    // T19: terminal-chunk truncation joins
                                    // stripe workers so the survivor (and a
                                    // warm replacement) drains the remainder
                                    // durably. Cancel paths (client gone)
                                    // return at once exactly as before.
                                    if !tx.is_closed() {
                                        for h in stripe_workers.drain(..) {
                                            let _ = h.await;
                                        }
                                    }
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
                            FetchItem::Staged { index, record } => {
                                // T12: this demand owns the fill (a stripe
                                // worker stages it with no live channel), so
                                // emission waits on durable completion -- no
                                // follower accounting, no reorder buffer. The
                                // cache is the authority, exactly as in the
                                // Waiter arm above.
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
                                    // A fill that was abandoned after our
                                    // chunk had already been promoted leaves
                                    // the chunk PRESENT; a failed record alone
                                    // must not fail a demand that can be
                                    // served from durable bytes.
                                    match cache.is_present(&key, index) {
                                        Ok(true) => {}
                                        _ => {
                                            // T19: same join-on-terminal rule
                                            // as the Waiter arm above
                                            // (failed record, client
                                            // present); cancel paths return
                                            // at once exactly as before.
                                            if !tx.is_closed() {
                                                for h in stripe_workers.drain(..) {
                                                    let _ = h.await;
                                                }
                                            }
                                            return;
                                        }
                                    }
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
                                            "[rust-proxy] cache pread failed on staged chunk {index}: {err}"
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
                            FetchItem::Local { index } => {
                                // P11 completed-prefetch handoff: this chunk is
                                // already durable in the cache (a completed prefetch
                                // fill, or any prior fill). The cache is authoritative
                                // — read it locally, no upstream.
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
                                            "[rust-proxy] cache pread failed on prefetch-durable chunk {index}: {err}"
                                        );
                                        return;
                                    }
                                };
                                if first_byte {
                                    first_byte = false;
                                    stage.set_t5(Instant::now());
                                    metrics
                                        .record_first_byte(open_start.elapsed().as_millis() as u64);
                                }
                                if tx.send(Ok(bytes::Bytes::from(bytes))).await.is_err() {
                                    metrics
                                        .client_cancellations
                                        .fetch_add(1, Ordering::SeqCst);
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        }

        // T12: join steal-path workers on the normal path -- every chunk
        // channel hit EOF, hence every fill returned, so the joins are
        // immediate. (Early exits above return without joining; the
        // shutdown guard stops assignment and permits free on
        // worker/fill drops either way.)
        for h in stripe_workers {
            let _ = h.await;
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
            work_class: WorkClass::Demand,
            cdn_attempts: stage.take_attempts(),
            provider: provider_attribution.as_ref().map(|(p, _, _)| p.clone()).unwrap_or_default(),
            cap_id: provider_attribution.as_ref().map(|(_, c, _)| c.clone()).unwrap_or_default(),
            account_scope: provider_attribution.as_ref().map(|(_, _, a)| a.clone()).unwrap_or_default(),
            corr_id: corr_id.clone(),
        });
    });

    let body = Body::from_stream(ReceiverStream::new(rx));
    let mut builder = Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{size}"),
        )
        .header(header::CONTENT_LENGTH, client_content_len.to_string())
        .header(header::ACCEPT_RANGES, "bytes");
    // Request-scoped serving-primary attribution headers. Set only
    // from the pre-commit snapshot above: no buffering, no media delay,
    // no global state. Absent on pure cache hits (truthful: no provider
    // served this demand). Invalid values are skipped, never fabricated —
    // a demand with unusable attribution simply carries none.
    for (name, value) in ServingAttribution::header_pairs_for(serving_attribution.as_ref()) {
        if let Ok(v) = axum::http::HeaderValue::from_str(&value) {
            builder = builder.header(name, v);
        }
    }
    builder.body(body).unwrap()
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
    /// T12: a chunk THIS demand owns and a stripe worker fills stage-only
    /// (no live channel -- disk, not mpsc, is the reorder boundary). Wait
    /// for its record exactly like a waiter, then pread the authoritative
    /// bytes. Unlike Waiter it never inflates the follower count (nothing
    /// consults followers for these fills; cancellation travels via the
    /// coordinator shutdown plus the workers' own exits).
    Staged {
        index: u64,
        record: Arc<cache::ChunkInFlightRecord>,
    },
    /// A chunk already durable in the cache (a completed prefetch fill, or any
    /// prior fill). Served from disk — no upstream fetch, no coalescer claim.
    /// P11 added this so demand consumes useful prefetch work instead of
    /// duplicating it.
    Local {
        index: u64,
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

/// RAII guard for owned inflight chunk responsibility. When a fill task
/// becomes the owner of one or more inflight records (via
/// `join_or_claim_many`), those records MUST be resolved — success or failure
/// — or every waiter on `done.notified().await` blocks forever and the
/// inflight map leaks the entry.
///
/// The guard resolves them on Drop with `failed` semantics. Normal completion
/// calls `finish_success` / `finish_failure` to record the real outcome and
/// disarm the guard. If the future is cancelled at any `.await` after the
/// guard is created, Drop performs the existing failure/reclaim cleanup:
/// mark failed, finalize inflight ownership, notify waiters.
///
/// Synchronous bookkeeping only — no blocking, no async.
struct OwnedFillGuard {
    cache: Arc<CacheEngine>,
    metrics: Arc<Metrics>,
    key: String,
    indices: Vec<u64>,
    records: Vec<Arc<cache::ChunkInFlightRecord>>,
    armed: bool,
}

impl OwnedFillGuard {
    fn new(
        cache: Arc<CacheEngine>,
        metrics: Arc<Metrics>,
        key: &str,
        indices: Vec<u64>,
    ) -> Self {
        let records = cache.inflight().records_for(&key, &indices);
        Self {
            cache,
            metrics,
            key: key.to_string(),
            indices,
            records,
            armed: true,
        }
    }

    fn finish_success(mut self, published: &[u64]) {
        self.mark(true, published);
        self.armed = false;
    }

    fn finish_failure(mut self) {
        self.mark(false, &[]);
        self.armed = false;
    }

    fn mark(&self, ok: bool, published: &[u64]) {
        for idx in &self.indices {
            let rec = match self.records.iter().find(|r| r.chunk_index == *idx) {
                Some(r) => r,
                None => continue,
            };
            if ok && published.contains(idx) {
                rec.success.store(true, Ordering::SeqCst);
            } else {
                rec.failed.store(true, Ordering::SeqCst);
                self.metrics.cache.chunk_fills_failed.fetch_add(1, Ordering::SeqCst);
            }
            self.cache.inflight().finalize(&self.key, *idx);
            rec.done.notify_waiters();
        }
    }
}

impl Drop for OwnedFillGuard {
    fn drop(&mut self) {
        if self.armed {
            self.mark(false, &[]);
        }
    }
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
    // P5: capability pre-acquired in `get_file` for the FIRST fetch span. When
    // `Some`, the byte stream reuses it instead of re-acquiring (no double
    // acquire / maxInFlight=1 limiter loss). Later spans get `None`.
    existing_cap: Option<manager::ReservedCapability>,
    // T12 (proven as HY4 P2P on m3-north-db): returns the fill's final
    // reservation (post any in-fill replacement) so a stripe worker can
    // thread the same warm lane across chunk fills with zero acquisition;
    // None only when the fill never held one (failed acquire with none
    // passed in). All pre-existing callers ignore the value.
) -> Option<manager::ReservedCapability> {
    fill_chunk_run_inner(
        cache,
        metrics,
        manager,
        client,
        priority,
        tf,
        indices,
        f_start,
        f_end,
        w_start,
        w_end,
        faults,
        sink,
        stage,
        cold,
        existing_cap.map(ReaderCapability::Owned),
    )
    .await
}

/// T22: fill span driven by a shared child reader from a `CapabilityLease`.
/// The shared child holds no reservation of its own, so `into_reserved`
/// returns `None` and the outer scheduler must not treat this fill as a
/// reusable warm lane. Recovery that requires capability reacquisition
/// surfaces as a terminal error — shared children must not independently
/// race the sibling for the single permit.
pub async fn fill_chunk_run_shared_child(
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
    child: manager::ChildReaderHandle,
) {
    fill_chunk_run_inner(
        cache,
        metrics,
        manager,
        client,
        priority,
        tf,
        indices,
        f_start,
        f_end,
        w_start,
        w_end,
        faults,
        sink,
        stage,
        cold,
        Some(ReaderCapability::Shared(child)),
    )
    .await;
}

/// Inner shared by the owned-reader and shared-child variants. The `cap`
/// parameter selects how the transport reader is constructed: `Owned` carries
/// the single permit and may hand back a reservation; `Shared` borrows from a
/// `CapabilityLease` and returns `None` (no reservation, no independent
/// reacquisition). All post-reader logic (recovery, staging, hedge, promotion,
/// throughput detection) is identical.
async fn fill_chunk_run_inner(
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
    cap: Option<ReaderCapability>,
) -> Option<manager::ReservedCapability> {

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

    // Own inflight guard: resolves owned records on Drop if the future is
    // cancelled at any `.await` after this point. Normal completion disarms
    // the guard via finish_success/finish_failure.
    let guard = OwnedFillGuard::new(cache.clone(), metrics.clone(), &key, indices.clone());

    let stager = match cache.begin_stage(tf.clone()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[rust-proxy] begin_stage failed: {e}");
            guard.finish_failure();
            if let Some(tx) = sink.as_ref() {
                let _ = tx.send(SpanMsg::Failed).await;
            }
            // T12: hand back the un-consumed reservation, if any.
            // For shared children, into_reserved() returns None — no reservation to hand back.
            return match cap {
                Some(ReaderCapability::Owned(r)) => Some(r),
                _ => None,
            };
        }
    };

    // The chunk callback stages bytes AND measures delivered volume. It fires
    // for every chunk the resilient reader has COMMITTED to delivering, i.e.
    // after internal recovery, with the authoritative offset — so Slice 3.5
    // retries never double-stage, and transport.rs needs no change for 4.75.
    //
    // T17: the stager is SHARED by at most two execution attempts under one
    // logical claim, so staging goes through per-attempt gates. Each gate
    // is an Arc<AtomicBool> checked per invocation:
    //   stage_fn    -- the ungated stager (manual exactly-once staging of an
    //                  election winner);
    //   cb          -- primary attempt's callback (gate true except during a
    //                  hedge race, so a primary chunk that loses the race is
    //                  never staged even if its future already completed
    //                  inside the same poll);
    //   cb_hedge    -- hedge attempt's callback (gate false until a hedge
    //                  win promotes it to the active producer).
    // With no hedge in flight both gates read their steady state and every
    // path behaves exactly as before (one extra atomic load per chunk).
    let stage_gate_primary = Arc::new(AtomicBool::new(true));
    let stage_gate_hedge = Arc::new(AtomicBool::new(false));
    let stage_fn: Arc<dyn Fn(u64, &[u8]) + Send + Sync> = {
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
    let cb: Arc<dyn Fn(u64, &[u8]) + Send + Sync> = {
        let inner = stage_fn.clone();
        let gate = stage_gate_primary.clone();
        Arc::new(move |offset: u64, data: &[u8]| {
            if gate.load(Ordering::SeqCst) {
                inner(offset, data);
            }
        })
    };
    let cb_hedge: Arc<dyn Fn(u64, &[u8]) + Send + Sync> = {
        let inner = stage_fn.clone();
        let gate = stage_gate_hedge.clone();
        Arc::new(move |offset: u64, data: &[u8]| {
            if gate.load(Ordering::SeqCst) {
                inner(offset, data);
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
    // P5/T22: the `cap` parameter selects how the transport reader is
    // constructed. `Owned` carries the single permit and reuses the
    // pre-acquired reservation; `Shared` borrows from a `CapabilityLease`
    // (no permit, no acquisition); `None` acquires a fresh reservation.
    // Second client handle for a hedge reader (the construction below
    // moves `client`).
    let client_hedge = client.clone();
    let mut reader = match cap {
        Some(ReaderCapability::Owned(reserved)) => {
            let acquire_ms = acquire_start.elapsed();
            if let Some(s) = stage.as_ref() {
                s.set_t2(Instant::now());
            }
            if cold {
                *metrics.cold_acquire_ms.lock().unwrap() = Some(acquire_ms.as_millis() as u64);
            }
            ResilientRangeReader::new_with_chunk_cb(
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
            )
        }
        Some(ReaderCapability::Shared(child)) => {
            if let Some(s) = stage.as_ref() {
                s.set_t2(Instant::now());
            }
            ResilientRangeReader::new_shared_child_with_chunk_cb(
                client,
                metrics.clone(),
                manager.clone(),
                child,
                priority,
                f_start,
                f_end,
                tf.size,
                false,
                faults,
                Some(cb),
            )
        }
        None => {
            let reserved = match manager.acquire_for_read(priority).await {
                Ok(r) => r,
                Err(_) => {
                    stager.abort();
                    guard.finish_failure();
                    if let Some(tx) = sink.as_ref() {
                        let _ = tx.send(SpanMsg::Failed).await;
                    }
                    // T12: no reservation was ever held here.
                    return None;
                }
            };
            let acquire_ms = acquire_start.elapsed();
            if let Some(s) = stage.as_ref() {
                s.set_t2(Instant::now());
            }
            if cold {
                *metrics.cold_acquire_ms.lock().unwrap() = Some(acquire_ms.as_millis() as u64);
            }
            ResilientRangeReader::new_with_chunk_cb(
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
            )
        }
    };
    // Hand the stage clock to the transport so T3/T4 are stamped at the real
    // dispatch / first-body-byte instants.
    if let Some(s) = stage.as_ref() {
        reader.set_stage_clock(s.clone());
    }
    // ---- T16 sustained-low-throughput warm promotion (proven as HY4 P2M
    // on m3-north-db). Loop-local estimator beside the read loop: same
    // committed Step::Chunk feed, no shared state, no locks. Constructed
    // only for demand fills (sink.is_some()); prefetch and stage-only
    // fills (sink None) never threaten playback and are excluded
    // structurally. Unset/zero floor => None => the fill behaves exactly
    // as before (zero overhead, zero verdicts, zero promotions).
    let mut throughput: Option<ThroughputEstimator> = if sink.is_some() {
        low_throughput_config().map(|cfg| {
            let live = reader.current_cap();
            ThroughputEstimator::new(
                cfg.floor_bps,
                cfg.window,
                cfg.blocked_threshold,
                live.provider.clone(),
                live.cap_id.clone(),
            )
        })
    } else {
        None
    };
    // ---- T16 window-cadenced consecutive-low policy (fill-local) ----
    // Counts INDEPENDENT sustained low observations within one producer
    // epoch (never per-frame classifications). Promotion may fire at count
    // >= 2. Stays at zero unless the estimator above is active.
    let mut low_policy = LowObservationPolicy::new();
    // ---- T17 bounded hedge election state (fill-local) ----
    // One-hedge-per-claim bound, plus the warm cap kept from a failed race
    // for the promotion attempt below (no drop+re-reserve gap). A later
    // independent fill starts false/empty again.
    let mut hedge_consumed = false;
    let mut kept_warm: Option<(manager::ReservedCapability, String)> = None;

    let sub_open = Instant::now();
    if reader.ensure_open().await.is_err() {
        stager.abort();
        guard.finish_failure();
        if let Some(tx) = sink.as_ref() {
            let _ = tx.send(SpanMsg::Failed).await;
        }
        // T12: hand back the live reservation. Shared children hold none,
        // so into_reserved() returns None for them.
        return reader.into_reserved();
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
    // T17: an elected hedge winner's Step is processed through the normal
    // arm below (its bytes were staged manually exactly once during the
    // election; the arm itself never stages).
    let mut pending: Option<Step> = None;
    loop {
        let step = match pending.take() {
            Some(s) => s,
            None => reader.next_chunk().await,
        };
        match step {
            Step::Chunk(b) => {
                let n = b.len() as u64;
                if n == 0 {
                    continue;
                }
                let cs = pos;
                let ce = pos + n - 1;
                pos = ce + 1;
                let chunk_at = Instant::now();
                // T16: feed the same committed body bytes to the throughput
                // estimator. A transport-internal producer swap (dead-link
                // reacquire without fill-level promotion) resets the epoch
                // via the live identity check -- same producer (reopen /
                // retry) stays in the epoch.
                if let Some(est) = throughput.as_mut() {
                    let live = reader.current_cap();
                    if live.provider != est.provider() || live.cap_id != est.cap_id() {
                        est.reset_for_producer(live.provider.clone(), live.cap_id.clone());
                    }
                    est.observe(chunk_at, n);
                    let snap = est.classify(chunk_at);
                    // T16 window-cadenced consecutive-low policy. The
                    // estimator window is the cadence (no second knob):
                    // only temporally independent sustained observations
                    // advance the count, never adjacent frame verdicts.
                    let _ = low_policy.note_verdict(
                        &snap,
                        Duration::from_millis(snap.window_ms),
                        chunk_at,
                    );
                }
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
                            // T16 contamination boundary: a downstream send
                            // issued with zero channel capacity WILL block,
                            // so latch a taint BEFORE awaiting (a stalled
                            // consumer can hold the send indefinitely, and
                            // post-await recording would never execute). A
                            // fast completion clears a momentary-fullness
                            // false alarm with samples intact, while a slow
                            // completion confirms real downstream pacing and
                            // discards the epoch (never read as provider
                            // degradation).
                            if let Some(est) = throughput.as_mut() {
                                est.note_presend(tx.capacity() == 0);
                            }
                            let send_start = Instant::now();
                            let send_ok =
                                tx.send(SpanMsg::Chunk(b.slice(a..a + z))).await.is_ok();
                            if let Some(est) = throughput.as_mut() {
                                est.note_send(send_start.elapsed());
                            }
                            if !send_ok {
                                // Client hung up. Keep filling: the chunk is
                                // still worth having, and waiters depend on
                                // these records being resolved.
                                client_gone = true;
                                metrics.client_cancellations.fetch_add(1, Ordering::SeqCst);
                            }
                        }
                    }
                }
                // T16: low-throughput promotion fire. The policy arms
                // structurally (two independent sustained low observations
                // in one producer epoch), never on a timer. Unarmed
                // (including detector OFF) behaves exactly as before.
                // This runs only on healthy delivery, so the existing
                // failure/recovery ordering stays authoritative.
                if low_policy.count() >= 2 {
                    let slow_cap = reader.current_cap();
                    // ---- T17 bounded hedge election (first-valid-wins,
                    // proven as HY4 P2N on m3-north-db) BEFORE promotion.
                    //
                    // Single-round race REPLACING abandon-and-promote this
                    // iteration: the already-reserved warm standby opens the
                    // same `[pos, f_end]` as a second execution attempt
                    // under this fill's single logical claim. The first
                    // producer to return its next body chunk becomes the
                    // SOLE producer for the remainder. Gates, in order: low
                    // arming + hedge knob + one-per-fill bound + warm
                    // standby in hand (a miss falls through to promotion
                    // below). Maximum two attempts, at most one hedge per
                    // logical fill, zero cold acquisition.
                    //
                    // Staging discipline: the primary gate closes BEFORE
                    // polling. No primary future is in flight at this point
                    // (we are inside the arm after a delivered chunk), so
                    // until the election neither attempt can stage. The
                    // winner's first chunk is staged manually exactly once
                    // below; the loser's never. The elected winner's Step is
                    // processed through the normal arm above (via `pending`).
                    let mut elected: Option<Step> = None;
                    if hedge_enabled() && !hedge_consumed && pos <= f_end {
                        match manager.reserve_standby(&slow_cap) {
                            Some((hedge_reserved, hedge_slot_key))
                                if hedge_slot_key == tf.durable_key =>
                            {
                                hedge_consumed = true;
                                let race_pos = pos;
                                let hedge_provider =
                                    hedge_reserved.cap.provider.clone();
                                eprintln!(
                                    "[t17] hedge_race_started: tf={} span={f_start}-{f_end} race_offset={race_pos} primary={} hedge={hedge_provider}",
                                    tf.durable_key,
                                    slow_cap.provider,
                                );
                                stage_gate_primary.store(false, Ordering::SeqCst);
                                let mut hedge_reader =
                                    ResilientRangeReader::new_with_chunk_cb(
                                        client_hedge.clone(),
                                        metrics.clone(),
                                        manager.clone(),
                                        hedge_reserved,
                                        priority,
                                        pos,
                                        f_end,
                                        tf.size,
                                        false,
                                        faults,
                                        Some(cb_hedge.clone()),
                                    );
                                // No race deadline on this branch (no
                                // stall/runway arms exist here): pending
                                // forever, exactly like the bare await.
                                // Failure ordering stays authoritative (a
                                // Terminal still fails the fill).
                                let (primary_first, hedge_first) = tokio::select! {
                                    s = reader.next_chunk() => (Some(s), None),
                                    s = hedge_reader.next_chunk() => (None, Some(s)),
                                };
                                if let Some(s) = primary_first {
                                    // Primary wins: drop the hedge (permit
                                    // released, connection closed --
                                    // cancellation, never a provider
                                    // failure), stage the winning chunk
                                    // manually exactly once (its gated
                                    // callback was off during the race),
                                    // re-open the primary gate. Same
                                    // producer continues.
                                    drop(hedge_reader);
                                    if let Step::Chunk(b) = &s {
                                        stage_fn(pos, b);
                                    }
                                    stage_gate_primary.store(true, Ordering::SeqCst);
                                    low_policy.reset_sequence();
                                    eprintln!(
                                        "[t17] hedge_elected: winner=primary tf={} span={f_start}-{f_end} race_offset={race_pos}",
                                        tf.durable_key,
                                    );
                                    elected = Some(s);
                                } else if let Some(s) = hedge_first {
                                    match s {
                                        Step::Chunk(b) => {
                                            // Hedge wins: ownership transfer.
                                            // Manual exactly-once stage, then
                                            // the hedge gate opens so later
                                            // hedge chunks stage internally
                                            // through the same single
                                            // authoritative stager. The
                                            // pending primary attempt is
                                            // dropped (cancellation, never a
                                            // provider failure) and the hedge
                                            // reader becomes the active
                                            // reader for the remainder.
                                            stage_fn(pos, &b);
                                            stage_gate_hedge.store(true, Ordering::SeqCst);
                                            let hcap = hedge_reader.current_cap();
                                            let old_reader = std::mem::replace(
                                                &mut reader,
                                                hedge_reader,
                                            );
                                            drop(old_reader);
                                            if let Some(est) = throughput.as_mut() {
                                                est.reset_for_producer(
                                                    hcap.provider.clone(),
                                                    hcap.cap_id.clone(),
                                                );
                                            }
                                            low_policy.reset_sequence();
                                            eprintln!(
                                                "[t17] hedge_elected: winner=hedge tf={} span={f_start}-{f_end} race_offset={race_pos} hedge={}",
                                                tf.durable_key,
                                                hcap.provider,
                                            );
                                            elected = Some(Step::Chunk(b));
                                        }
                                        _ => {
                                            // Hedge errored/ended before
                                            // either won: re-open the primary
                                            // gate (same producer continues)
                                            // and keep its warm cap for the
                                            // promotion attempt below (no
                                            // drop+re-reserve gap).
                                            stage_gate_primary.store(true, Ordering::SeqCst);
                                            kept_warm = Some((
                                                hedge_reader.into_reserved().expect("T17: hedge reader owns its reservation"),
                                                hedge_slot_key,
                                            ));
                                            eprintln!(
                                                "[t17] hedge_failed: tf={} span={f_start}-{f_end} race_offset={race_pos} (primary continues into promotion)",
                                                tf.durable_key,
                                            );
                                        }
                                    }
                                }
                            }
                            other => {
                                drop(other);
                            }
                        }
                    }
                    if let Some(s) = elected {
                        pending = Some(s);
                        continue;
                    }
                    // T16 promotion (existing): runs only when no hedge
                    // election produced a winner this frame. Warm-only: a
                    // cap kept from a failed race is preferred (no
                    // drop+re-reserve gap); otherwise reserve fresh. On a
                    // miss there is no cold-acquire fallback -- reset the
                    // sequence so re-attempt needs a fresh interval
                    // (bounded attempts, never a per-frame hot loop), and
                    // continue serving from the current producer with no
                    // budget spent.
                    let standby = match kept_warm.take() {
                        Some(r) => Some(r),
                        None => match manager.reserve_standby(&slow_cap) {
                            Some(r) => Some(r),
                            None => None,
                        },
                    };
                    match standby {
                        Some((standby, slot_key)) if slot_key == tf.durable_key => {
                            let new_provider = standby.cap.provider.clone();
                            let new_cap_id = standby.cap.cap_id.clone();
                            reader.promote_to(standby);
                            if let Some(est) = throughput.as_mut() {
                                est.reset_for_producer(new_provider.clone(), new_cap_id);
                            }
                            // Fresh producer must prove itself slow again:
                            // re-arm needs two new independent windows.
                            low_policy.reset_sequence();
                            eprintln!(
                                "[t16] promoted: tf={} span={f_start}-{f_end} slow={} new={new_provider} at_pos={pos}",
                                tf.durable_key,
                                slow_cap.provider,
                            );
                        }
                        other => {
                            // No warm standby (or cross-TF, never): drop any
                            // reservation, serve the current producer, spend
                            // no budget.
                            drop(other);
                            low_policy.reset_sequence();
                            eprintln!(
                                "[t16] standby_miss: tf={} span={f_start}-{f_end} (no warm standby; serving current producer, no budget spent)",
                                tf.durable_key,
                            );
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
        guard.finish_success(&p);
        p
    } else {
        stager.abort();
        guard.finish_failure();
        Vec::new()
    };
    if let Some(tx) = sink.as_ref() {
        let _ = tx.send(if ok { SpanMsg::Eof } else { SpanMsg::Failed }).await;
    }
    // T12: return the final reservation (post any in-fill replacement) so
    // a stripe worker threads the same warm lane across chunk fills.
    reader.into_reserved()

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
    // P5: capability pre-acquired in `get_file` for the single / no-cache paths.
    // When `Some`, reuse it; otherwise acquire normally.
    existing_cap: Option<manager::ReservedCapability>,
    on_chunk: Option<Arc<dyn Fn(u64, &[u8]) + Send + Sync>>,
    stage: Option<StageClock>,
) -> bool {
    let acquire_start = Instant::now();
    // Slice 4.5 T1 — capability acquisition requested, through the same Slice 3
    // scheduler the cache path uses.
    if let Some(s) = stage.as_ref() {
        s.set_t1(acquire_start);
    }
    // P5: reuse the pre-acquired capability for the single / no-cache paths when
    // present, else acquire normally.
    let reserved = match existing_cap {
        Some(cap) => cap,
        None => match manager.acquire_for_read(priority).await {
            Ok(r) => r,
            Err(_) => return false,
        },
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

/// T5 transplant (proven as the HY4 P2G/P2H prewarm endpoint on
/// m3-north-db): narrow prewarm operation for one named provider
/// placement of one exact TorrentFile. No Node caller yet; main.rs
/// wires this to `POST /files/:tfId/prewarm`.
///
/// Runtime: load fresh S-1 truth for the torrentFileId via the existing
/// production control machinery; validate the requested placement
/// belongs to that exact TF; call T3 `prewarm_slot`; if the passed
/// runtime manager lacks that otherwise-valid fresh placement, apply
/// exactly one T4 `refresh_slots` and retry prewarm exactly once; return
/// the bounded result. No media bytes are read.
///
/// `current` is the cached manager for the tfId, if any. The returned
/// `store_manager` is the manager the caller must cache under the tfId:
/// `Some` on first build and on refresh-swap, `None` when the passed-in
/// manager stays live. `prewarm_slot`'s `InvalidSlot` surfaces as
/// `invalid` here, matching the endpoint vocabulary
/// (already_warm|warmed|in_flight|unavailable|invalid|failed).
pub struct PrewarmRequest {
    pub torrent_file_id: String,
    pub provider: String,
    pub provider_resource_id: String,
    pub provider_file_id: Option<String>,
    pub account_scope: Option<String>,
}

pub struct PrewarmEndpointResult {
    pub status_code: StatusCode,
    pub body: serde_json::Value,
    pub store_manager: Option<Arc<manager::CapabilityManager>>,
}

pub async fn prewarm_placement(
    client: &reqwest::Client,
    control_url: &str,
    keys: &ApiKeys,
    metrics: &Arc<Metrics>,
    current: Option<Arc<manager::CapabilityManager>>,
    req: PrewarmRequest,
) -> PrewarmEndpointResult {
    let fail = |status_code: StatusCode,
                body: serde_json::Value,
                store_manager: Option<Arc<manager::CapabilityManager>>| {
        PrewarmEndpointResult { status_code, body, store_manager }
    };
    // PrewarmOutcome -> endpoint payload. `InvalidSlot` maps to the
    // endpoint `invalid` verdict; every other status keeps its name.
    let render = |outcome: manager::PrewarmOutcome| {
        let status_name = match &outcome.status {
            manager::PrewarmStatus::InvalidSlot(_) => "invalid",
            s => s.name(),
        }
        .to_string();
        let mut body = serde_json::json!({
            "status": status_name,
            "torrentFileId": outcome.torrent_file_id,
            "tfDurableKey": outcome.tf_durable_key,
            "provider": outcome.provider,
            "providerResourceId": outcome.provider_resource_id,
            "capId": outcome.cap_id,
            "apiDelta": outcome.api_delta,
            "elapsedMs": outcome.elapsed_ms,
        });
        if let Some(reason) = outcome.status.detail() {
            body["reason"] = serde_json::Value::String(reason);
        }
        body
    };
    // 1. Fresh S-1 truth for this exact torrentFileId (existing
    // production control machinery; classified shape like handle_files).
    let control = match fetch_control(client, control_url, &req.torrent_file_id, SUPPORTED_SCHEMA_VERSION).await {
        Ok(c) => c,
        Err(_) => {
            return fail(
                StatusCode::BAD_GATEWAY,
                serde_json::json!({
                    "error": "S1_FETCH_FAILED",
                    "torrentFileId": req.torrent_file_id,
                }),
                None,
            );
        }
    };
    // 2. The requested placement must belong to fresh exact-TF truth
    // (optional facets narrow the match when supplied).
    let fresh_ok = control.providers.iter().any(|c| {
        c.provider == req.provider
            && c.provider_resource_id == req.provider_resource_id
            && req.provider_file_id.as_deref().map_or(true, |f| c.provider_file_id == f)
            && req.account_scope.as_deref().map_or(true, |a| c.account_scope == a)
    });
    if !fresh_ok {
        let key = TorrentFileId::compute_durable_key(
            &control.torrent_file.info_hash,
            control.torrent_file.canonical_internal_path.as_deref().unwrap_or(""),
            control.torrent_file.size,
        );
        return fail(
            StatusCode::OK,
            serde_json::json!({
                "status": "invalid",
                "torrentFileId": control.torrent_file.id,
                "tfDurableKey": key,
                "provider": req.provider,
                "providerResourceId": req.provider_resource_id,
                "capId": Option::<String>::None,
                "apiDelta": 0,
                "elapsedMs": 0,
                "reason": "requested placement is not in fresh exact-TF truth",
            }),
            None,
        );
    }
    // Runtime manager: cached, or built fresh from this same truth.
    let manager = match current {
        Some(m) => (m, false),
        None => (
            Arc::new(manager::CapabilityManager::new(
                control.torrent_file.clone(),
                control.providers.clone(),
                keys.clone(),
                client.clone(),
                metrics.clone(),
            )),
            true,
        ),
    };
    // 3. Prewarm against the runtime manager.
    let outcome = manager.0.prewarm_slot(&req.provider, &req.provider_resource_id).await;
    if !matches!(outcome.status, manager::PrewarmStatus::InvalidSlot(_)) {
        let body = render(outcome);
        return fail(StatusCode::OK, body, if manager.1 { Some(manager.0) } else { None });
    }
    // 4+5. The runtime lacks an otherwise-valid fresh placement: exactly
    // one T4 refresh, then exactly one prewarm retry. The retry verdict
    // is returned as-is, even if not warmed.
    let refreshed = manager::CapabilityManager::refresh_slots(
        &manager.0,
        &control.torrent_file,
        &control.providers,
        keys.clone(),
        client.clone(),
        metrics.clone(),
    );
    if !matches!(refreshed.status, manager::RefreshStatus::Refreshed) {
        return fail(
            StatusCode::OK,
            serde_json::json!({
                "status": "invalid",
                "torrentFileId": refreshed.torrent_file_id,
                "tfDurableKey": refreshed.tf_durable_key,
                "provider": req.provider,
                "providerResourceId": req.provider_resource_id,
                "capId": Option::<String>::None,
                "apiDelta": refreshed.api_delta,
                "elapsedMs": refreshed.elapsed_ms,
                "reason": refreshed.status.detail(),
            }),
            None,
        );
    }
    let retry = refreshed.manager.prewarm_slot(&req.provider, &req.provider_resource_id).await;
    let body = render(retry);
    fail(StatusCode::OK, body, Some(refreshed.manager))
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
    // GAP 2/3 pre-computed values (serde_json::json!() does not support let bindings)
    let concurrent_current = m.concurrent_demand_current.load(Ordering::SeqCst);
    let concurrent_peak = m.concurrent_demand_peak.load(Ordering::SeqCst);
    let caps_total = pool.iter().map(|(_, len, _)| *len as u64).sum::<u64>();
    let target_total = pool.iter().map(|(_, _, tgt)| *tgt as u64).sum::<u64>();
    let utilization_pct = if target_total > 0 {
        ((caps_total as f64 / target_total as f64) * 100.0).round() as u64
    } else {
        0u64
    };
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
        // GAP 2 (§15 Phase 2): concurrent demand peak tracking.
        "concurrent_demand": {
            "current": concurrent_current,
            "peak": concurrent_peak,
        },
        // GAP 3 (§15 Phase 2): pool aggregates computed from existing pool_summary().
        "pool_aggregate": {
            "caps": caps_total,
            "target": target_total,
            "utilization_pct": utilization_pct,
        },
        // field comment in metrics.rs. A bare `limiter_waits: 0` must never be
        // read as "no contention" — check `limiter_permit_waits` too.
        "limiter_waits": m.limiter_waits.load(Ordering::SeqCst),
        "limiter_permit_waits": m.limiter_permit_waits.load(Ordering::SeqCst),
        // Demand reads that waited on a coalescer fill already in-flight. Proves
        // demand can stall behind another reader's fill even without permit contention.
        "demand_joined_fill": m.demand_joined_fill.load(Ordering::SeqCst),
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
        // Observability-only per-capability pool attribution.
        "pool_attribution": state.manager.pool_attribution(),
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
        // P9 — playback-intelligence (sequential prefetch) telemetry. Surfaced so
        // the benchmark can attribute "later chunk served locally" to prefetch
        // rather than guessing, and so ON/OFF runs are directly comparable.
        "playback_intelligence": state.playback.snapshot(),
    })
    .to_string();
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap()
}

