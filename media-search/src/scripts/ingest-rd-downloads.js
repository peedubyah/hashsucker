#!/usr/bin/env node
/**
 * Ingest an RD /downloads NDJSON snapshot into the discovery cache.
 *
 * Source file: output of acquire-rd-downloads.js
 * Target table: rd_download_observations (NOT historical_provider_evidence)
 *
 * Idempotency: the cache ingest uses INSERT OR IGNORE on
 * (provider, source_id, source_event_id). Re-running on the same
 * snapshot is a no-op (inserted === 0). Re-running on a newer
 * snapshot (different source_version) reuses the existing rows
 * and refreshes last_seen_at.
 *
 * Usage:
 *   node src/scripts/ingest-rd-downloads.js \
 *     --snapshot /var/lib/hashsucker/snapshots/rd-downloads-2026-09-03.ndjson \
 *     --db /var/lib/hashsucker/discovery-cache.db
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createDiscoveryCache } from '../lib/discovery/cache.js';

function parseArgs(argv) {
  const args = { snapshot: undefined, db: undefined, batchSize: 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v == null) throw new Error(`flag ${a} requires a value`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--snapshot':
      case '-s':
        args.snapshot = next();
        break;
      case '--db':
      case '-d':
        args.db = next();
        break;
      case '--batch-size':
        args.batchSize = Number(next());
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (a.startsWith('-')) {
          throw new Error(`unknown flag: ${a}`);
        }
        throw new Error(`unexpected positional argument: ${a}`);
    }
  }
  return args;
}

const HELP = `ingest-rd-downloads

  Ingest an RD /downloads NDJSON snapshot into the discovery cache.

OPTIONS
  -s, --snapshot <path>      NDJSON snapshot from acquire-rd-downloads.js (required)
  -d, --db <path>            Discovery cache SQLite path
                             (defaults to in-memory if unset)
      --batch-size <n>       Rows per transaction (default 1000)
  -h, --help                 Show this help

NOTES
  Source version is taken from the snapshot's .manifest.json's
  sourceVersion field. If the manifest is missing, the snapshot
  is rejected — replay idempotency requires a content-derived
  source version.

  The target table is rd_download_observations. /downloads is NOT
  written to historical_provider_evidence because it has no
  infoHash and no deterministic bridge to /torrents.`;

async function readSnapshot(snapshotPath) {
  // Read manifest first to get the source version
  const manifestPath = `${snapshotPath}.manifest.json`;
  let sourceVersion = null;
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      sourceVersion = m.sourceVersion;
    } catch (err) {
      throw new Error(`failed to read manifest ${manifestPath}: ${err.message}`);
    }
  }
  if (!sourceVersion) {
    throw new Error(`manifest missing or has no sourceVersion: ${manifestPath}`);
  }
  // Stream the rows
  const rows = [];
  const s = fs.createReadStream(snapshotPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: s, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    rows.push(JSON.parse(line));
  }
  return { rows, sourceVersion };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help || !args.snapshot) {
    process.stderr.write(HELP + '\n');
    if (!args.help) throw new Error('--snapshot is required');
    return null;
  }
  const snapshotPath = path.resolve(args.snapshot);
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`snapshot not found: ${snapshotPath}`);
  }
  const log = (...a) => process.stderr.write('[ingest-rd-downloads] ' + a.join(' ') + '\n');
  log(`reading ${snapshotPath}`);
  const { rows, sourceVersion } = await readSnapshot(snapshotPath);
  log(`read ${rows.length} rows, sourceVersion=${sourceVersion.slice(0, 12)}…`);

  const dbPath = args.db || env.DISCOVERY_DB;
  const cache = createDiscoveryCache({ dbPath: dbPath || ':memory:' });

  let totalIngested = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  const allErrors = [];
  const batchSize = args.batchSize;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const r = cache.ingestRdDownloadObservations({
      sourceVersion,
      observations: batch,
      now: Date.now(),
    });
    totalIngested += r.ingested;
    totalInserted += r.inserted;
    totalSkipped += r.skipped;
    if (r.errors && r.errors.length > 0) {
      allErrors.push(...r.errors);
    }
    log(`batch ${Math.floor(i / batchSize) + 1}: ingested=${r.ingested} inserted=${r.inserted} skipped=${r.skipped}`);
  }
  log(`done: ingested=${totalIngested} inserted=${totalInserted} skipped=${totalSkipped}`);
  log(`table now has ${cache.countRdDownloadObservations()} observations`);
  process.stdout.write(JSON.stringify({
    rowsRead: rows.length,
    ingested: totalIngested,
    inserted: totalInserted,
    skipped: totalSkipped,
    sourceVersion,
    observationRows: cache.countRdDownloadObservations(),
    errors: allErrors,
  }, null, 2) + '\n');
  return { ingested: totalIngested, inserted: totalInserted, skipped: totalSkipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`ingest-rd-downloads failed: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

export { parseArgs, HELP };
