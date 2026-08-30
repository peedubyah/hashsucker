#!/usr/bin/env node
/**
 * Live TV Structural Episode Hard Gate — Production Canary
 *
 * Proves that with the Stage-2 eligibility gate extended to live-origin
 * candidates, an actual /api/search request for South Park S27E05:
 *
 * 1. Accepts live candidates whose filename structurally covers S27E05.
 * 2. Rejects live candidates whose filename is S27E03 or S26E05.
 * 3. Rejects live candidates with no S/E structural evidence.
 * 4. Does not regress unrelated series (Stranger Things S04E01).
 * 5. Does not regress movies (Fellowship, Oppenheimer).
 *
 * Run against the same production cache the user-visible app uses.
 */

import assert from 'node:assert/strict';

const PROD_CACHE_PATH = '/home/patrick/hashsucker-data/discovery/discovery-cache.db';
const PROD_BASE = 'http://127.0.0.1:3000';

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    failures++;
    console.log(`  FAIL: ${label}`);
  }
}

async function search(query, extra) {
  const url = `${PROD_BASE}/api/search?${new URLSearchParams({
    type: 'series',
    ...extra,
    q: query,
    limit: '50',
  }).toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function movieSearch(query) {
  const url = `${PROD_BASE}/api/search?${new URLSearchParams({
    type: 'movie',
    q: query,
    limit: '50',
  }).toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

console.log('=== Live TV Hard Gate Canary (production cache) ===\n');

console.log('--- Test 1: South Park S27E05 — live gate accepts correct, rejects wrong ---');
{
  const r = await search('South Park', { mediaId: 'tt0121955:27:5' });
  const results = r.results || [];
  check(`returned ${results.length} results`, results.length > 0);

  let accepted = 0, wrongEp = 0, wrongSeason = 0, unknown = 0;
  const wrongEpFilenames = [];
  const wrongSeasonFilenames = [];
  const unknownFilenames = [];

  for (const c of results) {
    if (c._source !== 'live') continue;
    const fn = c.filename || '';
    const m = fn.match(/S(\d+)E(\d+)/i);
    if (!m) {
      // Unknown coverage — should NOT survive for an explicit S27E05 request.
      unknown++;
      unknownFilenames.push(fn);
      continue;
    }
    const season = parseInt(m[1], 10);
    const episode = parseInt(m[2], 10);
    if (season === 27 && episode === 5) {
      accepted++;
    } else if (season !== 27) {
      wrongSeason++;
      wrongSeasonFilenames.push(fn);
    } else {
      wrongEp++;
      wrongEpFilenames.push(fn);
    }
  }

  check(`accepted S27E05 live candidates present (count=${accepted})`, accepted > 0);
  check(`NO wrong-episode live candidates survive (count=${wrongEp})`, wrongEp === 0);
  if (wrongEpFilenames.length) console.log(`    wrong-episode leak filenames:`, wrongEpFilenames.slice(0, 3));
  check(`NO wrong-season live candidates survive (count=${wrongSeason})`, wrongSeason === 0);
  if (wrongSeasonFilenames.length) console.log(`    wrong-season leak filenames:`, wrongSeasonFilenames.slice(0, 3));
  check(`NO unknown-coverage live candidates survive (count=${unknown})`, unknown === 0);
  if (unknownFilenames.length) console.log(`    unknown-coverage leak filenames:`, unknownFilenames.slice(0, 3));
}

console.log('\n--- Test 2: South Park S27E03 — wrong episode filtered ---');
{
  const r = await search('South Park', { mediaId: 'tt0121955:27:3' });
  const results = r.results || [];
  let accepted = 0;
  let wrongEpSurvivors = [];
  for (const c of results) {
    if (c._source !== 'live') continue;
    const fn = c.filename || '';
    const m = fn.match(/S(\d+)E(\d+)/i);
    if (!m) continue;
    if (parseInt(m[1], 10) === 27 && parseInt(m[2], 10) === 3) {
      accepted++;
    } else if (parseInt(m[1], 10) === 27) {
      wrongEpSurvivors.push(fn);
    }
  }
  check(`S27E03 accepted (count=${accepted})`, accepted > 0);
  check(`NO wrong-episode live candidates for S27E03 request (count=${wrongEpSurvivors.length})`, wrongEpSurvivors.length === 0);
}

console.log('\n--- Test 3: Stranger Things S04E01 — unrelated series unaffected ---');
{
  const r = await search('Stranger Things', { mediaId: 'tt4574334:4:1' });
  const results = r.results || [];
  let accepted = 0;
  let southParkLeak = [];
  for (const c of results) {
    if (c._source !== 'live') continue;
    const fn = c.filename || '';
    if (/stranger.*things/i.test(fn) && /S04E01/i.test(fn)) {
      accepted++;
    }
    if (/south.park/i.test(fn)) {
      southParkLeak.push(fn);
    }
  }
  check(`S04E01 accepted (count=${accepted})`, accepted > 0);
  check(`NO South Park leak into Stranger Things (count=${southParkLeak.length})`, southParkLeak.length === 0);
}

console.log('\n--- Test 4: Movie canary — Fellowship still returns results ---');
{
  const r = await movieSearch('The Lord of the Rings Fellowship');
  const results = r.results || [];
  check(`Fellowship returned ${results.length} results (movie path unchanged)`, results.length > 0);
  const wrongYear = results.filter(c => c.year != null && c.year !== 2001).length;
  if (wrongYear > 0) {
    console.log(`    note: ${wrongYear} wrong-year corpus entries pre-exist (data quality, not TV gate)`);
  }
}

console.log('\n--- Test 5: Movie canary — Oppenheimer still returns results ---');
{
  const r = await movieSearch('Oppenheimer');
  const results = r.results || [];
  check(`Oppenheimer returned ${results.length} results (movie path unchanged)`, results.length > 0);
  const wrongYear = results.filter(c => c.year != null && c.year !== 2023).length;
  if (wrongYear > 0) {
    console.log(`    note: ${wrongYear} wrong-year corpus entries pre-exist (data quality, not TV gate)`);
  }
}

console.log(`\n=== ${failures === 0 ? 'LIVE TV HARD GATE: PASS' : `LIVE TV HARD GATE: FAIL (${failures} failures)`} ===`);
process.exit(failures === 0 ? 0 : 1);