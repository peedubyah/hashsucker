//! Endpoint-scoped provider backoff evidence (`Retry-After` ledger).
//!
//! ## Why this exists
//!
//! A provider's *acquisition* API (TorBox `/torrents/requestdl`,
//! Real-Debrid `/torrents` + `/unrestrict/link`) is a **per-account** endpoint:
//! one rate limit covers every resource the account owns. When such an
//! endpoint answers 429 with a `Retry-After`, that directive describes the
//! **account**, not the one TorrentFile we happened to be acquiring.
//!
//! Before this ledger, the only reaction was the per-slot breaker, which opens
//! per *placement*: N resources would each burn 3 failures before the account
//! stopped being hammered — amplification against an explicitly throttled
//! account, and evidence that lives at a different granularity than the
//! failure it records.
//!
//! ## Key model (deliberately minimal)
//!
//! ```text
//! (provider, account_scope)        acquisition API boundary  -> this ledger
//! (provider, account_scope,
//!  provider_resource_id,
//!  provider_file_id,
//!  + capability runtime url)       byte-delivery boundary    -> per-capability throttle
//! ```
//!
//! * Acquisition (`requestdl`, `addMagnet`, `unrestrict`) shares one
//!   provider-side quota per account, so the directive is recorded at
//!   `(provider, account_scope)` and suppresses **acquire** for every
//!   resource of that scope.
//! * Byte delivery (CDN range GETs) is per-resource: a 429 there throttles
//!   only that capability (`DeliveryCapability::throttle`). Delivery failures
//!   deliberately do NOT enter this ledger — a hot CDN host says nothing about
//!   the acquisition API, and blocking acquisition because one file's CDN is
//!   throttled would widen suppression beyond the provider's own scoping.
//! * Account scopes are already distinguished by runtime ownership
//!   (`ProviderCoord::account_scope`), so one account never poisons another.
//!
//! ## Lifetime
//!
//! Runtime-only, in-memory, `Instant`-based (monotonic; a wall-clock
//! adjustment cannot create a negative or effectively permanent cooldown).
//! Evidence expires automatically at its horizon and is dropped by `prune`, so
//! the map is bounded by (providers x account scopes) rather than by traffic.
//! A process restart clears it by construction — it is provider runtime state,
//! never durable media/control-plane truth.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Hard ceiling for a *retained* ledger entry (not the honored horizon, which
/// `capability::retry_after_max_secs` already bounds). Bounds worst-case
/// suppression if a caller records an immediate-but-far deadline.
pub const LEDGER_MAX_HORIZON: Duration = Duration::from_secs(15 * 60);

/// Prune cadence: entries whose horizon elapsed are dropped opportunistically.
fn prune_locked(map: &mut HashMap<(String, String), Instant>, now: Instant) {
    map.retain(|_, until| *until > now);
}

#[derive(Debug, Default)]
pub struct RetryAfterLedger {
    /// (provider, account_scope) -> earliest Instant the scope may acquire again.
    pub(crate) blocked_until: Mutex<HashMap<(String, String), Instant>>,
}

impl RetryAfterLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a provider Retry-After directive for one execution scope.
    /// A later directive REPLACES an earlier one (it may extend or shorten the
    /// horizon; the newest server instruction wins).
    pub fn record(&self, provider: &str, account_scope: &str, horizon: Duration) {
        let until = Instant::now() + horizon.min(LEDGER_MAX_HORIZON);
        let mut map = self.blocked_until.lock().unwrap();
        prune_locked(&mut map, Instant::now());
        map.insert((provider.to_string(), account_scope.to_string()), until);
    }

    /// How long this scope must still wait, if at all. Expired evidence reads
    /// as absent — stale evidence can never suppress anything.
    pub fn blocked_for(&self, provider: &str, account_scope: &str) -> Option<Duration> {
        let now = Instant::now();
        let mut map = self.blocked_until.lock().unwrap();
        prune_locked(&mut map, now);
        map.get(&(provider.to_string(), account_scope.to_string()))
            .filter(|until| **until > now)
            .map(|until| until.saturating_duration_since(now))
    }

    pub fn is_blocked(&self, provider: &str, account_scope: &str) -> bool {
        self.blocked_for(provider, account_scope).is_some()
    }

    /// Number of live entries (bounded by providers x account scopes).
    pub fn len(&self) -> usize {
        self.blocked_until.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_directive_blocks_only_its_own_scope() {
        let ledger = RetryAfterLedger::new();
        ledger.record("torbox", "default", Duration::from_secs(60));

        assert!(ledger.is_blocked("torbox", "default"), "the throttled scope waits");
        assert!(!ledger.is_blocked("torbox", "secondary"),
            "another account scope of the SAME provider is unaffected");
        assert!(!ledger.is_blocked("realdebrid", "default"),
            "another provider is unaffected");
    }

    #[test]
    fn evidence_expires_automatically_and_reads_as_absent() {
        let ledger = RetryAfterLedger::new();
        ledger.record("torbox", "default", Duration::from_millis(30));
        assert!(ledger.is_blocked("torbox", "default"), "inside the horizon");

        // Expiry is observed through the accessor (monotonic clock), no sleeps:
        // a horizon already in the past is simply not present.
        let past = Instant::now() - Duration::from_secs(1);
        ledger.blocked_until.lock().unwrap().insert(
            ("torbox".to_string(), "default".to_string()),
            past,
        );
        assert_eq!(ledger.blocked_for("torbox", "default"), None,
            "stale evidence can never suppress execution");
    }

    #[test]
    fn a_refreshed_directive_replaces_the_previous_one() {
        let ledger = RetryAfterLedger::new();
        ledger.record("torbox", "default", Duration::from_secs(600));
        let first = ledger.blocked_for("torbox", "default").unwrap();
        assert!(first > Duration::from_secs(500));

        ledger.record("torbox", "default", Duration::from_secs(5));
        let second = ledger.blocked_for("torbox", "default").unwrap();
        assert!(second <= Duration::from_secs(5),
            "the newest server instruction wins (shorter horizon honoured)");
    }

    #[test]
    fn the_map_is_bounded_and_prunes_expired_entries() {
        let ledger = RetryAfterLedger::new();
        for i in 0..8 {
            ledger.record("torbox", &format!("scope-{i}"), Duration::from_secs(1));
        }
        assert_eq!(ledger.len(), 8);
        // Force-evict everything, then prove a read prunes. (Collect the keys
        // under the lock and drop the guard before re-locking: std::sync::Mutex
        // is not reentrant.)
        let keys: Vec<_> = {
            let guard = ledger.blocked_until.lock().unwrap();
            guard.keys().cloned().collect()
        };
        {
            let mut guard = ledger.blocked_until.lock().unwrap();
            for key in keys {
                guard.insert(key, Instant::now() - Duration::from_secs(1));
            }
        }
        assert_eq!(ledger.blocked_for("torbox", "scope-0"), None);
        assert_eq!(ledger.len(), 0, "expired entries are dropped, not accumulated");
    }

    #[test]
    fn an_absurd_horizon_is_bounded() {
        let ledger = RetryAfterLedger::new();
        ledger.record("torbox", "default", Duration::from_secs(60 * 60 * 24 * 365));
        let remaining = ledger.blocked_for("torbox", "default").unwrap();
        assert!(remaining <= LEDGER_MAX_HORIZON,
            "retained evidence is bounded even for an absurd instruction");
    }
}
