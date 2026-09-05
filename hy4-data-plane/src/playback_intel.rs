// P9 — Playback Intelligence: sequential-read detection + bounded speculative
// prefetch + seek reprioritization + hot-range observation.
//
// Design constraints (frozen architecture, see P8 handoff):
//   * Rust owns MOTION, not truth. This module never discovers/ranks providers,
//     never substitutes a TorrentFile, never decides another release is
//     acceptable, and never touches Node's persisted-candidate fallback.
//   * Prefetch MUST reuse the existing chunk grid, the existing cache/coalescer
//     (single-flight in-flight map), the existing provider scheduler/limiter/
//     breaker, and the existing capability pool. It does NOT open a second
//     concurrency domain, does NOT bypass capability management, does NOT
//     duplicate an in-flight chunk, and does NOT amplify provider API calls
//     beyond one legitimate acquire per speculative chunk.
//   * The fill primitive is `serve::fill_chunk_run`: the SAME function the
//     demand path uses. Prefetch simply calls it with `sink = None` (no client
//     to stream to) so it only stages bytes durably. A later demand read for a
//     prefetched chunk becomes a WAITER on that fill and reads it locally once
//     published — zero duplicate upstream fetch.
//   * All state here is RUNTIME-ONLY and BOUNDED. Nothing is persisted. The
//     per-TorrentFile map is capped (LRU eviction) so a long-lived server with
//     many distinct files does not grow without bound.
//   * Failure shielding: a prefetch fill uses the exact same capability lifecycle
//     as demand. If it fails (429/5xx/dead/exhausted), that failure is contained
//     inside the background task and is NEVER surfaced to the client and NEVER
//     triggers Node's persisted-candidate fallback. Only a real client-demand
//     exhaustion path can do that.
//   * Seek handling: a non-sequential request bumps a per-TorrentFile generation
//     counter and reprioritizes. In-flight prefetch fills already claimed are
//     allowed to finish (they stage a valid chunk — harmless), but NO new
//     prefetch is issued for a superseded position, and prefetch always runs at
//     the lowest priority so it never contends ahead of real demand.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::json;

use crate::cache::{CacheEngine, ChunkGrid, TorrentFileId};

/// How aggressively prefetch contends for a provider capability.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PrefetchMode {
    /// Try-once, never wait. Prefetch only fills when a capability is IMMEDIATELY
    /// free, so it can never delay demand and never amplifies provider API. Under a
    /// saturated single-capability workload this yields 100% (harmless no-op); it
    /// fires whenever genuine idle capacity exists (multi-capability TorrentFiles,
    /// or bursty/idle demand). SAFEST — the conservative default.
    Try,
    /// Wait (briefly, bounded) for a busy capability to free, then fill ahead.
    /// Delivers true read-ahead during idle gaps, but may serialize behind demand
    /// on a fully-saturated single-capability lane. Bounded so demand is never
    /// delayed beyond one chunk fill. Use when spare provider capacity is expected.
    Wait,
}

/// Conservative, opt-in configuration. Disabled by default so the existing
/// behavior is unchanged until an operator explicitly turns it on.
#[derive(Clone, Copy)]
pub struct PfConfig {
    /// Master switch. Default OFF (PREFETCH_ENABLED unset / not "1"/"true").
    pub enabled: bool,
    /// How many chunks to prefetch ahead once sequential confidence is armed.
    /// Clamped to 1..=4. Default 1.
    pub ahead_chunks: u64,
    /// Consecutive forward-sequential reads required before prefetch arms.
    /// Default 3 (conservative). Lower for faster arming in benchmarks.
    pub sequential_threshold: u64,
    /// Priority reported for speculative acquires. Always the lowest so demand
    /// always wins the capability limiter. Default 0.
    pub prefetch_priority: u8,
    /// Contention policy (see `PrefetchMode`). Default `Try` (safest).
    pub mode: PrefetchMode,
}

impl PfConfig {
    pub fn from_env() -> Self {
        let enabled = std::env::var("PREFETCH_ENABLED")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let ahead_chunks = std::env::var("PREFETCH_AHEAD_CHUNKS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v >= 1 && *v <= 4)
            .unwrap_or(1);
        let sequential_threshold = std::env::var("PREFETCH_SEQUENTIAL_THRESHOLD")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v >= 1)
            .unwrap_or(3);
        let prefetch_priority = std::env::var("PREFETCH_PRIORITY")
            .ok()
            .and_then(|v| v.parse::<u8>().ok())
            .unwrap_or(0);
        let mode = match std::env::var("PREFETCH_MODE")
            .map(|v| v.to_ascii_lowercase())
            .as_deref()
        {
            Ok("wait") => PrefetchMode::Wait,
            _ => PrefetchMode::Try,
        };
        Self {
            enabled,
            ahead_chunks,
            sequential_threshold,
            prefetch_priority,
            mode,
        }
    }

    /// True when prefetch should wait (bounded) for a busy capability to free.
    pub fn is_wait(&self) -> bool {
        matches!(self.mode, PrefetchMode::Wait)
    }
}

/// One recently-touched chunk in the observed hot range for a TorrentFile. The
/// hot range is purely observed — no hardcoded head/tail rules, no TorrentFile-
/// generic shape; it is whatever this specific file's reads have actually hit.
#[derive(Clone, Copy)]
struct HotChunk {
    idx: u64,
    count: u64,
    last: Instant,
}

/// Runtime-only per-TorrentFile playback state. Bounded in size (hot list capped
/// at 16, whole-map capped at 1024 with LRU eviction).
struct PfTfState {
    last_start: u64,
    last_end: u64,
    last_dir: i8, // -1 backward, 0 unknown/overlap, +1 forward
    /// Consecutive forward-sequential reads. The "sequential confidence".
    forward_run: u64,
    backward_run: u64,
    /// Bumped on every seek; invalidates stale prefetch intent at the caller.
    generation: u64,
    hot: Vec<HotChunk>,
    last_active: Instant,
}

impl PfTfState {
    fn new() -> Self {
        Self {
            last_start: 0,
            last_end: 0,
            last_dir: 0,
            forward_run: 0,
            backward_run: 0,
            generation: 0,
            hot: Vec::new(),
            last_active: Instant::now(),
        }
    }

    /// Classify the direction of a new demand read relative to the last one,
    /// update the sequential run, detect seeks, and return (confidence, is_seek).
    fn observe(&mut self, start: u64, end: u64, threshold: u64) -> (f64, bool) {
        let dir: i8 = if start >= self.last_end {
            1
        } else if end <= self.last_start {
            -1
        } else {
            0 // overlap or non-monotonic random access
        };
        let prev_dir = self.last_dir;
        let mut is_seek = false;
        match dir {
            1 => {
                if prev_dir == 1 {
                    self.forward_run += 1;
                } else {
                    self.forward_run = 1;
                }
                self.backward_run = 0;
                // A forward jump that leaves a gap is a seek (not contiguous
                // playback): reprioritize and start a fresh run from here.
                if self.last_end != 0 && start > self.last_end + 1 {
                    is_seek = true;
                    self.generation += 1;
                }
            }
            -1 => {
                if prev_dir == -1 {
                    self.backward_run += 1;
                } else {
                    self.backward_run = 1;
                }
                self.forward_run = 0;
            }
            _ => {
                // Overlap / random access: treat as a seek. Reprioritize and reset.
                is_seek = true;
                self.generation += 1;
                self.forward_run = 0;
                self.backward_run = 0;
            }
        }
        self.last_start = start;
        self.last_end = end;
        self.last_dir = dir;
        self.last_active = Instant::now();
        let conf = if threshold == 0 {
            1.0
        } else {
            (self.forward_run as f64 / threshold as f64).min(1.0)
        };
        (conf, is_seek)
    }

    fn record_hot(&mut self, grid: &ChunkGrid, start: u64, end: u64) {
        let cnt = grid.chunk_count();
        if cnt == 0 {
            return;
        }
        let last = grid.file_size.saturating_sub(1);
        let a = grid.index_of(start).min(cnt.saturating_sub(1));
        let b = grid.index_of(end.min(last)).min(cnt.saturating_sub(1));
        for idx in a..=b {
            if let Some(h) = self.hot.iter_mut().find(|h| h.idx == idx) {
                h.count += 1;
                h.last = Instant::now();
                continue;
            }
            if self.hot.len() >= 16 {
                if let Some(pos) = self
                    .hot
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, h)| h.last)
                    .map(|(i, _)| i)
                {
                    self.hot.remove(pos);
                }
            }
            self.hot.push(HotChunk {
                idx,
                count: 1,
                last: Instant::now(),
            });
        }
    }

    fn confidence(&self, threshold: u64) -> f64 {
        if threshold == 0 {
            1.0
        } else {
            (self.forward_run as f64 / threshold as f64).min(1.0)
        }
    }
}

/// Result of one observation, handed back to `get_file` so it can launch the
/// actual fills (which must run as background tasks).
pub struct PfPlan {
    /// Candidate chunk indices strictly ahead of the demand window that are NOT
    /// yet durable. The spawned fill task claims each via the SAME in-flight
    /// coalescer only AFTER a non-blocking capability acquire succeeds, so a
    /// candidate is never a stranded in-flight record.
    pub targets: Vec<u64>,
    /// Sequential confidence in [0,1] after this read.
    pub confidence: f64,
    /// Whether this read was classified as a seek (generation bumped).
    pub is_seek: bool,
    /// The generation observed for this read (for diagnostics).
    pub generation: u64,
}

/// The playback-intelligence subsystem. One instance per data-plane process,
/// shared across all TorrentFiles. Holds the per-TF state map and the
/// (runtime-only) prefetch counters.
pub struct PlaybackIntelligence {
    map: Mutex<HashMap<String, PfTfState>>,
    pub config: PfConfig,
    // ---- minimal prefetch metrics (requirement 7) ----
    /// Observations that armed AND launched >=1 prefetch chunk.
    pub triggered: AtomicU64,
    /// Prefetch chunks we took ownership of (claimed via coalescer).
    pub chunks_requested: AtomicU64,
    /// Prefetch fills that finished with the chunk PRESENT.
    pub chunks_completed: AtomicU64,
    /// Prefetch chunks skipped because already durable.
    pub skipped_present: AtomicU64,
    /// Prefetch chunks skipped because already in-flight (joined an existing fill).
    pub joined_inflight: AtomicU64,
    /// Prefetch fills whose chunk ended up NOT present (provider/upstream failure).
    pub failures: AtomicU64,
    /// Number of seek events that reprioritized (generation bumps).
    pub seek_reprioritizations: AtomicU64,
}

impl PlaybackIntelligence {
    pub fn new(config: PfConfig) -> Arc<Self> {
        Arc::new(Self {
            map: Mutex::new(HashMap::new()),
            config,
            triggered: AtomicU64::new(0),
            chunks_requested: AtomicU64::new(0),
            chunks_completed: AtomicU64::new(0),
            skipped_present: AtomicU64::new(0),
            joined_inflight: AtomicU64::new(0),
            failures: AtomicU64::new(0),
            seek_reprioritizations: AtomicU64::new(0),
        })
    }

    /// Observe a client demand read for `tf`, update sequential/seek/hot state,
    /// and — once sequential confidence is armed — return CANDIDATE chunk indices
    /// (the next `ahead_chunks` chunks strictly beyond the demand window that are
    /// not yet durable). The actual claim via the in-flight coalescer and the fill
    /// happen later, inside the background `fill_chunk_run` task, and ONLY after a
    /// non-blocking capability acquire succeeds there.
    ///
    /// Safe to call on every request: cheap (one map lock, a few cache lookups),
    /// never blocks the client byte stream, and never acquires a provider
    /// capability itself (that happens later, inside `fill_chunk_run` after a
    /// best-effort `acquire_for_read_try`).
    pub fn observe_and_claim_prefetch(
        self: &Arc<Self>,
        cache: &Arc<CacheEngine>,
        tf: &TorrentFileId,
        grid: &ChunkGrid,
        req_start: u64,
        req_end: u64,
    ) -> PfPlan {
        let empty = PfPlan {
            targets: Vec::new(),
            confidence: 0.0,
            is_seek: false,
            generation: 0,
        };
        if !self.config.enabled || grid.chunk_count() == 0 {
            return empty;
        }
        let key = tf.cache_key();
        let threshold = self.config.sequential_threshold;

        // ---- observe under the lock; compute targets outside ----
        let (conf, is_seek, generation, max_demand) = {
            let mut map = self.map.lock().unwrap();
            if map.len() >= 1024 {
                if let Some(k) = map.iter().min_by_key(|(_, s)| s.last_active).map(|(k, _)| k.clone())
                {
                    map.remove(&k);
                }
            }
            let s = map.entry(key.clone()).or_insert_with(PfTfState::new);
            let (c, seek) = s.observe(req_start, req_end, threshold);
            s.record_hot(grid, req_start, req_end);
            let last = grid.file_size.saturating_sub(1);
            let md = grid.index_of(req_end.min(last));
            (c, seek, s.generation, md)
        };

        if is_seek {
            self.seek_reprioritizations
                .fetch_add(1, Ordering::SeqCst);
        }

        // Not yet armed: report diag only, no prefetch.
        if conf < 1.0 {
            return PfPlan {
                targets: Vec::new(),
                confidence: conf,
                is_seek,
                generation,
            };
        }

        // ---- armed: compute candidate ahead-chunks to consider ----
        // We deliberately do NOT claim the in-flight coalescer record here. The
        // claim must happen ONLY inside the background fill task, and ONLY after a
        // non-blocking capability acquire succeeds there. Claiming in the demand
        // path (synchronously) would risk stranding demand readers on a record we
        // later decide not to drive (e.g. no spare provider capacity). So this
        // function returns lightweight CANDIDATES; the spawned fill task claims +
        // fills them. `skipped_present` still counts chunks already durable so the
        // telemetry reflects "considered but not fetched".
        let chunk_count = grid.chunk_count();
        let ahead = self.config.ahead_chunks.max(1);
        let mut targets: Vec<u64> = Vec::new();
        let mut idx = max_demand + 1;
        while idx < chunk_count && (targets.len() as u64) < ahead {
            // Already durable? Nothing to fetch — skip and count it.
            match cache.is_present(&key, idx) {
                Ok(true) => {
                    self.skipped_present.fetch_add(1, Ordering::SeqCst);
                    idx += 1;
                    continue;
                }
                _ => {}
            }
            targets.push(idx);
            idx += 1;
        }

        if !targets.is_empty() {
            self.triggered.fetch_add(1, Ordering::SeqCst);
        }
        PfPlan {
            targets,
            confidence: conf,
            is_seek,
            generation,
        }
    }

    /// Number of distinct TorrentFiles currently tracked (diagnostic).
    pub fn active_count(&self) -> usize {
        self.map.lock().unwrap().len()
    }

    /// Serde snapshot for the /metrics endpoint. Bounded: returns the 8 most
    /// recently active TorrentFiles with their observed shape.
    pub fn snapshot(&self) -> serde_json::Value {
        let threshold = self.config.sequential_threshold;
        let top: Vec<serde_json::Value> = {
            let map = self.map.lock().unwrap();
            let mut v: Vec<&PfTfState> = map.values().collect();
            v.sort_by_key(|s| std::cmp::Reverse(s.last_active));
            v.truncate(8);
            v.iter()
                .map(|s| {
                    json!({
                        "confidence": s.confidence(threshold),
                        "forward_run": s.forward_run,
                        "generation": s.generation,
                        "forward_region": [s.last_start, s.last_end],
                        "hot_chunks": s.hot.iter().map(|h| json!({"idx": h.idx, "count": h.count})).collect::<Vec<_>>(),
                    })
                })
                .collect()
        };
        json!({
            "enabled": self.config.enabled,
            "mode": match self.config.mode { PrefetchMode::Try => "try", PrefetchMode::Wait => "wait" },
            "ahead_chunks": self.config.ahead_chunks,
            "sequential_threshold": self.config.sequential_threshold,
            "prefetch_priority": self.config.prefetch_priority,
            "prefetch_triggered": self.triggered.load(Ordering::SeqCst),
            "prefetch_chunks_requested": self.chunks_requested.load(Ordering::SeqCst),
            "prefetch_chunks_completed": self.chunks_completed.load(Ordering::SeqCst),
            "prefetch_chunks_skipped_present": self.skipped_present.load(Ordering::SeqCst),
            "prefetch_joined_inflight": self.joined_inflight.load(Ordering::SeqCst),
            "prefetch_failures": self.failures.load(Ordering::SeqCst),
            "seek_reprioritizations": self.seek_reprioritizations.load(Ordering::SeqCst),
            "active_torrent_files": self.active_count(),
            "top": top,
        })
    }
}
