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

use std::collections::HashMap;
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
    pub tf_id: String,
    pub target_file_id: String,
    pub breaker: Breaker,
    // acquired capabilities for this placement (length <= target).
    pub caps: Mutex<Vec<Arc<DeliveryCapability>>>,
    pub target: AtomicUsize,
}

impl Slot {
    fn sf_key(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            self.coord.provider,
            self.coord.account_scope,
            self.tf_id,
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

pub enum DeliveryError {
    AllSameTfFailed {
        last: Option<String>,
        retry_after: Option<Duration>,
    },
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
        // Group coords by placement; pick the file whose size matches the authoritative
        // TorrentFile (Node already supplied the mapping — we do NOT discover it).
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
                slots.push(Slot {
                    coord: t.clone(),
                    tf_id: tf.info_hash.clone(),
                    target_file_id: t.provider_file_id.clone(),
                    breaker: Breaker::new(3, Duration::from_secs(30)),
                    caps: Mutex::new(Vec::new()),
                    target: AtomicUsize::new(1),
                });
                let _ = (provider, scope, resource);
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
                let res = provider::acquire(&coord, &tf, &keys, &client, &metrics).await;
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
}
