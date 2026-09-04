#!/usr/bin/env node
/**
 * Real-Debrid /downloads READ-ONLY census.
 *
 * Fetches the complete /downloads history using the same pagination
 * approach as rd-census.mjs: unparameterized GET first (handles
 * accounts ≤ 100 rows), then paginated from offset=1 to avoid the
 * RD offset=0 204 bug.
 *
 * Reports:
 *   - X-Total-Count, total rows, unique download IDs
 *   - Field presence: filename, filesize, generated
 *   - Generated timestamp range, rows by year
 *   - Total historical bytes
 *   - Duplicate (filename, filesize) pairs
 *   - Duplicate normalized filenames
 *   - Host distribution
 *   - Schema field inventory (from a sample row)
 *   - /torrents vs /downloads totals (for historical dataset identification)
 *
 * Usage:
 *   REALDEBRID_API_KEY=xxx node src/scripts/rd-downloads-census.mjs
 *   REALDEBRID_API_KEY=xxx node src/scripts/rd-downloads-census.mjs --no-torrents
 *
 * Environment:
 *   REALDEBRID_API_KEY   Required.
 */

import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = process.env.REALDEBRID_API_KEY;
if (!TOKEN) {
  console.error('FATAL: REALDEBRID_API_KEY env var is required');
  process.exit(1);
}

const RD_API_BASE = 'https://api.real-debrid.com/rest/1.0';
const PAGE_SIZE = 5000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const SKIP_TORRENTS = argv.includes('--no-torrents');
const log = (...args) => console.error('[rd-downloads-census]', ...args);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchUnparameterized() {
  const url = `${RD_API_BASE}/downloads`;
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
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const totalStr = res.headers.get('X-Total-Count');
    const total = totalStr ? parseInt(totalStr, 10) : null;
    const json = await res.json();
    if (!Array.isArray(json)) {
      throw new Error(`Expected JSON array, got ${typeof json}`);
    }
    return { entries: json, total };
  } catch (err) {
    clearTimeout(tid);
    throw err;
  }
}

async function fetchPageOffset(offset) {
  const url = `${RD_API_BASE}/downloads?offset=${offset}&limit=${PAGE_SIZE}`;
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
      return { entries: null, total: null, endOfData: false };
    }
    if (res.status === 204) {
      return { entries: [], total: null, endOfData: true };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const totalStr = res.headers.get('X-Total-Count');
    const total = totalStr ? parseInt(totalStr, 10) : null;
    const text = await res.text();
    if (!text || text.trim() === '') {
      return { entries: [], total, endOfData: true };
    }
    const json = JSON.parse(text);
    if (!Array.isArray(json)) {
      throw new Error(`Expected JSON array, got ${typeof json}`);
    }
    return { entries: json, total, endOfData: false };
  } catch (err) {
    clearTimeout(tid);
    throw err;
  }
}

async function fetchAllDownloads() {
  log('Probing /downloads via unparameterized GET');
  let unpaged = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    unpaged = await fetchUnparameterized();
    if (unpaged.entries !== null) break;
    await sleep(2000);
  }

  // Always paginate from offset=1 to capture the full range. The
  // unparameterized GET is capped at 100 rows by RD. RD's
  // pagination is 1-based, so offset=1 returns the FIRST page
  // (1..PAGE_SIZE), offset=2 the second, etc. We need to know
  // totalKnown before knowing how many pages to fetch.
  if (unpaged?.total === null && (!unpaged?.entries || unpaged.entries.length === 0)) {
    throw new Error('Unable to determine /downloads total');
  }
  const totalKnown = unpaged?.total || null;
  log(`X-Total-Count: ${totalKnown}`);

  if (totalKnown !== null && totalKnown <= 100 && unpaged?.entries?.length === totalKnown) {
    log(`Full dataset fits in unpaged GET (${totalKnown} rows)`);
    return { entries: unpaged.entries, total: totalKnown };
  }

  // Paginate starting at offset=1 (RD offset is 1-based and
  // offset=0 returns 204). Use a Set keyed on download id to
  // dedup any rows that overlap between unpaged and paginated
  // responses.
  const seen = new Map(); // id -> row
  if (unpaged?.entries) {
    for (const r of unpaged.entries) {
      if (r.id) seen.set(r.id, r);
    }
  }
  log(`After unpaged ingest: ${seen.size} unique ids`);

  let offset = 1;
  let done = false;
  let pagesFetched = 0;
  while (!done) {
    const { entries, total, endOfData } = await fetchPageOffset(offset);
    pagesFetched++;
    if (total !== null && totalKnown === null) {
      // shouldn't happen since we already have total from unpaged
    }
    if (endOfData) { log(`End at offset ${offset}`); done = true; break; }
    if (!entries) { log(`No entries, stopping`); done = true; break; }
    for (const r of entries) {
      if (r.id && !seen.has(r.id)) seen.set(r.id, r);
    }
    log(`  page offset=${offset} returned ${entries.length} rows (unique total ${seen.size}/${totalKnown || '?'})`);
    if (entries.length < PAGE_SIZE) { done = true; break; }
    if (totalKnown !== null && offset + entries.length >= totalKnown) { done = true; break; }
    offset += PAGE_SIZE;
  }
  return { entries: [...seen.values()], total: totalKnown };
}

// ---------------------------------------------------------------------------
// Identity bridge inspection
// ---------------------------------------------------------------------------

/**
 * For a sample of rows, check whether any field deterministically
 * bridges to /torrents. Candidate bridges:
 *   - /downloads[id]  → /torrents/info/{id} (RD docs say "id" is the
 *     download id, not a torrent id; need to verify whether
 *     /torrents/info/{downloadId} returns 404)
 *   - filename pattern matching against /torrents rows
 *   - host + link patterns
 */
async function checkTorrentsInfoBridge(downloadIds) {
  const results = [];
  for (const id of downloadIds.slice(0, 3)) {
    const url = `${RD_API_BASE}/torrents/info/${id}`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15_000);
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'User-Agent': 'HashSucker/1.0 (media-search acquisition)',
        },
        signal: controller.signal,
      });
    } catch (err) {
      results.push({ downloadId: id, status: 'fetch-error', body: err.message.slice(0, 80) });
      clearTimeout(tid);
      continue;
    }
    clearTimeout(tid);
    const body = await res.text().catch(() => '');
    results.push({
      downloadId: id,
      httpStatus: res.status,
      contentType: res.headers.get('content-type') || '',
      bodyPreview: body.slice(0, 200),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runCensus() {
  log('Starting /downloads census');
  const t0 = Date.now();
  const { entries, total: totalKnown } = await fetchAllDownloads();
  log(`Final /downloads row count: ${entries.length} (server reports ${totalKnown})`);

  // Field presence
  let filenamePresent = 0;
  let filesizePresent = 0;
  let generatedPresent = 0;
  let totalBytes = 0;
  let totalBytesMissing = 0;
  const hostCounts = {};
  const yearCounts = {};
  const seenIds = new Set();
  const dupIds = new Set();
  const filenameCounts = {};     // normalized
  const pairCounts = {};         // (filename, filesize)
  let oldest = null;
  let newest = null;

  for (const row of entries) {
    if (row.id) {
      if (seenIds.has(row.id)) dupIds.add(row.id);
      else seenIds.add(row.id);
    }
    if (row.filename) {
      filenamePresent++;
      const norm = row.filename.toLowerCase().replace(/\.\w{2,4}$/, '');
      filenameCounts[norm] = (filenameCounts[norm] || 0) + 1;
      if (row.filesize !== undefined && row.filesize !== null) {
        const key = `${norm}|${row.filesize}`;
        pairCounts[key] = (pairCounts[key] || 0) + 1;
      }
    }
    if (row.filesize !== undefined && row.filesize !== null) {
      filesizePresent++;
      totalBytes += row.filesize;
    } else {
      totalBytesMissing++;
    }
    if (row.generated) {
      generatedPresent++;
      const ms = Date.parse(row.generated);
      if (!isNaN(ms)) {
        if (oldest === null || ms < oldest) oldest = ms;
        if (newest === null || ms > newest) newest = ms;
        const year = new Date(ms).getUTCFullYear();
        yearCounts[year] = (yearCounts[year] || 0) + 1;
      }
    }
    if (row.host) {
      hostCounts[row.host] = (hostCounts[row.host] || 0) + 1;
    }
  }

  // Duplicates
  const dupFilenames = Object.entries(filenameCounts).filter(([, c]) => c > 1);
  const dupPairs = Object.entries(pairCounts).filter(([, c]) => c > 1);

  // Sample row schema
  const sampleRow = entries[0] || {};
  const sampleKeys = Object.keys(sampleRow).sort();
  const sampleShape = {};
  for (const k of sampleKeys) {
    const v = sampleRow[k];
    sampleShape[k] = {
      type: Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v),
      isHashLike: typeof v === 'string' && /^[a-f0-9]{32,64}$/i.test(v),
      isUrl: typeof v === 'string' && /^https?:\/\//.test(v),
    };
  }

  // Bridge check: /torrents/info/{downloadId}?
  const bridgeResults = await checkTorrentsInfoBridge([...seenIds].slice(0, 3));
  log('Bridge check: tested first 3 /downloads ids against /torrents/info/{id}');

  // /torrents total
  let torrentsTotal = null;
  if (!SKIP_TORRENTS) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${RD_API_BASE}/torrents`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'User-Agent': 'HashSucker/1.0 (media-search acquisition)',
        },
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (res.ok) {
        torrentsTotal = parseInt(res.headers.get('X-Total-Count') || '0', 10);
      } else {
        log(`/torrents probe HTTP ${res.status}`);
      }
    } catch (err) {
      clearTimeout(tid);
      log(`/torrents probe failed: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  const fmt = (n) => (n ?? 0).toLocaleString();
  const fmtBytes = (n) => {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    if (n < 1024n * 1024n * 1024n * 1024n) return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
    return `${(n / 1024 / 1024 / 1024 / 1024).toFixed(2)}TB`;
  };
  const fmtTs = (ms) => (ms ? new Date(ms).toISOString() : 'N/A');
  const pct = (n, d) => d > 0 ? ((n / d) * 100).toFixed(2) + '%' : 'N/A';

  console.log('\n========================================');
  console.log('  REAL-DEBRID /downloads CENSUS REPORT');
  console.log('========================================\n');
  console.log(`--- Pagination ---`);
  console.log(`  X-Total-Count (server):    ${fmt(totalKnown)}`);
  console.log(`  TotalRowsFetched:          ${fmt(entries.length)}`);
  console.log(`  Elapsed:                   ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  console.log(`\n--- Identity ---`);
  console.log(`  UniqueDownloadIds:         ${fmt(seenIds.size)}`);
  console.log(`  DuplicateDownloadIds:      ${fmt(dupIds.size)}`);
  console.log(`\n--- Field Presence ---`);
  console.log(`  filename present:          ${fmt(filenamePresent)} / ${fmt(entries.length)} (${pct(filenamePresent, entries.length)})`);
  console.log(`  filesize present:          ${fmt(filesizePresent)} / ${fmt(entries.length)} (${pct(filesizePresent, entries.length)})`);
  console.log(`  generated present:         ${fmt(generatedPresent)} / ${fmt(entries.length)} (${pct(generatedPresent, entries.length)})`);
  console.log(`\n--- Time Range ---`);
  console.log(`  OldestGenerated:           ${fmtTs(oldest)}`);
  console.log(`  NewestGenerated:           ${fmtTs(newest)}`);
  const yearKeys = Object.keys(yearCounts).sort();
  console.log(`  RowsByYear:                ${yearKeys.map(y => `${y}:${yearCounts[y]}`).join(', ')}`);
  console.log(`\n--- Bytes ---`);
  console.log(`  TotalHistoricalBytes:      ${fmtBytes(totalBytes)}`);
  console.log(`  FilesizeMissingRows:       ${fmt(totalBytesMissing)}`);
  console.log(`\n--- Duplicates ---`);
  console.log(`  DuplicateFilenameGroups:   ${fmt(dupFilenames.length)} (rows in dups: ${fmt(dupFilenames.reduce((s, [, c]) => s + c, 0))})`);
  console.log(`  Duplicate(Filename,Sz)Groups: ${fmt(dupPairs.length)} (rows in dups: ${fmt(dupPairs.reduce((s, [, c]) => s + c, 0))})`);
  if (dupPairs.length > 0) {
    console.log(`    Top 5 (filename|filesize → count):`);
    dupPairs
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([k, c]) => {
        const [fn, sz] = k.split('|');
        console.log(`      [${c}x] ${fn} | ${fmtBytes(parseInt(sz, 10))}`);
      });
  }
  console.log(`\n--- Host Distribution ---`);
  const hostSorted = Object.entries(hostCounts).sort((a, b) => b[1] - a[1]);
  for (const [h, c] of hostSorted) {
    console.log(`  ${h.padEnd(40)} ${fmt(c)}`);
  }
  console.log(`\n--- Schema (sample row 0) ---`);
  console.log(`  Keys (${sampleKeys.length}): ${sampleKeys.join(', ')}`);
  for (const [k, info] of Object.entries(sampleShape)) {
    const flags = [];
    if (info.isHashLike) flags.push('HASH-LIKE');
    if (info.isUrl) flags.push('URL');
    console.log(`    ${k.padEnd(15)} ${info.type.padEnd(8)} ${flags.join(' ')}`);
  }
  console.log(`\n--- Identity Bridge Tests ---`);
  console.log(`  Tested: GET /torrents/info/{downloadId} for first 3 /downloads ids`);
  for (const r of bridgeResults) {
    console.log(`    id=${r.downloadId} → HTTP ${r.httpStatus}  body=${r.bodyPreview.slice(0, 80).replace(/\n/g, ' ')}`);
  }
  console.log(`\n--- Comparison: /torrents vs /downloads ---`);
  console.log(`  /torrents X-Total-Count:    ${fmt(torrentsTotal)}`);
  console.log(`  /downloads X-Total-Count:   ${fmt(totalKnown)}`);
  console.log(`  Ratio (downloads/torrents): ${torrentsTotal > 0 ? (totalKnown / torrentsTotal).toFixed(2) : 'N/A'}x`);
  console.log(`\n--- Verdict ---`);
  if (torrentsTotal !== null && totalKnown > torrentsTotal * 2) {
    console.log(`  /downloads is ${totalKnown / Math.max(torrentsTotal, 1)}x larger than /torrents.`);
    console.log(`  /downloads is the historical dataset.`);
  } else if (torrentsTotal !== null && totalKnown <= torrentsTotal * 2) {
    console.log(`  /downloads and /torrents are similar in size.`);
    console.log(`  Either could be the historical dataset; review semantics.`);
  } else {
    console.log(`  /torrents count unavailable — compare against semantic criteria.`);
  }
  console.log(`\n========================================\n`);
}

runCensus().catch((err) => {
  console.error('FATAL:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
