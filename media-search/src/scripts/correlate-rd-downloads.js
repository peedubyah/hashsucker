#!/usr/bin/env node
/**
 * Correlate the persisted RD /downloads raw observations against the
 * current candidate corpus.
 *
 * Inputs:
 *   - rd_download_observations (cache table, populated by ingest-rd-downloads.js)
 *   - candidates                (cache table)
 *
 * Output:
 *   - rd_download_correlations (cache table, derived hypothesis cache)
 *   - analysis report on stdout
 *
 * The correlation table is rebuilt from scratch on each run; it is a
 * pure function of (observations, candidates) state. The observations
 * table is NEVER cleared.
 *
 * This script does NOT touch historical_provider_evidence, ranking,
 * or runtime request handling. It is north-side analysis only.
 *
 * Usage:
 *   node src/scripts/correlate-rd-downloads.js --db /path/to/cache.db
 *   node src/scripts/correlate-rd-downloads.js --db /path/to/cache.db --no-write
 *     # --no-write: report only, do not update the correlations table
 */
import path from 'node:path';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import {
  correlateRdDownloads,
  groupCorrelationsByFileBytes,
  CORRELATION_CLASSES,
} from '../lib/acquisition/rd-downloads-correlate.js';

function parseArgs(argv) {
  const args = { db: undefined, write: true, strongFloor: 0.70 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v == null) throw new Error(`flag ${a} requires a value`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--db':
      case '-d':
        args.db = next();
        break;
      case '--no-write':
        args.write = false;
        break;
      case '--strong-floor':
        args.strongFloor = Number(next());
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

const HELP = `correlate-rd-downloads

  Correlate RD /downloads raw observations against the current candidate
  corpus and write the derived hypothesis cache.

OPTIONS
  -d, --db <path>            Discovery cache SQLite path
                             (defaults to in-memory if unset)
      --no-write             Report only; do not update the correlations table
      --strong-floor <n>     Minimum score to be considered "plausible"
                             for UNIQUE_STRONG/MULTIPLE_PLAUSIBLE (default 0.70)
  -h, --help                 Show this help

NOTES
  The correlations table is a DERIVED HYPOTHESIS CACHE, never identity.
  Safe to rebuild from scratch; never authoritative.

  This script does NOT touch historical_provider_evidence or ranking.`;

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}

function fmtPct(n, total) {
  if (total === 0) return '0.00%';
  return `${(100 * n / total).toFixed(2)}%`;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stderr.write(HELP + '\n');
    return null;
  }
  const log = (...a) => process.stderr.write('[correlate-rd-downloads] ' + a.join(' ') + '\n');

  const dbPath = args.db || env.DISCOVERY_DB;
  const cache = createDiscoveryCache({ dbPath: dbPath || ':memory:' });

  const observations = cache.getAllRdDownloadObservations();
  log(`observations: ${observations.length}`);

  // Streaming candidate loader: walk the corpus in pages and run
  // correlation on each page. The correlation layer de-duplicates
  // and accumulates correlations across pages. This avoids the
  // OOM / latency of loading the entire 1M+ candidate corpus at
  // once.
  //
  // For each page, we map the raw row shape to the public
  // correlation shape (info_hash, file_index_key, search_key,
  // filename, title, size).
  function mapRaw(c) {
    return {
      info_hash: c.info_hash,
      file_index_key: c.file_index == null ? -1 : c.file_index,
      search_key: c.search_key,
      filename: c.filename,
      title: c.title,
      size: c.size,
    };
  }

  let rawCandidates = [];
  if (cache.queryRawCandidatesByTokens) {
    // Per-observation SQL LIKE prefilter. For each obs, pull a
    // handful of distinctive tokens (long, alphabetic, not stopword)
    // and run a single OR-LIKE query against the candidates table.
    // De-dupes by (info_hash, file_index_key) across the whole
    // observation set.
    //
    // This avoids loading 1.48M rows into memory.
    const seen = new Set();
    const tokensFor = (obs) => {
      const src = (obs.normalized_filename || obs.filename || '').toLowerCase();
      const raw = src.replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
      // Sort: longest first, drop short or pure-digit
      raw.sort((a, b) => b.length - a.length);
      return raw.filter((t) => t.length >= 4 && /[a-z]/.test(t));
    };
    let totalLooked = 0;
    for (let oi = 0; oi < observations.length; oi += 1) {
      const obs = observations[oi];
      const tokens = tokensFor(obs);
      if (tokens.length === 0) continue;
      const rows = cache.queryRawCandidatesByTokens({ tokens, limit: 1000 });
      for (const c of rows) {
        const fik = c.file_index == null ? -1 : c.file_index;
        const k = `${c.info_hash}::${fik}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rawCandidates.push(mapRaw(c));
      }
      totalLooked += 1;
      if (totalLooked % 20 === 0) {
        log(`  prefilter ${totalLooked}/${observations.length} obs → ${rawCandidates.length} unique candidates so far`);
      }
    }
    log(`loaded ${rawCandidates.length} unique candidates via per-obs token prefilter (${observations.length} obs)`);
  } else if (cache.iterateRawCandidates) {
    // Stream pages
    let pageNo = 0;
    for (const page of cache.iterateRawCandidates({ pageSize: 50000 })) {
      pageNo += 1;
      for (const c of page.rows) rawCandidates.push(mapRaw(c));
      if (pageNo % 10 === 0) {
        log(`  loaded page ${pageNo} (cursor=${page.lastInfoHash.slice(0, 8)}…, total so far: ${rawCandidates.length})`);
      }
    }
    log(`loaded ${rawCandidates.length} candidates via streaming`);
  } else if (cache.queryRawCandidatesBySearchKeys) {
    const searchKeys = new Set();
    for (const obs of observations) {
      if (obs.normalized_filename) {
        const base = obs.normalized_filename.replace(/\.[^.]+$/, '');
        if (base.length > 0) searchKeys.add(base);
      }
      if (obs.parsed_title) {
        const t = obs.parsed_title.toLowerCase().replace(/[^a-z0-9]+/g, '.');
        if (t.length > 0) searchKeys.add(t);
      }
    }
    log(`search_keys: ${searchKeys.size} (from ${observations.length} observations)`);
    rawCandidates = cache.queryRawCandidatesBySearchKeys({
      searchKeys: [...searchKeys],
    }).map(mapRaw);
  } else {
    log('WARN: no streaming API; falling back to full scan');
    const candidates = cache.queryCachedCandidates ? cache.queryCachedCandidates() : [];
    for (const c of candidates) {
      rawCandidates.push({
        info_hash: c.infoHash,
        file_index_key: c.fileIndex == null ? -1 : c.fileIndex,
        search_key: c.searchKey,
        filename: c.filename,
        title: c.title,
        size: c.size,
      });
    }
  }
  log(`candidates (total): ${rawCandidates.length}`);

  const { correlations, stats } = correlateRdDownloads({
    observations,
    candidates: rawCandidates,
    strongFloor: args.strongFloor,
  });

  // Per-group aggregation
  const groups = groupCorrelationsByFileBytes(correlations, observations);

  // Source version comes from the first observation (or 'unknown')
  const sourceVersion = observations.length > 0
    ? observations[0].source_version
    : 'unknown';

  if (args.write) {
    log(`writing ${correlations.length} correlation rows`);
    const r = cache.writeRdDownloadCorrelations({
      sourceVersion,
      correlations,
      now: Date.now(),
    });
    log(`written: ${r.written}, errors: ${r.errors.length}`);
    if (r.errors.length > 0) {
      for (const e of r.errors.slice(0, 5)) {
        log(`  err: ${JSON.stringify(e)}`);
      }
    }
  } else {
    log('--no-write: correlations table NOT updated');
  }

  // Report
  const totalEvents = stats.eventsByClass.UNIQUE_STRONG
    + stats.eventsByClass.MULTIPLE_PLAUSIBLE
    + stats.eventsByClass.WEAK
    + stats.eventsByClass.UNMATCHED;
  const totalBytes = stats.bytesByClass.UNIQUE_STRONG
    + stats.bytesByClass.MULTIPLE_PLAUSIBLE
    + stats.bytesByClass.WEAK
    + stats.bytesByClass.UNMATCHED;

  const out = {
    rawEvents: stats.rawEvents,
    uniqueFileBytesGroups: stats.uniqueFileBytesGroups,
    classDistribution: stats.eventsByClass,
    bytesByClass: stats.bytesByClass,
    bytesByClassHuman: Object.fromEntries(
      Object.entries(stats.bytesByClass).map(([k, v]) => [k, fmtBytes(v)])
    ),
    eventPercentByClass: Object.fromEntries(
      Object.entries(stats.eventsByClass).map(([k, v]) => [k, fmtPct(v, totalEvents)])
    ),
    bytesPercentByClass: Object.fromEntries(
      Object.entries(stats.bytesByClass).map(([k, v]) => [k, fmtPct(v, totalBytes)])
    ),
    totalBytesHuman: fmtBytes(totalBytes),
    totalEvents,
    candidateHashCardinality: stats.candidateHashCardinality,
    groupSummary: {
      totalGroups: groups.length,
      groupsByClass: countGroupsByClass(groups),
      topGroups: groups
        .sort((a, b) => b.totalBytes - a.totalBytes)
        .slice(0, 10)
        .map((g) => ({
          filename: g.normalized_filename,
          bytes: g.exact_bytes,
          bytesHuman: fmtBytes(g.exact_bytes),
          events: g.events,
          totalBytes: g.totalBytes,
          totalBytesHuman: fmtBytes(g.totalBytes),
          classes: g.classes,
          candidateHashCount: g.candidateHashCount,
        })),
    },
    config: { strongFloor: args.strongFloor, wrote: args.write },
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return out;
}

function countGroupsByClass(groups) {
  // A group's class is decided by majority class.
  // (We don't write per-group class; we report per-group event counts.)
  const out = { UNIQUE_STRONG: 0, MULTIPLE_PLAUSIBLE: 0, WEAK: 0, UNMATCHED: 0 };
  for (const g of groups) {
    let best = 'UNMATCHED';
    let bestN = -1;
    for (const c of Object.keys(out)) {
      if (g.classes[c] > bestN) { bestN = g.classes[c]; best = c; }
    }
    out[best] += 1;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`correlate-rd-downloads failed: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

export { parseArgs, HELP, fmtBytes };
