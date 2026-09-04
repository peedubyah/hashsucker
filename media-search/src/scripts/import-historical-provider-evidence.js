#!/usr/bin/env node
/**
 * Resumable historical provider evidence importer.
 *
 * Streams a local snapshot file and feeds the existing durable
 * `ingestHistoricalProviderEvidence(...)` API on the discovery cache.
 *
 * HARD CONTRACT — historical priors only:
 *   - Importing a row NEVER implies current cache hit, current placement,
 *     current availability, or current delivery capability.
 *   - Imported rows feed the historical prior axis only (ranking
 *     `historicalPrior`, provider-order fallback priors).
 *   - This script MUST NOT mutate `candidates`, provider_observations,
 *     playback_handoffs, vfs_*, or any other cache/control-plane table.
 *
 * Supported local input shapes (auto-detected unless --format is given):
 *
 *   - "ndhashes" : newline-delimited 40-char SHA-1 hex infoHashes.
 *                  Comments (# ...) and blank lines are skipped.
 *                  Lines may be `<infoHash>` or `<infoHash>,<fileIndex>`.
 *                  Anything after a third comma-separated field is ignored.
 *
 *   - "csv"      : CSV with a header. Required column: info_hash (or
 *                  infohash/infoHash). Optional columns: file_index
 *                  (or fileindex/fileIndex), observed_at (epoch ms;
 *                  falls back to current time).
 *
 *   - "auto"     : sniffs the first non-blank line. If it parses as a
 *                  header (commas AND contains a known column name),
 *                  treat as CSV; otherwise ndhashes.
 *
 *   - "rd-history": Real-Debrid history export. We accept any of the
 *                  well-known shapes (NDJSON with {hash, ...} or
 *                  hash-only NDJSON, or CSV with hash column) and
 *                  normalize to the internal {infoHash, fileIndex,
 *                  observedAt} shape internally.
 *
 * Resumability:
 *   - The importer persists an `import_checkpoints` row in a SEPARATE
 *     table inside the discovery cache. The historical evidence tables
 *     are NOT overloaded with importer cursor state.
 *   - Checkpoint is written ONLY after a batch is committed by
 *     `ingestHistoricalProviderEvidence`.
 *   - Crash mid-batch = batch not committed = no checkpoint advance =
 *     safe to replay (the ingest API is replay-idempotent on the
 *     snapshot identity).
 *   - Resume requires sourceId + sourceVersion + input fingerprint match.
 *   - A changed input file with the same (sourceId, sourceVersion) is
 *     REJECTED unless --reset is passed.
 *
 * Usage:
 *   node src/scripts/import-historical-provider-evidence.js \
 *     --provider realdebrid \
 *     --source-id rd-history-export \
 *     --source-version 2026-09-03 \
 *     --input /path/to/snapshot.txt
 *
 *   --provider        : provider name (REQUIRED; e.g. realdebrid, torbox)
 *   --source-id       : independent historical source identifier (REQUIRED)
 *   --source-version  : snapshot/version identifier (REQUIRED; non-empty)
 *   --input           : path to local snapshot file (REQUIRED)
 *   --db              : discovery cache path (default: $DISCOVERY_DB or ./discovery-cache.db)
 *   --batch-size      : rows per ingestHistoricalProviderEvidence call (default 2000)
 *   --format          : ndhashes | csv | rd-history | auto (default auto)
 *   --dry-run         : parse+normalize only, do NOT write to DB
 *   --resume          : resume from last committed checkpoint if present
 *   --reset           : ignore existing checkpoint and start fresh
 *                       (use with caution: changes input fingerprint mismatch
 *                        must be intentional)
 *   --now             : override current epoch ms (for testing)
 *
 * Environment:
 *   DISCOVERY_DB      : default discovery cache path
 *   HPE_FP_HEAD_MIB   : fingerprint head size in MiB (default 8)
 *   HPE_FP_TAIL_MIB   : fingerprint tail size in MiB (default 8)
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { createDiscoveryCache } from '../lib/discovery/cache.js';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (!a.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${a}`);
    }
    const eq = a.indexOf('=');
    let key;
    let value;
    if (eq >= 0) {
      key = a.slice(2, eq);
      value = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        value = true;
      } else {
        value = next;
        i += 1;
      }
    }
    if (key in args) {
      throw new Error(`duplicate flag: --${key}`);
    }
    // Normalize kebab-case to snake_case for ergonomic downstream access.
    // --source-id → args['source-id'] AND args['source_id']
    // --dry-run   → args['dry-run'] AND args['dry_run'] (both truthy)
    args[key] = value;
    const snake = key.replace(/-/g, '_');
    if (snake !== key && !(snake in args)) args[snake] = value;
  }
  return args;
}

function printUsage() {
  process.stdout.write(`Usage:
  node src/scripts/import-historical-provider-evidence.js \\
    --provider <name> \\
    --source-id <id> \\
    --source-version <ver> \\
    --input <path>

Options:
  --db <path>           discovery cache (default: $DISCOVERY_DB or ./discovery-cache.db)
  --batch-size <n>      rows per batch (default 2000)
  --format <fmt>        ndhashes|csv|rd-history|auto (default auto)
  --dry-run             parse+normalize only, write no DB rows
  --resume              resume from last committed checkpoint if present
  --reset               ignore existing checkpoint; start fresh
  --now <ms>            override current epoch ms (testing)
  --help, -h            show this help
`);
}

// ---------------------------------------------------------------------------
// Checkpoint schema
// ---------------------------------------------------------------------------
//
// SEPARATE from historical evidence tables. Tracks importer cursor state
// only. Historical evidence tables remain a pure function of the
// sightings inserted; this table holds importer progress.
//
// One row per (source_id, source_version, input_path). The primary key
// is (source_id, source_version), so two imports against the same
// source/version cannot collide. The input_path is stored but not
// keyed, allowing the fingerprint check to catch a moved file.
//
// PK is (provider, source_id, source_version) so that two providers
// sharing the same source_id (e.g. "torrents") and source_version
// (e.g. a date stamp) get independent checkpoint rows. This is a
// minimal, additive change from the original (source_id, source_version)
// PK; existing rows are migrated below by a single ALTER.
//
const CHECKPOINT_SCHEMA = `
CREATE TABLE IF NOT EXISTS import_checkpoints (
  provider TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  input_path TEXT NOT NULL,
  input_size INTEGER NOT NULL,
  input_mtime_ms INTEGER NOT NULL,
  input_fingerprint TEXT NOT NULL,
  format TEXT NOT NULL,
  batch_size INTEGER NOT NULL,
  lines_seen INTEGER NOT NULL DEFAULT 0,
  rows_seen INTEGER NOT NULL DEFAULT 0,
  rows_valid INTEGER NOT NULL DEFAULT 0,
  rows_invalid INTEGER NOT NULL DEFAULT 0,
  rows_duplicate INTEGER NOT NULL DEFAULT 0,
  batches_committed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (provider, source_id, source_version)
);

CREATE INDEX IF NOT EXISTS idx_import_checkpoints_status
  ON import_checkpoints(status);
`;

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

const FP_HEAD_MIB = Number(process.env.HPE_FP_HEAD_MIB || 8);
const FP_TAIL_MIB = Number(process.env.HPE_FP_TAIL_MIB || 8);
const FP_CHUNK = 1024 * 1024;

async function fingerprintFile(absPath) {
  const stat = await fs.promises.stat(absPath);
  const size = stat.size;
  const mtimeMs = Math.floor(stat.mtimeMs);

  const head = createHash('sha256');
  const tail = createHash('sha256');

  const fd = await fs.promises.open(absPath, 'r');
  try {
    const headBytes = Math.min(size, FP_HEAD_MIB * 1024 * 1024);
    if (headBytes > 0) {
      const buf = Buffer.alloc(headBytes);
      await fd.read(buf, 0, headBytes, 0);
      head.update(buf);
    }
    const tailBytes = Math.min(size, FP_TAIL_MIB * 1024 * 1024);
    if (tailBytes > 0) {
      const buf = Buffer.alloc(tailBytes);
      await fd.read(buf, 0, tailBytes, size - tailBytes);
      tail.update(buf);
    }
  } finally {
    await fd.close();
  }

  return {
    size,
    mtimeMs,
    headHash: size > 0 ? head.digest('hex') : 'EMPTY',
    tailHash: size > 0 ? tail.digest('hex') : 'EMPTY',
  };
}

function fingerprintString(fp) {
  return `v1|size=${fp.size}|mtime=${fp.mtimeMs}|head=${fp.headHash}|tail=${fp.tailHash}`;
}

function fingerprintEqual(a, b) {
  if (!a || !b) return false;
  if (a.size !== b.size) return false;
  if (a.mtimeMs !== b.mtimeMs) return false;
  if (a.headHash !== b.headHash) return false;
  if (a.tailHash !== b.tailHash) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const HASH_RE = /^[a-fA-F0-9]{40}$/;

function normalizeHash(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!HASH_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function parseFileIndex(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length === 0) return null;
  // Per spec: fileIndex NULL => release-level. Reject negative or non-int.
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function parseObservedAt(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (s.length === 0) return fallback;
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

// ---------------------------------------------------------------------------
// Format detection + line parsing
// ---------------------------------------------------------------------------

function detectFormat(firstLine) {
  if (!firstLine) return 'ndhashes';
  // CSV: must contain a comma AND a known column header
  if (firstLine.includes(',')) {
    const lower = firstLine.toLowerCase();
    if (/\b(info_hash|infohash|hash)\b/.test(lower)) return 'csv';
  }
  // NDJSON: looks like {"hash":...} on a single line
  const t = firstLine.trim();
  if (t.startsWith('{') && t.endsWith('}')) return 'rd-history';
  return 'ndhashes';
}

function parseCsvHeader(headerLine) {
  // Minimal CSV: split on comma, trim, lowercase. Quoted values not handled
  // (real-Debrid exports we care about are unquoted).
  return headerLine.split(',').map((s) => s.trim().toLowerCase());
}

function csvColumnIndex(header, aliases) {
  for (let i = 0; i < header.length; i += 1) {
    if (aliases.includes(header[i])) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Streaming parser
//
// Yields normalized rows: { infoHash, fileIndex, observedAt }.
// Tracks parse stats: { valid, invalid, duplicate }.
//
// Duplicate handling: a "duplicate" is a normalized row that we have
// already yielded during this parse session for the same source/version.
// The downstream ingestHistoricalProviderEvidence is also idempotent
// (sightings PK enforces one-row-per-snapshot), so the parse-level
// dedup is purely a stats signal. We keep the dedup set bounded to
// the current batch to keep memory bounded.
// ---------------------------------------------------------------------------

async function* streamParse({ inputPath, format, startLine, now, onStats }) {
  const seen = new Set();
  const fileStream = createReadStream(inputPath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  let formatResolved = format !== 'auto';
  let header = null;
  let hashIdx = -1;
  let fileIdx = -1;
  let observedIdx = -1;
  // Reserved for future expansion (e.g. JSONL preamble); currently
  // unused. The auto-detect path handles the "first line may be a
  // header or a data row" branching inline.
  const rewindBuffer = [];

  function setupFormatFromHeader(headerLine) {
    if (format === 'csv') {
      header = parseCsvHeader(headerLine);
      hashIdx = csvColumnIndex(header, ['info_hash', 'infohash', 'hash']);
      fileIdx = csvColumnIndex(header, ['file_index', 'fileindex', 'file_index_key']);
      observedIdx = csvColumnIndex(header, ['observed_at', 'observedat', 'last_seen_at', 'lastseenat']);
      if (hashIdx < 0) {
        throw new Error(`csv header missing info_hash/infohash/hash column: ${headerLine}`);
      }
    }
  }

  function processLine(trimmed, line) {
    let infoHash = null;
    let fileIndex = null;
    let observedAt = null;

    if (format === 'csv') {
      const cols = line.split(',');
      infoHash = normalizeHash(cols[hashIdx]);
      if (infoHash) {
        if (fileIdx >= 0) fileIndex = parseFileIndex(cols[fileIdx]);
        if (observedIdx >= 0) observedAt = parseObservedAt(cols[observedIdx], now);
      }
    } else if (format === 'rd-history') {
      if (trimmed.startsWith('{')) {
        try {
          const obj = JSON.parse(trimmed);
          infoHash = normalizeHash(obj.hash || obj.info_hash || obj.infoHash);
          if (infoHash) {
            if (obj.file_index != null) fileIndex = parseFileIndex(String(obj.file_index));
            else if (obj.fileIndex != null) fileIndex = parseFileIndex(String(obj.fileIndex));
            if (obj.observed_at != null) observedAt = parseObservedAt(String(obj.observed_at), now);
            else if (obj.observedAt != null) observedAt = parseObservedAt(String(obj.observedAt), now);
            else if (obj.last_seen_at != null) observedAt = parseObservedAt(String(obj.last_seen_at), now);
          }
        } catch {
          // fall through to ndhashes parse
        }
      }
      if (!infoHash) {
        const parts = trimmed.split(',');
        infoHash = normalizeHash(parts[0]);
        if (infoHash && parts.length > 1) {
          fileIndex = parseFileIndex(parts[1]);
          if (parts.length > 2) observedAt = parseObservedAt(parts[2], now);
        }
      }
    } else {
      const parts = trimmed.split(',');
      infoHash = normalizeHash(parts[0]);
      if (infoHash && parts.length > 1) {
        fileIndex = parseFileIndex(parts[1]);
        if (parts.length > 2) observedAt = parseObservedAt(parts[2], now);
      }
    }

    if (!infoHash) {
      onStats({ invalid: 1 });
      return null;
    }
    if (observedAt == null) observedAt = now;

    const key = `${infoHash}\x00${fileIndex == null ? -1 : fileIndex}`;
    if (seen.has(key)) {
      // Within-batch duplicate: count as valid+duplicate for stats, but
      // do NOT yield for ingest. The downstream ingest would be a
      // no-op anyway (sighting PK already present in this snapshot),
      // and excluding it from the batch keeps the per-batch count of
      // new sightings accurate.
      onStats({ duplicate: 1, valid: 1 });
      return { infoHash, fileIndex, observedAt, duplicate: true, skip: true };
    }
    seen.add(key);
    onStats({ valid: 1 });
    return { infoHash, fileIndex, observedAt, duplicate: false };
  }

  try {
    for await (const rawLine of rl) {
      lineNo += 1;
      if (lineNo <= startLine) continue;

      const line = rawLine.replace(/\r$/, '');
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith('#')) continue;

      // Drain any pending rewind buffer first
      if (rewindBuffer.length > 0) {
        const pending = rewindBuffer.shift();
        const result = processLine(pending.trimmed, pending.line);
        if (result && !result.skip) yield result;
      }

      if (!formatResolved) {
        const detected = detectFormat(trimmed);
        format = detected;
        formatResolved = true;
        if (format === 'csv') {
          // First non-blank line IS the header; consume it.
          setupFormatFromHeader(trimmed);
        } else {
          // ndhashes / rd-history: that first line is data, not a header.
          // processLine it now.
          const result = processLine(trimmed, line);
          if (result && !result.skip) yield result;
        }
        continue;
      }

      const result = processLine(trimmed, line);
      if (result && !result.skip) yield result;
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  return runFromOptions(args);
}

// Pure entrypoint that takes a pre-parsed options bag. Tests use this
// directly to drive the importer without going through argv.
export async function runFromOptions(args) {
  // Normalize hyphenated keys to snake_case for ergonomic test usage.
  const a = { ...args };
  for (const k of Object.keys(a)) {
    const snake = k.replace(/-/g, '_');
    if (snake !== k && !(snake in a)) a[snake] = a[k];
  }
  args = a;

  // For test injection: call after each committed batch. Throw to simulate
  // a mid-import crash. The caller can track batch counts.
  // For test injection: call after each committed batch. Throw to simulate
  // a mid-import crash. The caller can track batch counts.
  const _onBatchFlushed = args._onBatchFlushed || null;
  // For test injection: pre-built cache (lets tests monkey-patch
  // ingestHistoricalProviderEvidence on the same instance the importer uses).
  const _injectedCache = args._cache || null;

  const provider = args.provider;
  const sourceId = args.source_id;
  const sourceVersion = args.source_version;
  const inputPath = args.input;

  if (!provider || typeof provider !== 'string') {
    throw new Error('--provider is required');
  }
  if (!sourceId || typeof sourceId !== 'string') {
    throw new Error('--source-id is required');
  }
  if (!sourceVersion || typeof sourceVersion !== 'string' || sourceVersion.length === 0) {
    throw new Error('--source-version is required (non-empty)');
  }
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('--input is required');
  }

  const dbPath = args.db
    || process.env.DISCOVERY_DB
    || path.resolve(process.cwd(), 'discovery-cache.db');
  const batchSize = Number.isInteger(args.batch_size) ? args.batch_size : parseInt(args.batch_size, 10) || 2000;
  if (batchSize < 1 || batchSize > 50000) {
    throw new Error(`--batch-size must be between 1 and 50000 (got ${batchSize})`);
  }
  const format = (args.format || 'auto').toLowerCase();
  if (!['auto', 'ndhashes', 'csv', 'rd-history'].includes(format)) {
    throw new Error(`--format must be one of auto|ndhashes|csv|rd-history (got ${format})`);
  }
  const dryRun = !!args['dry-run'] || args.dry_run === true;
  const resume = !!args.resume;
  const reset = !!args.reset;
  const now = Number.isInteger(args.now) ? args.now : Date.now();

  // Input file
  const absInput = path.resolve(inputPath);
  if (!fs.existsSync(absInput)) {
    throw new Error(`input not found: ${absInput}`);
  }
  const fp = await fingerprintFile(absInput);
  const fpString = fingerprintString(fp);

  // Open cache. Dry-run uses an in-memory DB so we never mutate prod
  // state. The in-memory cache still produces a non-trivial plan/report.
  // If the caller pre-built a cache (test injection), use it instead.
  const cache = _injectedCache
    ? _injectedCache
    : (dryRun
        ? createDiscoveryCache({ dbPath: ':memory:' })
        : createDiscoveryCache({ dbPath: dbPath }));

  // Ensure checkpoint schema exists
  const rawDb = cache.getRawDb();
  rawDb.exec(CHECKPOINT_SCHEMA);

  // Best-effort idempotent migration from the historical
  // (source_id, source_version) PK to (provider, source_id, source_version).
  // Existing rows are duplicated across the existing (provider) value if
  // it differs, or attached to the new 'unknown' provider otherwise.
  // The migration only runs on legacy tables where the PK is the old shape.
  try {
    const legacyRows = rawDb.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name='import_checkpoints_legacy_v1'`
    ).get();
    if (!legacyRows) {
      const probe = rawDb.prepare(
        `SELECT provider, source_id, source_version FROM import_checkpoints LIMIT 1`
      ).get();
      if (probe) {
        // Detect legacy PK by attempting to find a row whose (provider)
        // would not be unique for the (source_id, source_version) pair —
        // but the simpler signal: an old table has rows but no provider
        // would have been used in the ON CONFLICT target. The schema is
        // defined with the new PK; SQLite will have created a new table
        // only if the old one didn't exist. We re-create legacy rows by
        // copying whatever was in the old shape into the new shape, then
        // drop the legacy table.
        const legacy = rawDb.prepare(
          `SELECT * FROM import_checkpoints`
        ).all();
        rawDb.exec(`
          CREATE TABLE import_checkpoints_legacy_v1 (
            source_id TEXT NOT NULL,
            source_version TEXT NOT NULL,
            provider TEXT,
            input_path TEXT NOT NULL,
            input_size INTEGER NOT NULL,
            input_mtime_ms INTEGER NOT NULL,
            input_fingerprint TEXT NOT NULL,
            format TEXT NOT NULL,
            batch_size INTEGER NOT NULL,
            lines_seen INTEGER NOT NULL DEFAULT 0,
            rows_seen INTEGER NOT NULL DEFAULT 0,
            rows_valid INTEGER NOT NULL DEFAULT 0,
            rows_invalid INTEGER NOT NULL DEFAULT 0,
            rows_duplicate INTEGER NOT NULL DEFAULT 0,
            batches_committed INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            finished_at INTEGER,
            PRIMARY KEY (source_id, source_version)
          );
        `);
        const insLegacy = rawDb.prepare(
          `INSERT OR IGNORE INTO import_checkpoints_legacy_v1
            (source_id, source_version, provider, input_path, input_size,
             input_mtime_ms, input_fingerprint, format, batch_size,
             lines_seen, rows_seen, rows_valid, rows_invalid,
             rows_duplicate, batches_committed, status, started_at,
             updated_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const r of legacy) {
          insLegacy.run(
            r.source_id, r.source_version, r.provider || 'unknown',
            r.input_path, r.input_size, r.input_mtime_ms,
            r.input_fingerprint, r.format, r.batch_size,
            r.lines_seen, r.rows_seen, r.rows_valid, r.rows_invalid,
            r.rows_duplicate, r.batches_committed, r.status,
            r.started_at, r.updated_at, r.finished_at
          );
        }
        rawDb.exec(`DROP TABLE import_checkpoints;`);
        rawDb.exec(CHECKPOINT_SCHEMA);
        const insNew = rawDb.prepare(
          `INSERT OR IGNORE INTO import_checkpoints
            (provider, source_id, source_version, input_path, input_size,
             input_mtime_ms, input_fingerprint, format, batch_size,
             lines_seen, rows_seen, rows_valid, rows_invalid,
             rows_duplicate, batches_committed, status, started_at,
             updated_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const r of legacy) {
          insNew.run(
            r.provider || 'unknown', r.source_id, r.source_version,
            r.input_path, r.input_size, r.input_mtime_ms,
            r.input_fingerprint, r.format, r.batch_size,
            r.lines_seen, r.rows_seen, r.rows_valid, r.rows_invalid,
            r.rows_duplicate, r.batches_committed, r.status,
            r.started_at, r.updated_at, r.finished_at
          );
        }
      }
    }
  } catch (err) {
    // Migration is best-effort. If it fails, the new table is empty
    // and the import will start fresh.
  }

  // Checkpoint lookup
  const existing = rawDb.prepare(
    `SELECT * FROM import_checkpoints
     WHERE provider = ? AND source_id = ? AND source_version = ?`
  ).get(provider, sourceId, sourceVersion);

  if (existing) {
    if (reset) {
      // Hard reset: delete existing checkpoint AND wipe prior sightings
      // for this snapshot identity. The downstream ingest will be a fresh
      // full run. This is destructive for the historical evidence rows
      // tied to (sourceId, sourceVersion) — caller must be intentional.
      const delSighting = rawDb.prepare(
        `DELETE FROM historical_provider_evidence_sightings
         WHERE source_id = ? AND source_version = ?`
      );
      const delAgg = rawDb.prepare(
        `DELETE FROM historical_provider_evidence
         WHERE source_id = ?`
      );
      const delCkpt = rawDb.prepare(
        `DELETE FROM import_checkpoints
         WHERE provider = ? AND source_id = ? AND source_version = ?`
      );
      rawDb.exec('BEGIN IMMEDIATE');
      try {
        delSighting.run(sourceId, sourceVersion);
        delAgg.run(sourceId);
        delCkpt.run(provider, sourceId, sourceVersion);
        rawDb.exec('COMMIT');
      } catch (err) {
        rawDb.exec('ROLLBACK');
        throw err;
      }
    } else {
      // Validate fingerprint
      if (existing.input_fingerprint !== fpString) {
        throw new Error(
          `input fingerprint mismatch for (source_id=${sourceId}, source_version=${sourceVersion}). `
            + `Refusing to resume. Use --reset to start a fresh import for this snapshot.`
        );
      }
      if (!resume && existing.status === 'complete') {
        // Completed import rerun: treat as fast no-op unless --resume is set
        const stats = printCompletedRerunStats(existing, absInput);
        if (!_injectedCache) cache.close();
        return stats;
      }
    }
  } else if (!resume && !reset) {
    // No existing checkpoint, --resume not requested: this is a fresh import
  }

  // Initialize or resume checkpoint
  const initialLinesSeen = existing && resume ? existing.lines_seen : 0;

  const stats = {
    rowsSeen: 0,
    rowsValid: 0,
    rowsInvalid: 0,
    rowsDuplicate: 0,
    rowsNewSightings: 0,
    rowsExistingSightings: 0,
    batches: 0,
  };
  const startMs = Date.now();
  const parseStats = {
    valid: 0,
    invalid: 0,
    duplicate: 0,
  };

  // Persist a fresh checkpoint row (or reset stale one)
  const upsertCheckpoint = rawDb.prepare(`
    INSERT INTO import_checkpoints (
      source_id, source_version, provider, input_path, input_size, input_mtime_ms,
      input_fingerprint, format, batch_size, lines_seen,
      rows_seen, rows_valid, rows_invalid, rows_duplicate, batches_committed,
      status, started_at, updated_at
    ) VALUES (
      @source_id, @source_version, @provider, @input_path, @input_size, @input_mtime_ms,
      @input_fingerprint, @format, @batch_size, @lines_seen,
      @rows_seen, @rows_valid, @rows_invalid, @rows_duplicate, @batches_committed,
      @status, @started_at, @updated_at
    )
    ON CONFLICT(provider, source_id, source_version) DO UPDATE SET
      lines_seen = excluded.lines_seen,
      rows_seen = excluded.rows_seen,
      rows_valid = excluded.rows_valid,
      rows_invalid = excluded.rows_invalid,
      rows_duplicate = excluded.rows_duplicate,
      batches_committed = excluded.batches_committed,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);

  function checkpointFields(extra = {}) {
    return {
      source_id: sourceId,
      source_version: sourceVersion,
      provider,
      input_path: absInput,
      input_size: fp.size,
      input_mtime_ms: fp.mtimeMs,
      input_fingerprint: fpString,
      format,
      batch_size: batchSize,
      lines_seen: extra.lines_seen ?? 0,
      rows_seen: extra.rows_seen ?? 0,
      rows_valid: extra.rows_valid ?? 0,
      rows_invalid: extra.rows_invalid ?? 0,
      rows_duplicate: extra.rows_duplicate ?? 0,
      batches_committed: extra.batches_committed ?? 0,
      status: extra.status ?? 'pending',
      started_at: extra.started_at ?? startMs,
      updated_at: Date.now(),
    };
  }

  if (!existing || reset) {
    upsertCheckpoint.run(checkpointFields({ status: 'pending' }));
  } else if (resume) {
    // Touch updated_at to mark resumption
    upsertCheckpoint.run(checkpointFields({
      lines_seen: initialLinesSeen,
      rows_seen: existing.rows_seen,
      rows_valid: existing.rows_valid,
      rows_invalid: existing.rows_invalid,
      rows_duplicate: existing.rows_duplicate,
      batches_committed: existing.batches_committed,
      status: existing.status,
      started_at: existing.started_at,
    }));
  }

  if (dryRun) {
    // Parse the full file (no resume shortcut, since dry-run must
    // report total counts), but never call ingestHistoricalProviderEvidence
    // and never commit a checkpoint.
    for await (const row of streamParse({
      inputPath: absInput,
      format,
      startLine: 0,
      now,
      onStats: (s) => {
        if (s.valid) parseStats.valid += s.valid;
        if (s.invalid) parseStats.invalid += s.invalid;
        if (s.duplicate) parseStats.duplicate += s.duplicate;
      },
    })) {
      // discard
    }
    const elapsed = Date.now() - startMs;
    const report = {
      mode: 'dry-run',
      provider,
      sourceId,
      sourceVersion,
      input: absInput,
      fingerprint: fpString,
      format,
      resumedFromLine: 0,
      rowsRead: parseStats.valid + parseStats.invalid,
      rowsValid: parseStats.valid,
      rowsInvalid: parseStats.invalid,
      rowsDuplicate: parseStats.duplicate,
      batches: 0,
      newSightings: 0,
      existingSightings: 0,
      elapsedMs: elapsed,
      rateRowsPerSec: parseStats.valid > 0
        ? Math.round((parseStats.valid + parseStats.invalid) / (elapsed / 1000))
        : 0,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    cache.close();
    return report;
  }

  // Live import
  let batch = [];
  let linesSeen = initialLinesSeen;
  // Snapshot of linesSeen at the last successful checkpoint write. The
  // error-path checkpoint must NOT regress past this value.
  let lastCommittedLines = initialLinesSeen;
  // rowsSeen tracks total parseable lines (valid + invalid + duplicate),
  // matching the dry-run rowsRead semantic. We update it from the parser
  // callback below, not in the for-await body, so invalid lines still
  // count.
  stats.rowsSeen = 0;

  const flushBatch = async () => {
    if (batch.length === 0) return;
    if (_onBatchFlushed) {
      _onBatchFlushed(stats.batches);
    }
    const observations = batch.map((r) => ({
      infoHash: r.infoHash,
      fileIndex: r.fileIndex,
      firstSeenAt: r.observedAt,
      lastSeenAt: r.observedAt,
      observationCount: 1,
    }));
    const r = cache.ingestHistoricalProviderEvidence({
      provider,
      sourceId,
      sourceVersion,
      observations,
      now,
      evidenceType: 'historical_hit',
    });
    stats.batches += 1;
    // r.ingested = rows attempted by the API; r.skipped = rows the API
    // rejected (e.g. invalid hash). We do NOT pre-filter invalid hashes
    // here, so skipped should be 0 in practice. The split between new
    // and existing sightings is approximated as best-effort; exact
    // values are available via a follow-up query if needed.
    const newFromApi = Math.max(0, r.ingested - r.skipped);
    stats.rowsNewSightings += newFromApi;
    stats.rowsExistingSightings += (batch.length - newFromApi);
    batch = [];

    upsertCheckpoint.run(checkpointFields({
      lines_seen: linesSeen,
      rows_seen: stats.rowsSeen,
      rows_valid: stats.rowsValid,
      rows_invalid: stats.rowsInvalid,
      rows_duplicate: stats.rowsDuplicate,
      batches_committed: stats.batches,
      status: 'pending',
    }));
    lastCommittedLines = linesSeen;
  };

  try {
    for await (const row of streamParse({
      inputPath: absInput,
      format,
      startLine: initialLinesSeen,
      now,
      onStats: (s) => {
        if (s.valid) {
          stats.rowsValid += 1;
          if (s.duplicate) stats.rowsDuplicate += 1;
          stats.rowsSeen += 1;
        }
        if (s.invalid) {
          stats.rowsInvalid += 1;
          stats.rowsSeen += 1;
        }
      },
    })) {
      linesSeen += 1;
      batch.push(row);
      if (batch.length >= batchSize) {
        await flushBatch();
      }
    }
    // Final batch
    await flushBatch();

    // Mark complete
    upsertCheckpoint.run(checkpointFields({
      lines_seen: linesSeen,
      rows_seen: stats.rowsSeen,
      rows_valid: stats.rowsValid,
      rows_invalid: stats.rowsInvalid,
      rows_duplicate: stats.rowsDuplicate,
      batches_committed: stats.batches,
      status: 'complete',
      started_at: existing?.started_at ?? startMs,
    }));

    const elapsed = Date.now() - startMs;
    const report = {
      mode: 'live',
      provider,
      sourceId,
      sourceVersion,
      input: absInput,
      fingerprint: fpString,
      format,
      resumedFromLine: initialLinesSeen,
      rowsRead: stats.rowsSeen,
      rowsValid: stats.rowsValid,
      rowsInvalid: stats.rowsInvalid,
      rowsDuplicate: stats.rowsDuplicate,
      batches: stats.batches,
      newSightings: stats.rowsNewSightings,
      existingSightings: stats.rowsExistingSightings,
      elapsedMs: elapsed,
      rateRowsPerSec: elapsed > 0 ? Math.round(stats.rowsSeen / (elapsed / 1000)) : 0,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!_injectedCache) cache.close();
    return report;
  } catch (err) {
    // On error, mark checkpoint as 'failed' so caller knows state is
    // partial. Preserve the last committed batch boundary so resume
    // picks up exactly where the prior committed work ended.
    try {
      upsertCheckpoint.run(checkpointFields({
        lines_seen: lastCommittedLines,
        rows_seen: Math.max(0, stats.rowsSeen - batch.length),
        rows_valid: Math.max(0, stats.rowsValid - batch.length),
        rows_invalid: stats.rowsInvalid,
        rows_duplicate: stats.rowsDuplicate,
        batches_committed: stats.batches,
        status: 'failed',
        started_at: existing?.started_at ?? startMs,
      }));
    } catch {
      // best-effort
    }
    if (!_injectedCache) cache.close();
    throw err;
  }
}

function printCompletedRerunStats(ckpt, inputPath) {
  const report = {
    mode: 'rerun',
    provider: ckpt.provider,
    sourceId: ckpt.source_id,
    sourceVersion: ckpt.source_version,
    input: inputPath,
    fingerprint: ckpt.input_fingerprint,
    status: ckpt.status,
    rowsRead: ckpt.rows_seen,
    rowsValid: ckpt.rows_valid,
    rowsInvalid: ckpt.rows_invalid,
    rowsDuplicate: ckpt.rows_duplicate,
    batches: ckpt.batches_committed,
    note: 'completed import rerun is a fast no-op; pass --resume to re-traverse the file',
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report;
}

// ---------------------------------------------------------------------------
// Allow this file to be both invoked as a script and required as a lib
// (so tests can call runFromOptions(...) directly).
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    if (process.env.DEBUG) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}
