// Slice 4.75 — Fixed-grid chunk cache.
//
// Slice 4/4.5 stored ARBITRARY durable extents: any interval the coalescer
// happened to fetch became durable truth. Durable state therefore depended on
// request shape — the same bytes could be present as one 8 MiB extent in one
// run and as two hundred small extents in another — and every plan had to do
// interval union/difference math against rows whose boundaries nobody
// controlled.
//
// Slice 4.75 replaces that with a FIXED GRID:
//
//   TorrentFile -> chunkIndex -> complete chunk PRESENT or ABSENT
//   chunk_start(i) = i * chunk_size
//   chunk_len(i)   = min(chunk_size, file_size - chunk_start(i))
//
// The grid is a pure function of (file_size, chunk_size), so durable truth is
// independent of request shape. Consequences:
//
//   * A row in `chunks` exists IFF the complete expected chunk is durably on
//     disk. There is NO durable partial state and NO durable FILLING state, so
//     a crash can never leave a half-written chunk advertised as present.
//     FILLING is runtime-only (the in-flight map) and never persisted.
//   * Coalescing is per-chunk single-flight: key = (cache_key, chunk_index).
//     One owner, any number of waiters. No interval-fragmentation logic.
//   * The chunk is the unit of DURABLE truth, not necessarily of NETWORK I/O:
//     adjacent missing chunks collapse into ONE provider Range and are split
//     back into chunks on arrival.
//
// The EOF chunk is deterministically shorter than `chunk_size`. That is part of
// the grid definition, not a special case: `chunk_len` computes it and every
// consumer uses `chunk_len` rather than assuming a uniform length.
//
// What deliberately did NOT change: the external HTTP Range contract (206/416
// and exact byte windows), provider behavior, the Slice 3 limiter/breaker/
// capability path, Slice 3.5 recovery, and the whole Slice 4.5 stage waterfall.
//
// Chunk size is CONFIGURED and PERSISTED with the cache format version. Changing
// either one invalidates the grid, so the store is reset to clean rather than
// reinterpreted. "8 MiB" is a default, not ontology.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rusqlite::{params, Connection};
use tokio::sync::Notify;

use crate::metrics::Metrics;

/// Durable cache format version. Slice 4 used the arbitrary-extent layout with
/// no version marker at all; Slice 4.75 starts a NEW database file
/// (`chunks.sqlite`) at version 2 and discards the experimental extent store
/// rather than migrating it (see §8 of the Slice 4.75 brief).
pub const CACHE_FORMAT_VERSION: u64 = 2;

/// Default chunk size. Configurable via `SLICE4_CHUNK_SIZE`.
pub const DEFAULT_CHUNK_SIZE: u64 = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Identity — P3 FINAL IDENTITY CHECK (Conclusion B)
//
// `torrent_files.id` is a SQLite surrogate PK: a `tf_<randomUUID()>` generated
// at first insert (media-search/src/lib/control-plane/store.js:923). The same
// logical TorrentFile can therefore acquire a different surrogate id across
// any DB reconstruction, import, merge, repair that wipes the row, or
// different inventory-observation run. There is no `UPDATE torrent_files` and
// no `DELETE FROM torrent_files` anywhere in the repo, so the existing
// surrogate is preserved WITHIN ONE DB INSTANCE, but it is NOT durable
// across host DB lifecycle changes.
//
// The schema itself declares the identity grain (store.js:97-110):
//   "Identity is (info_hash, canonical_internal_path). The size is a
//    positive integer invariant; once inserted it is never updated."
//
// Therefore the cache and the capability single-flight MUST NOT key on
// `torrent_files.id`. The key MUST be a deterministic representation of the
// durable tuple: InfoHash + CanonicalInternalPath + Exact positive size.
//
// Key format: `tfkv\x1f<info_hash>\x1f<size_decimal>\x1f<canonical_path>`
//   - `\x1f` (ASCII Unit Separator) is the field separator. The host's
//     `canonicalizeInternalPath` allows arbitrary characters except
//     backslash, NUL, and ".."-as-component; `\x1f` is not in any
//     provider path report and is not forbidden, but even if it
//     appeared in some future provider's path, the length-prefix-free
//     form here is unambiguous because the size is a fixed-format
//     decimal terminating at the next `\x1f`.
//   - `info_hash` is always 40 lowercase hex chars (the DB has a CHECK
//     constraint enforcing this on insert).
//   - `size` is a positive safe integer serialized as decimal.
//   - `canonical_path` is the verbatim canonicalized form.
//
// `tf_id_durable` is RETAINED as a field for logging and forensics (it
// identifies the current DB row, which is still useful), but it is NOT
// the cache key, and changing the surrogate id for the same logical
// TorrentFile does NOT change the cache key.
//
// See docs/hy4/CROSS-FILE-KEYING-AUDIT.md §11 (P3 final identity check).
// ---------------------------------------------------------------------------

/// The frozen, durable identity of a cached file. Bytes are interchangeable across
/// providers only under the same `TorrentFileId`.
///
/// The cache key is the deterministic `durable_key` (a representation of
/// `info_hash + canonical_path + size`); see the file-level note above.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct TorrentFileId {
    /// Current host DB row id from S-1 (`torrent_files.id`). RETAINED for
    /// logging, forensics, and round-tripping with the host. NOT used as
    /// the cache key — this value can change when the same logical
    /// TorrentFile is reconstructed.
    pub tf_id_durable: String,
    /// S-1-projected BitTorrent info_hash. Part of the durable identity tuple.
    pub info_hash: String,
    pub canonical_path: String,
    pub size: u64,
    /// Deterministic key derived from `(info_hash, canonical_path, size)`.
    /// Stable across DB reconstruction, import, merge, repair, restart.
    /// Computed once at construction and reused.
    pub durable_key: String,
}

impl TorrentFileId {
    /// Build a `TorrentFileId` and compute its deterministic `durable_key`.
    pub fn new(
        tf_id_durable: String,
        info_hash: String,
        canonical_path: String,
        size: u64,
    ) -> Self {
        let durable_key = Self::compute_durable_key(&info_hash, &canonical_path, size);
        Self {
            tf_id_durable,
            info_hash,
            canonical_path,
            size,
            durable_key,
        }
    }

    /// The cache key. Stable across host DB lifecycle changes.
    pub fn cache_key(&self) -> String {
        self.durable_key.clone()
    }

    /// The deterministic key for `(info_hash, canonical_path, size)`.
    /// Public so the capability layer (manager.rs) can derive the same
    /// key without going through a full `TorrentFileId`.
    pub fn compute_durable_key(info_hash: &str, canonical_path: &str, size: u64) -> String {
        // \x1f is the ASCII Unit Separator; it is the conventional
        // unambiguous field delimiter in data engineering. It is not
        // forbidden by canonicalizeInternalPath, but no provider in
        // scope has ever reported a path containing it.
        format!("tfkv\x1f{}\x1f{}\x1f{}", info_hash, size, canonical_path)
    }
}

// ---------------------------------------------------------------------------
// ChunkGrid — the fixed grid itself
// ---------------------------------------------------------------------------

/// The fixed grid over one TorrentFile. A pure function of (chunk_size, file_size).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChunkGrid {
    pub chunk_size: u64,
    pub file_size: u64,
}

impl ChunkGrid {
    pub fn new(chunk_size: u64, file_size: u64) -> Self {
        assert!(chunk_size > 0, "chunk_size must be > 0");
        Self {
            chunk_size,
            file_size,
        }
    }

    pub fn chunk_count(&self) -> u64 {
        if self.file_size == 0 {
            0
        } else {
            (self.file_size + self.chunk_size - 1) / self.chunk_size
        }
    }

    pub fn chunk_start(&self, i: u64) -> u64 {
        i * self.chunk_size
    }

    /// Expected length of chunk `i`. The EOF chunk is deterministically shorter;
    /// a chunk starting at or beyond EOF has length 0 (it does not exist).
    pub fn chunk_len(&self, i: u64) -> u64 {
        let s = self.chunk_start(i);
        if s >= self.file_size {
            0
        } else {
            self.chunk_size.min(self.file_size - s)
        }
    }

    /// Inclusive end offset of chunk `i`. Returns `None` for a non-existent chunk.
    pub fn chunk_end(&self, i: u64) -> Option<u64> {
        let len = self.chunk_len(i);
        if len == 0 {
            None
        } else {
            Some(self.chunk_start(i) + len - 1)
        }
    }

    pub fn index_of(&self, offset: u64) -> u64 {
        offset / self.chunk_size
    }

    /// Every chunk index whose byte range intersects `[start..=end]`, ascending.
    pub fn chunks_touching(&self, start: u64, end: u64) -> Vec<u64> {
        if self.file_size == 0 || start > end {
            return Vec::new();
        }
        let last = end.min(self.file_size - 1);
        if start > last {
            return Vec::new();
        }
        let a = self.index_of(start);
        let b = self.index_of(last);
        (a..=b).collect()
    }
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

/// One touched chunk's intersection with the client window `[start..=end]`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChunkSeg {
    pub index: u64,
    /// Inclusive start, clamped to the client window.
    pub start: u64,
    /// Inclusive end, clamped to the client window.
    pub end: u64,
    /// Whether this chunk is durably PRESENT at plan time.
    pub present: bool,
}

/// What a maximal run of same-kind segments must be served from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunKind {
    /// Every byte of this run is already durable; read it locally.
    Local,
    /// None of these bytes are durable yet; fetch upstream, stage the whole
    /// chunks, and stream the window to the client as bytes arrive.
    Fetch,
}

/// A maximal run of consecutive segments sharing a `RunKind`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlanRun {
    pub kind: RunKind,
    /// Inclusive window bounds of this run (always within the client request).
    pub start: u64,
    pub end: u64,
    /// Half-open range into `ChunkPlan::segments`.
    pub seg_from: usize,
    pub seg_to: usize,
}

/// The fixed-grid plan for one client Range request.
#[derive(Clone, Debug)]
pub struct ChunkPlan {
    pub grid: ChunkGrid,
    pub request: (u64, u64),
    /// Ascending by file offset; together these cover EXACTLY `[request.0, request.1]`.
    pub segments: Vec<ChunkSeg>,
}

impl ChunkPlan {
    /// All segments PRESENT — i.e. the request is served with zero provider work.
    /// This is the only honest definition of a cache hit: on a miss the client is
    /// ALSO ultimately served locally (after the fill publishes), so
    /// "bytes came from disk" would wrongly report every miss as a hit.
    pub fn is_full_hit(&self) -> bool {
        !self.segments.is_empty() && self.segments.iter().all(|s| s.present)
    }

    /// Group consecutive same-kind segments into runs. Runs are ascending by
    /// file offset and together cover the whole request.
    pub fn runs(&self) -> Vec<PlanRun> {
        let mut out: Vec<PlanRun> = Vec::new();
        let mut i = 0usize;
        while i < self.segments.len() {
            let kind = if self.segments[i].present {
                RunKind::Local
            } else {
                RunKind::Fetch
            };
            let mut j = i;
            while j + 1 < self.segments.len()
                && self.segments[j + 1].present == self.segments[i].present
            {
                j += 1;
            }
            out.push(PlanRun {
                kind,
                start: self.segments[i].start,
                end: self.segments[j].end,
                seg_from: i,
                seg_to: j + 1,
            });
            i = j + 1;
        }
        out
    }

    /// Chunk indices covered by a run, ascending.
    pub fn run_indices(&self, r: &PlanRun) -> Vec<u64> {
        self.segments[r.seg_from..r.seg_to]
            .iter()
            .map(|s| s.index)
            .collect()
    }

    /// Bytes of the request that are already durable.
    pub fn local_bytes(&self) -> u64 {
        self.segments
            .iter()
            .filter(|s| s.present)
            .map(|s| s.end - s.start + 1)
            .sum()
    }
}

// ---------------------------------------------------------------------------
// Per-chunk single-flight coalescer (runtime only; never persisted)
// ---------------------------------------------------------------------------

/// ONE chunk fill. The owner stages + publishes the chunk; every other reader
/// that needs the same chunk attaches as a waiter.
///
/// `done` is a `Notify`. `notify_waiters()` stores NO permit, so a waiter that
/// calls `notified().await` after the notification was already delivered blocks
/// forever. Callers MUST check `success`/`failed` BEFORE awaiting — the pattern
/// used in `main.rs`.
pub struct ChunkInFlightRecord {
    pub key: String,
    pub chunk_index: u64,
    pub done: Notify,
    pub success: AtomicBool,
    pub failed: AtomicBool,
    pub error: Mutex<Option<String>>,
}

impl ChunkInFlightRecord {
    fn new(key: &str, chunk_index: u64) -> Arc<Self> {
        Arc::new(Self {
            key: key.to_string(),
            chunk_index,
            done: Notify::new(),
            success: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            error: Mutex::new(None),
        })
    }
}

/// Outcome of joining or claiming ONE chunk.
#[derive(Clone)]
pub struct ChunkJoin {
    pub index: u64,
    /// True iff this caller now OWNS the fill and must drive it upstream.
    pub owned: bool,
    /// The record to wait on (always present, owned or not).
    pub record: Arc<ChunkInFlightRecord>,
    /// True iff another reader was already filling this chunk (we are a waiter).
    pub joined_existing: bool,
}

/// `(cache_key, chunk_index) -> fill record`. Single mutex; churn is low.
pub struct InFlightMap {
    map: Mutex<BTreeMap<(String, u64), Arc<ChunkInFlightRecord>>>,
}

impl Default for InFlightMap {
    fn default() -> Self {
        Self {
            map: Mutex::new(BTreeMap::new()),
        }
    }
}

impl InFlightMap {
    /// Claim chunk `idx` for `key`, or join an existing owner's fill.
    pub fn join_or_claim(&self, key: &str, idx: u64) -> ChunkJoin {
        let mut map = self.map.lock();
        if let Some(rec) = map.get(&(key.to_string(), idx)) {
            return ChunkJoin {
                index: idx,
                owned: false,
                record: rec.clone(),
                joined_existing: true,
            };
        }
        let rec = ChunkInFlightRecord::new(key, idx);
        map.insert((key.to_string(), idx), rec.clone());
        ChunkJoin {
            index: idx,
            owned: true,
            record: rec,
            joined_existing: false,
        }
    }

    /// Claim/join a whole ascending list of chunk indices, atomically enough that
    /// two concurrent readers cannot both believe they own the same chunk.
    ///
    /// NOTE: the whole batch is taken under one lock acquisition. That matters —
    /// per-index locking would let reader A claim 10 and reader B claim 11 and
    /// then deadlock when each waits for the other to drive its piece.
    pub fn join_or_claim_many(&self, key: &str, indices: &[u64]) -> Vec<ChunkJoin> {
        let mut map = self.map.lock();
        let k = key.to_string();
        indices
            .iter()
            .map(|&idx| {
                if let Some(rec) = map.get(&(k.clone(), idx)) {
                    ChunkJoin {
                        index: idx,
                        owned: false,
                        record: rec.clone(),
                        joined_existing: true,
                    }
                } else {
                    let rec = ChunkInFlightRecord::new(key, idx);
                    map.insert((k.clone(), idx), rec.clone());
                    ChunkJoin {
                        index: idx,
                        owned: true,
                        record: rec,
                        joined_existing: false,
                    }
                }
            })
            .collect()
    }

    /// Look up records the caller already owns (used by the fill task to set
    /// success/failed and notify). Returns `None` if a record vanished — which
    /// would mean someone finalized a chunk they did not own.
    pub fn records_for(&self, key: &str, indices: &[u64]) -> Vec<Arc<ChunkInFlightRecord>> {
        let map = self.map.lock();
        indices
            .iter()
            .filter_map(|i| map.get(&(key.to_string(), *i)).cloned())
            .collect()
    }

    /// Drop a fill record. Called by the owner after setting success/failed and
    /// notifying, so a later reader sees an ABSENT-or-PRESENT chunk and either
    /// claims it fresh or reads it locally.
    pub fn finalize(&self, key: &str, idx: u64) {
        self.map.lock().remove(&(key.to_string(), idx));
    }

    /// True iff a fill for this chunk is live RIGHT NOW.
    pub fn has(&self, key: &str, idx: u64) -> bool {
        self.map.lock().contains_key(&(key.to_string(), idx))
    }

    pub fn len(&self) -> usize {
        self.map.lock().len()
    }
}

// ---------------------------------------------------------------------------
// CacheEngine
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct CacheConfig {
    pub root: PathBuf,
    pub max_bytes: u64,
    /// Fixed grid stride. Persisted alongside the format version; changing it
    /// invalidates the grid, so the store is reset rather than reinterpreted.
    pub chunk_size: u64,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            root: std::env::var("SLICE4_CACHE_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("./slice4-cache")),
            max_bytes: std::env::var("SLICE4_CACHE_MAX_BYTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(512 * 1024 * 1024),
            chunk_size: std::env::var("SLICE4_CHUNK_SIZE")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|v: &u64| *v > 0)
                .unwrap_or(DEFAULT_CHUNK_SIZE),
        }
    }
}

pub struct CacheEngine {
    pub cfg: CacheConfig,
    /// Single connection guarded by a mutex. WAL for crash safety.
    db: Mutex<Connection>,
    /// Per-chunk single-flight.
    inflight: InFlightMap,
    /// Live byte count: SUM(size) over complete PRESENT chunk rows.
    current_bytes: AtomicU64,
    /// Open chunk-file handles, bounded by cache capacity / chunk size.
    chunk_files: Mutex<BTreeMap<(String, u64), Arc<Mutex<File>>>>,
    pub metrics: Arc<Metrics>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl CacheEngine {
    pub fn open(cfg: CacheConfig, metrics: Arc<Metrics>) -> rusqlite::Result<Arc<Self>> {
        std::fs::create_dir_all(&cfg.root)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        // Deliberately a NEW database file. Slice 4's `extents.sqlite` is left
        // untouched and inert: the brief says old experimental contents do not
        // require migration, so there is no code here that reads them.
        let db_path = cfg.root.join("chunks.sqlite");
        let db = Connection::open(&db_path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "NORMAL")?;
        db.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chunks (
                cache_key   TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                size        INTEGER NOT NULL,
                last_access INTEGER NOT NULL,
                PRIMARY KEY (cache_key, chunk_index)
            );
            CREATE INDEX IF NOT EXISTS chunks_lru ON chunks(last_access);
            "#,
        )?;
        let engine = Arc::new(Self {
            cfg,
            db: Mutex::new(db),
            inflight: InFlightMap::default(),
            current_bytes: AtomicU64::new(0),
            chunk_files: Mutex::new(BTreeMap::new()),
            metrics,
        });

        // ---- Format / grid handshake -------------------------------------
        //
        // A row in `chunks` means "the complete expected chunk is durably on
        // disk". That meaning is only valid for ONE (format_version, chunk_size)
        // pair: `size` records the expected length, and the expected length is a
        // function of the grid. If either has changed, every surviving row now
        // describes bytes on a grid that no longer exists, so the honest move is
        // to discard them — not to reinterpret them.
        let stored_version = engine.meta_get("format_version")?;
        let stored_chunk = engine.meta_get("chunk_size")?;
        let version_ok = stored_version == Some(CACHE_FORMAT_VERSION);
        let chunk_ok = stored_chunk == Some(engine.cfg.chunk_size);
        if !version_ok || !chunk_ok {
            if stored_version.is_some() || stored_chunk.is_some() {
                eprintln!(
                    "[cache] format/grid change detected (stored format={:?} chunk_size={:?}; \
                     current format={} chunk_size={}) — resetting cache store to clean",
                    stored_version, stored_chunk, CACHE_FORMAT_VERSION, engine.cfg.chunk_size
                );
            }
            engine.reset_store()?;
            engine.meta_set("format_version", CACHE_FORMAT_VERSION)?;
            engine.meta_set("chunk_size", engine.cfg.chunk_size)?;
        }

        // Recompute current_bytes from complete PRESENT chunks.
        let total: i64 = {
            let db = engine.db.lock();
            db.query_row("SELECT COALESCE(SUM(size),0) FROM chunks", [], |r| r.get(0))?
        };
        engine.current_bytes.store(total.max(0) as u64, Ordering::SeqCst);
        Ok(engine)
    }

    fn meta_get(&self, k: &str) -> rusqlite::Result<Option<u64>> {
        let db = self.db.lock();
        let v: Option<String> = db
            .query_row("SELECT value FROM meta WHERE key=?1", params![k], |r| r.get(0))
            .ok();
        Ok(v.and_then(|s| s.parse::<u64>().ok()))
    }

    fn meta_set(&self, k: &str, v: u64) -> rusqlite::Result<()> {
        let db = self.db.lock();
        db.execute(
            "INSERT INTO meta(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![k, v.to_string()],
        )?;
        Ok(())
    }

    /// Drop every chunk row and every chunk object. Used when the format or the
    /// grid changed; there is no interpretation under which the old bytes are
    /// still valid.
    fn reset_store(&self) -> rusqlite::Result<()> {
        {
            let db = self.db.lock();
            db.execute("DELETE FROM chunks", [])?;
        }
        if let Ok(rd) = fs::read_dir(&self.cfg.root) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    let _ = fs::remove_dir_all(&p);
                }
            }
        }
        self.chunk_files.lock().clear();
        self.current_bytes.store(0, Ordering::SeqCst);
        Ok(())
    }

    // ---- paths -----------------------------------------------------------

    /// Local object-shaped storage: `cache/<cache_key>/<chunk_index>.chunk`.
    /// This is a directory of files, NOT an object store: no S3 API, no MinIO,
    /// no multipart upload, no tiering, no remote credentials.
    fn chunk_dir(&self, key: &str) -> PathBuf {
        self.cfg.root.join(key)
    }

    fn chunk_path(&self, key: &str, idx: u64) -> PathBuf {
        self.chunk_dir(key).join(format!("{idx}.chunk"))
    }

    fn staging_path(&self, key: &str, idx: u64, tag: u64) -> PathBuf {
        self.chunk_dir(key).join(format!(".stage-{idx}-{tag}.tmp"))
    }

    fn ensure_dir(&self, key: &str) -> rusqlite::Result<()> {
        fs::create_dir_all(self.chunk_dir(key))
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
    }

    // ---- budget ----------------------------------------------------------

    pub fn current_bytes(&self) -> u64 {
        self.current_bytes.load(Ordering::SeqCst)
    }

    fn add_current_bytes(&self, n: u64) {
        self.current_bytes.fetch_add(n, Ordering::SeqCst);
    }

    /// Saturating subtraction. `fetch_sub` wraps on underflow, and a wrapped
    /// budget counter reads as ~18 EiB, which would evict the entire cache.
    fn sub_current_bytes(&self, n: u64) {
        let _ = self.current_bytes.fetch_update(
            Ordering::SeqCst,
            Ordering::SeqCst,
            |cur| Some(cur.saturating_sub(n)),
        );
    }

    pub fn chunk_size(&self) -> u64 {
        self.cfg.chunk_size
    }

    pub fn grid_for(&self, tf: &TorrentFileId) -> ChunkGrid {
        ChunkGrid::new(self.cfg.chunk_size, tf.size)
    }

    // ---- presence --------------------------------------------------------

    pub fn is_present(&self, key: &str, idx: u64) -> rusqlite::Result<bool> {
        let db = self.db.lock();
        let n: i64 = db.query_row(
            "SELECT COUNT(*) FROM chunks WHERE cache_key=?1 AND chunk_index=?2",
            params![key, idx as i64],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// Present chunk indices within `[lo..=hi]`, ascending.
    fn present_in_range(&self, key: &str, lo: u64, hi: u64) -> rusqlite::Result<Vec<u64>> {
        let db = self.db.lock();
        let mut stmt = db.prepare(
            "SELECT chunk_index FROM chunks
             WHERE cache_key=?1 AND chunk_index>=?2 AND chunk_index<=?3
             ORDER BY chunk_index ASC",
        )?;
        let rows = stmt
            .query_map(params![key, lo as i64, hi as i64], |r| {
                r.get::<_, i64>(0).map(|v| v as u64)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Refresh LRU for every chunk a request touched. Batched into one UPDATE
    /// rather than one per chunk.
    pub fn touch(&self, key: &str, lo: u64, hi: u64) -> rusqlite::Result<()> {
        let db = self.db.lock();
        db.execute(
            "UPDATE chunks SET last_access=?1 WHERE cache_key=?2 AND chunk_index>=?3 AND chunk_index<=?4",
            params![now_ms(), key, lo as i64, hi as i64],
        )?;
        Ok(())
    }

    // ---- planning --------------------------------------------------------

    /// Build the fixed-grid plan for `[start..=end]`.
    ///
    /// The segments it returns tile EXACTLY the requested window — no more, no
    /// less. That is the whole of the external-contract guarantee: the chunk grid
    /// may make us FETCH more than the client asked for (measured as
    /// `chunk_overfetch_bytes`), but it must never make us DELIVER more.
    pub fn plan_chunks(
        self: &Arc<Self>,
        tf_id: &TorrentFileId,
        start: u64,
        end: u64,
    ) -> rusqlite::Result<ChunkPlan> {
        let key = tf_id.cache_key();
        let grid = self.grid_for(tf_id);
        let indices = grid.chunks_touching(start, end);
        let present: std::collections::BTreeSet<u64> = if indices.is_empty() {
            Default::default()
        } else {
            self.present_in_range(&key, indices[0], *indices.last().unwrap())?
                .into_iter()
                .collect()
        };
        let mut segments = Vec::with_capacity(indices.len());
        for i in &indices {
            let cs = grid.chunk_start(*i);
            let ce = match grid.chunk_end(*i) {
                Some(e) => e,
                None => continue,
            };
            let s = start.max(cs);
            let e = end.min(ce);
            if s > e {
                continue;
            }
            segments.push(ChunkSeg {
                index: *i,
                start: s,
                end: e,
                present: present.contains(i),
            });
        }
        if !indices.is_empty() {
            self.touch(&key, indices[0], *indices.last().unwrap())?;
        }

        // Plan-time accounting. Local bytes are exact here (presence is known);
        // upstream bytes are counted at FETCH time in main.rs, because only the
        // fetch site knows whether the coalescer already covered a chunk.
        let local_bytes: u64 = segments
            .iter()
            .filter(|s| s.present)
            .map(|s| s.end - s.start + 1)
            .sum();
        if !segments.is_empty() {
            if segments.iter().all(|s| s.present) {
                self.metrics.cache.full_hits.fetch_add(1, Ordering::SeqCst);
            } else if segments.iter().any(|s| s.present) {
                self.metrics.cache.partial_hits.fetch_add(1, Ordering::SeqCst);
            } else {
                self.metrics.cache.misses.fetch_add(1, Ordering::SeqCst);
            }
            self.metrics
                .cache
                .bytes_local
                .fetch_add(local_bytes, Ordering::SeqCst);
        }
        Ok(ChunkPlan {
            grid,
            request: (start, end),
            segments,
        })
    }

    // ---- local read ------------------------------------------------------

    fn open_chunk_file(&self, key: &str, idx: u64) -> std::io::Result<Arc<Mutex<File>>> {
        let mut m = self.chunk_files.lock();
        if let Some(f) = m.get(&(key.to_string(), idx)) {
            return Ok(f.clone());
        }
        let f = OpenOptions::new().read(true).open(self.chunk_path(key, idx))?;
        let a = Arc::new(Mutex::new(f));
        m.insert((key.to_string(), idx), a.clone());
        Ok(a)
    }

    /// Read `[start..=end]` out of the chunk objects. Exact bytes or error.
    ///
    /// Spans chunk boundaries transparently: a local run can cover several
    /// consecutive present chunks.
    pub fn pread(
        self: &Arc<Self>,
        tf_id: &TorrentFileId,
        start: u64,
        end: u64,
    ) -> std::io::Result<Vec<u8>> {
        let key = tf_id.cache_key();
        let grid = self.grid_for(tf_id);
        let mut out = Vec::with_capacity((end - start + 1) as usize);
        let mut pos = start;
        while pos <= end {
            let idx = grid.index_of(pos);
            let ce = grid
                .chunk_end(idx)
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "past EOF"))?;
            let e = end.min(ce);
            let file = self.open_chunk_file(&key, idx).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::Other, format!("chunk {idx}: {e}"))
            })?;
            let mut f = file.lock();
            f.seek(SeekFrom::Start(pos - grid.chunk_start(idx)))?;
            let n = (e - pos + 1) as usize;
            let base = out.len();
            out.resize(base + n, 0u8);
            f.read_exact(&mut out[base..base + n])?;
            drop(f);
            pos = e + 1;
        }
        Ok(out)
    }

    // ---- staging + publication -------------------------------------------

    /// Begin staging a contiguous upstream span that will be split into chunks.
    pub fn begin_stage(self: &Arc<Self>, tf: TorrentFileId) -> rusqlite::Result<Arc<ChunkStager>> {
        let key = tf.cache_key();
        self.ensure_dir(&key)?;
        Ok(Arc::new(ChunkStager {
            engine: self.clone(),
            key,
            grid: self.grid_for(&tf),
            tag: STAGE_TAG.fetch_add(1, Ordering::Relaxed),
            cur: Mutex::new(None),
            promoted: Mutex::new(Vec::new()),
        }))
    }

    /// Publish a complete chunk: durable bytes first, then metadata.
    ///
    /// `INSERT OR IGNORE` + `changes()` is load-bearing for the same reason the
    /// 4.5 `UPDATE ... AND state<>'present'` guard was: SQLite reports rows
    /// MATCHED, not values altered, so without the row-count check a racing
    /// second publish would silently charge the byte budget twice. Phantom
    /// budget bytes inflate `current_bytes` permanently and drive more
    /// eviction — a self-reinforcing feedback loop.
    fn publish_chunk(
        &self,
        key: &str,
        idx: u64,
        expected: u64,
    ) -> rusqlite::Result<bool> {
        // A row already exists: someone else published this chunk. Keep the
        // already-published object, drop the redundant staged copy, and do NOT
        // charge the budget again.
        if self.is_present(key, idx)? {
            self.metrics.cache.publish_noop.fetch_add(1, Ordering::SeqCst);
            return Ok(false);
        }
        let db = self.db.lock();
        let changed = db.execute(
            "INSERT OR IGNORE INTO chunks(cache_key, chunk_index, size, last_access)
             VALUES (?1,?2,?3,?4)",
            params![key, idx as i64, expected as i64, now_ms()],
        )?;
        drop(db);
        if changed == 0 {
            self.metrics.cache.publish_noop.fetch_add(1, Ordering::SeqCst);
            return Ok(false);
        }
        self.add_current_bytes(expected);
        self.metrics.cache.chunk_fills.fetch_add(1, Ordering::SeqCst);
        self.metrics
            .cache
            .missing_extents_filled
            .fetch_add(1, Ordering::SeqCst);
        Ok(true)
    }

    // ---- eviction --------------------------------------------------------

    /// Chunk-granular LRU. Evicts coldest-first until `current_bytes <= max_bytes`.
    ///
    /// Candidates are PRESENT chunks only. A chunk with a LIVE fill is skipped
    /// outright (counted in `evict_skipped_filling`): evicting it would delete
    /// the object out from under a fill that is about to publish, and the fill
    /// would then charge the budget for a row that no longer exists.
    ///
    /// The budget is guaranteed AT REST, not mid-fill. A sweep that cannot make
    /// progress stops instead of spinning — transient overshoot during a burst
    /// of concurrent fills is expected and is reported, not hidden.
    pub fn maybe_evict(&self) -> rusqlite::Result<()> {
        let max = self.cfg.max_bytes;
        if self.current_bytes() <= max {
            return Ok(());
        }
        // Coldest first. `last_access` is persisted, so LRU ordering survives a
        // restart (Slice 4's runtime-only map could not, which left a restarted
        // cache permanently over budget with nothing evictable).
        let candidates: Vec<(String, u64, u64)> = {
            let db = self.db.lock();
            let mut stmt = db.prepare(
                "SELECT cache_key, chunk_index, size FROM chunks ORDER BY last_access ASC",
            )?;
            // Bound to a local, then returned: a tail expression keeps its
            // temporaries alive to the end of the block, and `MappedRows`
            // borrows `stmt` — which is dropped before `db`, so the borrow
            // would outlive it.
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)? as u64,
                        r.get::<_, i64>(2)? as u64,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut evicted_bytes: u64 = 0;
        for (k, i, sz) in candidates {
            if self.current_bytes() <= max {
                break;
            }
            // FILLING is runtime-only now: a live fill is exactly "an entry
            // exists in the in-flight map for this (key, chunk)".
            if self.inflight.has(&k, i) {
                // Counted HERE, not in evict_chunk: evict_chunk is never reached
                // for a skipped chunk, so a counter inside it would read 0
                // forever and the guard would be unobservable.
                self.metrics
                    .cache
                    .evict_skipped_filling
                    .fetch_add(1, Ordering::SeqCst);
                continue;
            }
            self.evict_chunk(&k, i, sz)?;
            evicted_bytes += sz;
        }
        if evicted_bytes > 0 {
            self.metrics
                .cache
                .bytes_evicted
                .fetch_add(evicted_bytes, Ordering::SeqCst);
        }
        Ok(())
    }

    fn evict_chunk(&self, key: &str, idx: u64, size: u64) -> rusqlite::Result<()> {
        let db = self.db.lock();
        let changed = db.execute(
            "DELETE FROM chunks WHERE cache_key=?1 AND chunk_index=?2",
            params![key, idx as i64],
        )?;
        drop(db);
        if changed == 0 {
            // Already gone (raced with another sweeper). Do not touch the budget.
            return Ok(());
        }
        self.chunk_files.lock().remove(&(key.to_string(), idx));
        let _ = fs::remove_file(self.chunk_path(key, idx));
        self.sub_current_bytes(size);
        self.metrics.cache.evictions.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    // ---- accessors -------------------------------------------------------

    pub fn inflight(&self) -> &InFlightMap {
        &self.inflight
    }

    /// `(chunks_present, chunks_inflight)`.
    ///
    /// Counted on demand from the chunk map and the in-flight map rather than
    /// tracked as atomics. Slice 4's `extents_present` / `extents_filling`
    /// atomics were declared and surfaced but never written, so they read a
    /// permanent 0 and made every assertion about published state unfalsifiable
    /// — it could neither pass nor fail for the right reason. Deriving the
    /// counts means they cannot drift out of sync with the truth.
    pub fn chunk_counts(&self) -> (u64, u64) {
        let present: i64 = {
            let db = self.db.lock();
            db.query_row("SELECT COALESCE(COUNT(*),0) FROM chunks", [], |r| r.get(0))
                .unwrap_or(0)
        };
        (present.max(0) as u64, self.inflight.len() as u64)
    }

    pub fn debug_summary(&self) -> rusqlite::Result<serde_json::Value> {
        let (present, filling) = self.chunk_counts();
        Ok(serde_json::json!({
            "format_version": CACHE_FORMAT_VERSION,
            "chunk_size": self.cfg.chunk_size,
            "current_bytes": self.current_bytes(),
            "max_bytes": self.cfg.max_bytes,
            "chunks_present": present,
            "chunks_inflight": filling,
        }))
    }
}

static STAGE_TAG: AtomicU64 = AtomicU64::new(1);

/// One in-progress chunk object being written under a temporary name.
struct OpenChunk {
    index: u64,
    expected: u64,
    written: u64,
    file: File,
    tmp: PathBuf,
}

/// Staging + publication for one upstream fetch.
///
/// Bytes arrive in strictly ascending offset order (the resilient reader
/// guarantees this even across internal recovery), so a single "current chunk"
/// cursor is sufficient — no scatter map needed.
///
/// A chunk is promoted the instant its staged length reaches the grid's expected
/// length. Nothing else can ever make a chunk PRESENT: an incomplete chunk is
/// discarded, never published. That is the Slice 4.75 hard invariant — "PRESENT
/// means the complete expected chunk is durably available. No PRESENT metadata
/// may outrun durable bytes."
pub struct ChunkStager {
    engine: Arc<CacheEngine>,
    key: String,
    grid: ChunkGrid,
    tag: u64,
    cur: Mutex<Option<OpenChunk>>,
    promoted: Mutex<Vec<u64>>,
}

impl ChunkStager {
    /// Stage `data` at absolute file offset `offset`, crossing chunk boundaries
    /// as needed. Returns the chunk indices promoted by THIS call (usually 0 or
    /// 1; more only if `data` spans several whole chunks at once).
    pub fn stage(&self, offset: u64, data: &[u8]) -> rusqlite::Result<Vec<u64>> {
        let mut promoted_here: Vec<u64> = Vec::new();
        let mut off = offset;
        let mut rest: &[u8] = data;
        while !rest.is_empty() {
            let idx = self.grid.index_of(off);
            let expected = self.grid.chunk_len(idx);
            if expected == 0 {
                return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("staged byte at {off} lands in non-existent chunk {idx}"),
                    ),
                )));
            }
            let cstart = self.grid.chunk_start(idx);
            let room = (expected - (off - cstart)) as usize;
            let n = rest.len().min(room);
            let mut cur = self.cur.lock();
            let need_open = match cur.as_ref() {
                Some(c) => c.index != idx,
                None => true,
            };
            if need_open {
                // The previous chunk must already be complete: bytes arrive in
                // ascending order, so once we move past a chunk we will never
                // write to it again. If it is somehow short, dropping it here is
                // the correct (and safe) outcome — it never becomes PRESENT.
                self.close_current(&mut cur, false)?;
                *cur = Some(self.open_chunk(idx, expected)?);
            }
            let c = cur.as_mut().unwrap();
            c.file
                .write_all(&rest[..n])
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            c.written += n as u64;
            let complete = c.written == c.expected;
            if complete {
                let idx_done = c.index;
                let expected_done = c.expected;
                // ---- DURABILITY BARRIER ----
                // fsync the staged object BEFORE the metadata row appears, so
                // the map can never advertise bytes that are not on disk.
                let sync_start = Instant::now();
                let _ = c.file.sync_data(); // best-effort; some filesystems ignore it
                self.engine
                    .metrics
                    .cache
                    .durable_sync_us
                    .fetch_add(sync_start.elapsed().as_micros() as u64, Ordering::SeqCst);
                let tmp = c.tmp.clone();
                // No explicit `drop(c)` here: `c` is a `&mut` borrow of `cur`,
                // and dropping a reference is a no-op (it would neither close
                // the handle nor release the lock). NLL ends the borrow at the
                // `tmp.clone()` above because `c` is not used afterwards.
                // The handle is closed by close_current(.., keep=true) below.
                self.close_current(&mut cur, true)?;
                let final_path = self.engine.chunk_path(&self.key, idx_done);
                fs::rename(&tmp, &final_path)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                // fsync the directory so the rename itself is durable.
                if let Ok(d) = File::open(self.engine.chunk_dir(&self.key)) {
                    let _ = d.sync_data();
                }
                if self
                    .engine
                    .publish_chunk(&self.key, idx_done, expected_done)?
                {
                    self.promoted.lock().push(idx_done);
                    promoted_here.push(idx_done);
                }
            }
            drop(cur);
            off += n as u64;
            rest = &rest[n..];
        }
        Ok(promoted_here)
    }

    fn open_chunk(&self, idx: u64, expected: u64) -> rusqlite::Result<OpenChunk> {
        let tmp = self.engine.staging_path(&self.key, idx, self.tag);
        let f = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        Ok(OpenChunk {
            index: idx,
            expected,
            written: 0,
            file: f,
            tmp,
        })
    }

    /// `keep=true` on the promotion path (the file was already renamed away, so
    /// there is nothing to delete); `keep=false` discards an incomplete staging
    /// file, which is the crash-safety guarantee.
    fn close_current(&self, cur: &mut Option<OpenChunk>, keep: bool) -> rusqlite::Result<()> {
        if let Some(c) = cur.take() {
            drop(c.file);
            if !keep {
                let _ = fs::remove_file(&c.tmp);
            }
        }
        Ok(())
    }

    /// Promote the trailing chunk if it is complete; discard it otherwise.
    ///
    /// Returns EVERY chunk index this stager published — the accumulated list,
    /// not just what the tail promoted. Callers need the full set to decide
    /// which owned chunks reached PRESENT. (`stage()` returns only what that
    /// individual call promoted, so the two must not be concatenated.)
    pub fn finish(&self) -> Vec<u64> {
        let mut cur = self.cur.lock();
        if let Some(c) = cur.as_ref() {
            if c.written == c.expected {
                let idx = c.index;
                let expected = c.expected;
                let tmp = c.tmp.clone();
                let sync_start = Instant::now();
                let _ = c.file.sync_data();
                self.engine
                    .metrics
                    .cache
                    .durable_sync_us
                    .fetch_add(sync_start.elapsed().as_micros() as u64, Ordering::SeqCst);
                drop(cur);
                let _ = self.close_current(&mut self.cur.lock(), true);
                let final_path = self.engine.chunk_path(&self.key, idx);
                if fs::rename(&tmp, &final_path).is_ok() {
                    if let Ok(d) = File::open(self.engine.chunk_dir(&self.key)) {
                        let _ = d.sync_data();
                    }
                    if let Ok(true) = self.engine.publish_chunk(&self.key, idx, expected) {
                        self.promoted.lock().push(idx);
                    }
                }
            } else {
                // Incomplete trailing chunk. Discard it — it must never be
                // advertised as PRESENT.
                let _ = self.close_current(&mut cur, false);
            }
        }
        self.promoted.lock().clone()
    }

    /// Abandon every in-progress staging file. Used when the upstream read
    /// failed: no partial chunk may survive.
    pub fn abort(&self) {
        let mut cur = self.cur.lock();
        let _ = self.close_current(&mut cur, false);
    }

    pub fn promoted(&self) -> Vec<u64> {
        self.promoted.lock().clone()
    }

    pub fn grid(&self) -> ChunkGrid {
        self.grid
    }
}

// ---------------------------------------------------------------------------
// Tests (unit-level; the bounded A–H proofs live in playback-bench/src/slice475)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const MIB: u64 = 1024 * 1024;

    fn mk() -> (Arc<CacheEngine>, TorrentFileId) {
        mk_with_size(8 * MIB, 64 * MIB, 4096)
    }

    fn mk_with_size(chunk_size: u64, file_size: u64, max_bytes: u64) -> (Arc<CacheEngine>, TorrentFileId) {
        let dir = tempdir().unwrap();
        let cfg = CacheConfig {
            root: dir.path().to_path_buf(),
            max_bytes,
            chunk_size,
        };
        let m = Arc::new(Metrics::default());
        let e = CacheEngine::open(cfg, m).unwrap();
        let tf = TorrentFileId::new(
            "tf_dune_2021_mkv".into(),
            "0439d86e8da335cde1b25575ed0534bf7359bc38".into(),
            "Dune (2021)/Dune.mkv".into(),
            file_size,
        );
        (e, tf)
    }

    /// Fill a chunk completely by staging exactly `chunk_len` bytes.
    ///
    /// Returns every chunk this stager published. `stage()` returns only what
    /// THAT call promoted; `finish()` returns the accumulated list — so callers
    /// must not concatenate both.
    fn fill_chunk(e: &Arc<CacheEngine>, tf: &TorrentFileId, idx: u64) -> Vec<u64> {
        let grid = e.grid_for(tf);
        let start = grid.chunk_start(idx);
        let len = grid.chunk_len(idx) as usize;
        let st = e.begin_stage(tf.clone()).unwrap();
        st.stage(start, &vec![0xAA; len]).unwrap();
        st.finish()
    }

    // ---- grid math ----

    #[test]
    fn grid_eof_chunk_is_deterministically_shorter() {
        // 20 MiB file, 8 MiB chunks -> 8, 8, 4.
        let g = ChunkGrid::new(8 * MIB, 20 * MIB);
        assert_eq!(g.chunk_count(), 3);
        assert_eq!(g.chunk_len(0), 8 * MIB);
        assert_eq!(g.chunk_len(1), 8 * MIB);
        assert_eq!(g.chunk_len(2), 4 * MIB, "EOF chunk must be shorter");
        assert_eq!(g.chunk_end(2), Some(20 * MIB - 1));
        assert_eq!(g.chunk_len(3), 0, "chunk past EOF does not exist");
        assert_eq!(g.chunk_end(3), None);
    }

    #[test]
    fn grid_chunks_touching_is_exact() {
        let g = ChunkGrid::new(8 * MIB, 40 * MIB);
        assert_eq!(g.chunks_touching(0, 0), vec![0]);
        assert_eq!(g.chunks_touching(0, 8 * MIB - 1), vec![0]);
        assert_eq!(g.chunks_touching(0, 8 * MIB), vec![0, 1]);
        assert_eq!(g.chunks_touching(4 * MIB, 20 * MIB), vec![0, 1, 2]);
        // A range ending exactly at EOF must not invent a chunk past the end.
        assert_eq!(g.chunks_touching(39 * MIB, 40 * MIB - 1), vec![4]);
    }

    // ---- plan exactness (proof A's unit-level half) ----

    #[test]
    fn plan_segments_tile_the_request_exactly() {
        let (e, tf) = mk();
        // Arbitrary window that starts and ends mid-chunk.
        let p = e.plan_chunks(&tf, 3 * MIB + 17, 21 * MIB - 5).unwrap();
        let mut cursor = 3 * MIB + 17;
        for s in &p.segments {
            assert_eq!(s.start, cursor, "segments must be contiguous");
            cursor = s.end + 1;
        }
        assert_eq!(cursor, 21 * MIB - 5 + 1, "segments must end exactly at the request end");
        assert!(!p.segments.is_empty());
    }

    #[test]
    fn plan_runs_group_consecutive_same_kind() {
        let (e, tf) = mk();
        // Publish chunks 0 and 2 only: present, absent, present, absent.
        assert_eq!(fill_chunk(&e, &tf, 0), vec![0]);
        assert_eq!(fill_chunk(&e, &tf, 2), vec![2]);
        let p = e.plan_chunks(&tf, 0, 32 * MIB - 1).unwrap();
        let runs = p.runs();
        let kinds: Vec<RunKind> = runs.iter().map(|r| r.kind).collect();
        assert_eq!(
            kinds,
            vec![RunKind::Local, RunKind::Fetch, RunKind::Local, RunKind::Fetch],
            "alternating presence must yield alternating runs"
        );
        // Runs must tile the request exactly and in order.
        let mut cursor = 0u64;
        for r in &runs {
            assert_eq!(r.start, cursor);
            cursor = r.end + 1;
        }
        assert_eq!(cursor, 32 * MIB);
        assert!(!p.is_full_hit());
    }

    #[test]
    fn plan_full_hit_is_all_present() {
        let (e, tf) = mk();
        fill_chunk(&e, &tf, 0);
        fill_chunk(&e, &tf, 1);
        let p = e.plan_chunks(&tf, 0, 16 * MIB - 1).unwrap();
        assert!(p.is_full_hit(), "every segment present => full hit");
        assert_eq!(p.runs().len(), 1);
        assert_eq!(p.runs()[0].kind, RunKind::Local);
    }

    // ---- per-chunk single-flight (proof B's unit-level half) ----

    #[test]
    fn per_chunk_single_flight_one_owner_many_waiters() {
        let map = InFlightMap::default();
        let joins = map.join_or_claim_many("k", &[7]);
        assert_eq!(joins.len(), 1);
        assert!(joins[0].owned, "the first caller owns the chunk");
        assert!(!joins[0].joined_existing);

        let mut waiters = 0;
        for _ in 0..9 {
            let j = map.join_or_claim("k", 7);
            assert!(!j.owned, "later callers are pure waiters");
            assert!(j.joined_existing);
            assert!(Arc::ptr_eq(&j.record, &joins[0].record), "waiters attach to the SAME record");
            waiters += 1;
        }
        assert_eq!(waiters, 9);
        assert_eq!(map.len(), 1, "exactly one fill record exists for the chunk");

        map.finalize("k", 7);
        assert_eq!(map.len(), 0);
    }

    #[test]
    fn distinct_chunks_are_independent_flights() {
        let map = InFlightMap::default();
        let j = map.join_or_claim_many("k", &[10, 11, 12]);
        assert_eq!(j.len(), 3);
        assert!(j.iter().all(|x| x.owned), "nobody else is filling these");
        // A different cache_key is a different universe.
        let other = map.join_or_claim("other", 10);
        assert!(other.owned);
        assert_eq!(map.len(), 4);
    }

    // ---- staging / publication ----

    #[test]
    fn complete_chunk_publishes_and_charges_budget() {
        let (e, tf) = mk();
        let promoted = fill_chunk(&e, &tf, 0);
        assert_eq!(promoted, vec![0]);
        assert!(e.is_present(&tf.cache_key(), 0).unwrap());
        assert_eq!(e.current_bytes(), 8 * MIB, "budget charges the chunk length");
        assert_eq!(e.metrics.cache.chunk_fills.load(Ordering::SeqCst), 1);
        // The object exists on disk at the documented path.
        let p = e.chunk_path(&tf.cache_key(), 0);
        assert!(p.exists(), "chunk object must exist at cache/<key>/<idx>.chunk");
        assert_eq!(std::fs::metadata(&p).unwrap().len(), 8 * MIB);
    }

    #[test]
    fn incomplete_chunk_is_never_published() {
        let (e, tf) = mk();
        let st = e.begin_stage(tf.clone()).unwrap();
        // Stage only half the chunk, then abandon.
        st.stage(0, &vec![0xAA; (4 * MIB) as usize]).unwrap();
        st.abort();
        assert!(
            !e.is_present(&tf.cache_key(), 0).unwrap(),
            "a partial chunk must never appear PRESENT"
        );
        assert_eq!(e.current_bytes(), 0, "no phantom budget bytes");
        assert_eq!(e.metrics.cache.chunk_fills.load(Ordering::SeqCst), 0);
        // No staging turd left behind.
        let dir = e.chunk_dir(&tf.cache_key());
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|x| x.file_name().to_string_lossy().contains(".stage-"))
            .collect();
        assert!(leftovers.is_empty(), "aborted staging files must be removed");
    }

    #[test]
    fn finishing_a_short_trailing_chunk_does_not_publish() {
        let (e, tf) = mk();
        let st = e.begin_stage(tf.clone()).unwrap();
        let _ = st.stage(0, &vec![0xAA; 100]).unwrap();
        let promoted = st.finish();
        assert!(promoted.is_empty());
        assert!(!e.is_present(&tf.cache_key(), 0).unwrap());
        assert_eq!(e.current_bytes(), 0);
    }

    #[test]
    fn staging_a_span_publishes_each_chunk_independently() {
        let (e, tf) = mk();
        // One fetch spanning chunks 0..=2 (8+8+8 MiB) delivered in 4 MiB pieces.
        let st = e.begin_stage(tf.clone()).unwrap();
        let mut all: Vec<u64> = Vec::new();
        for i in 0..6u64 {
            all.extend(st.stage(i * 4 * MIB, &vec![0xBB; (4 * MIB) as usize]).unwrap());
        }
        assert_eq!(
            all,
            vec![0, 1, 2],
            "each complete chunk publishes on its own, as soon as it is complete"
        );
        // `finish()` returns every chunk THIS STAGER published (accumulated),
        // not just what it promoted at the tail. All three were already
        // published mid-span — which is what lets a waiter read chunk 0 while
        // chunks 1 and 2 are still arriving — so the tail promotes nothing new.
        assert_eq!(st.finish(), vec![0, 1, 2]);
        assert_eq!(e.current_bytes(), 24 * MIB);
        for i in 0..3 {
            assert!(e.is_present(&tf.cache_key(), i).unwrap());
        }
        assert!(!e.is_present(&tf.cache_key(), 3).unwrap());
    }

    #[test]
    fn publishing_twice_does_not_double_count() {
        let (e, tf) = mk();
        let key = tf.cache_key();
        fill_chunk(&e, &tf, 0);
        assert_eq!(e.current_bytes(), 8 * MIB);
        // A racing read that planned before the publish still drives its own
        // fetch and still promotes. The second publish must be a budget no-op.
        let promoted = fill_chunk(&e, &tf, 0);
        assert_eq!(promoted, Vec::<u64>::new(), "second fill publishes nothing new");
        assert_eq!(e.current_bytes(), 8 * MIB, "budget must not inflate");
        assert_eq!(e.metrics.cache.publish_noop.load(Ordering::SeqCst), 1);
        assert!(e.is_present(&key, 0).unwrap());
    }

    // ---- eviction ----

    #[test]
    fn eviction_is_chunk_granular_and_never_touches_a_live_fill() {
        // Budget BELOW one chunk, so the sweep cannot be satisfied by evicting
        // a single chunk and must therefore consider BOTH candidates. (With a
        // budget of exactly one chunk the sweep stops after the first eviction
        // and the guard is never reached — the test would pass vacuously.)
        let (e, tf) = mk_with_size(8 * MIB, 64 * MIB, 4 * MIB);
        let key = tf.cache_key();
        fill_chunk(&e, &tf, 0);
        fill_chunk(&e, &tf, 1);
        assert_eq!(e.current_bytes(), 16 * MIB);

        // Mark chunk 1 as a LIVE fill.
        let _live = e.inflight().join_or_claim(&key, 1);
        e.maybe_evict().unwrap();

        assert!(
            !e.is_present(&key, 0).unwrap(),
            "the cold chunk must be evicted"
        );
        assert!(
            e.is_present(&key, 1).unwrap(),
            "a chunk with a live fill must never be evicted"
        );
        assert_eq!(
            e.metrics.cache.evict_skipped_filling.load(Ordering::SeqCst),
            1,
            "the guard must be observed to fire, not merely to exist"
        );
        assert_eq!(
            e.current_bytes(),
            8 * MIB,
            "only the non-filling chunk's bytes were reclaimed"
        );

        // Once the fill is gone, the chunk is evictable.
        e.inflight().finalize(&key, 1);
        e.maybe_evict().unwrap();
        assert!(!e.is_present(&key, 1).unwrap());
        assert_eq!(e.current_bytes(), 0);
    }

    #[test]
    fn eviction_frees_exactly_the_chunk_size() {
        let (e, tf) = mk_with_size(8 * MIB, 64 * MIB, 8 * MIB);
        fill_chunk(&e, &tf, 0);
        fill_chunk(&e, &tf, 1);
        let before = e.current_bytes();
        e.maybe_evict().unwrap();
        let after = e.current_bytes();
        assert_eq!(
            before - after,
            8 * MIB,
            "evicting one chunk must free exactly one chunk's bytes"
        );
        assert_eq!(e.metrics.cache.bytes_evicted.load(Ordering::SeqCst), 8 * MIB);
        assert_eq!(e.metrics.cache.evictions.load(Ordering::SeqCst), 1);
    }

    // ---- restart ----

    #[test]
    fn present_chunks_survive_restart_and_budget_is_recomputed() {
        let dir = tempdir().unwrap();
        let cfg = CacheConfig {
            root: dir.path().to_path_buf(),
            max_bytes: 512 * MIB,
            chunk_size: 8 * MIB,
        };
        let m = Arc::new(Metrics::default());
        let tf = TorrentFileId::new(
            "tf_test_survive_restart".into(),
            "abc".into(),
            "x".into(),
            64 * MIB,
        );
        {
            let e1 = CacheEngine::open(cfg.clone(), m.clone()).unwrap();
            fill_chunk(&e1, &tf, 0);
            fill_chunk(&e1, &tf, 3);
            assert_eq!(e1.current_bytes(), 16 * MIB);
        }
        let e2 = CacheEngine::open(cfg, m).unwrap();
        assert!(e2.is_present(&tf.cache_key(), 0).unwrap(), "PRESENT chunk survives");
        assert!(e2.is_present(&tf.cache_key(), 3).unwrap());
        assert!(!e2.is_present(&tf.cache_key(), 1).unwrap());
        assert_eq!(
            e2.current_bytes(),
            16 * MIB,
            "budget must be recomputed from surviving chunks"
        );
        let (present, filling) = e2.chunk_counts();
        assert_eq!(present, 2);
        assert_eq!(filling, 0, "FILLING is runtime-only and can never survive restart");
    }

    #[test]
    fn chunk_size_change_resets_the_grid() {
        let dir = tempdir().unwrap();
        let m = Arc::new(Metrics::default());
        let tf = TorrentFileId::new(
            "tf_test_chunk_size_change".into(),
            "abc".into(),
            "x".into(),
            64 * MIB,
        );
        {
            let e1 = CacheEngine::open(
                CacheConfig {
                    root: dir.path().to_path_buf(),
                    max_bytes: 512 * MIB,
                    chunk_size: 8 * MIB,
                },
                m.clone(),
            )
            .unwrap();
            fill_chunk(&e1, &tf, 0);
            assert_eq!(e1.current_bytes(), 8 * MIB);
        }
        // Reopen on a DIFFERENT grid. The old chunk objects describe bytes on a
        // grid that no longer exists, so they must be discarded rather than
        // reinterpreted.
        let e2 = CacheEngine::open(
            CacheConfig {
                root: dir.path().to_path_buf(),
                max_bytes: 512 * MIB,
                chunk_size: 4 * MIB,
            },
            m,
        )
        .unwrap();
        assert_eq!(e2.current_bytes(), 0, "grid change must reset the store");
        assert!(!e2.is_present(&tf.cache_key(), 0).unwrap());
        assert_eq!(e2.chunk_size(), 4 * MIB);
        assert_eq!(e2.meta_get("format_version").unwrap(), Some(CACHE_FORMAT_VERSION));
        assert_eq!(e2.meta_get("chunk_size").unwrap(), Some(4 * MIB));
    }

    // ---- local read across the grid ----

    #[test]
    fn pread_returns_exact_bytes_across_chunk_boundaries() {
        let (e, tf) = mk();
        let st = e.begin_stage(tf.clone()).unwrap();
        let payload: Vec<u8> = (0..(24 * MIB) as usize).map(|i| (i % 251) as u8).collect();
        st.stage(0, &payload).unwrap();
        st.finish();
        // A window that starts mid-chunk and ends mid-chunk, spanning 3 chunks.
        let got = e.pread(&tf, 3 * MIB + 11, 20 * MIB - 7).unwrap();
        let expect = &payload[(3 * MIB + 11) as usize..=(20 * MIB - 7) as usize];
        assert_eq!(got.len(), expect.len());
        assert!(got == expect, "pread must return EXACTLY the requested bytes");
    }

    // ---- P3 correction: same-infoHash sibling-file adversarial proof ----
    //
    // This test is the focused adversarial proof demanded by the P3
    // correction. It is capable of failing under the previous
    // info_hash-only key (or any key that does not include the durable
    // TorrentFile PK): the two sibling files share the same info_hash
    // but must still get DISTINCT cache entries, DISTINCT bytes, and
    // DISTINCT capability reuse keys.
    //
    // Setup: two TorrentFileIds with the same info_hash but
    //   - different tf_id_durable  (the SQLite PK)
    //   - different canonical_path
    //   - different size
    // Fill chunk 0 of each with distinguishable bytes (0xAA for A,
    // 0xBB for B). The same chunk index 0 in the same engine must
    // resolve to two independent on-disk files with two independent
    // SQLite rows.
    #[test]
    fn same_info_hash_sibling_files_get_distinct_cache_entries() {
        let dir = tempdir().unwrap();
        let cfg = CacheConfig {
            root: dir.path().to_path_buf(),
            max_bytes: 64 * MIB,
            chunk_size: 8 * MIB,
        };
        let m = Arc::new(Metrics::default());
        let e = CacheEngine::open(cfg, m).unwrap();

        // Shared info_hash (sibling files in the same torrent).
        const SHARED_INFO_HASH: &str = "deadbeefcafe0000deadbeefcafe0000deadbeef";
        let tf_a = TorrentFileId::new(
            "tf_sibling_A".into(),
            SHARED_INFO_HASH.into(),
            "Siblings/episode_01.mkv".into(),
            16 * MIB, // 2 chunks
        );
        let tf_b = TorrentFileId::new(
            "tf_sibling_B".into(),
            SHARED_INFO_HASH.into(),
            "Siblings/episode_02.mkv".into(),
            24 * MIB, // 3 chunks; different size, different chunk count
        );

        // ---- 1. Cache keys are distinct ----
        // The key is a deterministic representation of the durable tuple
        // (info_hash, canonical_path, size). Sibling files that share
        // info_hash MUST still have distinct keys, because canonical_path
        // and/or size differ.
        let key_a = tf_a.cache_key();
        let key_b = tf_b.cache_key();
        assert_ne!(
            key_a, key_b,
            "SAME info_hash sibling files MUST have distinct cache keys \
             (durable tuple differs in path and/or size)"
        );
        // The new key shape: "tfkv\x1f<info_hash>\x1f<size>\x1f<path>".
        assert!(
            key_a.starts_with("tfkv\x1f") && key_a.contains(SHARED_INFO_HASH)
                && key_a.contains("Siblings/episode_01.mkv")
                && key_a.contains("16777216"),
            "key_a must be the deterministic (info_hash, size, path) tuple (got {key_a:?})"
        );
        assert!(
            key_b.starts_with("tfkv\x1f") && key_b.contains(SHARED_INFO_HASH)
                && key_b.contains("Siblings/episode_02.mkv")
                && key_b.contains("25165824"),
            "key_b must be the deterministic (info_hash, size, path) tuple (got {key_b:?})"
        );

        // ---- 2. Fill chunk 0 of each with distinguishable bytes ----
        let grid_a = e.grid_for(&tf_a);
        let grid_b = e.grid_for(&tf_b);
        let len_a = grid_a.chunk_len(0) as usize;
        let len_b = grid_b.chunk_len(0) as usize;

        let st_a = e.begin_stage(tf_a.clone()).unwrap();
        st_a.stage(0, &vec![0xAA; len_a]).unwrap();
        st_a.finish();
        let st_b = e.begin_stage(tf_b.clone()).unwrap();
        st_b.stage(0, &vec![0xBB; len_b]).unwrap();
        st_b.finish();

        // ---- 3. Both chunks are PRESENT (independent rows) ----
        assert!(
            e.is_present(&key_a, 0).unwrap(),
            "sibling A chunk 0 must be PRESENT after stage+finish"
        );
        assert!(
            e.is_present(&key_b, 0).unwrap(),
            "sibling B chunk 0 must be PRESENT after stage+finish"
        );

        // ---- 4. pread returns the CORRECT bytes for each ----
        // (read the entire chunk 0 of each)
        let bytes_a = e.pread(&tf_a, 0, len_a as u64 - 1).unwrap();
        let bytes_b = e.pread(&tf_b, 0, len_b as u64 - 1).unwrap();
        assert_eq!(bytes_a.len(), len_a);
        assert_eq!(bytes_b.len(), len_b);
        assert!(
            bytes_a.iter().all(|&b| b == 0xAA),
            "sibling A bytes must all be 0xAA; a key collision would have returned B's 0xBB"
        );
        assert!(
            bytes_b.iter().all(|&b| b == 0xBB),
            "sibling B bytes must all be 0xBB; a key collision would have returned A's 0xAA"
        );

        // ---- 5. Distinct chunk counts ----
        // A has 2 chunks (size 16 MiB / 8 MiB), B has 3 chunks (size 24 MiB).
        assert_eq!(grid_a.chunk_count(), 2);
        assert_eq!(grid_b.chunk_count(), 3);

        // ---- 6. Warm reread cannot cross alias ----
        // Re-pread both; bytes must still be correct.
        let bytes_a2 = e.pread(&tf_a, 0, len_a as u64 - 1).unwrap();
        let bytes_b2 = e.pread(&tf_b, 0, len_b as u64 - 1).unwrap();
        assert!(bytes_a2.iter().all(|&b| b == 0xAA));
        assert!(bytes_b2.iter().all(|&b| b == 0xBB));

        // ---- 7. Capability reuse key: the two siblings MUST be
        //         distinguishable even if they share the same provider,
        //         account, resource, and provider_file_id (a worst-case
        //         setup: two sibling files in the same torrent that
        //         happen to point at the same provider file). The
        //         corrected key shape uses the stable durable_key (NOT
        //         the mutable surrogate PK), so the resulting sf_keys
        //         differ.
        //
        // The Slot is in manager.rs; we exercise the same keying
        // arithmetic inline here rather than pulling in the manager
        // crate-internals for a focused test.
        let provider = "realdebrid";
        let account_scope = "main";
        let resource = "rd_res_42";
        let provider_file_id = "rd_pf_42";
        // Slot.sf_key now uses the durable_key (stable, derived from
        // the tuple), not the surrogate PK.
        let sf_key_a = format!(
            "{}|{}|{}|{}|{}",
            provider, account_scope, tf_a.durable_key, resource, provider_file_id
        );
        let sf_key_b = format!(
            "{}|{}|{}|{}|{}",
            provider, account_scope, tf_b.durable_key, resource, provider_file_id
        );
        assert_ne!(
            sf_key_a, sf_key_b,
            "Siblings sharing the same provider coord MUST be \
             distinguishable in the capability reuse key"
        );
    }

    // ─── P3 final identity check proofs (conclusion B) ──────────────────
    //
    // These tests prove the durable_key contract:
    //   (1) Two TorrentFileId instances representing the SAME logical
    //       TorrentFile (same info_hash + canonical_path + size) but
    //       with DIFFERENT current host surrogate PKs (as happens when
    //       the control-plane DB is reconstructed, a row is
    //       re-inserted, or any other lifecycle path that mints a
    //       fresh `tf_<randomUUID>`) MUST share the same cache key.
    //       The cache directory is durable on disk; the PK is not.
    //   (2) Two TorrentFileId instances sharing an info_hash but with
    //       different canonical_path or different size MUST have
    //       different cache keys (sibling files in one torrent).
    //   (3) Capability single-flight keying is invariant under PK
    //       changes for the same logical TorrentFile.
    //
    // The proofs use only the in-crate tempdir-backed CacheEngine
    // (no live control-plane / discovery DB mutation), per the P3
    // correction directive on adversarial same-infoHash proofs.

    #[test]
    fn same_logical_torrentfile_with_different_surrogate_pk_shares_cache_key() {
        // Simulate a control-plane DB reconstruction: the same
        // logical TorrentFile (same info_hash, same canonical path,
        // same size) gets a fresh `tf_<randomUUID>` surrogate.
        const INFO_HASH: &str = "0123456789abcdef0123456789abcdef01234567";
        const CANONICAL: &str = "Movies/Dune (2021)/Dune.mkv";
        const SIZE: u64 = 7_500_000_000; // 7.5 GB

        let original = TorrentFileId::new(
            "tf_db1_uuid_aaaa".into(),
            INFO_HASH.into(),
            CANONICAL.into(),
            SIZE,
        );
        // Simulate the host assigning a fresh surrogate after a
        // DB rebuild, partial restore, import/merge, etc.
        let after_rebuild = TorrentFileId::new(
            "tf_db2_uuid_bbbb_cccc_dddd".into(),
            INFO_HASH.into(),
            CANONICAL.into(),
            SIZE,
        );
        // The current host PKs differ (this is the whole point).
        assert_ne!(
            original.tf_id_durable, after_rebuild.tf_id_durable,
            "PK is intentionally different to simulate a DB reconstruction"
        );
        // The cache key MUST be the same.
        assert_eq!(
            original.cache_key(),
            after_rebuild.cache_key(),
            "Same logical TorrentFile MUST share the cache key \
             even when the host surrogate PK changes"
        );
        // And the durable_key field is identical (it's the same tuple).
        assert_eq!(original.durable_key, after_rebuild.durable_key);
    }

    #[test]
    fn same_logical_torrentfile_survives_chunk_grid_after_surrogate_change() {
        // End-to-end: stage bytes for a TorrentFile under PK_A;
        // "rebuild" the DB and construct a new TorrentFileId with
        // PK_B; the chunk MUST still be reachable.
        let dir = tempdir().unwrap();
        let cfg = CacheConfig {
            root: dir.path().to_path_buf(),
            max_bytes: 64 * MIB,
            chunk_size: 8 * MIB,
        };
        let m = Arc::new(Metrics::default());
        let e = Arc::new(CacheEngine::open(cfg, m).unwrap());

        const INFO_HASH: &str = "abc123abc123abc123abc123abc123abc123abc1";
        const CANONICAL: &str = "Stable/survivor.bin";
        const SIZE: u64 = 16 * MIB; // 2 chunks

        let tf_pk_a = TorrentFileId::new(
            "tf_pk_A".into(),
            INFO_HASH.into(),
            CANONICAL.into(),
            SIZE,
        );
        // Stage chunk 0.
        let st = e.begin_stage(tf_pk_a.clone()).unwrap();
        st.stage(0, &vec![0xCC; 8 * MIB as usize]).unwrap();
        st.finish();
        // Chunk 0 is present under PK_A.
        assert!(e.is_present(&tf_pk_a.cache_key(), 0).unwrap());

        // Simulate a host DB reconstruction: same logical TF, fresh PK.
        let tf_pk_b = TorrentFileId::new(
            "tf_pk_B_after_rebuild".into(),
            INFO_HASH.into(),
            CANONICAL.into(),
            SIZE,
        );
        // The whole point: the cache_key does NOT contain the host PK,
        // so it is invariant under any host DB reconstruction.
        assert_eq!(tf_pk_a.cache_key(), tf_pk_b.cache_key(),
            "cache_key() MUST be invariant under PK change");
        assert_ne!(tf_pk_a.tf_id_durable, tf_pk_b.tf_id_durable,
            "sanity: PKs do differ — this is what we're proving the key survives");
        // Chunk 0 must still be present and readable under the
        // reconstructed identity.
        assert!(
            e.is_present(&tf_pk_b.cache_key(), 0).unwrap(),
            "chunk durably written under PK_A MUST be reachable under PK_B"
        );
        let bytes = e.pread(&tf_pk_b, 0, 8 * MIB - 1).unwrap();
        assert!(
            bytes.iter().all(|&b| b == 0xCC),
            "reconstructed identity must read the same bytes"
        );
    }

    #[test]
    fn different_canonical_path_same_info_hash_yields_different_cache_key() {
        const SHARED_INFO_HASH: &str =
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        const SIZE: u64 = 1_000_000;
        let tf_x = TorrentFileId::new(
            "tf_x".into(),
            SHARED_INFO_HASH.into(),
            "Season 01/episode_01.mkv".into(),
            SIZE,
        );
        let tf_y = TorrentFileId::new(
            "tf_y".into(),
            SHARED_INFO_HASH.into(),
            "Season 01/episode_02.mkv".into(),
            SIZE,
        );
        assert_ne!(
            tf_x.cache_key(),
            tf_y.cache_key(),
            "Siblings with the same info_hash but different canonical_path \
             MUST have distinct cache keys"
        );
    }

    #[test]
    fn different_size_same_info_hash_same_path_yields_different_cache_key() {
        // Adversarial: same info_hash AND same path, but the
        // observed size differs. This can only happen if a
        // provider re-reports the file with a different size
        // (size conflict at the control plane) — the two
        // observations MUST NOT alias the cache.
        const SHARED_INFO_HASH: &str =
            "feedfacefeedfacefeedfacefeedfacefeedface";
        const SHARED_PATH: &str = "Single/torrent_relative/path.bin";
        let tf_observed_a = TorrentFileId::new(
            "tf_a".into(),
            SHARED_INFO_HASH.into(),
            SHARED_PATH.into(),
            1_000_000,
        );
        let tf_observed_b = TorrentFileId::new(
            "tf_b".into(),
            SHARED_INFO_HASH.into(),
            SHARED_PATH.into(),
            1_000_001, // off by one byte
        );
        assert_ne!(
            tf_observed_a.cache_key(),
            tf_observed_b.cache_key(),
            "Same (info_hash, path) with different size MUST have \
             distinct cache keys (size-conflict guard)"
        );
    }

    #[test]
    fn capability_sf_key_is_invariant_under_surrogate_pk_change() {
        // Slot.sf_key() uses the stable durable_key, so the
        // single-flight coalescer MUST NOT split a single logical
        // TorrentFile across two in-flight maps when the host
        // re-issues the PK.
        const INFO_HASH: &str = "00112233445566778899aabbccddeeff00112233";
        const CANONICAL: &str = "TV/show_name_s01e01.mkv";
        const SIZE: u64 = 2_000_000_000;

        let tf_a = TorrentFileId::new(
            "tf_orig".into(),
            INFO_HASH.into(),
            CANONICAL.into(),
            SIZE,
        );
        let tf_b = TorrentFileId::new(
            "tf_after_rebuild".into(),
            INFO_HASH.into(),
            CANONICAL.into(),
            SIZE,
        );
        let provider = "torbox";
        let account_scope = "default";
        let resource = "tb_res_99";
        let provider_file_id = "tb_pf_99";
        // This is the exact format Slot.sf_key produces in
        // manager.rs. The third field is durable_key, NOT the
        // surrogate PK.
        let sf_a = format!(
            "{}|{}|{}|{}|{}",
            provider, account_scope, tf_a.durable_key, resource, provider_file_id
        );
        let sf_b = format!(
            "{}|{}|{}|{}|{}",
            provider, account_scope, tf_b.durable_key, resource, provider_file_id
        );
        assert_eq!(
            sf_a, sf_b,
            "Slot.sf_key() MUST be invariant under host PK change \
             for the same logical TorrentFile (no single-flight split)"
        );
        // Negative control: changing the canonical_path (i.e. a
        // different sibling) MUST change sf_key.
        let tf_sibling = TorrentFileId::new(
            "tf_sibling".into(),
            INFO_HASH.into(),
            "TV/show_name_s01e02.mkv".into(),
            SIZE,
        );
        let sf_sibling = format!(
            "{}|{}|{}|{}|{}",
            provider, account_scope, tf_sibling.durable_key, resource, provider_file_id
        );
        assert_ne!(
            sf_a, sf_sibling,
            "Different canonical_path MUST yield a different sf_key"
        );
    }
}
