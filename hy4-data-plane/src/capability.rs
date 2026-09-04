// Slice 3 — DeliveryCapability runtime object, provider/account breaker, Retry-After.
//
// A DeliveryCapability is a PRIVATE runtime artifact. Its `runtime_url` is a signed
// provider delivery URL that must NEVER be logged, exposed in a response, persisted,
// or treated as durable identity. It lives only inside the Rust data plane for the
// duration of a session. Validity/expiry policy (CASE A-D):
//   CASE A: explicit expiry (signed short-lived URL) -> honor expires_at.
//   CASE B: 403/401/410 on use -> Dead (provider revoked it; re-acquire or next provider).
//   CASE C: 5xx/timeout/transient -> Degraded (keep, breaker may open).
//   CASE D: 429 on use -> Throttled (honor Retry-After / cooldown; never poison TorrentFile).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Semaphore;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityStatus {
    Alive,
    Degraded, // transiently unhealthy; may recover, breaker may trip
    Throttled, // rate-limited; respect cooldown window
    Dead,     // permanently unusable for this file (revoked/removed)
}

#[derive(Debug, Clone)]
pub enum AcquireError {
    RateLimited(Option<Duration>), // 429 — honor Retry-After, do NOT poison TorrentFile
    NoCapability(String),           // provider cannot produce a capability for this file
    Transient(String),             // network/unknown; retryable within a slot
}

impl std::fmt::Display for AcquireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AcquireError::RateLimited(d) => {
                write!(f, "rate_limited retry_after={:?}", d)
            }
            AcquireError::NoCapability(s) => write!(f, "no_capability: {s}"),
            AcquireError::Transient(s) => write!(f, "transient: {s}"),
        }
    }
}

#[derive(Debug)]
pub struct DeliveryCapability {
    // PRIVATE: never logged / exposed / persisted / used as identity.
    pub(crate) runtime_url: String,
    pub provider: String,
    pub account_scope: String,
    pub torrent_file_id: String, // infoHash
    pub provider_resource_id: String,
    pub provider_file_id: String,
    pub acquired_at: Instant,
    expires_at: Mutex<Option<Instant>>,
    status: Mutex<CapabilityStatus>,
    throttled_until: Mutex<Instant>,
    // maxInFlight = 1 per capability (per spec §limiter).
    pub limiter: Arc<Semaphore>,
    pub in_flight: AtomicU64,
}

impl DeliveryCapability {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        runtime_url: String,
        provider: String,
        account_scope: String,
        torrent_file_id: String,
        provider_resource_id: String,
        provider_file_id: String,
        ttl: Option<Duration>,
    ) -> Arc<Self> {
        Arc::new(Self {
            runtime_url,
            provider,
            account_scope,
            torrent_file_id,
            provider_resource_id,
            provider_file_id,
            acquired_at: Instant::now(),
            expires_at: Mutex::new(ttl.map(|d| Instant::now() + d)),
            status: Mutex::new(CapabilityStatus::Alive),
            throttled_until: Mutex::new(Instant::now()),
            limiter: Arc::new(Semaphore::new(1)),
            in_flight: AtomicU64::new(0),
        })
    }

    pub fn status(&self) -> CapabilityStatus {
        *self.status.lock().unwrap()
    }

    pub fn set_status(&self, s: CapabilityStatus) {
        *self.status.lock().unwrap() = s;
    }

    /// Usable right now? False if Dead, or expired (CASE A), or inside a Throttled
    /// cooldown window (CASE D). After a Throttled cooldown elapses the cap becomes
    /// usable AGAIN with its SAME URL (§5: 429 is transient, do NOT re-acquire).
    pub fn usable_now(&self, now: Instant) -> bool {
        if matches!(self.status(), CapabilityStatus::Dead) {
            return false;
        }
        if let Some(exp) = *self.expires_at.lock().unwrap() {
            if now >= exp {
                return false;
            }
        }
        if matches!(self.status(), CapabilityStatus::Throttled)
            && now < *self.throttled_until.lock().unwrap()
        {
            return false;
        }
        true
    }

    /// Should this cap be removed from the pool? Dead caps and expired (CASE A) caps
    /// are pruned. Throttled caps are NOT pruned — they recover after their cooldown
    /// and must keep their still-valid URL so we do NOT re-acquire a fresh requestdl
    /// on every throttle (§5/§6: a 429 is transient; re-acquiring would amplify API).
    pub fn prunable(&self, now: Instant) -> bool {
        if matches!(self.status(), CapabilityStatus::Dead) {
            return true;
        }
        if let Some(exp) = *self.expires_at.lock().unwrap() {
            if now >= exp {
                return true;
            }
        }
        false
    }

    /// Mark Throttled with a cooldown. We deliberately do NOT expire the cap here: a
    /// 429 is transient, and after the cooldown the SAME CDN URL must be reused, not
    /// re-acquired (which would re-hit requestdl and amplify provider API calls — the
    /// exact behavior Slice 3.5 exists to eliminate). Death/revocation is signalled by
    /// 401/403/404/410 via mark_dead(), which IS pruned and re-acquired.
    pub fn throttle(&self, until: Instant) {
        *self.status.lock().unwrap() = CapabilityStatus::Throttled;
        *self.throttled_until.lock().unwrap() = until;
    }

    pub fn mark_dead(&self) {
        *self.status.lock().unwrap() = CapabilityStatus::Dead;
    }

    /// Instant until which this cap is Throttled (cooldown window). Used by the manager's
    /// §6 Warpbox-style blocking step to wait out a transient 429 before reuse.
    pub fn throttle_until(&self) -> Instant {
        *self.throttled_until.lock().unwrap()
    }

    pub fn mark_degraded(&self) {
        let mut s = self.status.lock().unwrap();
        if !matches!(*s, CapabilityStatus::Dead) {
            *s = CapabilityStatus::Degraded;
        }
    }
}

// ---- Provider / account breaker -------------------------------------------
//
// Consecutive failures for a (provider, accountScope) open the breaker for a
// cooldown so we stop hammering a broken provider. Half-open: once the cooldown
// elapses a single probe is allowed (success resets, failure re-opens).
pub struct Breaker {
    failures: AtomicU64,
    opened_at: Mutex<Option<Instant>>,
    threshold: u64,
    cooldown: Duration,
}

impl Breaker {
    pub fn new(threshold: u64, cooldown: Duration) -> Self {
        Self {
            failures: AtomicU64::new(0),
            opened_at: Mutex::new(None),
            threshold,
            cooldown,
        }
    }

    pub fn record_failure(&self) {
        let f = self.failures.fetch_add(1, Ordering::SeqCst) + 1;
        if f >= self.threshold {
            *self.opened_at.lock().unwrap() = Some(Instant::now());
        }
    }

    pub fn record_success(&self) {
        self.failures.store(0, Ordering::SeqCst);
        *self.opened_at.lock().unwrap() = None;
    }

    pub fn is_open(&self, now: Instant) -> bool {
        let g = self.opened_at.lock().unwrap();
        match *g {
            Some(t) if now < t + self.cooldown => true,
            Some(_) => {
                drop(g);
                self.record_success(); // cooldown elapsed -> half-open reset
                false
            }
            None => false,
        }
    }
}

// ---- Retry-After ----------------------------------------------------------
//
// Numeric seconds: MEASURED (both TorBox and RD return numeric on 429).
// HTTP-date form: INFERRED best-effort (not parsed here; providers in scope use
// numeric). Returns None when absent/unknowable -> caller applies a default backoff.
pub fn parse_retry_after(hdr: Option<&str>) -> Option<Duration> {
    let h = hdr?;
    let t = h.trim();
    if let Ok(secs) = t.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    // HTTP-date form omitted (INFERRED): providers observed use numeric seconds.
    None
}

// ---- API keys (Rust owns credential use for acquisition; §8 rule 5) --------
#[derive(Clone)]
pub struct ApiKeys {
    pub torbox: String,
    pub realdebrid: String,
}

impl ApiKeys {
    pub fn from_env() -> Self {
        Self {
            torbox: std::env::var("TORBOX_API_KEY").unwrap_or_default(),
            realdebrid: std::env::var("REALDEBRID_API_KEY").unwrap_or_default(),
        }
    }
}
