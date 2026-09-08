//! HY4 south data plane -- pure Rust payload transplanted from the Frankenstein lab.
//!
//! Provenance: `frankenstein/rust-data-plane/src/{transport,capability,manager,provider,cache,metrics,control}.rs`
//! at commit `ef5f33c`. These seven modules are transplanted **verbatim** -- byte-for-byte
//! identical to the donor. Nothing here has been renamed, re-normalized, or "cleaned up";
//! the semantics below are proven south behavior from the Slice 4.75 fixed-grid chunk
//! cache closure.
//!
//! # P3 step 1: serving core (serve.rs)
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
pub mod transport;

// HY4 P2E.1 deterministic fill-identity repair proof (unit-level).
// Test-only: pins that plan/fill TorrentFile identity is the durable
// (infoHash, path, size) tuple, never the routing UUID.
#[cfg(test)]
mod p2e1_identity;

// T2 transplant proof: warm same-TorrentFile standby reservation
// (unit-level, no I/O). Test-only: pins the five standby semantics.
#[cfg(test)]
mod t2_standby;

// T3 transplant proof: explicit runtime prewarm primitive (async
// unit-level, stubbed provider edge). Test-only: pins the four prewarm
// behaviors plus the prewarm->standby handoff.
#[cfg(test)]
mod t3_prewarm;
