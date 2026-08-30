#!/usr/bin/env node
/**
 * DMM Hash Prevalence Census
 *
 * Full single pass over pinned 14,534-fragment tree to compute:
 * - occurrence_count: total raw occurrences of each infoHash
 * - fragment_count: distinct fragments containing each infoHash
 * - sample_filename: one representative filename
 *
 * Extends existing census DB with hash_prevalence table.
 * Uses bulk transactions. Resumable via census_progress.
 */

import { DMMHashListSource, extractPayload } from '../lib/discovery/dmm-ingestion-runner.js';
import { decodeDmmPayload, parseDmmPayload } from '../lib/discovery/adapters/dmm.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const TREE_SHA = 'fda7edc62d85d1021492d2767cd5af9080fc922f';
const CENSUS_DB_DIR = path.resolve(process.cwd(), '../../artifacts/dmm-census');
const CENSUS_DB_PATH = path.join(CENSUS_DB_DIR, 'census.db');
const CONCURRENCY = parseInt(process.env.CENSUS_CONCURRENCY || '8', 10);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * p)];
}

async function main() {
  console.log('=== DMM Hash Prevalence Census ===\n');
  console.log(`Pinned tree SHA: ${TREE_SHA}`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  ensureDir(CENSUS_DB_DIR);

  const censusDb = new DatabaseSync(CENSUS_DB_PATH);

  // Create prevalence table
  censusDb.exec(`
    CREATE TABLE IF NOT EXISTS hash_prevalence (
      info_hash TEXT PRIMARY KEY,
      occurrence_count INTEGER NOT NULL DEFAULT 0,
      fragment_count INTEGER NOT NULL DEFAULT 0,
      sample_filename TEXT
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS prevalence_progress (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      started_at INTEGER NOT NULL,
      last_fragment_idx INTEGER NOT NULL DEFAULT 0,
      fragments_complete INTEGER NOT NULL DEFAULT 0,
      fragments_failed INTEGER NOT NULL DEFAULT 0,
      total_raw_records INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Resume support
  const progressRow = censusDb.prepare('SELECT * FROM prevalence_progress WHERE id = 1').get();
  let startIdx = 0;
  let fragmentsComplete = 0;
  let fragmentsFailed = 0;
  let totalRawRecords = 0;

  if (progressRow) {
    startIdx = progressRow.last_fragment_idx;
    fragmentsComplete = progressRow.fragments_complete;
    fragmentsFailed = progressRow.fragments_failed;
    totalRawRecords = progressRow.total_raw_records;
    console.log(`Resuming prevalence pass from fragment index ${startIdx}`);
    console.log(`Previously complete: ${fragmentsComplete}\n`);
  } else {
    censusDb.prepare('INSERT INTO prevalence_progress (id, started_at) VALUES (1, ?)').run(Date.now());
  }

  // Prepared statements
  const updateProgressStmt = censusDb.prepare(`
    UPDATE prevalence_progress SET
      last_fragment_idx = ?,
      fragments_complete = ?,
      fragments_failed = ?,
      total_raw_records = ?
    WHERE id = 1
  `);

  // Discover fragments
  const source = new DMMHashListSource();
  console.log('Discovering fragments...');
  const discovery = await source.listFragments({ treeSha: TREE_SHA });
  const fragments = discovery.fragments;
  console.log(`Total fragments: ${fragments.length}`);
  console.log(`Tree SHA: ${discovery.treeSha}`);
  console.log(`Branch: ${discovery.branch}\n`);

  // In-memory prevalence accumulator
  // Key: infoHash -> { occurrence_count, fragment_count, sample_filename }
  const prevalenceMap = new Map();

  // Load existing prevalence data if resuming
  if (progressRow && progressRow.fragments_complete > 0) {
    console.log('Loading existing prevalence data...');
    const existing = censusDb.prepare('SELECT info_hash, occurrence_count, fragment_count, sample_filename FROM hash_prevalence').all();
    for (const row of existing) {
      prevalenceMap.set(row.info_hash, {
        occurrence_count: row.occurrence_count,
        fragment_count: row.fragment_count,
        sample_filename: row.sample_filename
      });
    }
    console.log(`Loaded ${prevalenceMap.size} existing hashes\n`);
  }

  const startTime = Date.now();
  let nextIdx = startIdx;
  let lastReportedAt = Date.now();
  const inFlight = new Set();

  async function processFragment(frag, idx) {
    try {
      const html = await source.fetchFragment(frag.url);
      const payload = extractPayload(html);
      if (!payload) {
        return { idx, status: 'failed', reason: 'no_payload', entries: [] };
      }

      let json;
      try {
        json = decodeDmmPayload(payload);
      } catch (e) {
        return { idx, status: 'failed', reason: 'decompress_error', entries: [] };
      }

      let entries;
      try {
        entries = parseDmmPayload(json);
      } catch (e) {
        return { idx, status: 'failed', reason: 'parse_error', entries: [] };
      }

      return { idx, status: 'complete', entries };
    } catch (e) {
      return { idx, status: 'failed', reason: e.message, entries: [] };
    }
  }

  function reportProgress() {
    const now = Date.now();
    if (now - lastReportedAt < 5000) return;
    lastReportedAt = now;

    const elapsed = (now - startTime) / 1000;
    const processed = fragmentsComplete + fragmentsFailed;
    const rate = processed / elapsed;
    const remaining = fragments.length - processed;
    const eta = rate > 0 ? remaining / rate : 0;

    console.log(
      `[${processed}/${fragments.length}] ` +
      `complete=${fragmentsComplete} failed=${fragmentsFailed} | ` +
      `raw=${totalRawRecords} unique=${prevalenceMap.size} | ` +
      `rate=${rate.toFixed(1)}/s eta=${(eta / 60).toFixed(1)}min`
    );
  }

  // Process fragments with bounded concurrency
  while (nextIdx < fragments.length || inFlight.size > 0) {
    while (inFlight.size < CONCURRENCY && nextIdx < fragments.length) {
      const frag = fragments[nextIdx];
      const idx = nextIdx;
      nextIdx++;

      const promise = processFragment(frag, idx).then((result) => {
        inFlight.delete(promise);

        if (result.status === 'complete') {
          fragmentsComplete++;
          totalRawRecords += result.entries.length;

          // Count occurrences within this fragment
          const fragmentHashCounts = new Map();
          for (const entry of result.entries) {
            const hash = entry.infoHash;
            if (!hash) continue;

            const count = fragmentHashCounts.get(hash) || 0;
            fragmentHashCounts.set(hash, count + 1);
          }

          // Update prevalence map
          for (const [hash, count] of fragmentHashCounts) {
            const existing = prevalenceMap.get(hash);
            if (existing) {
              existing.occurrence_count += count;
              existing.fragment_count += 1;
            } else {
              // Find a filename for this hash from the entries
              const sampleEntry = result.entries.find(e => e.infoHash === hash);
              prevalenceMap.set(hash, {
                occurrence_count: count,
                fragment_count: 1,
                sample_filename: sampleEntry?.filename || sampleEntry?.title || null
              });
            }
          }
        } else {
          fragmentsFailed++;
        }

        reportProgress();
      });

      inFlight.add(promise);
    }

    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }

    // Persist progress every 100 fragments
    if ((fragmentsComplete + fragmentsFailed) % 100 === 0) {
      flushPrevalenceToDb();
      updateProgressStmt.run(nextIdx, fragmentsComplete, fragmentsFailed, totalRawRecords);
    }
  }

  // Wait for any remaining in-flight tasks
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
  }

  // Final flush
  flushPrevalenceToDb();
  updateProgressStmt.run(nextIdx, fragmentsComplete, fragmentsFailed, totalRawRecords);

  function flushPrevalenceToDb() {
    // Overwrite (not add) — prevalenceMap holds cumulative state
    censusDb.exec('BEGIN');
    const stmt = censusDb.prepare(`
      INSERT INTO hash_prevalence (info_hash, occurrence_count, fragment_count, sample_filename)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(info_hash) DO UPDATE SET
        occurrence_count = excluded.occurrence_count,
        fragment_count = excluded.fragment_count,
        sample_filename = excluded.sample_filename
    `);
    for (const [hash, data] of prevalenceMap) {
      stmt.run(hash, data.occurrence_count, data.fragment_count, data.sample_filename);
    }
    censusDb.exec('COMMIT');
  }

  // --- Compute final stats ---
  const elapsedTotal = (Date.now() - startTime) / 1000;

  // Get all prevalence data for percentile computation
  console.log('\nComputing prevalence statistics...');
  const allPrevalence = censusDb.prepare('SELECT info_hash, occurrence_count, fragment_count, sample_filename FROM hash_prevalence').all();

  const uniqueCount = allPrevalence.length;
  const totalOccurrences = allPrevalence.reduce((sum, r) => sum + r.occurrence_count, 0);

  // Sort fragment_counts for percentile computation
  const fragmentCounts = allPrevalence.map(r => r.fragment_count).sort((a, b) => a - b);

  const minFc = fragmentCounts[0] || 0;
  const maxFc = fragmentCounts[fragmentCounts.length - 1] || 0;
  const medianFc = percentile(fragmentCounts, 0.5);
  const p90Fc = percentile(fragmentCounts, 0.9);
  const p95Fc = percentile(fragmentCounts, 0.95);
  const p99Fc = percentile(fragmentCounts, 0.99);

  // Concentration thresholds
  const thresholds = [2, 5, 10, 50, 100, 500, 1000];
  const concentration = {};
  for (const t of thresholds) {
    concentration[t] = fragmentCounts.filter(c => c >= t).length;
  }

  // Top 25 by fragment_count
  const top25 = [...allPrevalence].sort((a, b) => b.fragment_count - a.fragment_count).slice(0, 25);

  censusDb.close();

  // --- Final Report ---
  console.log('\n=== DMM HASH PREVALENCE REPORT ===\n');
  console.log(`Pinned tree SHA: ${TREE_SHA}`);
  console.log(`Total fragments: ${fragments.length}`);
  console.log(`  Complete: ${fragmentsComplete}`);
  console.log(`  Failed: ${fragmentsFailed}`);
  console.log('');
  console.log(`Raw torrent records: ${totalOccurrences.toLocaleString()}`);
  console.log(`Unique infoHashes: ${uniqueCount.toLocaleString()}`);
  console.log(`Duplicate ratio: ${totalOccurrences > 0 ? ((1 - uniqueCount / totalOccurrences) * 100).toFixed(2) : 0}%`);
  console.log('');
  console.log('Fragment-count distribution (distinct fragments per hash):');
  console.log(`  Min: ${minFc}`);
  console.log(`  Median: ${medianFc}`);
  console.log(`  P90: ${p90Fc}`);
  console.log(`  P95: ${p95Fc}`);
  console.log(`  P99: ${p99Fc}`);
  console.log(`  Max: ${maxFc}`);
  console.log('');
  console.log('Concentration (hashes appearing in >= N fragments):');
  for (const t of thresholds) {
    console.log(`  >= ${t}: ${concentration[t].toLocaleString()}`);
  }
  console.log('');
  console.log('Top 25 infoHashes by distinct fragment_count:');
  console.log('  infoHash                              | frag_cnt | occ_cnt  | sample_filename');
  console.log('  --------------------------------------|----------|----------|------------------');
  for (const h of top25) {
    const hashDisplay = h.info_hash.substring(0, 36).padEnd(36);
    const fc = String(h.fragment_count).padStart(8);
    const oc = String(h.occurrence_count).padStart(8);
    const fn = (h.sample_filename || '').substring(0, 40);
    console.log(`  ${hashDisplay} | ${fc} | ${oc} | ${fn}`);
  }
  console.log('');
  console.log(`Elapsed time: ${(elapsedTotal / 60).toFixed(1)} minutes (${elapsedTotal.toFixed(0)} seconds)`);
  console.log(`Throughput: ${(fragmentsComplete / elapsedTotal).toFixed(1)} fragments/sec`);
  console.log('\n=== PREVALENCE CENSUS COMPLETE ===');
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
