#!/usr/bin/env node
/**
 * Synthetic scale benchmark for the RD history acquirer.
 *
 * Builds a fake in-memory RD torrent list of N entries, then runs the
 * acquirer over it with the external-sort path (chunkRows > 0). Reports
 * rows/sec, peak RSS, output size, and dedup behavior.
 *
 * NO real RD API is contacted.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { acquireRdHistory } from '../src/lib/acquisition/rd-history.js';
import {
  createFakeRdFetch,
  makeRdEntry,
} from '../test/fixtures/rd-acquisition/fake-rd-server.js';

const N = Number(process.env.BENCH_ROWS || 200_000);
const PAGE = Number(process.env.BENCH_PAGE || 2000);
const CHUNK = Number(process.env.BENCH_CHUNK || 50_000);
const DUP_RATIO = Number(process.env.BENCH_DUP_RATIO || 0); // 0..1
const DIR = process.env.BENCH_DIR || path.join(process.cwd(), '.tmp-bench-rd-acq');

const RD_TOKEN = 'BENCH_TOKEN_NOT_LOGGED';

function buildEntries(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(makeRdEntry(i));
  }
  return out;
}

function injectDuplicates(entries, ratio) {
  if (ratio <= 0) return entries;
  const dupCount = Math.floor(entries.length * ratio);
  // Append the first dupCount entries again (so they get re-seen on
  // later pages) to exercise the k-way merge dedup path.
  return entries.concat(entries.slice(0, dupCount));
}

function rssMB() {
  const m = process.memoryUsage();
  return Math.round(m.rss / (1024 * 1024));
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const out = path.join(DIR, 'bench-snap.ndjson');
  // Clean previous run
  try { fs.unlinkSync(out); } catch { /* ignore */ }
  try { fs.unlinkSync(`${out}.manifest.json`); } catch { /* ignore */ }

  const totalInputEntries = N + Math.floor(N * DUP_RATIO);
  const entries = injectDuplicates(buildEntries(N), DUP_RATIO);
  const fetchFn = createFakeRdFetch({ entries, pageSize: PAGE });

  const baselineRss = rssMB();
  const start = Date.now();
  const result = await acquireRdHistory({
    apiKey: RD_TOKEN,
    outputPath: out,
    fetchFn,
    pageSize: PAGE,
    chunkRows: CHUNK,
  });
  const elapsed = Date.now() - start;
  const peakRss = rssMB();

  const stat = fs.statSync(out);
  const manifest = JSON.parse(fs.readFileSync(`${out}.manifest.json`, 'utf8'));

  console.log(JSON.stringify({
    inputRows: entries.length,
    uniqueRows: N,
    dupRatio: DUP_RATIO,
    pagesFetched: result.pagesFetched,
    rowsSeen: result.rowsSeen,
    rowsAccepted: result.rowsAccepted,
    rowsRejected: result.rowsRejected,
    outputBytes: stat.size,
    outputSha256: manifest.outputSha256,
    elapsedMs: elapsed,
    rowsPerSec: Math.round(result.rowsAccepted / (elapsed / 1000)),
    pagePerSec: Math.round((result.pagesFetched * PAGE) / (elapsed / 1000)),
    baselineRssMB: baselineRss,
    peakRssMB: peakRss,
    rssDeltaMB: peakRss - baselineRss,
    pageSize: PAGE,
    chunkRows: CHUNK,
  }, null, 2));
}

main().catch((err) => {
  console.error('bench failed:', err);
  process.exit(1);
});
