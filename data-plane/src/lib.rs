//! HashSucker south data plane -- pure Rust payload.
//!
//! Provenance: `frankenstein/rust-data-plane/src/{transport,capability,manager,provider,cache,metrics,control}.rs`
//! at commit `ef5f33c`. These seven modules were transplanted **verbatim** -- byte-for-byte
//! identical to the donor. The semantics below are proven south behavior from the Slice 4.75 fixed-grid chunk
//! cache closure.
//!
//! # Serving core (serve.rs)
//!
//! The proven serving code (formerly inlined into the lab's `main.rs`) is
//! extracted here as `pub mod serve`. The lab's `main.rs` is NOT carried
//! over -- the bootstrap was process-global. See `serve.rs`'s header for
//! the exact transformations applied.
//!
//! # Ownership boundary (frozen)
//!
//! Rust owns **motion, not truth**. It fetches authoritative TorrentFile identity and
//! Node-supplied ordered provider coordinates from the north control endpoint; it never
//! reads SQLite, never discovers/ranks providers, never substitutes a TorrentFile,
//! and never mutates durable identity.

// The /metrics handler in serve.rs uses one large `serde_json::json!` literal
// that pushes the macro expansion past rustc's default recursion limit of 128.
// The donor main.rs set `#![recursion_limit = "256"]` at its top; we set it
// here at the crate root so the same limit applies.
#![recursion_limit = "256"]

pub mod cache;
pub mod capability;
pub mod control;
pub mod manager;
pub mod metrics;
pub mod playback_intel;
pub mod provider;
pub mod serve;
pub mod throughput;
pub mod transport;

/// Read a runtime configuration variable with canonical `DATA_PLANE_*`
/// naming and deprecated `HY4_*` fallback.
///
/// Precedence:
///   1. `DATA_PLANE_FOO` (canonical) — returned if set and non-empty.
///   2. `HY4_FOO` (deprecated) — returned if set and non-empty.
///   3. Otherwise `None`.
///
/// Empty values are treated as unset so that `DATA_PLANE_FOO=` falls
/// through to a deprecated `HY4_FOO=bar` rather than silently shadowing
/// it.
pub fn env_canonical(canonical: &str, deprecated: &str) -> Option<String> {
    // Treat empty values as unset so that `DATA_PLANE_FOO=` falls through
    // to a deprecated `HY4_FOO=bar` rather than silently shadowing it.
    std::env::var(canonical)
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var(deprecated).ok())
        .filter(|v| !v.is_empty())
}

// Deterministic fill-identity repair proof (unit-level).
// Test-only: pins that plan/fill TorrentFile identity is the durable
// (infoHash, path, size) tuple, never the routing UUID.
#[cfg(test)]
mod torrent_file_identity;

// Warm same-TorrentFile standby reservation (unit-level, no I/O).
// Test-only: pins the five standby semantics.
#[cfg(test)]
mod standby_reservation;

// Explicit runtime prewarm primitive (async unit-level, stubbed provider edge).
// Test-only: pins the four prewarm behaviors plus the prewarm->standby handoff.
#[cfg(test)]
mod prewarm;

// Runtime slot refresh after durable placement change (unit-level, stubbed edge
// for the prewarm handoff only). Test-only: pins add/migrate/reject/then-prewarm.
#[cfg(test)]
mod slot_refresh;

// Rust prewarm endpoint with one refresh/retry (async, mock S-1 + stubbed
// provider edge). Test-only: pins prewarm/refresh+retry/invalid/bounded-cycle
// through the real orchestration.
#[cfg(test)]
mod prewarm_endpoint;

// Request-scoped serving-primary attribution (async end-to-end through get_file
// against localhost mock CDNs). Test-only: pins provider-backed reporting,
// cache-hit silence, and per-request independence.
#[cfg(test)]
mod serving_attribution;

// Fixed two-lane disjoint fill. Test-only: pins gate-OFF single path, same-provider
// and cross-provider two-way disjoint fills with zero acquisition, and graceful
// single-producer fallback.
#[cfg(test)]
mod two_lane_fill;

// Test-only process-global env serialiser for the active-active gate flags,
// shared by the two-lane-fill and work-stealing proof modules (both flip the same
// process-global gates and must not observe each other's flags).
#[cfg(test)]
mod test_env;

// Two-lane work stealing. Test-only: pins steal-OFF fixed ownership, slow-B/slow-A
// tail steals with exactly-once exact output, and active-chunk non-stealability,
// all with zero acquisition.
#[cfg(test)]
mod work_stealing;

// Slow-lane retirement. Test-only: pins retire-OFF work-stealing behavior,
// slow-B/slow-A retirement with healthy-lane drain and exactly-once exact output,
// and transient/contaminated non-retirement, all with zero acquisition.
#[cfg(test)]
mod lane_retirement;

// Bounded automatic two-lane activation. Test-only: pins AUTO-OFF current behavior,
// below-threshold single, qualifying-run two-lane engagement with api delta 0,
// and single-warm-cap fallback with zero cold acquisition.
#[cfg(test)]
mod active_active_activation;

// Sustained useful-throughput detector. Test-only, detector-only: pins disabled-inert,
// sustained-low classification, healthy non-classification, and
// contamination/producer-change protection against false lows.
#[cfg(test)]
mod throughput_detection;

// Sustained-low-throughput warm promotion. Test-only: pins single-low no-arm, two-low
// warm promotion with exact bytes and zero acquisition, healthy/contaminated
// no-promotion, and no-standby continuation without failure.
#[cfg(test)]
mod throughput_promotion;

// Bounded same-TF first-valid-wins hedge. Test-only: pins hedge-OFF current behavior,
// standby-wins and primary-wins elections with exact bytes and zero acquisition,
// clean loser cancellation, and staged-once bytes with no-standby continuation.
#[cfg(test)]
mod range_hedge;

// Warm replacement of a retired lane. Test-only: pins replace-OFF lane-retirement
// drain, retired-B rebound by warm C with exact bytes and zero acquisition,
// no-C survivor drain, and retired-cap non-reselection.
#[cfg(test)]
mod retired_lane_replacement;

// Terminal-failure vacancy + warm replacement. Test-only: pins recoverable
// no-vacancy, terminal-B replacement with ordered-prefix exactness,
// no-C survivor drain, and failed-cap exclusion with never-duplicated
// failed Range, all with zero acquisition.
#[cfg(test)]
mod terminal_lane_replacement;

// Runtime naming compatibility proof. Test-only: pins the DATA_PLANE_*
// canonical / HY4_* deprecated fallback contract (canonical wins, old
// name still works, default unchanged when neither is set).
#[cfg(test)]
mod runtime_naming_compat;

// Bounded two-reader capability lease. Test-only: pins one-capability /
// two-child-reader semantics with real mock CDNs and concurrent execution.
#[cfg(test)]
mod capability_lease;
