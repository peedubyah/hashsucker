//! HY4 south data plane -- pure Rust payload transplanted from the Frankenstein lab.
//!
//! Provenance: `frankenstein/rust-data-plane/src/{transport,capability,manager,provider,cache,metrics,control}.rs`
//! at commit `ef5f33c`. These seven modules are transplanted **verbatim** -- byte-for-byte
//! identical to the donor. Nothing here has been renamed, re-normalized, or "cleaned up";
//! the semantics below are proven south behavior from the Slice 4.75 fixed-grid chunk
//! cache closure.
//!
//! # Ownership boundary (frozen)
//!
//! Rust owns **motion, not truth**. It fetches authoritative TorrentFile identity and
//! Node-supplied ordered provider coordinates from the north control endpoint; it never
//! reads SQLite, never discovers or ranks providers, never substitutes a TorrentFile,
//! and never mutates durable identity.
//!
//! # What is deliberately NOT here yet
//!
//! The donor `main.rs` is **not** transplanted. It was a single-TorrentFile lab process:
//! `TORRENT_FILE_ID` was required process-wide at startup, control was fetched once at
//! boot, and the entire router was two routes. Re-authoring it is the host seam work,
//! not a copy. The ~1,000-line serving core (`get_file` / `fill_chunk_run` /
//! `window_slice`) inside it is the remaining transplant payload and lands in a later
//! tranche; the ~480-line bootstrap/router is throwaway.

pub mod cache;
pub mod capability;
pub mod control;
pub mod manager;
pub mod metrics;
pub mod provider;
pub mod transport;
