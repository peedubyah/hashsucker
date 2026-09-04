#!/usr/bin/env node
// 1M-row benchmark for the historical evidence importer.
// Generates a large synthetic input file, runs the importer, and reports
// performance characteristics: throughput, peak RSS, DB size growth, batch
// latency, resume correctness.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runFromOptions } from '../src/scripts/import-historical-provider-evidence.js';

const ROWS = Number(process.env.BENCH_ROWS) || 1_000_000;
const BATCH = Number(process.env.BENCH_BATCH) || 2000;
const DUP_FRAC = Number(process.env.BENCH_DUP_FRAC) || 0.05; // 5% within-file dups
const ROOT = process.env.BENCH_DIR
  || path.resolve(process.cwd(), '.tmp-bench-1m');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const inputPath = path.join(ROOT, 'bench-input.txt');
const dbPath = path.join(ROOT, 'bench.db');

console.error(`[bench] rows=${ROWS} batch=${BATCH} dup_frac=${DUP_FRAC}`);
console.error(`[bench] input: ${inputPath}`);
console.error(`[bench] db:    ${dbPath}`);

// -----------------------------------------------------------------------------
// Generate input
// -----------------------------------------------------------------------------
const t0 = performance.now();
const ws = fs.createWriteStream(inputPath);
const expected = [];
let written = 0;
const uniq = Math.floor(ROWS * (1 - DUP_FRAC));
// Use crypto.randomBytes to generate real-looking 20-byte SHA-1 hashes.
for (let i = 0; i < ROWS; i += 1) {
  let hash;
  if (i < uniq) {
    // unique
    hash = crypto.createHash('sha1').update(`bench-${i}`).digest('hex');
    expected.push(hash);
  } else {
    // duplicate of an earlier row
    const j = i % uniq;
    hash = expected[j];
  }
  ws.write(hash + '\n');
  written += 1;
}
await new Promise((resolve) => ws.end(resolve));
const genMs = performance.now() - t0;
const inputSize = fs.statSync(inputPath).size;
console.error(`[bench] input generated: ${written} rows, ${(inputSize / 1e6).toFixed(1)} MB, in ${genMs.toFixed(0)} ms`);

// -----------------------------------------------------------------------------
// Run 1: cold import
// -----------------------------------------------------------------------------
const rssBefore = process.memoryUsage().rss;
const t1 = performance.now();
const r1 = await runFromOptions({
  provider: 'realdebrid',
  'source-id': 'bench-snap',
  'source-version': 'V1',
  input: inputPath,
  db: dbPath,
  'batch-size': BATCH,
});
const coldMs = performance.now() - t1;
const rssAfter = process.memoryUsage().rss;
const dbSize = fs.statSync(dbPath).size;
console.error(`[bench] cold: rowsRead=${r1.rowsRead} valid=${r1.rowsValid} newSightings=${r1.newSightings} existingSightings=${r1.existingSightings}`);
console.error(`[bench] cold: elapsedMs=${r1.elapsedMs} rate=${(r1.rowsRead / (r1.elapsedMs / 1000)).toFixed(0)} rows/sec`);
console.error(`[bench] cold: wall=${coldMs.toFixed(0)} ms; rss Δ=${((rssAfter - rssBefore) / 1e6).toFixed(1)} MB; dbSize=${(dbSize / 1e6).toFixed(1)} MB`);

// -----------------------------------------------------------------------------
// Run 2: same args again -> completed rerun, must be fast no-op
// -----------------------------------------------------------------------------
const t2 = performance.now();
const r2 = await runFromOptions({
  provider: 'realdebrid',
  'source-id': 'bench-snap',
  'source-version': 'V1',
  input: inputPath,
  db: dbPath,
  'batch-size': BATCH,
});
const rerunMs = performance.now() - t2;
console.error(`[bench] rerun: elapsedMs=${r2.elapsedMs ?? rerunMs.toFixed(0)} mode=${r2.mode ?? 'unknown'}`);

// -----------------------------------------------------------------------------
// Run 3: fingerprint change + --reset -> fresh re-import
// -----------------------------------------------------------------------------
// Touch the input (rewrite) so the fingerprint changes.
const ws2 = fs.createWriteStream(inputPath);
for (let i = 0; i < ROWS; i += 1) {
  let hash;
  if (i < uniq) hash = crypto.createHash('sha1').update(`bench-${i}`).digest('hex');
  else hash = expected[i % uniq];
  ws2.write(hash + '\n');
}
await new Promise((resolve) => ws2.end(resolve));
// Force mtime to differ (touch)
const future = new Date(Date.now() + 60_000);
fs.utimesSync(inputPath, future, future);

const t3 = performance.now();
let r3 = { mode: 'rejected' };
try {
  r3 = await runFromOptions({
    provider: 'realdebrid',
    'source-id': 'bench-snap',
    'source-version': 'V1',
    input: inputPath,
    db: dbPath,
    'batch-size': BATCH,
  });
} catch (err) {
  r3 = { mode: 'rejected-with-throw', error: err.message };
}
const mismatchMs = performance.now() - t3;
console.error(`[bench] mismatched-fp (no reset): elapsedMs=${mismatchMs.toFixed(0)} mode=${r3.mode}`);

// -----------------------------------------------------------------------------
// Run 4: with --reset
// -----------------------------------------------------------------------------
const t4 = performance.now();
const r4 = await runFromOptions({
  provider: 'realdebrid',
  'source-id': 'bench-snap',
  'source-version': 'V1',
  input: inputPath,
  db: dbPath,
  'batch-size': BATCH,
  reset: true,
});
const resetMs = performance.now() - t4;
console.error(`[bench] --reset: elapsedMs=${r4.elapsedMs} newSightings=${r4.newSightings} existingSightings=${r4.existingSightings}`);

// -----------------------------------------------------------------------------
// Final summary
// -----------------------------------------------------------------------------
const finalDbSize = fs.statSync(dbPath).size;
const peakRssMb = Math.max(rssAfter, process.memoryUsage().rss) / 1e6;
console.error('');
console.error('=== BENCHMARK SUMMARY ===');
console.error(`Input rows:        ${ROWS.toLocaleString()}`);
console.error(`Input size:        ${(inputSize / 1e6).toFixed(1)} MB`);
console.error(`Cold import:       ${(r1.elapsedMs / 1000).toFixed(2)} s (${(r1.rowsRead / (r1.elapsedMs / 1000)).toFixed(0)} rows/sec)`);
console.error(`Cold new sightings:${r1.newSightings.toLocaleString()}`);
console.error(`Cold existing:     ${r1.existingSightings.toLocaleString()}`);
console.error(`DB size (cold):    ${(dbSize / 1e6).toFixed(1)} MB`);
console.error(`Rerun no-op:       ${rerunMs.toFixed(0)} ms`);
console.error(`Mismatch rej:      ${mismatchMs.toFixed(0)} ms (mode=${r3.mode})`);
console.error(`--reset re-import: ${(r4.elapsedMs / 1000).toFixed(2)} s`);
console.error(`Final DB size:     ${(finalDbSize / 1e6).toFixed(1)} MB`);
console.error(`Peak RSS:          ${peakRssMb.toFixed(1)} MB`);

// Cleanup
fs.rmSync(ROOT, { recursive: true, force: true });
console.error('[bench] cleaned up.');
