//! Per-chunk cache-value ledger: did fetched bytes later serve real demand?
//!
//! The aggregate counters (`bytes_upstream`, `bytes_local`, `evictions`)
//! cannot answer the terminal cache-value question — "of the bytes fetched
//! in the background, how many later made playback better before eviction?"
//! — because they never join a fetch to a later use. This ledger does that
//! join per chunk, bounded and in-memory:
//!
//! * one record per PRESENT chunk: `(cache_key, index)` → source, size,
//!   population time, delivered bytes, first/last consumer-use times;
//! * on eviction the record folds into per-source aggregates and is
//!   dropped, so memory stays proportional to present chunks (≤1024
//!   entries at the 8 GiB / 8 MiB grid) plus fixed histograms;
//! * reuse-distance (fill → first consumer use) accrues into fixed
//!   latency buckets at first-use time — O(1) memory for the Phase 10
//!   distribution.
//!
//! Observational only: every method is a no-op for correctness (callers
//! ignore return values), locking is a single short Mutex, and a restart
//! simply restarts observation. Chunks already durable before this process
//! booted are attributed `Preexisting` on first touch — never to a fetch
//! this process did not perform.
//!
//! A "consumer use" is bytes handed to a client response (the consume
//! loop's successful sends). Plan-time `touch()` is explicitly NOT a use:
//! it fires for requested ranges whether or not any byte is delivered.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// Why a chunk's bytes were fetched.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ChunkSource {
    /// Foreground serve span of a demand fill (streams to the client AND stages).
    DemandServe,
    /// Prefix-backfill span of a demand fill (staged only; explicitly
    /// "optional cache warming, not foreground bytes" at the call site).
    DemandBackfill,
    /// P9 speculative prefetch fill (never streams; cap freed on drop).
    Prefetch,
    /// Published after the fill observed its consumer gone. The bytes were
    /// fetched with no attached demand; later delivery redeems them.
    PostDisconnect,
    /// Durable before this process booted (or otherwise published outside
    /// observed fills). Delivery and eviction are counted; fetch credit
    /// and reuse latency are not attributable.
    Preexisting,
}

impl ChunkSource {
    fn idx(self) -> usize {
        match self {
            ChunkSource::DemandServe => 0,
            ChunkSource::DemandBackfill => 1,
            ChunkSource::Prefetch => 2,
            ChunkSource::PostDisconnect => 3,
            ChunkSource::Preexisting => 4,
        }
    }

    fn name(self) -> &'static str {
        match self {
            ChunkSource::DemandServe => "demand_serve",
            ChunkSource::DemandBackfill => "demand_backfill",
            ChunkSource::Prefetch => "prefetch",
            ChunkSource::PostDisconnect => "post_disconnect",
            ChunkSource::Preexisting => "preexisting",
        }
    }

    fn all() -> [ChunkSource; 5] {
        [
            ChunkSource::DemandServe,
            ChunkSource::DemandBackfill,
            ChunkSource::Prefetch,
            ChunkSource::PostDisconnect,
            ChunkSource::Preexisting,
        ]
    }
}

/// Fill → first consumer-use latency buckets (upper bounds, seconds).
/// Answers "is background fill serving imminent playback or speculative
/// future demand" with O(1) memory.
const LATENCY_BOUNDS_S: [u64; 7] = [10, 60, 300, 1800, 7200, 43200, u64::MAX];
const LATENCY_LABELS: [&str; 7] = [
    "le10s", "le60s", "le5m", "le30m", "le2h", "le12h", "gt12h",
];

struct ChunkRec {
    source: ChunkSource,
    populated_at: Instant,
    size: u64,
    delivered: u64,
    first_use: Option<Instant>,
    last_use: Option<Instant>,
}

#[derive(Default)]
struct Inner {
    live: HashMap<(String, u64), ChunkRec>,
    fetched_bytes: [u64; 5],
    delivered_bytes: [u64; 5],
    evicted_used_bytes: [u64; 5],
    evicted_unused_bytes: [u64; 5],
    reuse_latency: [u64; 7],
}

/// Bounded in-memory per-chunk value ledger. See module docs.
#[derive(Default)]
pub struct ChunkValueLedger {
    mu: Mutex<Inner>,
}

impl ChunkValueLedger {
    /// A chunk became durable. Records (overwrites) the live entry and
    /// credits `fetched_bytes` to the source — except `Preexisting`, which
    /// is never fetch-credited (this process did not fetch it).
    ///
    /// Merge, not blind overwrite: fills stream bytes to the client BEFORE
    /// the chunk completes and publishes, so a live record may already
    /// carry delivery history (attributed `Preexisting` at delivery time,
    /// when no fetch had been observed). That history is preserved and its
    /// volume moves into the now-known source bucket; the reuse-latency
    /// bucket fires here, with use-before-publish saturating to the
    /// imminent bucket — truthful, since streaming delivery happens during
    /// the fill itself.
    pub fn record_populate(&self, key: &str, idx: u64, size: u64, source: ChunkSource) {
        let now = Instant::now();
        let mut inner = self.mu.lock().unwrap();
        // Scope the removal so later aggregate updates don't alias it.
        let (carried_delivered, first_use, last_use, bucket) = match inner
            .live
            .remove(&(key.to_string(), idx))
        {
            Some(prev) => {
                inner.delivered_bytes[prev.source.idx()] = inner.delivered_bytes[prev.source.idx()]
                    .saturating_sub(prev.delivered);
                let bucket = prev.first_use.map(|t| {
                    let dt = t.saturating_duration_since(now).as_secs();
                    LATENCY_BOUNDS_S
                        .iter()
                        .position(|&bound| dt <= bound)
                        .unwrap_or(LATENCY_BOUNDS_S.len() - 1)
                });
                (prev.delivered, prev.first_use, prev.last_use, bucket)
            }
            None => (0, None, None, None),
        };
        if let Some(b) = bucket {
            inner.reuse_latency[b] = inner.reuse_latency[b].saturating_add(1);
        }
        if source != ChunkSource::Preexisting {
            inner.fetched_bytes[source.idx()] =
                inner.fetched_bytes[source.idx()].saturating_add(size);
        }
        inner.delivered_bytes[source.idx()] =
            inner.delivered_bytes[source.idx()].saturating_add(carried_delivered);
        inner.live.insert(
            (key.to_string(), idx),
            ChunkRec {
                source,
                populated_at: now,
                size,
                delivered: carried_delivered,
                first_use,
                last_use,
            },
        );
    }

    /// `bytes` of chunk `(key, idx)` were handed to a client response.
    /// Chunks with no live record (durable before boot) are attributed
    /// `Preexisting` — delivery counted, fetch credit and reuse latency not.
    pub fn record_deliver(&self, key: &str, idx: u64, chunk_len: u64, bytes: u64) {
        if bytes == 0 {
            return;
        }
        let now = Instant::now();
        let mut inner = self.mu.lock().unwrap();
        // Scope the entry borrow so later aggregate updates don't alias it.
        let (src_idx, bucket) = {
            let rec = inner.live.entry((key.to_string(), idx)).or_insert_with(|| ChunkRec {
                source: ChunkSource::Preexisting,
                populated_at: now,
                size: chunk_len,
                delivered: 0,
                first_use: None,
                last_use: None,
            });
            rec.delivered = rec.delivered.saturating_add(bytes);
            rec.last_use = Some(now);
            let mut bucket = None;
            if rec.first_use.is_none() {
                rec.first_use = Some(now);
                // Reuse distance is only meaningful when this process observed
                // the fill: Preexisting chunks have no honest fill timestamp.
                if rec.source != ChunkSource::Preexisting {
                    let dt = now.saturating_duration_since(rec.populated_at).as_secs();
                    bucket = Some(
                        LATENCY_BOUNDS_S
                            .iter()
                            .position(|&bound| dt <= bound)
                            .unwrap_or(LATENCY_BOUNDS_S.len() - 1),
                    );
                }
            }
            (rec.source.idx(), bucket)
        };
        if let Some(b) = bucket {
            inner.reuse_latency[b] = inner.reuse_latency[b].saturating_add(1);
        }
        inner.delivered_bytes[src_idx] =
            inner.delivered_bytes[src_idx].saturating_add(bytes);
    }

    /// A chunk left durable storage. Folds into per-source aggregates and
    /// drops the record. Unknown chunks count under `Preexisting`.
    pub fn record_evict(&self, key: &str, idx: u64, size: u64) {
        let mut inner = self.mu.lock().unwrap();
        match inner.live.remove(&(key.to_string(), idx)) {
            Some(rec) => {
                let slot = if rec.delivered > 0 {
                    &mut inner.evicted_used_bytes
                } else {
                    &mut inner.evicted_unused_bytes
                };
                slot[rec.source.idx()] = slot[rec.source.idx()].saturating_add(rec.size);
            }
            None => {
                inner.evicted_unused_bytes[ChunkSource::Preexisting.idx()] =
                    inner.evicted_unused_bytes[ChunkSource::Preexisting.idx()].saturating_add(size);
            }
        }
    }

    /// Snapshot for /metrics. Ratios are computed here and labeled so the
    /// handler stays a dumb serializer.
    pub fn snapshot(&self) -> serde_json::Value {
        let inner = self.mu.lock().unwrap();
        let by_source: Vec<serde_json::Value> = ChunkSource::all()
            .iter()
            .map(|s| {
                let i = s.idx();
                let fetched = inner.fetched_bytes[i];
                let delivered = inner.delivered_bytes[i];
                let ev_used = inner.evicted_used_bytes[i];
                let ev_unused = inner.evicted_unused_bytes[i];
                serde_json::json!({
                    "source": s.name(),
                    "fetched_bytes": fetched,
                    "delivered_bytes": delivered,
                    "evicted_used_bytes": ev_used,
                    "evicted_unused_bytes": ev_unused,
                    // Share of fetched bytes later handed to a consumer at
                    // least once (delivery volume, not distinct chunks).
                    "delivered_share": if fetched > 0 {
                        (delivered as f64 / fetched as f64 * 1000.0).round() / 1000.0
                    } else { 0.0 },
                    // Share of fetched bytes evicted with zero consumer use.
                    "evicted_unused_share": if fetched > 0 {
                        (ev_unused as f64 / fetched as f64 * 1000.0).round() / 1000.0
                    } else { 0.0 },
                })
            })
            .collect();
        let live_chunks = inner.live.len() as u64;
        let live_bytes: u64 = inner.live.values().map(|r| r.size).sum();
        let histogram: Vec<serde_json::Value> = LATENCY_LABELS
            .iter()
            .zip(inner.reuse_latency.iter())
            .map(|(label, count)| serde_json::json!({"le": label, "chunks": count}))
            .collect();
        // Observed (this-process) background = prefetch + post_disconnect +
        // demand_backfill. DemandServe is foreground by construction.
        let bg_idx = [
            ChunkSource::DemandBackfill.idx(),
            ChunkSource::Prefetch.idx(),
            ChunkSource::PostDisconnect.idx(),
        ];
        let bg_fetched: u64 = bg_idx.iter().map(|&i| inner.fetched_bytes[i]).sum();
        let bg_delivered: u64 = bg_idx.iter().map(|&i| inner.delivered_bytes[i]).sum();
        let bg_ev_unused: u64 = bg_idx.iter().map(|&i| inner.evicted_unused_bytes[i]).sum();
        serde_json::json!({
            "by_source": by_source,
            "live_chunks_tracked": live_chunks,
            "live_bytes_tracked": live_bytes,
            "reuse_latency_chunks": histogram,
            "background": {
                "fetched_bytes": bg_fetched,
                "delivered_bytes": bg_delivered,
                "evicted_unused_bytes": bg_ev_unused,
                "reuse_ratio": if bg_fetched > 0 {
                    (bg_delivered as f64 / bg_fetched as f64 * 1000.0).round() / 1000.0
                } else { 0.0 },
                "evicted_unused_ratio": if bg_fetched > 0 {
                    (bg_ev_unused as f64 / bg_fetched as f64 * 1000.0).round() / 1000.0
                } else { 0.0 },
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn populate_deliver_evict_folds_exact_ratios() {
        let l = ChunkValueLedger::default();
        // Two demand chunks fetched; one delivered twice (replay counts volume).
        l.record_populate("k", 0, 100, ChunkSource::DemandServe);
        l.record_populate("k", 1, 100, ChunkSource::DemandServe);
        l.record_deliver("k", 0, 100, 100);
        l.record_deliver("k", 0, 100, 100);
        // One prefetch chunk fetched, never delivered, then evicted.
        l.record_populate("k", 2, 100, ChunkSource::Prefetch);
        l.record_evict("k", 2, 100);
        // One demand chunk delivered then evicted used.
        l.record_evict("k", 0, 100);

        let s = l.snapshot();
        let by: HashMap<String, serde_json::Value> = s["by_source"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| (v["source"].as_str().unwrap().to_string(), v.clone()))
            .collect();
        assert_eq!(by["demand_serve"]["fetched_bytes"], 200);
        assert_eq!(by["demand_serve"]["delivered_bytes"], 200);
        assert_eq!(by["demand_serve"]["evicted_used_bytes"], 100);
        assert_eq!(by["demand_serve"]["evicted_unused_bytes"], 0);
        assert_eq!(by["prefetch"]["fetched_bytes"], 100);
        assert_eq!(by["prefetch"]["delivered_bytes"], 0);
        assert_eq!(by["prefetch"]["evicted_unused_bytes"], 100);
        // Chunk 1 still live: not evicted, not counted as waste.
        assert_eq!(s["live_chunks_tracked"], 1);
        assert_eq!(s["live_bytes_tracked"], 100);
        // Background = prefetch only here: 0/100 reuse, 100/100 unused.
        assert_eq!(s["background"]["fetched_bytes"], 100);
        assert_eq!(s["background"]["reuse_ratio"], 0.0);
        assert_eq!(s["background"]["evicted_unused_ratio"], 1.0);
    }

    #[test]
    fn preexisting_delivery_counts_but_earns_no_fetch_credit_or_latency() {
        let l = ChunkValueLedger::default();
        l.record_deliver("k", 7, 100, 50);
        let s = l.snapshot();
        let by: HashMap<String, serde_json::Value> = s["by_source"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| (v["source"].as_str().unwrap().to_string(), v.clone()))
            .collect();
        assert_eq!(by["preexisting"]["fetched_bytes"], 0);
        assert_eq!(by["preexisting"]["delivered_bytes"], 50);
        let total_lat: u64 = s["reuse_latency_chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["chunks"].as_u64().unwrap())
            .sum();
        assert_eq!(total_lat, 0, "unknown fill time must not pollute the histogram");
    }

    #[test]
    fn post_disconnect_delivery_redeems_in_background_ratio() {
        let l = ChunkValueLedger::default();
        l.record_populate("k", 3, 100, ChunkSource::PostDisconnect);
        l.record_deliver("k", 3, 100, 100);
        let s = l.snapshot();
        assert_eq!(s["background"]["fetched_bytes"], 100);
        assert_eq!(s["background"]["reuse_ratio"], 1.0);
        assert_eq!(s["background"]["evicted_unused_ratio"], 0.0);
    }

    #[test]
    fn populate_merges_early_delivery_history() {
        // Streaming fills deliver bytes BEFORE the chunk completes and
        // publishes. The pre-publish delivery must survive publication and
        // land in the now-known source bucket — never dropped, never double.
        let l = ChunkValueLedger::default();
        l.record_deliver("k", 0, 100, 60);
        l.record_populate("k", 0, 100, ChunkSource::DemandServe);
        l.record_deliver("k", 0, 100, 40);
        let s = l.snapshot();
        let by: HashMap<String, serde_json::Value> = s["by_source"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| (v["source"].as_str().unwrap().to_string(), v.clone()))
            .collect();
        assert_eq!(by["demand_serve"]["fetched_bytes"], 100);
        assert_eq!(by["demand_serve"]["delivered_bytes"], 100);
        assert_eq!(by["preexisting"]["delivered_bytes"], 0, "moved, not duplicated");
        let total_lat: u64 = s["reuse_latency_chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["chunks"].as_u64().unwrap())
            .sum();
        assert_eq!(total_lat, 1, "exactly one first-use bucketing");
        assert_eq!(s["reuse_latency_chunks"].as_array().unwrap()[0]["chunks"], 1);
    }

    #[test]
    fn zero_bytes_deliver_is_ignored_and_empty_snapshot_is_zeroed() {
        let l = ChunkValueLedger::default();
        l.record_deliver("k", 9, 100, 0);
        let s = l.snapshot();
        assert_eq!(s["live_chunks_tracked"], 0);
        assert_eq!(s["background"]["fetched_bytes"], 0);
    }
}
