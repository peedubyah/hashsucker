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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::Semaphore;

/// Observability-only unique capability id. Stable for the lifetime of this Arc;
/// never used for routing, identity, or cache keying. Exposed in pool_attribution
/// so live provider attribution is provable without signed URLs or tokens.
static CAP_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

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
    pub torrent_file_id: String, // current host DB row id (torrentFile.id); informational only, NOT a key
    pub provider_resource_id: String,
    pub provider_file_id: String,
    /// Observability-only unique capability id. Stable for the lifetime of this
    /// Arc; never used for routing, identity, or cache keying. Exposed in
    /// CdnAttempt / StageReport / pool_attribution so live provider attribution
    /// is provable without signed URLs or tokens.
    pub cap_id: String,
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
        let cap_id = format!(
            "{}-{}-{}",
            provider,
            provider_file_id,
            CAP_ID_COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        Arc::new(Self {
            runtime_url,
            provider,
            account_scope,
            torrent_file_id,
            provider_resource_id,
            provider_file_id,
            cap_id,
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
    /// Observability-only: milliseconds until this capability expires.
    /// None if no expiry is set (capability lives until dead/revoked).
    pub fn expires_in_ms(&self, now: Instant) -> Option<u64> {
        self.expires_at.lock().unwrap().map(|exp| {
            if exp > now { exp.duration_since(now).as_millis() as u64 } else { 0 }
        })
    }

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
// Two accepted forms (RFC 9110 §10.2.3):
//   * delta-seconds — MEASURED (both TorBox and RD return numeric on 429);
//   * HTTP-date (IMF-fixdate) — converted to a horizon relative to now; a date
//     in the past means "no wait" (zero), never a negative duration.
//
// The honored horizon is bounded by `retry_after_max_secs()` (default 15 min,
// env override). A Retry-After is *evidence from the server* about one
// execution scope, but a buggy proxy or a misconfigured provider can emit an
// effectively permanent value (hours/years). Runtime recovery from the same
// failure is available through the breaker/backoff path, so capping the
// instruction keeps a single bad header from wedging a capability forever
// while still honoring the server's intent for any sane value.
//
// Malformed / absent / unparseable -> None: the caller applies its own default
// backoff rather than treating the header as authoritative.
//
// This is RUNTIME-ONLY evidence: it lives on DeliveryCapability/manager state
// and is never persisted, so a process restart clears it by construction
// (DeliveryCapability/provider runtime state is non-durable).
pub const RETRY_AFTER_MAX_SECS_DEFAULT: u64 = 15 * 60;

/// Upper bound on an honored Retry-After horizon (seconds).
pub fn retry_after_max_secs() -> u64 {
    std::env::var("RETRY_AFTER_MAX_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(RETRY_AFTER_MAX_SECS_DEFAULT)
}

/// Parse an HTTP-date (IMF-fixdate, RFC 7231 §7.1.1.1) into a SystemTime.
/// Only the fixed-format production form is accepted; obsolete formats and
/// anything malformed return None.
pub fn parse_http_date(hdr: &str) -> Option<SystemTime> {
    let t = hdr.trim();
    // "Sun, 06 Nov 1994 08:49:37 GMT" — day, DD Mon YYYY HH:MM:SS GMT
    let (_, rest) = t.split_once(", ")?;
    let mut parts = rest.split(' ');
    let day: u32 = parts.next()?.parse().ok()?;
    let mon = parts.next()?;
    let year: i64 = parts.next()?.parse().ok()?;
    let time = parts.next()?;
    let tz = parts.next()?;
    if tz != "GMT" || parts.next().is_some() {
        return None;
    }
    let month = match mon {
        "Jan" => 1, "Feb" => 2, "Mar" => 3, "Apr" => 4, "May" => 5, "Jun" => 6,
        "Jul" => 7, "Aug" => 8, "Sep" => 9, "Oct" => 10, "Nov" => 11, "Dec" => 12,
        _ => return None,
    };
    let mut hms = time.split(':');
    let hour: u32 = hms.next()?.parse().ok()?;
    let minute: u32 = hms.next()?.parse().ok()?;
    let second: u32 = hms.next()?.parse().ok()?;
    if hms.next().is_some() || day == 0 || day > 31 || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    let secs = days
        .checked_mul(86_400)?
        .checked_add(hour as i64 * 3600 + minute as i64 * 60 + second as i64)?;
    let epoch = UNIX_EPOCH.checked_add(Duration::from_secs(secs.max(0) as u64))?;
    Some(epoch)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// algorithm). Deterministic, no clock, no external crate.
fn days_from_civil(y: i64, m: u32, d: u32) -> Option<i64> {
    if !(1..=12).contains(&m) || d == 0 || d > 31 || y < 1970 || y > 9999 {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era as i64 * 146_097 + doe as i64 - 719_468)
}

pub fn parse_retry_after(hdr: Option<&str>) -> Option<Duration> {
    let h = hdr?;
    let t = h.trim();
    let max = Duration::from_secs(retry_after_max_secs());
    if let Ok(secs) = t.parse::<u64>() {
        return Some(Duration::from_secs(secs).min(max));
    }
    // HTTP-date form: horizon relative to now; past dates mean "no wait".
    let at = parse_http_date(t)?;
    let horizon = at
        .duration_since(SystemTime::now())
        .unwrap_or(Duration::ZERO);
    Some(horizon.min(max))
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

// ---- Retry-After tests (deterministic: no sleeps, no wall-clock waits) -----
#[cfg(test)]
mod retry_after_tests {
    use super::*;

    #[test]
    fn delta_seconds_is_honored() {
        assert_eq!(parse_retry_after(Some("5")), Some(Duration::from_secs(5)));
        assert_eq!(parse_retry_after(Some(" 30 ")), Some(Duration::from_secs(30)));
        assert_eq!(parse_retry_after(Some("0")), Some(Duration::ZERO));
    }

    #[test]
    fn delta_seconds_are_bounded_so_a_bad_header_cannot_wedge_a_capability() {
        // A buggy proxy or misconfigured provider can emit an effectively
        // permanent value; the honored horizon is capped.
        let parsed = parse_retry_after(Some("86400")).expect("parsed");
        assert_eq!(parsed, Duration::from_secs(retry_after_max_secs()));
        assert!(parsed <= Duration::from_secs(15 * 60), "default cap is 15 minutes");
    }

    #[test]
    fn malformed_values_fail_safe() {
        for bad in ["", "   ", "soon", "-5", "5.5", "abc", "5 seconds", "NaN", "999999999999999999999999"] {
            assert_eq!(parse_retry_after(Some(bad)), None, "malformed must not become evidence: {bad:?}");
        }
        assert_eq!(parse_retry_after(None), None, "absent header is not evidence");
    }

    #[test]
    fn http_date_form_is_accepted() {
        // A horizon in the future, expressed as an IMF-fixdate.
        let future = SystemTime::now() + Duration::from_secs(120);
        let secs = future.duration_since(UNIX_EPOCH).unwrap().as_secs();
        let hdr = format_http_date(UNIX_EPOCH + Duration::from_secs(secs));
        let parsed = parse_retry_after(Some(&hdr)).expect("http-date must parse");
        // The horizon is clamped only by the assertion resolution; it must be
        // positive and well under the cap.
        assert!(parsed > Duration::ZERO, "a future date means 'wait'");
        assert!(parsed <= Duration::from_secs(15 * 60));
    }

    #[test]
    fn http_date_in_the_past_means_no_wait_and_never_negative() {
        let past = SystemTime::now() - Duration::from_secs(3600);
        let secs = past.duration_since(UNIX_EPOCH).unwrap().as_secs();
        let hdr = format_http_date(UNIX_EPOCH + Duration::from_secs(secs));
        assert_eq!(parse_retry_after(Some(&hdr)), Some(Duration::ZERO));
    }

    #[test]
    fn http_date_parsing_rejects_garbage() {
        for bad in [
            "Sun, 06 Nov 1994 08:49:37 EST", // wrong zone
            "Sun 06 Nov 1994 08:49:37 GMT",  // missing comma
            "Sun, 06 Nov 1994 08:49 GMT",    // missing seconds
            "Sun, 06 Foo 1994 08:49:37 GMT", // unknown month
            "Sun, 32 Nov 1994 08:49:37 GMT", // impossible day
            "Sun, 06 Nov 1994 25:49:37 GMT", // impossible hour
            "not a date at all",
            "",
        ] {
            assert_eq!(parse_retry_after(Some(bad)), None, "reject: {bad:?}");
        }
    }

    #[test]
    fn http_date_round_trips_known_instants() {
        assert_eq!(parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"), Some(UNIX_EPOCH + Duration::from_secs(784111777)));
        assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(UNIX_EPOCH));
        assert_eq!(parse_http_date("Mon, 01 Jan 2024 00:00:00 GMT"), Some(UNIX_EPOCH + Duration::from_secs(1704067200)));
    }

    /// Render a SystemTime as an IMF-fixdate for the date-form tests.
    fn format_http_date(at: SystemTime) -> String {
        let secs = at.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        let days = secs.div_euclid(86_400);
        let rem = secs.rem_euclid(86_400);
        let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
        let (year, month, day) = civil_from_days(days);
        const DOW: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
        const MON: [&str; 12] = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        let dow = DOW[((days % 7 + 7) % 7) as usize];
        format!(
            "{}, {:02} {} {:04} {:02}:{:02}:{:02} GMT",
            dow, day, MON[(month - 1) as usize], year, hour, minute, second
        )
    }

    fn civil_from_days(days: i64) -> (i64, u32, u32) {
        let z = days + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = (z - era * 146_097) as u64;
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let y = yoe as i64 + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        (if m <= 2 { y + 1 } else { y }, m, d)
    }

    #[test]
    fn capability_throttle_expires_automatically() {
        // The Retry-After evidence attached to a capability is a deadline:
        // after it elapses the capability is usable again with the SAME url,
        // and a stale (past) deadline never suppresses anything.
        let cap = DeliveryCapability::new(
            "https://cdn.test/file".into(),
            "torbox".into(),
            "default".into(),
            "tf1".into(),
            "res1".into(),
            "file1".into(),
            None,
        );
        let now = Instant::now();
        cap.throttle(now + Duration::from_millis(50));
        assert!(!cap.usable_now(now), "inside the horizon the capability is suppressed");

        let after = now + Duration::from_millis(60);
        assert!(cap.usable_now(after), "after the horizon the capability is eligible again");

        // A refreshed Retry-After replaces (extends) the evidence.
        cap.throttle(after + Duration::from_millis(50));
        assert!(!cap.usable_now(after), "a refreshed directive re-suppresses");
        cap.throttle(after); // an earlier directive must not shorten a later one
        assert!(cap.usable_now(after + Duration::from_millis(1)), "past deadline never suppresses");
    }
}
