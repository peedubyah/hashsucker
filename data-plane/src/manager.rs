// Slice 3.5 — CapabilityManager: turns Node-supplied provider coordinates into live,
// reusable, single-flighted, pooled DeliveryCapabilities, and fails over across the
// same TorrentFile before ever declaring AllSameTfDeliveryFailed.
//
// Slice 3.5 additions over Slice 3:
//  - Capability cache reuse is made explicit and counted (capability_reuses / evictions).
//  - A BOUNDED negative cache (§7) shares a recent HARD acquisition failure across waiters so
//    twenty simultaneous reads do not make twenty identical provider calls. Transient failures
//    (429/5xx) are NEVER cached as negative state.
//  - Provider/account breaker open events are counted.
//
// Hard rules honored:
//  - NO discovery / ranking / TorrentFile substitution. Only the coords Node gave us.
//  - Single-flight keyed by provider+accountScope+TorrentFile+providerResourceId+
//    providerFileId (so we never fire a duplicate provider acquire for the same coord).
//  - Per-capability limiter maxInFlight=1.
//  - Pool starts at 1; grows to 2 only under measured read pressure (POOL_GROWTH_REASON
//    recorded); 2->4 only when explicitly opted in (bounded API, operator decision).
//  - AllSameTfDeliveryFailed ONLY when every viable provider is exhausted AND no recovery is
//    in flight.
//  - Do NOT infer capability death merely because another capability was minted.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedSemaphorePermit};

use crate::capability::{AcquireError, ApiKeys, Breaker, CapabilityStatus, DeliveryCapability};
use crate::control::{ControlTorrentFile, ProviderCoord};
use crate::metrics::Metrics;
use crate::provider;

// ---- single-flight plumbing -------------------------------------------------
// One InFlight per (key) while an acquire is in progress. Owner does the work;
// waiters block on `notify` then read the result. Double-checked to avoid lost wakes.
struct InFlight {
    notify: Notify,
    owner: AtomicBool,
    done: AtomicBool,
    result: Mutex<Option<Result<Arc<DeliveryCapability>, AcquireError>>>,
}
impl InFlight {
    fn new() -> Self {
        Self {
            notify: Notify::new(),
            owner: AtomicBool::new(false),
            done: AtomicBool::new(false),
            result: Mutex::new(None),
        }
    }
}

/// Bounded negative cache entry: a recent HARD acquisition failure keyed by coord.
struct NegEntry {
    expires_at: Instant,
    err: AcquireError,
}

pub struct Slot {
    pub coord: ProviderCoord,
    /// Current host DB row id (`torrent_files.id`). RETAINED for
    /// logging/forensics. NOT used for the single-flight key.
    pub tf_id: String,
    /// Deterministic key derived from `(info_hash, canonical_path, size)`.
    /// Stable across DB reconstruction; this is what `sf_key()` uses.
    pub durable_key: String,
    pub target_file_id: String,
    pub breaker: Breaker,
    // acquired capabilities for this placement (length <= target).
    pub caps: Mutex<Vec<Arc<DeliveryCapability>>>,
    pub target: AtomicUsize,
}

impl Slot {
    fn sf_key(&self) -> String {
        // P3 final identity check, conclusion B: the key is the stable
        // (info_hash, canonical_path, size) tuple, NOT the mutable
        // surrogate PK. Slot.tf_id is retained for logging only.
        format!(
            "{}|{}|{}|{}|{}",
            self.coord.provider,
            self.coord.account_scope,
            self.durable_key,
            self.coord.provider_resource_id,
            self.coord.provider_file_id
        )
    }
}

pub struct ReservedCapability {
    pub cap: Arc<DeliveryCapability>,
    // held for the duration of the read; enforces maxInFlight=1 per capability.
    pub _permit: OwnedSemaphorePermit,
}

/// Inner state of a capability lease. The single owned reservation (holding the
/// one maxInFlight=1 permit) lives here; `child_count` tracks how many active
/// readers currently borrow from the lease. When the last child drops, the
/// reservation is released (permit freed) and new children are refused.
///
/// Protected by a `Mutex` so child creation/removal is race-free. The mutex is
/// only held for short, non-async critical sections (no `.await` inside).
struct LeaseInner {
    /// The owned reservation. `None` once the lease has been released (last
    /// child dropped); after that, `child_reader()` refuses new children.
    reserved: Option<ReservedCapability>,
    /// Active child readers (0, 1, or 2). Capped at 2 by `child_reader()`.
    child_count: u8,
}

/// A bounded lease over one `ReservedCapability` that allows up to two concurrent
/// child readers to share the same signed URL / capability reservation.
///
/// Invariants:
///   - exactly one `OwnedSemaphorePermit` for the lifetime of the lease,
///   - exactly one `in_flight` reservation on the underlying capability,
///   - at most two active `ChildReaderHandle`s,
///   - a third `child_reader()` call returns `None`,
///   - the permit lives until the last child handle drops,
///   - new children are refused once the reservation has been released.
///
/// Construction: `CapabilityLease::new(reserved)` returns an `Arc<Self>` that the
/// caller holds until it no longer needs to spawn children. `Arc::clone` of that
/// handle is passed to `child_reader()`; each returned `ChildReaderHandle` holds
/// its own `Arc`, so the lease stays alive exactly as long as children exist.
///
/// Not part of any scheduler path. Wiring into active-active engagement is a
/// separate, explicit step.
pub struct CapabilityLease {
    inner: Mutex<LeaseInner>,
}

/// A handle to one borrowed child reader. Holds a clone of the underlying
/// `Arc<DeliveryCapability>` (so the transport reader can read the signed URL
/// and traverse the normal breaker/limiter/retry path) plus an `Arc` to the
/// parent lease (so the last child's drop releases the single permit).
///
/// `Drop` is the only mechanism that decrements the lease's child count and
/// releases the reservation. A handle is `Send` but NOT `Clone` — there is
/// exactly one handle per spawned reader, so permit accounting stays exact.
pub struct ChildReaderHandle {
    pub cap: Arc<DeliveryCapability>,
    lease: Arc<CapabilityLease>,
}

impl Clone for ChildReaderHandle {
    fn clone(&self) -> Self {
        let mut inner = self.lease.inner.lock().unwrap();
        if inner.child_count >= 2 || inner.reserved.is_none() {
            return Self {
                cap: self.cap.clone(),
                lease: self.lease.clone(),
            };
        }
        inner.child_count += 1;
        Self {
            cap: self.cap.clone(),
            lease: self.lease.clone(),
        }
    }
}

impl CapabilityLease {
    /// Wrap one owned reservation into a lease. The reservation's permit is now
    /// owned by the lease and will be released only when the last child handle
    /// drops (or when the lease itself is dropped with no children).
    pub fn new(reserved: ReservedCapability) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(LeaseInner {
                reserved: Some(reserved),
                child_count: 0,
            }),
        })
    }

    /// Try to create one borrowed child reader handle.
    ///
    /// Returns `None` if the lease already has two active children or if its
    /// reservation has already been released. There is no way to create a third
    /// handle: the cap is structural, not just advisory.
    pub fn child_reader(lease: &Arc<Self>) -> Option<ChildReaderHandle> {
        let mut inner = lease.inner.lock().unwrap();
        if inner.child_count >= 2 || inner.reserved.is_none() {
            return None;
        }
        inner.child_count += 1;
        let cap = inner
            .reserved
            .as_ref()
            .expect("reserved checked non-None above")
            .cap
            .clone();
        Some(ChildReaderHandle {
            cap,
            lease: lease.clone(),
        })
    }

    /// Current number of active child readers (observability / proofs only).
    pub fn child_count(&self) -> u8 {
        self.inner.lock().unwrap().child_count
    }

    /// True once the reservation has been released (last child dropped). After
    /// this, `child_reader()` always returns `None`.
    pub fn is_released(&self) -> bool {
        self.inner.lock().unwrap().reserved.is_none()
    }
}

impl Drop for ChildReaderHandle {
    fn drop(&mut self) {
        let mut inner = self.lease.inner.lock().unwrap();
        // Decrement first; if we just released the last child, drop the
        // reservation here so the permit frees even if the lease Arc is still
        // held by the creator.
        inner.child_count = inner.child_count.saturating_sub(1);
        if inner.child_count == 0 {
            inner.reserved = None;
        }
    }
}

pub enum DeliveryError {
    AllSameTfFailed {
        last: Option<String>,
        retry_after: Option<Duration>,
    },
}

/// Prewarm vocabulary, trimmed to the existing-slot scope: no fresh-S-1
/// validation, so no StalePool variant. Every variant is terminal for the
/// request (no hidden retries); only `Warmed` performs acquisition, and it
/// performs exactly one bounded attempt through the existing single-flight.
pub enum PrewarmStatus {
    /// A usable free capability already exists; zero acquisition.
    AlreadyWarm,
    /// One bounded acquisition completed; carries no bytes, holds no
    /// permit — the cap sits warm/free for later standby reservation.
    Warmed,
    /// Slot at target with no free lane (demand or concurrent prewarm
    /// owns the permits); pool growth is demand's job, never prewarm's.
    InFlight(String),
    /// Slot breaker open; explicit request must not hammer it.
    Unavailable(String),
    /// Bounded acquire error (breaker recorded, like try_slot).
    Failed(String),
    /// No pool slot matches the requested placement coordinates.
    /// Zero acquisition; nothing created.
    InvalidSlot(String),
}

impl PrewarmStatus {
    /// Wire name for the future Node→Rust prewarm contract (snake_case, stable).
    pub fn name(&self) -> &'static str {
        match self {
            PrewarmStatus::AlreadyWarm => "already_warm",
            PrewarmStatus::Warmed => "warmed",
            PrewarmStatus::InFlight(_) => "in_flight",
            PrewarmStatus::Unavailable(_) => "unavailable",
            PrewarmStatus::Failed(_) => "failed",
            PrewarmStatus::InvalidSlot(_) => "invalid_slot",
        }
    }

    /// Human-readable detail, if any.
    pub fn detail(&self) -> Option<String> {
        match self {
            PrewarmStatus::AlreadyWarm | PrewarmStatus::Warmed => None,
            PrewarmStatus::InFlight(s)
            | PrewarmStatus::Unavailable(s)
            | PrewarmStatus::Failed(s)
            | PrewarmStatus::InvalidSlot(s) => Some(s.clone()),
        }
    }
}

/// One explicit prewarm outcome. Manager-local identity
/// only (routing UUID + durable key); production caps carry `cap_id`
/// (not the later HY4 generation), so the warmed cap is reported by id.
pub struct PrewarmOutcome {
    pub status: PrewarmStatus,
    pub torrent_file_id: String,
    pub tf_durable_key: String,
    pub provider: String,
    pub provider_resource_id: String,
    pub cap_id: Option<String>,
    pub api_delta: u64,
    pub elapsed_ms: u64,
}

/// Slot refresh result vocabulary (adapted
/// to whole-inventory form): refresh result vocabulary. Only `Refreshed`
/// changes runtime state; every other variant returns the input manager
/// bit-for-bit untouched and performs zero acquisition.
pub enum RefreshStatus {
    /// Live inventory already matches fresh truth; input manager reused.
    AlreadyCurrent,
    /// Inventory rebuilt from fresh truth; carries the refreshed manager.
    /// Surviving slots' capabilities migrate by Arc (warmth preserved,
    /// limiters still globally enforced); old in-flight readers keep the
    /// old manager Arc, which stays valid.
    Refreshed,
    /// Fresh truth is for another TorrentFile (or lists nothing): live
    /// state kept, zero acquisition.
    Conflict(String),
}

impl RefreshStatus {
    /// Wire name (snake_case, stable).
    pub fn name(&self) -> &'static str {
        match self {
            RefreshStatus::AlreadyCurrent => "already_current",
            RefreshStatus::Refreshed => "refreshed",
            RefreshStatus::Conflict(_) => "conflict",
        }
    }

    pub fn detail(&self) -> Option<String> {
        match self {
            RefreshStatus::AlreadyCurrent | RefreshStatus::Refreshed => None,
            RefreshStatus::Conflict(s) => Some(s.clone()),
        }
    }
}

/// T4 transplant: one inventory refresh, fully attributed. `manager` is
/// the live manager to serve from (the input on AlreadyCurrent/Conflict,
/// a rebuilt one on Refreshed). `api_delta` is always zero by
/// construction (refresh never acquires); it is reported so proofs can
/// assert it.
pub struct RefreshOutcome {
    pub status: RefreshStatus,
    pub manager: Arc<CapabilityManager>,
    pub torrent_file_id: String,
    pub tf_durable_key: String,
    pub slots_before: usize,
    pub slots_after: usize,
    pub api_delta: u64,
    pub elapsed_ms: u64,
}

pub struct CapabilityManager {
    pub tf: ControlTorrentFile,
    pub slots: Vec<Slot>,
    pub keys: ApiKeys,
    pub client: reqwest::Client,
    pub metrics: Arc<Metrics>,
    // single-flight map: key -> in-flight acquire shared across waiters.
    inflight: AsyncMutex<HashMap<String, Arc<InFlight>>>,
    // bounded negative cache (§7): recent HARD acquisition failures, shared by waiters.
    neg_cache: Mutex<HashMap<String, NegEntry>>,
    neg_ttl: Duration,
    pub pool_growth_reasons: Mutex<Vec<String>>,
    pool_max_default: usize,
}

/// Transient errors (429/5xx) must never become long-lived negative state (§7). Only
/// hard failures (e.g. dead-link / revoked / protocol-invalid) are cached briefly.
fn is_hard_failure(e: &AcquireError) -> bool {
    !matches!(e, AcquireError::RateLimited(_) | AcquireError::Transient(_))
}

impl CapabilityManager {
    pub fn new(
        tf: ControlTorrentFile,
        coords: Vec<ProviderCoord>,
        keys: ApiKeys,
        client: reqwest::Client,
        metrics: Arc<Metrics>,
    ) -> Self {
        // Default slot grouping: identical to the pre-P15 behavior. We
        // group coords by placement, pick the file whose size matches the
        // authoritative TorrentFile, and build a Slot per group. The
        // resulting slot iteration order is whatever HashMap iteration
        // produces, which is what the existing system has always done
        // (and is what other code paths and tests rely on). S-1 order
        // is NOT modified here. P15's bench uses an EXPLICIT,
        // opt-in, reversible env-var gate (DATA_PLANE_FORCE_SLOT_ORDER) below
        // to deterministically target a specific provider as the first
        // slot; the default is unchanged.
        let mut groups: HashMap<(String, String, String), Vec<ProviderCoord>> = HashMap::new();
        for c in coords {
            groups
                .entry((
                    c.provider.clone(),
                    c.account_scope.clone(),
                    c.provider_resource_id.clone(),
                ))
                .or_default()
                .push(c);
        }
        let mut slots = Vec::new();
        for ((provider, scope, resource), files) in groups {
            let target = files
                .iter()
                .find(|f| f.size == tf.size)
                .or_else(|| files.first());
            if let Some(t) = target {
                // P3 final identity check, conclusion B: the slot
                // carries the stable durable_key derived from
                // (info_hash, canonical_path, size), NOT the mutable
                // surrogate PK. The single-flight key and the
                // negative cache therefore cannot alias sibling files
                // AND survive a host DB reconstruction.
                let durable_key = crate::cache::TorrentFileId::compute_durable_key(
                    &tf.info_hash,
                    tf.canonical_internal_path.as_deref().unwrap_or(""),
                    tf.size,
                );
                slots.push(Slot {
                    coord: t.clone(),
                    // Current host PK. Retained for logging/forensics.
                    tf_id: tf.id.clone(),
                    durable_key,
                    target_file_id: t.provider_file_id.clone(),
                    breaker: Breaker::new(3, Duration::from_secs(30)),
                    caps: Mutex::new(Vec::new()),
                    target: AtomicUsize::new(1),
                });
                let _ = (provider, scope, resource);
            }
        }
        // P15: OPTIONAL, REVERSIBLE bench-only ordering gate. When unset
        // (the default), slot iteration order is identical to the
        // pre-P15 system (HashMap iteration; not deterministic). When
        // set, moves the named provider to the FRONT of its tfId's slot
        // list so the bench can deterministically force a specific
        // provider as the first-tried slot and DATA_PLANE_FORCE_SLOT_FAILURE
        // can target it. Relative order among non-named providers is
        // preserved.
        // Format: DATA_PLANE_FORCE_SLOT_ORDER="tfId:provider;tfId2:provider"
        // Empty env var = disabled (DEFAULT). NEVER set in production.
        if let Some(spec) = crate::env_canonical("DATA_PLANE_FORCE_SLOT_ORDER", "HY4_FORCE_SLOT_ORDER") {
            for entry in spec.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let mut parts = entry.splitn(2, ':');
                if let (Some(t), Some(p)) = (parts.next(), parts.next()) {
                    if t.trim() == tf.id {
                        let target_provider = p.trim().to_string();
                        if let Some(pos) = slots.iter().position(|s| s.coord.provider == target_provider) {
                            if pos > 0 {
                                let s = slots.remove(pos);
                                slots.insert(0, s);
                            }
                        }
                    }
                }
            }
        }
        let pool_max_default = std::env::var("POOL_MAX")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v >= 2)
            .unwrap_or(2);
        let neg_ttl = std::env::var("NEG_CACHE_TTL_SECONDS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(Duration::from_secs)
            .unwrap_or_else(|| Duration::from_secs(2));
        Self {
            tf,
            slots,
            keys,
            client,
            metrics,
            inflight: AsyncMutex::new(HashMap::new()),
            neg_cache: Mutex::new(HashMap::new()),
            neg_ttl,
            pool_growth_reasons: Mutex::new(Vec::new()),
            pool_max_default,
        }
    }

    fn pool_max(&self) -> usize {
        self.pool_max_default
    }

    fn record_pool_growth(&self, reason: String) {
        self.pool_growth_reasons.lock().unwrap().push(reason);
        self.metrics.pool_growths.fetch_add(1, Ordering::SeqCst);
    }

    /// Resolve a capability for a given pool index with single-flight dedupe and a bounded
    /// negative cache for hard failures.
    async fn resolve_internal(
        &self,
        slot: &Slot,
        idx: usize,
    ) -> Result<Arc<DeliveryCapability>, AcquireError> {
        let key = format!("{}#{}", slot.sf_key(), idx);
        let coord = slot.coord.clone();
        let tf = self.tf.clone();
        let keys = self.keys.clone();
        let client = self.client.clone();
        let metrics = self.metrics.clone();

        // Negative cache (§7): a recent HARD failure is shared by all waiters so we don't
        // make N identical provider calls. Transient failures were never inserted.
        {
            let mut nc = self.neg_cache.lock().unwrap();
            if let Some(entry) = nc.get(&key) {
                if Instant::now() < entry.expires_at {
                    self.metrics.record_negative_hit();
                    return Err(entry.err.clone());
                }
                nc.remove(&key);
            }
        }

        loop {
            // fast path: already present and still usable
            if let Some(c) = slot.caps.lock().unwrap().get(idx).cloned() {
                if c.usable_now(Instant::now()) {
                    return Ok(c);
                }
            }
            let entry = {
                let mut m = self.inflight.lock().await;
                if let Some(e) = m.get(&key) {
                    e.clone()
                } else {
                    let e = Arc::new(InFlight::new());
                    m.insert(key.clone(), e.clone());
                    e
                }
            };
            if entry.done.load(Ordering::SeqCst) {
                let r = entry.result.lock().unwrap();
                if let Some(res) = &*r {
                    return res.clone();
                }
            }
            // try to become the owner (only one task acquires per key)
            if entry
                .owner
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                // P15: RUNTIME fault injection, INSIDE the per-slot acquisition
                // path. This is after manager construction (the slot already
                // exists in self.slots, the in-flight dedupe key has been
                // claimed, and the per-slot breaker is healthy), and before
                // the actual provider::acquire call. The denied provider's
                // slot is NOT removed from the slot list (BOTH coords still
                // entered the manager) but THIS specific acquire call
                // returns NoCapability, which:
                //   1) is classified as a HARD failure by is_hard_failure
                //   2) populates the bounded negative cache (existing neg_ttl)
                //   3) is returned to try_slot which records
                //      slot.breaker.record_failure()
                //   4) is returned to acquire_for_read which iterates to the
                //      next slot in the same tfId
                // No provider API is called by the denied slot (no TB
                // requestdl, no RD /torrents + /torrents/info/{id} +
                // /unrestrict/link). Zero DB writes. Zero DeliveryCapability
                // persisted. Other slots remain healthy.
                // Format: DATA_PLANE_FORCE_SLOT_FAILURE="tfId:provider;tfId2:provider"
                // Empty = disabled. NEVER set in production.
                if let Some(spec) = crate::env_canonical("DATA_PLANE_FORCE_SLOT_FAILURE", "HY4_FORCE_SLOT_FAILURE") {
                    let mut denied = false;
                    for entry in spec.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                        let mut parts = entry.splitn(2, ':');
                        if let (Some(t), Some(p)) = (parts.next(), parts.next()) {
                            if t.trim() == tf.id && p.trim() == coord.provider {
                                denied = true;
                                break;
                            }
                        }
                    }
                    if denied {
                        eprintln!(
                            "[p15] DATA_PLANE_FORCE_SLOT_FAILURE: tfId={} provider={} slot_attempted=1 slot_failed=1 reason=runtime_injected",
                            tf.id, coord.provider
                        );
                        let res: Result<Arc<DeliveryCapability>, AcquireError> = Err(
                            AcquireError::NoCapability(format!(
                                "p15 runtime fault: tfId={} provider={} denied",
                                tf.id, coord.provider
                            )),
                        );
                        // Cache the hard failure briefly so concurrent readers
                        // don't all repeat the injection (consistent with the
                        // existing hard-failure path below).
                        self.neg_cache.lock().unwrap().insert(
                            key.clone(),
                            NegEntry {
                                expires_at: Instant::now() + self.neg_ttl,
                                err: res.as_ref().unwrap_err().clone(),
                            },
                        );
                        *entry.result.lock().unwrap() = Some(res.clone());
                        entry.done.store(true, Ordering::SeqCst);
                        entry.notify.notify_waiters();
                        self.inflight.lock().await.remove(&key);
                        return res;
                    }
                }
                let res = provider::acquire(&coord, &tf, &keys, &client, &metrics).await;
                // P15: log first-ever attempt per slot (one line per slot per
                // process lifetime, guarded by a static mutex). This is the
                // evidence that a given provider's slot was actually exercised
                // inside the manager. Pair with the failure line above to
                // prove attempt+fail+failover within a single tfId.
                if res.is_ok() {
                    use std::sync::OnceLock;
                    static LOGGED: OnceLock<std::sync::Mutex<std::collections::HashSet<(String,String)>>> =
                        OnceLock::new();
                    let set = LOGGED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
                    let mut g = set.lock().unwrap();
                    let key2 = (tf.id.clone(), coord.provider.clone());
                    if g.insert(key2) {
                        eprintln!(
                            "[p15] slot_attempted: tfId={} provider={} slot_served=1",
                            tf.id, coord.provider
                        );
                    }
                }
                if res.is_err() {
                    // Cache only HARD failures briefly (§7). Transient 429/5xx are not
                    // allowed to become long-lived negative state.
                    if is_hard_failure(res.as_ref().unwrap_err()) {
                        self.neg_cache.lock().unwrap().insert(
                            key.clone(),
                            NegEntry {
                                expires_at: Instant::now() + self.neg_ttl,
                                err: res.as_ref().unwrap_err().clone(),
                            },
                        );
                    }
                }
                *entry.result.lock().unwrap() = Some(res.clone());
                entry.done.store(true, Ordering::SeqCst);
                entry.notify.notify_waiters();
                self.inflight.lock().await.remove(&key);
                return res;
            }
            // waiter: double-checked wait to avoid lost wakeups
            loop {
                if entry.done.load(Ordering::SeqCst) {
                    let r = entry.result.lock().unwrap();
                    if let Some(res) = &*r {
                        return res.clone();
                    }
                }
                let notified = entry.notify.notified();
                if entry.done.load(Ordering::SeqCst) {
                    continue;
                }
                notified.await;
            }
        }
    }

    fn first_usable_free(&self, slot: &Slot, now: Instant) -> Option<Arc<DeliveryCapability>> {
        slot.caps
            .lock()
            .unwrap()
            .iter()
            .find(|c| c.usable_now(now) && c.limiter.available_permits() > 0)
            .cloned()
    }

    /// A cap that is Alive, usable, but currently busy (permit taken). This is the ONLY
    /// signal for pool growth: genuine concurrent read pressure. A Throttled cap is NOT a
    /// growth signal (§6: we wait it out, we do not mint a 2nd capability / 2nd requestdl).
    fn first_alive_busy(&self, slot: &Slot, now: Instant) -> Option<Arc<DeliveryCapability>> {
        slot.caps
            .lock()
            .unwrap()
            .iter()
            .find(|c| {
                c.usable_now(now)
                    && matches!(c.status(), CapabilityStatus::Alive)
                    && c.limiter.available_permits() == 0
            })
            .cloned()
    }

    /// A cap we can block/WAIT on (§6 Warpbox-style blocking): any cap that is not dead
    /// and not prunable. Used in the final blocking step so a Throttled cap is waited out
    /// (and then reused with its SAME URL) rather than triggering a re-acquire.
    fn first_waitable(&self, slot: &Slot, now: Instant) -> Option<Arc<DeliveryCapability>> {
        slot.caps
            .lock()
            .unwrap()
            .iter()
            .find(|c| !matches!(c.status(), CapabilityStatus::Dead) && !c.prunable(now))
            .cloned()
    }

    fn try_reserve(&self, cap: &Arc<DeliveryCapability>) -> Option<ReservedCapability> {
        match cap.limiter.clone().try_acquire_owned() {
            Ok(permit) => {
                cap.in_flight.fetch_add(1, Ordering::SeqCst);
                Some(ReservedCapability {
                    cap: cap.clone(),
                    _permit: permit,
                })
            }
            Err(_) => None,
        }
    }

    /// Try to satisfy one read from one slot. Returns a reserved cap, or an
    /// AcquireError (rate-limited / no-capability / transient) so the caller can
    /// fail over to the next slot.
    async fn try_slot(
        &self,
        slot: &Slot,
        now: Instant,
        priority: u8,
    ) -> Result<ReservedCapability, AcquireError> {
        // 0) prune dead/expired capabilities so the pool can be refilled. Without this
        //    an expired (e.g. TTL'd) or revoked cap would sit in the slot forever at
        //    caps.len()==target, permanently blocking re-acquisition. Throttled caps are
        //    NOT pruned (they recover and keep their URL — see §5/§6).
        {
            let mut caps = slot.caps.lock().unwrap();
            let before = caps.len();
            caps.retain(|c| !c.prunable(now));
            let evicted = before - caps.len();
            for _ in 0..evicted {
                self.metrics.record_cap_eviction();
            }
        }
        // 1) existing usable + free capability -> REUSE (counted)
        if let Some(cap) = self.first_usable_free(slot, now) {
            if let Some(r) = self.try_reserve(&cap) {
                self.metrics.record_cap_reuse();
                return Ok(r);
            }
        }
        // 2) pressure: a usable cap exists AND is genuinely busy (Alive, permit taken)
        //    -> grow pool 1->2 (measured), recording the reason. 2->4 only via explicit
        //    POOL_MAX opt-in. A merely Throttled cap is NOT a growth signal (we wait it).
        if self.first_alive_busy(slot, now).is_some() {
            let cur = slot.target.load(Ordering::SeqCst);
            if cur < self.pool_max() && !slot.breaker.is_open(now) {
                slot.target.store(cur + 1, Ordering::SeqCst);
                self.record_pool_growth(format!(
                    "concurrent-read-pressure slot={} {}->{} pri={}",
                    slot.sf_key(),
                    cur,
                    cur + 1,
                    priority
                ));
            }
        }
        // 3) grow up to target
        while slot.caps.lock().unwrap().len() < slot.target.load(Ordering::SeqCst)
            && !slot.breaker.is_open(now)
        {
            let idx = slot.caps.lock().unwrap().len();
            match self.resolve_internal(slot, idx).await {
                Ok(cap) => {
                    slot.caps.lock().unwrap().push(cap.clone());
                    if let Some(r) = self.try_reserve(&cap) {
                        return Ok(r);
                    }
                }
                Err(e) => {
                    slot.breaker.record_failure();
                    return Err(e);
                }
            }
        }
        // 4) all at target & busy -> block on the first waitable cap (§6 Warpbox-style
        //    blocking). If it is Throttled we WAIT OUT the cooldown and then REUSE the
        //    SAME capability (no new requestdl); if merely busy we wait for its permit.
        //    Either way: REUSE (counted), never a re-acquire on a transient 429.
        if let Some(cap) = self.first_waitable(slot, now) {
            if matches!(cap.status(), CapabilityStatus::Throttled) {
                let until = cap.throttle_until();
                let wait = until.saturating_duration_since(Instant::now());
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
            }
            // Slice 4.75 — instrument permit contention.
            //
            // This is the blocking acquire for the capability's maxInFlight=1
            // permit, i.e. the literal "wait behind the shared limiter" that
            // §6 describes. It had no counter: `limiter_waits` was wired in
            // Slice 4.5 only to the 429/5xx throttle cooldown inside
            // transport.rs. Slice 4.75 proof M measured 8 chunk spans claimed
            // concurrently that serialized 4.64x behind this gate while
            // `limiter_waits` stayed at 0 — the counter and its name disagreed.
            //
            // Contention is PREDICTED from `available_permits() == 0` rather
            // than inferred from elapsed time: the prediction is racy by one
            // acquire in either direction (a permit may free before we await,
            // or be taken between the check and the await), but it is
            // deterministic, cheap, and never fabricates a wait that did not
            // happen. Elapsed time is recorded either way.
            let contended = cap.limiter.available_permits() == 0;
            let waited_from = Instant::now();
            match cap.limiter.clone().acquire_owned().await {
                Ok(permit) => {
                    if contended {
                        self.metrics.record_limiter_permit_wait();
                        self.metrics
                            .add_limiter_wait_ms(waited_from.elapsed().as_millis() as u64);
                    }
                    cap.in_flight.fetch_add(1, Ordering::SeqCst);
                    self.metrics.record_cap_reuse();
                    return Ok(ReservedCapability {
                        cap: cap.clone(),
                        _permit: permit,
                    });
                }
                Err(_) => return Err(AcquireError::Transient("permit closed".into())),
            }
        }
        Err(AcquireError::NoCapability(
            "slot has no usable capability".into(),
        ))
    }

    /// Acquire a reserved capability for one read, failing over across all Node-supplied
    /// providers for the SAME TorrentFile. Returns AllSameTfFailed only when every slot
    /// is exhausted and none can recover in flight.
    pub async fn acquire_for_read(
        &self,
        priority: u8,
    ) -> Result<ReservedCapability, DeliveryError> {
        let now = Instant::now();
        let mut last_err: Option<String> = None;
        let mut retry_after: Option<Duration> = None;
        // iterate slots in Node-supplied preference order
        for slot in &self.slots {
            if slot.breaker.is_open(now) {
                last_err = Some("breaker-open".into());
                self.metrics.record_breaker_open();
                continue;
            }
            match self.try_slot(slot, now, priority).await {
                Ok(r) => {
                    slot.breaker.record_success();
                    return Ok(r);
                }
                Err(AcquireError::RateLimited(ra)) => {
                    retry_after = retry_after.or(ra);
                    last_err = Some("rate-limited".into());
                    continue; // fail over to next provider
                }
                Err(e) => {
                    slot.breaker.record_failure();
                    last_err = Some(format!("{e}"));
                    continue;
                }
            }
        }
        self.metrics.all_same_tf.fetch_add(1, Ordering::SeqCst);
        Err(DeliveryError::AllSameTfFailed {
            last: last_err,
            retry_after,
        })
    }

    /// P9 — best-effort, NON-BLOCKING capability acquire for SPECULATIVE
    /// (prefetch) work.
    ///
    /// Returns `Some(cap)` only when a capability is *immediately free* — i.e.
    /// `usable_now()` is true AND its `maxInFlight=1` permit is available. It
    /// NEVER blocks on a busy permit, NEVER grows the pool (no 2nd capability /
    /// extra requestdl), and NEVER waits out a Throttle cooldown. If no
    /// capability is free right now, it returns `None` so the caller can drop the
    /// speculative fill and never delay a real demand read.
    ///
    /// This is the single seam that keeps prefetch inside the SAME provider
    /// scheduler/limiter/breaker the demand path uses: prefetch reuses an idle
    /// capability instead of opening a parallel provider stack, and because the
    /// acquire is non-blocking it can never sit in front of demand in the
    /// limiter's wait queue.
    pub fn acquire_for_read_try(&self, _priority: u8) -> Option<ReservedCapability> {
        let now = Instant::now();
        for slot in &self.slots {
            if slot.breaker.is_open(now) {
                continue;
            }
            // Drop dead/expired caps so a free one isn't masked by a prunable one.
            // Scoped so the lock is released before first_usable_free re-locks.
            {
                let mut caps = slot.caps.lock().unwrap();
                caps.retain(|c| !c.prunable(now));
            }
            if let Some(cap) = self.first_usable_free(slot, now) {
                if let Some(r) = self.try_reserve(&cap) {
                    self.metrics.record_cap_reuse();
                    return Some(r);
                }
            }
        }
        None
    }

    /// P9 — bounded, speculation-aware capability acquire for prefetch.
    ///
    /// Like `acquire_for_read_try` it NEVER grows the pool (no 2nd capability /
    /// extra requestdl) and NEVER waits out a Throttle cooldown. Unlike the try
    /// variant it is willing to wait BRIEFLY for a currently-busy capability to
    /// free, so prefetch can actually run during idle gaps in demand and stage
    /// the next chunk(s) ahead — the real read-ahead benefit. The wait is BOUNDED
    /// by `PREFETCH_WAIT_BUDGET` so prefetch can never sit in front of demand for
    /// longer than a genuine idle gap: if the capability does not free within the
    /// budget (demand is keeping it busy), prefetch bails and demand is never
    /// delayed. Picks ONE usable (non-throttled) cap and waits on ITS limiter —
    /// the same single concurrency domain demand uses, so there is no parallel
    /// provider stack and no API amplification.
    pub async fn acquire_for_read_prefetch(&self, _priority: u8) -> Option<ReservedCapability> {
        const BUDGET: std::time::Duration = std::time::Duration::from_millis(1000);
        let now = Instant::now();
        for slot in &self.slots {
            if slot.breaker.is_open(now) {
                continue;
            }
            {
                let mut caps = slot.caps.lock().unwrap();
                caps.retain(|c| !c.prunable(now));
            }
            // (1) immediately free?
            if let Some(cap) = self.first_usable_free(slot, now) {
                if let Some(r) = self.try_reserve(&cap) {
                    self.metrics.record_cap_reuse();
                    return Some(r);
                }
            }
            // (2) wait (bounded) for a usable, non-throttled cap to free. No pool
            //     growth, no re-acquire: we block on the SAME cap's limiter.
            let waitable = slot
                .caps
                .lock()
                .unwrap()
                .iter()
                .find(|c| c.usable_now(now) && !matches!(c.status(), CapabilityStatus::Throttled))
                .cloned();
            if let Some(cap) = waitable {
                match tokio::time::timeout(BUDGET, cap.limiter.clone().acquire_owned()).await {
                    Ok(Ok(permit)) => {
                        cap.in_flight.fetch_add(1, Ordering::SeqCst);
                        self.metrics.record_cap_reuse();
                        return Some(ReservedCapability {
                            cap: cap.clone(),
                            _permit: permit,
                        });
                    }
                    _ => return None, // timed out or closed: bail, never delay demand
                }
            }
            // (3) only throttled/dead caps: do not pile onto a throttling provider;
            //     bail so demand (which waits out the cooldown itself) is never made
            //     to wait behind speculative work.
        }
        None
    }

    /// P10 — read-only SPARE-CAPACITY signal for gating Wait-style prefetch.
    ///
    /// Returns the count of capabilities that are *immediately free* right now:
    /// `usable_now()` (not Dead/expired/Throttled) AND their maxInFlight=1 permit is
    /// available. This is the exact number of healthy idle lanes. It does NOT redesign
    /// the scheduler and does NOT create a queue — it is a single O(slots×caps) scan
    /// used only to answer "is there a lane a speculative fill can borrow without making
    /// demand wait?". `0` ⇒ the only lane is busy with demand ⇒ prefetch must stay in
    /// Try mode (never Wait). No amplification, no pool growth, no new concurrency domain.
    pub fn spare_capacity(&self) -> u32 {
        let now = Instant::now();
        let mut free = 0u32;
        for slot in &self.slots {
            if slot.breaker.is_open(now) {
                continue;
            }
            let caps = slot.caps.lock().unwrap();
            for cap in caps.iter() {
                if cap.usable_now(now) && cap.limiter.available_permits() > 0 {
                    free += 1;
                }
            }
        }
        free
    }

    /// §5 DEAD-link path: a capability came back 401/403/404/410 (or provider dead-link
    /// evidence) on actual media use. The cap is suspect/dead, so we single-flight
    /// re-acquire a FRESH capability for the same coord ONCE and let the caller retry the
    /// original Range. A transient (429/5xx) does NOT come here — it waits out a cooldown
    /// and reuses the same cap (see try_slot step 4). We do NOT infer capability death
    /// merely because another was minted, and we do NOT recreate the provider placement.
    pub async fn reacquire_for_read(
        &self,
        _priority: u8,
    ) -> Result<ReservedCapability, DeliveryError> {
        let now = Instant::now();
        let slot = match self.slots.iter().find(|s| !s.breaker.is_open(now)) {
            Some(s) => s,
            None => {
                self.metrics.all_same_tf.fetch_add(1, Ordering::SeqCst);
                return Err(DeliveryError::AllSameTfFailed {
                    last: Some("all breakers open on reacquire".into()),
                    retry_after: None,
                });
            }
        };
        // Drop dead/expired caps so the fresh acquire isn't blocked by a dead one still
        // occupying the slot.
        slot.caps.lock().unwrap().retain(|c| !c.prunable(now));
        let cap = match self.resolve_internal(slot, 0).await {
            Ok(c) => c,
            Err(_e) => {
                slot.breaker.record_failure();
                return Err(DeliveryError::AllSameTfFailed {
                    last: Some("reacquire failed".into()),
                    retry_after: None,
                });
            }
        };
        if let Some(r) = self.try_reserve(&cap) {
            return Ok(r);
        }
        // Acquired but the in-flight permit was taken in a race: add to the slot and retry.
        slot.caps.lock().unwrap().push(cap.clone());
        match self.try_reserve(&cap) {
            Some(r) => Ok(r),
            None => Err(DeliveryError::AllSameTfFailed {
                last: Some("reacquire reserve failed".into()),
                retry_after: None,
            }),
        }
    }

    /// Snapshot of pooling state for telemetry / reporting (honest, MEASURED).
    pub fn pool_summary(&self) -> Vec<(String, usize, usize)> {
        self.slots
            .iter()
            .map(|s| {
                (
                    s.sf_key(),
                    s.caps.lock().unwrap().len(),
                    s.target.load(Ordering::SeqCst),
                )
            })
            .collect()
    }

    /// Observability-only per-capability pool attribution for the /metrics pool_attribution field.
    /// Each entry carries provider, capability id, status, busy/free, and breaker state.
    /// Provider is execution metadata, NOT part of TorrentFile/cache byte identity.
    pub fn pool_attribution(&self) -> Vec<serde_json::Value> {
        use serde_json::json;
        let now = Instant::now();
        let mut out = Vec::new();
        for s in &self.slots {
            for c in s.caps.lock().unwrap().iter() {
                let status = c.status();
                let busy = c.limiter.available_permits() == 0 || c.in_flight.load(Ordering::SeqCst) > 0;
                out.push(json!({
                    "provider": c.provider,
                    "cap_id": c.cap_id,
                    "account_scope": c.account_scope,
                    "provider_resource_id": c.provider_resource_id,
                    "status": match status {
                        CapabilityStatus::Alive => "alive",
                        CapabilityStatus::Degraded => "degraded",
                        CapabilityStatus::Throttled => "throttled",
                        CapabilityStatus::Dead => "dead",
                    },
                    "busy": busy,
                    "expires_in_ms": c.expires_in_ms(now),
                    "breaker_open": s.breaker.is_open(now),
                }));
            }
        }
        out
    }

    /// Warm standby reservation:
    /// reserve a healthy FREE capability from the SAME slot as the
    /// primary, ensuring same-provider/account standby with zero
    /// acquisition overhead. Returns `None` if no usable standby exists.
    ///
    /// Phase 2 (`DATA_PLANE_CROSS_PROVIDER_STANDBY=1`, default OFF): when the
    /// primary's own slot has no usable standby, other slots are eligible
    /// under a strict same-exact-TorrentFile bound: the candidate slot's
    /// `durable_key` (stable `(info_hash, canonical_path, size)` digest,
    /// provider-independent) must equal the primary slot's. Same-provider
    /// standby is therefore always preferred (phase 1 runs first);
    /// cross-provider standby is explicit, warm-only (usable + free, zero
    /// acquisition API calls), and can never cross TorrentFiles.
    ///
    /// Returns the reservation together with the STANDBY SLOT's
    /// `durable_key` — the slot-authoritative TorrentFile identity both
    /// ends were checked against. Callers must use THIS for TorrentFile
    /// correlation, never a fill-local reconstruction.
    ///
    /// Additive warm-only selection path: pool growth, first_alive_busy,
    /// acquire/reacquire ordering, limiter/breaker, and negative cache
    /// are untouched. Returned reservations hold the normal per-cap
    /// permit (maxInFlight=1 preserved).
    pub fn reserve_standby(
        &self,
        primary_cap: &Arc<DeliveryCapability>,
    ) -> Option<(ReservedCapability, String)> {
        let now = Instant::now();
        // Identity anchor for phase 2: index of the slot holding primary.
        let primary_idx = self.slots.iter().position(|slot| {
            slot.caps
                .lock()
                .unwrap()
                .iter()
                .any(|c| Arc::ptr_eq(c, primary_cap))
        });
        let idx = match primary_idx {
            Some(i) => i,
            None => return None,
        };
        // Phase 1: same slot (explicit same-provider-first rule).
        if let Some(r) = self.reserve_free_in_slot(&self.slots[idx], primary_cap, now) {
            return Some((r, self.slots[idx].durable_key.clone()));
        }
        // Phase 2: cross-provider standby, same exact TorrentFile only.
        if crate::env_canonical("DATA_PLANE_CROSS_PROVIDER_STANDBY", "HY4_CROSS_PROVIDER_STANDBY")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            let anchor = self.slots[idx].durable_key.clone();
            for (j, slot) in self.slots.iter().enumerate() {
                if j == idx || slot.durable_key != anchor {
                    continue;
                }
                if let Some(r) = self.reserve_free_in_slot(slot, primary_cap, now) {
                    return Some((r, slot.durable_key.clone()));
                }
            }
        }
        None
    }

    /// One slot's share of standby selection: a DIFFERENT usable free cap,
    /// reserved without acquisition. Shared by the same-slot phase and the
    /// cross-provider phase so the health/free criteria cannot drift apart.
    fn reserve_free_in_slot(
        &self,
        slot: &Slot,
        primary_cap: &Arc<DeliveryCapability>,
        now: Instant,
    ) -> Option<ReservedCapability> {
        self.reserve_free_in_slot_excluding(slot, primary_cap, &[], now)
    }

    /// Standby reservation excluding specific capabilities
    /// m3-north-db): warm-only standby with retired-cap exclusion.
    ///
    /// Same two phases and same warm-only criteria as `reserve_standby`
    /// (free permit, usable now, same exact TorrentFile via the slot
    /// durable_key anchor); additionally refuses any candidate whose
    /// observability-only `cap_id` appears in `exclude_cap_ids` (retired
    /// lane caps must never be immediately reselected). No acquisition, no
    /// scoring, no enumeration API -- one extra predicate on the existing
    /// search. Returns the reservation plus its slot-authoritative
    /// durable_key so callers keep the same-TF invariant check.
    /// `reserve_standby` itself is untouched (it delegates with an empty
    /// exclusion list).
    pub fn reserve_standby_excluding(
        &self,
        primary_cap: &Arc<DeliveryCapability>,
        exclude_cap_ids: &[String],
    ) -> Option<(ReservedCapability, String)> {
        let now = Instant::now();
        // Identity anchor for phase 2: index of the slot holding primary.
        let primary_idx = self.slots.iter().position(|slot| {
            slot.caps
                .lock()
                .unwrap()
                .iter()
                .any(|c| Arc::ptr_eq(c, primary_cap))
        });
        let idx = match primary_idx {
            Some(i) => i,
            None => return None,
        };
        // Phase 1: same slot (explicit same-provider-first rule).
        if let Some(r) =
            self.reserve_free_in_slot_excluding(&self.slots[idx], primary_cap, exclude_cap_ids, now)
        {
            return Some((r, self.slots[idx].durable_key.clone()));
        }
        // Phase 2: cross-provider standby, same exact TorrentFile only.
        if crate::env_canonical("DATA_PLANE_CROSS_PROVIDER_STANDBY", "HY4_CROSS_PROVIDER_STANDBY")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            let anchor = self.slots[idx].durable_key.clone();
            for (j, slot) in self.slots.iter().enumerate() {
                if j == idx || slot.durable_key != anchor {
                    continue;
                }
                if let Some(r) =
                    self.reserve_free_in_slot_excluding(slot, primary_cap, exclude_cap_ids, now)
                {
                    return Some((r, slot.durable_key.clone()));
                }
            }
        }
        None
    }

    /// One slot's share of standby selection with a retired-cap exclusion
    /// list. Identical health/free criteria to `reserve_free_in_slot`.
    fn reserve_free_in_slot_excluding(
        &self,
        slot: &Slot,
        primary_cap: &Arc<DeliveryCapability>,
        exclude_cap_ids: &[String],
        now: Instant,
    ) -> Option<ReservedCapability> {
        // Clone the Arc so the slot lock is dropped before try_reserve.
        let candidate = slot
            .caps
            .lock()
            .unwrap()
            .iter()
            .find(|c| {
                !Arc::ptr_eq(c, primary_cap)
                    && !exclude_cap_ids.contains(&c.cap_id)
                    && c.usable_now(now)
                    && c.limiter.available_permits() > 0
            })
            .cloned();
        if let Some(cap) = candidate {
            if let Some(r) = self.try_reserve(&cap) {
                self.metrics.record_cap_reuse();
                return Some(r);
            }
        }
        None
    }

    /// Explicit prewarm of an existing slot
    /// explicit warm-up for one EXISTING slot of this manager's exact
    /// TorrentFile. Names an existing `(provider, provider_resource_id)`
    /// placement; anything else reports `InvalidSlot` with zero
    /// acquisition and nothing created.
    ///
    /// Outcomes: `AlreadyWarm` (usable+free cap exists, zero API),
    /// `Warmed` (one bounded acquire through the existing single-flight;
    /// the new cap installs into the normal pool warm/free — no permit
    /// held, no reader opened, no bytes flow), `InFlight` (slot at
    /// target with no free lane; pool growth is demand's job, never
    /// prewarm's), `Unavailable` (slot breaker open), `Failed` (bounded
    /// acquire error, breaker recorded like try_slot).
    ///
    /// Never creates durable truth, never persists anything, never
    /// chooses another TorrentFile. Production adaptations vs the proven
    /// source: no fresh-S-1 validation (no StalePool; the manager's own
    /// TF truth anchors the outcome key), no `slot.note_reserve` (no
    /// such pool field — pool-growth behavior untouched), warmed cap
    /// reported by `cap_id` (production caps carry no generation), and
    /// the pool install mirrors production `try_slot` with the proven
    /// same-length guard so a concurrent demand install cannot over-fill
    /// the slot target.
    pub async fn prewarm_slot(
        &self,
        provider: &str,
        resource_id: &str,
    ) -> PrewarmOutcome {
        let t0 = Instant::now();
        let api_before = self.metrics.api_requests.load(Ordering::SeqCst);
        let finish = |status: PrewarmStatus, cap_id: Option<String>| PrewarmOutcome {
            status,
            torrent_file_id: self.tf.id.clone(),
            tf_durable_key: crate::cache::TorrentFileId::compute_durable_key(
                &self.tf.info_hash,
                self.tf.canonical_internal_path.as_deref().unwrap_or(""),
                self.tf.size,
            ),
            provider: provider.to_string(),
            provider_resource_id: resource_id.to_string(),
            cap_id,
            api_delta: self
                .metrics
                .api_requests
                .load(Ordering::SeqCst)
                .saturating_sub(api_before),
            elapsed_ms: t0.elapsed().as_millis() as u64,
        };
        // Guard: the named slot must exist in THIS pool.
        let idx = match self.slots.iter().position(|s| {
            s.coord.provider == provider && s.coord.provider_resource_id == resource_id
        }) {
            Some(i) => i,
            None => {
                return finish(
                    PrewarmStatus::InvalidSlot(
                        "no pool slot matches the requested placement coordinates".into(),
                    ),
                    None,
                );
            }
        };
        let now = Instant::now();
        let slot = &self.slots[idx];
        // Prune dead/expired so a dead cap cannot block warming (mirrors
        // try_slot step 0; throttled caps are kept — they recover).
        {
            let mut caps = slot.caps.lock().unwrap();
            let before = caps.len();
            caps.retain(|c| !c.prunable(now));
            let evicted = before - caps.len();
            for _ in 0..evicted {
                self.metrics.record_cap_eviction();
            }
        }
        // Already warm: usable + free, zero API.
        if let Some(cap) = self.first_usable_free(slot, now) {
            let id = cap.cap_id.clone();
            return finish(PrewarmStatus::AlreadyWarm, Some(id));
        }
        // Breaker open: do not hammer a broken provider on explicit request.
        if slot.breaker.is_open(now) {
            return finish(
                PrewarmStatus::Unavailable("slot breaker open".into()),
                None,
            );
        }
        // Slot at target with no free lane: report, never grow the pool.
        let (caps_len, target) = {
            let caps = slot.caps.lock().unwrap();
            (caps.len(), slot.target.load(Ordering::SeqCst))
        };
        if caps_len >= target {
            return finish(
                PrewarmStatus::InFlight("slot at target, no free lane".into()),
                None,
            );
        }
        // One bounded acquire through the existing single-flight
        // (concurrent identical prewarms share it: exactly one API call).
        // No try_reserve anywhere on this path: the warmed cap lands
        // warm/free, permit untouched for later standby reservation.
        match self.resolve_internal(slot, caps_len).await {
            Ok(cap) => {
                {
                    let mut caps = slot.caps.lock().unwrap();
                    // Proven same-length guard: a concurrent demand install
                    // may have filled the slot first — never over-fill.
                    if caps.len() == caps_len {
                        caps.push(cap.clone());
                    }
                }
                let id = cap.cap_id.clone();
                finish(PrewarmStatus::Warmed, Some(id))
            }
            Err(e) => {
                slot.breaker.record_failure();
                finish(PrewarmStatus::Failed(format!("{e}")), None)
            }
        }
    }

    /// Runtime slot refresh after durable placement change
    /// targeted runtime slot refresh from externally supplied fresh
    /// TorrentFile/placement truth. Pure constructor: never mutates `old`
    /// (readers holding it are undisturbed) and never acquires (no
    /// provider calls, no media bytes, nothing persisted).
    ///
    /// Lineage is validated once: the manager's own TF durable identity
    /// must equal fresh truth — otherwise `Conflict` with live state
    /// kept. On match, the inventory rebuilds from fresh truth: slots
    /// fresh truth no longer lists are dropped
    /// semantic — rebuild-from-truth, never selective deletion);
    /// surviving slots migrate capabilities BY ARC (warmth preserved,
    /// limiters still globally enforced) plus pool targets; newly-visible
    /// slots start empty for T3 prewarm to fill. Identical inventories
    /// reuse the input manager (`AlreadyCurrent`).
    ///
    /// Production adaptations vs the proven source: whole-inventory form
    /// (no per-placement request tuple, no endpoint/Node caller in this
    /// slice — hence no UnknownPlacement/per-tuple Conflict branches);
    /// fresh breakers per slot (as proven — refresh re-arms placement
    /// liveness explicitly, never implicitly); no `last_reserve` clock
    /// migration (no such pool field). Callers swap to the returned
    /// manager iff the outcome is `Refreshed`.
    pub fn refresh_slots(
        old: &Arc<CapabilityManager>,
        fresh_tf: &ControlTorrentFile,
        fresh_coords: &[ProviderCoord],
        keys: ApiKeys,
        client: reqwest::Client,
        metrics: Arc<Metrics>,
    ) -> RefreshOutcome {
        let t0 = Instant::now();
        let api_before = metrics.api_requests.load(Ordering::SeqCst);
        // Cloned for the rebuild branch: `finish` below borrows `metrics`
        // for api_delta reads, so the move into Self::new must use a clone.
        let metrics_for_build = metrics.clone();
        let durable_of = |tf: &ControlTorrentFile| {
            crate::cache::TorrentFileId::compute_durable_key(
                &tf.info_hash,
                tf.canonical_internal_path.as_deref().unwrap_or(""),
                tf.size,
            )
        };
        let finish = |status: RefreshStatus,
                      manager: Arc<CapabilityManager>,
                      slots_before: usize,
                      slots_after: usize| {
            RefreshOutcome {
                status,
                manager,
                torrent_file_id: old.tf.id.clone(),
                tf_durable_key: durable_of(&old.tf),
                slots_before,
                slots_after,
                api_delta: metrics
                    .api_requests
                    .load(Ordering::SeqCst)
                    .saturating_sub(api_before),
                elapsed_ms: t0.elapsed().as_millis() as u64,
            }
        };
        let slots_before = old.slots.len();
        // Lineage: this manager must be for the same exact TorrentFile as
        // fresh truth (and fresh truth must list something). Otherwise
        // live state is kept, untouched.
        if fresh_coords.is_empty() || durable_of(&old.tf) != durable_of(fresh_tf) {
            return finish(
                RefreshStatus::Conflict(
                    "fresh truth is for another TorrentFile; live state kept".into(),
                ),
                old.clone(),
                slots_before,
                slots_before,
            );
        }
        // Inventory already current: the live placement-tuple set equals
        // the fresh set. Reuse the input manager as-is.
        let tuple_of = |provider: &str, scope: &str, resource: &str, file: &str| {
            (
                provider.to_string(),
                scope.to_string(),
                resource.to_string(),
                file.to_string(),
            )
        };
        let live: HashSet<_> = old
            .slots
            .iter()
            .map(|s| {
                tuple_of(
                    &s.coord.provider,
                    &s.coord.account_scope,
                    &s.coord.provider_resource_id,
                    &s.target_file_id,
                )
            })
            .collect();
        let fresh: HashSet<_> = fresh_coords
            .iter()
            .map(|c| {
                tuple_of(
                    &c.provider,
                    &c.account_scope,
                    &c.provider_resource_id,
                    &c.provider_file_id,
                )
            })
            .collect();
        if live == fresh {
            return finish(
                RefreshStatus::AlreadyCurrent,
                old.clone(),
                slots_before,
                slots_before,
            );
        }
        // Materialize the fresh inventory; migrate surviving slots'
        // runtime state by Arc (caps + pool targets).
        let fresh = Arc::new(Self::new(
            fresh_tf.clone(),
            fresh_coords.to_vec(),
            keys,
            client,
            metrics_for_build,
        ));
        for new_slot in fresh.slots.iter() {
            if let Some(old_slot) = old.slots.iter().find(|s| {
                s.coord.provider == new_slot.coord.provider
                    && s.coord.account_scope == new_slot.coord.account_scope
                    && s.coord.provider_resource_id == new_slot.coord.provider_resource_id
            }) {
                let caps = old_slot.caps.lock().unwrap().clone();
                let target = old_slot.target.load(Ordering::SeqCst);
                *new_slot.caps.lock().unwrap() = caps;
                new_slot.target.store(target, Ordering::SeqCst);
            }
        }
        let slots_after = fresh.slots.len();
        finish(RefreshStatus::Refreshed, fresh, slots_before, slots_after)
    }
}
