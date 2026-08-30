#!/usr/bin/env node
/**
 * DMM Full Repository Census
 *
 * Fetches, decompresses, and parses ALL 14,534 DMM fragments from the pinned
 * Git tree SHA, counting raw records and unique infoHashes WITHOUT inserting
 * into Hashsucker's candidate cache.
 *
 * Uses a standalone SQLite census DB (info_hash PRIMARY KEY) for dedup.
 * Tracks progress for resumability.
 * Uses bounded concurrency (default: 8 parallel fetches).
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

async function main() {
  console.log('=== DMM Full Repository Census ===\n');
  console.log(`Pinned tree SHA: ${TREE_SHA}`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  ensureDir(CENSUS_DB_DIR);

  // --- Census DB schema ---
  // Only two tables: info_hash dedup table + progress tracking
  const censusDb = new DatabaseSync(CENSUS_DB_PATH);
  censusDb.exec(`
    CREATE TABLE IF NOT EXISTS info_hashes (
      info_hash TEXT PRIMARY KEY
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS census_progress (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      started_at INTEGER NOT NULL,
      last_fragment_idx INTEGER NOT NULL DEFAULT 0,
      fragments_complete INTEGER NOT NULL DEFAULT 0,
      fragments_failed INTEGER NOT NULL DEFAULT 0,
      total_raw_records INTEGER NOT NULL DEFAULT 0,
      total_valid_hashes INTEGER NOT NULL DEFAULT 0,
      total_invalid_records INTEGER NOT NULL DEFAULT 0,
      total_html_bytes INTEGER NOT NULL DEFAULT 0,
      total_payload_bytes INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Resume support: check if we have a progress row
  const progressRow = censusDb.prepare('SELECT * FROM census_progress WHERE id = 1').get();
  let startIdx = 0;
  let cumulativeStats = {
    fragments_complete: 0,
    fragments_failed: 0,
    total_raw_records: 0,
    total_valid_hashes: 0,
    total_invalid_records: 0,
    total_html_bytes: 0,
    total_payload_bytes: 0,
  };

  if (progressRow) {
    startIdx = progressRow.last_fragment_idx;
    cumulativeStats = {
      fragments_complete: progressRow.fragments_complete,
      fragments_failed: progressRow.fragments_failed,
      total_raw_records: progressRow.total_raw_records,
      total_valid_hashes: progressRow.total_valid_hashes,
      total_invalid_records: progressRow.total_invalid_records,
      total_html_bytes: progressRow.total_html_bytes,
      total_payload_bytes: progressRow.total_payload_bytes,
    };
    console.log(`Resuming from fragment index ${startIdx}`);
    console.log(`Previously complete: ${cumulativeStats.fragments_complete}\n`);
  } else {
    censusDb.prepare('INSERT INTO census_progress (id, started_at) VALUES (1, ?)').run(Date.now());
  }

  // Prepared statements
  const insertHashStmt = censusDb.prepare('INSERT OR IGNORE INTO info_hashes (info_hash) VALUES (?)');
  const updateProgressStmt = censusDb.prepare(`
    UPDATE census_progress SET
      last_fragment_idx = ?,
      fragments_complete = ?,
      fragments_failed = ?,
      total_raw_records = ?,
      total_valid_hashes = ?,
      total_invalid_records = ?,
      total_html_bytes = ?,
      total_payload_bytes = ?
    WHERE id = 1
  `);

  // --- Discover fragments ---
  const source = new DMMHashListSource();
  console.log('Discovering fragments...');
  const discovery = await source.listFragments({ treeSha: TREE_SHA });
  const fragments = discovery.fragments;
  console.log(`Total fragments: ${fragments.length}`);
  console.log(`Tree SHA: ${discovery.treeSha}`);
  console.log(`Branch: ${discovery.branch}\n`);

  // --- Statistics tracking ---
  const recordsPerFragment = [];
  let zeroRecordFragments = 0;
  let totalRawRecords = 0;
  let totalValidHashes = 0;
  let totalInvalidRecords = 0;
  let totalHtmlBytes = 0;
  let totalPayloadBytes = 0;
  let fragmentsComplete = 0;
  let fragmentsFailed = 0;
  const startTime = Date.now();

  // Batch insert transaction
  const hashBatch = [];
  const HASH_BATCH_SIZE = 10000;

  function flushHashBatch() {
    if (hashBatch.length === 0) return;
    censusDb.exec('BEGIN');
    for (const hash of hashBatch) {
      insertHashStmt.run(hash);
    }
    censusDb.exec('COMMIT');
    hashBatch.length = 0;
  }

  // --- Process fragments with bounded concurrency ---
  let nextIdx = startIdx;
  let lastReportedAt = Date.now();
  const inFlight = new Set();

  async function processFragment(frag, idx) {
    try {
      // Fetch
      const html = await source.fetchFragment(frag.url);
      const htmlBytes = Buffer.byteLength(html, 'utf8');

      // Extract payload
      const payload = extractPayload(html);
      if (!payload) {
        return { idx, status: 'failed', reason: 'no_payload', htmlBytes, payloadBytes: 0, rawRecords: 0, validHashes: 0, invalidRecords: 0 };
      }

      // Decompress
      let json;
      try {
        json = decodeDmmPayload(payload);
      } catch (e) {
        return { idx, status: 'failed', reason: 'decompress_error', htmlBytes, payloadBytes: Buffer.byteLength(payload, 'utf8'), rawRecords: 0, validHashes: 0, invalidRecords: 0 };
      }

      // Parse
      let entries;
      try {
        entries = parseDmmPayload(json);
      } catch (e) {
        return { idx, status: 'failed', reason: 'parse_error', htmlBytes, payloadBytes: Buffer.byteLength(payload, 'utf8'), rawRecords: 0, validHashes: 0, invalidRecords: 0 };
      }

      const rawRecords = entries.length;
      let validHashes = 0;
      let invalidRecords = 0;

      // Count valid hashes and collect unique ones
      for (const entry of entries) {
        if (entry.infoHash && /^[a-f0-9]{40}$/.test(entry.infoHash)) {
          validHashes++;
          hashBatch.push(entry.infoHash);
        } else {
          invalidRecords++;
        }
      }

      if (hashBatch.length >= HASH_BATCH_SIZE) {
        flushHashBatch();
      }

      return {
        idx,
        status: 'complete',
        htmlBytes,
        payloadBytes: Buffer.byteLength(payload, 'utf8'),
        rawRecords,
        validHashes,
        invalidRecords,
      };
    } catch (e) {
      return { idx, status: 'failed', reason: e.message, htmlBytes: 0, payloadBytes: 0, rawRecords: 0, validHashes: 0, invalidRecords: 0 };
    }
  }

  function reportProgress() {
    const now = Date.now();
    if (now - lastReportedAt < 5000) return; // Report every 5 seconds
    lastReportedAt = now;

    const elapsed = (now - startTime) / 1000;
    const processed = fragmentsComplete + fragmentsFailed;
    const rate = processed / elapsed;
    const remaining = fragments.length - processed;
    const eta = rate > 0 ? remaining / rate : 0;

    console.log(
      `[${processed}/${fragments.length}] ` +
      `complete=${fragmentsComplete} failed=${fragmentsFailed} | ` +
      `raw=${totalRawRecords} valid=${totalValidHashes} invalid=${totalInvalidRecords} | ` +
      `rate=${rate.toFixed(1)}/s eta=${(eta / 60).toFixed(1)}min`
    );
  }

  // Concurrency-limited processing
  while (nextIdx < fragments.length || inFlight.size > 0) {
    // Launch new tasks up to concurrency limit
    while (inFlight.size < CONCURRENCY && nextIdx < fragments.length) {
      const frag = fragments[nextIdx];
      const idx = nextIdx;
      nextIdx++;

      const promise = processFragment(frag, idx).then((result) => {
        inFlight.delete(promise);

        if (result.status === 'complete') {
          fragmentsComplete++;
          totalRawRecords += result.rawRecords;
          totalValidHashes += result.validHashes;
          totalInvalidRecords += result.invalidRecords;
          totalHtmlBytes += result.htmlBytes;
          totalPayloadBytes += result.payloadBytes;
          recordsPerFragment.push(result.rawRecords);
          if (result.rawRecords === 0) zeroRecordFragments++;
        } else {
          fragmentsFailed++;
        }

        reportProgress();
      });

      inFlight.add(promise);
    }

    // Wait for at least one task to complete
    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }

    // Persist progress every 100 fragments
    if ((fragmentsComplete + fragmentsFailed) % 100 === 0) {
      flushHashBatch();
      updateProgressStmt.run(
        nextIdx,
        fragmentsComplete,
        fragmentsFailed,
        totalRawRecords,
        totalValidHashes,
        totalInvalidRecords,
        totalHtmlBytes,
        totalPayloadBytes
      );
    }
  }

  // Final flush
  flushHashBatch();
  updateProgressStmt.run(
    nextIdx,
    fragmentsComplete,
    fragmentsFailed,
    totalRawRecords,
    totalValidHashes,
    totalInvalidRecords,
    totalHtmlBytes,
    totalPayloadBytes
  );

  // --- Compute final stats ---
  const elapsedTotal = (Date.now() - startTime) / 1000;

  // Get unique hash count from DB
  const uniqueCount = censusDb.prepare('SELECT COUNT(*) as c FROM info_hashes').get().c;

  // Compute distribution stats
  recordsPerFragment.sort((a, b) => a - b);
  const min = recordsPerFragment[0] || 0;
  const max = recordsPerFragment[recordsPerFragment.length - 1] || 0;
  const median = recordsPerFragment.length > 0 ? recordsPerFragment[Math.floor(recordsPerFragment.length / 2)] : 0;
  const p95 = recordsPerFragment.length > 0 ? recordsPerFragment[Math.floor(recordsPerFragment.length * 0.95)] : 0;

  // Compute total source size (sum of all fragment HTML sizes)
  const totalSourceBytes = totalHtmlBytes;

  censusDb.close();

  // --- Final Report ---
  console.log('\n=== DMM REPOSITORY CENSUS REPORT ===\n');
  console.log(`Pinned tree SHA: ${TREE_SHA}`);
  console.log(`Total fragments: ${fragments.length}`);
  console.log(`  Complete: ${fragmentsComplete}`);
  console.log(`  Failed: ${fragmentsFailed}`);
  console.log('');
  console.log(`Raw torrent records: ${totalRawRecords.toLocaleString()}`);
  console.log(`Valid 40-char infoHash records: ${totalValidHashes.toLocaleString()}`);
  console.log(`Malformed/invalid records: ${totalInvalidRecords.toLocaleString()}`);
  console.log('');
  console.log(`Unique infoHashes: ${uniqueCount.toLocaleString()}`);
  console.log(`Duplicate occurrences: ${(totalValidHashes - uniqueCount).toLocaleString()}`);
  console.log(`Duplicate ratio: ${totalValidHashes > 0 ? ((1 - uniqueCount / totalValidHashes) * 100).toFixed(2) : 0}%`);
  console.log('');
  console.log('Records-per-fragment distribution:');
  console.log(`  Min: ${min}`);
  console.log(`  Median: ${median}`);
  console.log(`  P95: ${p95}`);
  console.log(`  Max: ${max}`);
  console.log(`  Fragments with 0 records: ${zeroRecordFragments}`);
  console.log('');
  console.log(`Total HTML bytes (compressed): ${formatBytes(totalHtmlBytes)}`);
  console.log(`Total payload bytes (LZString): ${formatBytes(totalPayloadBytes)}`);
  console.log(`Total source size: ${formatBytes(totalSourceBytes)}`);
  console.log('');
  console.log(`Elapsed time: ${(elapsedTotal / 60).toFixed(1)} minutes (${elapsedTotal.toFixed(0)} seconds)`);
  console.log(`Throughput: ${(fragmentsComplete / elapsedTotal).toFixed(1)} fragments/sec`);

  console.log('\n=== COMPARISON ===');
  console.log(`First 1,000-fragment rebuild: 2,049,183 raw / 604,109 unique`);
  console.log(`Current live Hashsucker: 314,662 unique`);
  console.log(`Full repository census: ${totalRawRecords.toLocaleString()} raw / ${uniqueCount.toLocaleString()} unique`);

  console.log('\n=== CENSUS COMPLETE ===');
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
