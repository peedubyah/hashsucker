#!/usr/bin/env node
/**
 * Real-Debrid /torrents READ-ONLY census.
 *
 * Fetches the complete /torrents history using the same pagination
 * path as the acquirer (same fetchPage, same retry/backoff, same
 * headers) but produces NO snapshot file and touches NO
 * discovery-cache SQLite for writing.
 *
 * Reuses deriveEventId/normalizeEntry from lib/acquisition/rd-history.js
 * so event identity is in lockstep with the importer.
 *
 * Output report:
 *   - TotalRows / ValidHashRows / InvalidHashRows
 *   - UniqueRdEventIds / UniqueInfoHashes
 *   - DuplicateEventIds / DuplicateInfoHashes / DuplicateRdIds
 *   - OldestAdded / NewestAdded / RowsByYear
 *   - ApproxNormalizedSnapshotBytes
 *   - PagesFetched / Elapsed / RequestsPerSecond
 *   - ExistingCandidateMatches:
 *       UniqueHistoricalHashes / HashesAlreadyInCorpus
 *       HashesNotCurrentlyInCorpus / CoveragePercent
 *
 * Usage:
 *   REALDEBRID_API_KEY=xxx node src/scripts/rd-census.mjs
 *   REALDEBRID_API_KEY=xxx node src/scripts/rd-census.mjs --sample 100
 *       (sample N rows for quick validation before full census)
 *   REALDEBRID_API_KEY=xxx node src/scripts/rd-census.mjs --no-corpus
 *       (skip the read-only candidates join)
 *
 * Environment:
 *   REALDEBRID_API_KEY   Required.
 *   DISCOVERY_DB         Path to HashSucker discovery cache (default:
 *                        ./discovery-cache.db in media-search dir).
 *   SKIP_CORPUS_JOIN=1   Same as --no-corpus.
 */

import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeEntry,
} from '../lib/acquisition/rd-history.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOKEN = process.env.REALDEBRID_API_KEY;
if (!TOKEN) {
  console.error('FATAL: REALDEBRID_API_KEY env var is required');
  process.exit(1);
}

const RD_API_BASE = 'https://api.real-debrid.com/rest/1.0';
const PAGE_SIZE = 5000; // RD maximum

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISCOVERY_DB = process.env.DISCOVERY_DB
  || join(__dirname, '../../discovery-cache.db');

const argv = process.argv.slice(2);
const SAMPLE_MODE = (() => {
  const idx = argv.indexOf('--sample');
  return idx !== -1 ? parseInt(argv[idx + 1], 10) || 100 : 0;
})();
const SKIP_CORPUS =
  argv.includes('--no-corpus') || process.env.SKIP_CORPUS_JOIN === '1';

// CSV-safe logger — no secrets
const log = (...args) => console.error('[rd-census]', ...args);

// ---------------------------------------------------------------------------
// RD API client (mirrors acquirer fetchPage)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllUnpaged() {
  // RD API quirk: /torrents with offset=0 returns HTTP 204 (no
  // content) even when data exists, but the unparameterized GET
  // returns the full list. For accounts with ≤ PAGE_SIZE rows this
  // is one round-trip and 100% reliable. For larger accounts we
  // still have to paginate with offset=1,1+limit,1+2*limit,… and
  // synthesize the index-0 row from the response.
  const url = `${RD_API_BASE}/torrents`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'User-Agent': 'HashSucker/1.0 (media-search acquisition)',
      },
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
      log(`HTTP 429 — backing off ${retryAfter}s`);
      await sleep((retryAfter + 1) * 1000);
      return { entries: null, total: null };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} on ${url}: ${body.slice(0, 200)}`);
    }
    const totalStr = res.headers.get('X-Total-Count');
    const total = totalStr ? parseInt(totalStr, 10) : null;
    const text = await res.text();
    const json = JSON.parse(text);
    if (!Array.isArray(json)) {
      throw new Error(`Expected JSON array, got ${typeof json} on ${url}`);
    }
    return { entries: json, total };
  } catch (err) {
    clearTimeout(tid);
    throw err;
  }
}

async function fetchPage(offset) {
  // RD quirk: /torrents with offset=0 returns HTTP 204 (treated as
  // "no content" even when rows exist). Start at offset=1. offset >
  // total also returns 204 and is the legitimate end-of-data signal.
  const url = `${RD_API_BASE}/torrents?offset=${offset}&limit=${PAGE_SIZE}`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 30_000);
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'User-Agent': 'HashSucker/1.0 (media-search acquisition)',
        },
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
        log(`HTTP 429 — backing off ${retryAfter}s (attempt ${attempt + 1}/4)`);
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      if (res.status === 204) {
        // 204 = no rows at this offset. End of data, not an error.
        return { entries: [], total: null, endOfData: true };
      }
      if (res.status >= 500) {
        log(`HTTP ${res.status} — retrying after 5s (attempt ${attempt + 1}/4)`);
        await sleep(5000);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} on ${url}: ${body.slice(0, 200)}`);
      }
      const totalStr = res.headers.get('X-Total-Count');
      const total = totalStr ? parseInt(totalStr, 10) : null;
      const text = await res.text();
      if (!text || text.trim() === '') {
        // Treat empty 200 as end-of-data
        return { entries: [], total, endOfData: true };
      }
      const json = JSON.parse(text);
      if (!Array.isArray(json)) {
        throw new Error(`Expected JSON array, got ${typeof json} on ${url}`);
      }
      return { entries: json, total, endOfData: false };
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') {
        log(`Timeout on offset ${offset} — retrying`);
      } else {
        log(`Error on offset ${offset}: ${err.message} — retrying`);
      }
      await sleep(Math.min(30_000, (attempt + 1) * 2000));
    }
  }
  throw new Error(`Failed after 4 attempts on offset ${offset}: ${lastErr?.message}`);
}

// ---------------------------------------------------------------------------
// Main census
// ---------------------------------------------------------------------------

async function runCensus() {
  log(`Starting RD census${SAMPLE_MODE ? ` (SAMPLE mode, max ${SAMPLE_MODE} rows)` : ''}`);
  log(`Discovery DB: ${DISCOVERY_DB}`);
  log(`Corpus join:  ${SKIP_CORPUS ? 'SKIPPED' : 'ENABLED'}`);

  const t0 = Date.now();
  let pagesFetched = 0;
  let totalKnown = null;

  // Counters
  let totalRows = 0;
  let validHashRows = 0;
  let invalidHashRows = 0;

  // Unique tracking
  const seenRdIds = new Set();
  const seenEventIds = new Set();
  const seenInfoHashes = new Set();
  const dupRdIds = new Set();
  const dupEventIds = new Set();
  const dupInfoHashes = new Set();

  let oldestAdded = null;
  let newestAdded = null;
  const rowsByYear = {};

  let requestsMade = 0;

  // For candidate join
  const historicalHashSet = new Set();

  // Try the unpaged single-call path first. RD's /torrents with
  // offset=0 returns HTTP 204 (a real API bug); the unparameterized
  // GET returns the full list. If total ≤ PAGE_SIZE, we're done
  // after this one call. If we get null/empty here, fall through to
  // paginated fetch (which avoids offset=0 by starting at 1).
  log('Probing /torrents via unparameterized GET (avoids offset=0 204 bug)');
  let unpaged = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    unpaged = await fetchAllUnpaged();
    if (unpaged.entries !== null) break;
    await sleep(2000);
  }

  // Pagination
  // RD quirk: /torrents with offset=0 returns HTTP 204 (empty body)
  // even when data exists. Start at offset=1 to get the first page.
  let offset = 1;
  let done = false;
  let earlyStop = false;
  let usePaginated = false;

  // If the unpaged GET succeeded AND total is known small, ingest
  // its result directly. Otherwise we have to paginate.
  if (unpaged?.entries && unpaged.total !== null) {
    totalKnown = unpaged.total;
    log(`X-Total-Count: ${unpaged.total}`);
    if (unpaged.total <= PAGE_SIZE) {
      log(`Total ≤ PAGE_SIZE — single-call mode, ingesting ${unpaged.entries.length} rows`);
      pagesFetched = 1;
      requestsMade = 1;
      // Ingest the unpaged result directly
      for (const entry of unpaged.entries) {
        totalRows++;
        if (SAMPLE_MODE && totalRows > SAMPLE_MODE) { earlyStop = true; break; }
        const normalized = normalizeEntry(entry);
        if (normalized === null) {
          invalidHashRows++;
          if (entry.id !== undefined && entry.id !== null) {
            if (seenRdIds.has(entry.id)) dupRdIds.add(entry.id);
            else seenRdIds.add(entry.id);
          }
          continue;
        }
        validHashRows++;
        const { infoHash, observedAtMs, sourceEventId } = normalized;
        historicalHashSet.add(infoHash.toLowerCase());
        if (entry.id !== undefined && entry.id !== null) {
          if (seenRdIds.has(entry.id)) dupRdIds.add(entry.id);
          else seenRdIds.add(entry.id);
        }
        if (seenEventIds.has(sourceEventId)) dupEventIds.add(sourceEventId);
        else seenEventIds.add(sourceEventId);
        if (seenInfoHashes.has(infoHash.toLowerCase())) dupInfoHashes.add(infoHash.toLowerCase());
        else seenInfoHashes.add(infoHash.toLowerCase());
        if (oldestAdded === null || observedAtMs < oldestAdded) oldestAdded = observedAtMs;
        if (newestAdded === null || observedAtMs > newestAdded) newestAdded = observedAtMs;
        const year = new Date(observedAtMs).getUTCFullYear();
        rowsByYear[year] = (rowsByYear[year] || 0) + 1;
      }
      done = true;
    } else {
      log(`Total ${unpaged.total} > PAGE_SIZE — falling through to paginated walk`);
      usePaginated = true;
    }
  } else {
    log('Unparameterized GET unavailable — falling through to paginated walk');
    usePaginated = true;
  }

  while (usePaginated && !done) {
    const { entries, total, endOfData } = await fetchPage(offset);
    requestsMade++;
    pagesFetched++;

    if (total !== null && totalKnown === null) {
      totalKnown = total;
      log(`X-Total-Count: ${total}`);
    }

    if (endOfData) {
      log(`End of data at offset ${offset} (204/empty 200)`);
      done = true;
      break;
    }

    for (const entry of entries) {
      totalRows++;

      if (SAMPLE_MODE && totalRows > SAMPLE_MODE) {
        earlyStop = true;
        break;
      }

      // Reuse the acquirer's normalizeEntry (same event identity)
      const normalized = normalizeEntry(entry);
      if (normalized === null) {
        invalidHashRows++;
        // Still count rd id if present
        if (entry.id !== undefined && entry.id !== null) {
          if (seenRdIds.has(entry.id)) dupRdIds.add(entry.id);
          else seenRdIds.add(entry.id);
        }
        continue;
      }

      validHashRows++;
      const { infoHash, observedAtMs, sourceEventId } = normalized;
      historicalHashSet.add(infoHash.toLowerCase());

      // RD id dedup
      if (entry.id !== undefined && entry.id !== null) {
        if (seenRdIds.has(entry.id)) dupRdIds.add(entry.id);
        else seenRdIds.add(entry.id);
      }

      // Event identity dedup
      if (seenEventIds.has(sourceEventId)) dupEventIds.add(sourceEventId);
      else seenEventIds.add(sourceEventId);

      if (seenInfoHashes.has(infoHash.toLowerCase())) dupInfoHashes.add(infoHash.toLowerCase());
      else seenInfoHashes.add(infoHash.toLowerCase());

      // Timestamp
      if (oldestAdded === null || observedAtMs < oldestAdded) oldestAdded = observedAtMs;
      if (newestAdded === null || observedAtMs > newestAdded) newestAdded = observedAtMs;
      const year = new Date(observedAtMs).getUTCFullYear();
      rowsByYear[year] = (rowsByYear[year] || 0) + 1;

      // Heartbeat every 10 pages
      if (pagesFetched % 10 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        log(
          `  pages=${pagesFetched} rows=${totalRows}`
          + (totalKnown ? `/${totalKnown}` : '')
          + ` elapsed=${elapsed}s`
        );
      }
    }

    if (earlyStop) { done = true; break; }
    if (entries.length < PAGE_SIZE) { done = true; break; }
    if (totalKnown !== null && offset + entries.length >= totalKnown) { done = true; break; }

    offset += PAGE_SIZE;
  }

  const elapsedMs = Date.now() - t0;
  const rps = (requestsMade / (elapsedMs / 1000)).toFixed(3);

  // -------------------------------------------------------------------------
  // Normalized snapshot byte estimate
  // -------------------------------------------------------------------------
  // Each output line: {"infoHash":"...","observedAt":1xxx,"sourceEventId":"..."}
  // ≈ 110 bytes/row
  const approxSnapshotBytes = validHashRows * 110;

  // -------------------------------------------------------------------------
  // Read-only candidate join (via sqlite3 CLI)
  // -------------------------------------------------------------------------
  let corpusStats = null;
  if (!SKIP_CORPUS) {
    try {
      statSync(DISCOVERY_DB);
    } catch (err) {
      log(`Discovery DB not found at ${DISCOVERY_DB} — skipping corpus join`);
      corpusStats = { skipped: 'db-not-found' };
    }

    if (corpusStats === null) {
      try {
        const corpusCountQ = `SELECT COUNT(DISTINCT info_hash) FROM candidates WHERE info_hash IS NOT NULL AND length(info_hash)=40;`;
        const out = execSync(
          `sqlite3 "${DISCOVERY_DB}" "${corpusCountQ}"`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        const corpusCount = parseInt(out, 10) || 0;

        const histCount = historicalHashSet.size;
        const hashList = [...historicalHashSet];
        let alreadyInCorpus = 0;
        const CHUNK = 999;
        for (let i = 0; i < hashList.length; i += CHUNK) {
          const chunk = hashList.slice(i, i + CHUNK).map(h => `'${h}'`).join(',');
          const q = `SELECT COUNT(DISTINCT info_hash) FROM candidates WHERE info_hash IN (${chunk}) AND length(info_hash)=40;`;
          const r = execSync(
            `sqlite3 "${DISCOVERY_DB}" "${q}"`,
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
          ).trim();
          alreadyInCorpus += parseInt(r, 10) || 0;
        }

        const notInCorpus = histCount - alreadyInCorpus;
        const coverage = histCount > 0 ? parseFloat(((alreadyInCorpus / histCount) * 100).toFixed(2)) : 0.0;

        corpusStats = {
          TotalCandidatesInCorpus: corpusCount,
          UniqueHistoricalHashes: histCount,
          HashesAlreadyInCorpus: alreadyInCorpus,
          HashesNotCurrentlyInCorpus: notInCorpus,
          CoveragePercent: coverage,
        };
      } catch (err) {
        log(`Candidate join failed: ${err.message}`);
        corpusStats = { error: err.message };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  const fmt = (n) => (n ?? 0).toLocaleString();
  const fmtTs = (ms) => (ms ? new Date(ms).toISOString() : 'N/A');
  const fmtBytes = (n) => {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  };

  const yearKeys = Object.keys(rowsByYear).sort();
  const yearsSummary = yearKeys.map(y => `${y}:${rowsByYear[y]}`).join(', ');

  console.log('\n========================================');
  console.log('  REAL-DEBRID /torrents CENSUS REPORT');
  console.log('========================================\n');
  console.log(`--- Pagination ---`);
  console.log(`  X-Total-Count:           ${fmt(totalKnown)}`);
  console.log(`  PagesFetched:            ${fmt(pagesFetched)}`);
  console.log(`  RowsSampled:             ${fmt(totalRows)}`);
  console.log(`  RequestsPerSecond:       ${rps}`);
  console.log(`  Elapsed:                 ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log(`\n--- Row Validity ---`);
  console.log(`  TotalRows:               ${fmt(totalRows)}`);
  console.log(`  ValidHashRows:           ${fmt(validHashRows)}`);
  console.log(`  InvalidHashRows:         ${fmt(invalidHashRows)}`);
  console.log(`  InvalidHashPct:          ${totalRows > 0 ? ((invalidHashRows / totalRows) * 100).toFixed(2) : 'N/A'}%`);
  console.log(`\n--- Event Identity (dedup) ---`);
  console.log(`  UniqueRdEventIds:        ${fmt(seenEventIds.size)}`);
  console.log(`  UniqueInfoHashes:        ${fmt(seenInfoHashes.size)}`);
  console.log(`  DuplicateEventIds:       ${fmt(dupEventIds.size)}`);
  console.log(`  DuplicateInfoHashes:     ${fmt(dupInfoHashes.size)}`);
  console.log(`  DuplicateRdIds:          ${fmt(dupRdIds.size)}`);
  console.log(`\n--- Time Range ---`);
  console.log(`  OldestAdded:             ${fmtTs(oldestAdded)}`);
  console.log(`  NewestAdded:             ${fmtTs(newestAdded)}`);
  console.log(`  RowsByYear:              ${yearsSummary}`);
  console.log(`\n--- Snapshot Size Estimate ---`);
  console.log(`  ApproxNormalizedSnapshotBytes: ${fmtBytes(approxSnapshotBytes)}`);
  console.log(`  (110 bytes/row × ${fmt(validHashRows)} valid rows)`);

  if (corpusStats) {
    console.log(`\n--- ExistingCandidateMatches (read-only join) ---`);
    if (corpusStats.skipped) {
      console.log(`  SKIPPED: ${corpusStats.skipped}`);
    } else if (corpusStats.error) {
      console.log(`  ERROR: ${corpusStats.error}`);
    } else {
      console.log(`  TotalCandidatesInCorpus:    ${fmt(corpusStats.TotalCandidatesInCorpus)}`);
      console.log(`  UniqueHistoricalHashes:     ${fmt(corpusStats.UniqueHistoricalHashes)}`);
      console.log(`  HashesAlreadyInCorpus:      ${fmt(corpusStats.HashesAlreadyInCorpus)}`);
      console.log(`  HashesNotCurrentlyInCorpus: ${fmt(corpusStats.HashesNotCurrentlyInCorpus)}`);
      console.log(`  CoveragePercent:            ${corpusStats.CoveragePercent}%`);
    }
  }

  // Projections if partial (census was truncated)
  if (totalKnown !== null && totalRows < totalKnown && !SAMPLE_MODE) {
    const projectedRows = totalKnown;
    const projectedValid = Math.round(validHashRows * (totalKnown / totalRows));
    const projectedBytes = projectedValid * 110;
    const secsPerPage = elapsedMs / pagesFetched / 1000;
    const projectedPages = Math.ceil(totalKnown / PAGE_SIZE);
    const projectedTime = (projectedPages * secsPerPage / 1000).toFixed(1);
    console.log(`\n--- Projections (full run from current page rate) ---`);
    console.log(`  ProjectedTotalRows:        ${fmt(projectedRows)}`);
    console.log(`  ProjectedValidHashRows:    ${fmt(projectedValid)}`);
    console.log(`  ProjectedSnapshotBytes:    ${fmtBytes(projectedBytes)}`);
    console.log(`  ProjectedPages:            ${fmt(projectedPages)}`);
    console.log(`  ProjectedAcquisitionTime:  ~${projectedTime}s`);
  }

  console.log('\n========================================\n');

  process.exit(0);
}

runCensus().catch((err) => {
  log(`FATAL: ${err.message}`);
  if (err.stack) log(err.stack);
  process.exit(1);
});
