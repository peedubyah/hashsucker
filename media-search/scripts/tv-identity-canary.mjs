#!/usr/bin/env node
/**
 * TV Identity Hard Gate Canary — production path
 *
 * Drives the real production code path (combinedSearch) directly with the
 * real on-disk cache and asserts the hard eligibility gate:
 *
 *   1. Correct episode present
 *   2. Wrong episode rejected
 *   3. Wrong season rejected
 *   4. Unrelated series rejected
 *   5. Season pack / episode-range file mapping honored
 *      (a release whose parsed episode range covers the requested episode
 *       is accepted; one whose range does not cover is rejected)
 *
 * Title: South Park (tt0121955). Season 27 has the densest per-episode
 * candidate diversity in the production corpus.
 *
 * Mode: corpus-only (no live discovery) so we can deterministically assert
 * the eligibility gate. The live provider tier has its own S/E
 * representation gap (separate problem, see report).
 */

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { combinedSearch } from '../src/lib/discovery/search-engine.js';
import { coversEpisode } from '../src/lib/discovery/episode-coverage.js';

const CACHE_PATH = '/home/patrick/hashsucker-data/discovery/discovery-cache.db';
const cache = createDiscoveryCache({ dbPath: CACHE_PATH });

let pass = true;
function assert(cond, msg) {
  if (cond) {
    console.log(`    PASS: ${msg}`);
  } else {
    console.log(`    FAIL: ${msg}`);
    pass = false;
  }
}

function summarize(label, results) {
  const byEp = {};
  for (const r of results) {
    const s = r.releaseAttributes?.season ?? 'null';
    const e = r.releaseAttributes?.episode ?? 'null';
    const er = r.releaseAttributes?.episodeRange ? `[${r.releaseAttributes.episodeRange}]` : '';
    const key = `S${s}E${e}${er}`;
    byEp[key] = (byEp[key] || 0) + 1;
  }
  console.log(`  [${label}] total=${results.length} breakdown=${JSON.stringify(byEp)}`);
  return { byEp, results };
}

function rangeCovers(rangeStr, episode) {
  const m = String(rangeStr).match(/^(\d+)-(\d+)$/);
  if (!m) return false;
  const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
  if (isNaN(a) || isNaN(b) || a > b) return false;
  return episode >= a && episode <= b;
}

async function searchCorpus(mediaId, season, episode, mediaTitle, q) {
  return combinedSearch(cache, {
    query: q,
    season,
    episode,
    mediaId,
    mediaTitle,
    limit: 200,
    includeProviders: false,
    includeLive: false,           // corpus-only for deterministic gate assertion
    includeMedia: true,
    mode: 'raw',
  });
}

async function main() {
  // ── Test 1: CORRECT EPISODE (S27E5) ─────────────────────────────────────
  console.log(`\n=== Test 1: CORRECT EPISODE — South Park S27E5 ===`);
  const correct = await searchCorpus('tt0121955:27:5', 27, 5, 'South Park', 'South Park');
  summarize('correct', correct.results);
  const correctE5 = correct.results.filter((r) => r.releaseAttributes?.season === 27 && r.releaseAttributes?.episode === 5);
  const wrongEp = correct.results.filter((r) => r.releaseAttributes?.season === 27 && r.releaseAttributes?.episode != null && r.releaseAttributes?.episode !== 5);
  const wrongSeason = correct.results.filter((r) => r.releaseAttributes?.season != null && r.releaseAttributes?.season !== 27);
  const inRange = correct.results.filter((r) => r.releaseAttributes?.season === 27 && r.releaseAttributes?.episode == null && r.releaseAttributes?.episodeRange && rangeCovers(r.releaseAttributes.episodeRange, 5));
  const outOfRange = correct.results.filter((r) => r.releaseAttributes?.season === 27 && r.releaseAttributes?.episode == null && r.releaseAttributes?.episodeRange && !rangeCovers(r.releaseAttributes.episodeRange, 5));
  const unknown = correct.results.filter((r) => r.releaseAttributes?.season === 27 && r.releaseAttributes?.episode == null && !r.releaseAttributes?.episodeRange);
  assert(correctE5.length > 0, `Correct-episode candidates present: ${correctE5.length}`);
  assert(wrongEp.length === 0, `No wrong-episode candidates in S27: ${wrongEp.length}`);
  assert(wrongSeason.length === 0, `No wrong-season candidates: ${wrongSeason.length}`);
  assert(outOfRange.length === 0, `No out-of-range candidates: ${outOfRange.length}`);
  assert(unknown.length === 0, `No unknown-coverage candidates: ${unknown.length}`);
  console.log(`    info: in-range=${inRange.length} (e.g. S27E1-5 accepted when E5 requested)`);

  // ── Test 2: WRONG EPISODE REQUEST (S27E3) ──────────────────────────────
  console.log(`\n=== Test 2: WRONG EPISODE REQUEST — South Park S27E3 ===`);
  const wrongEpReq = await searchCorpus('tt0121955:27:3', 27, 3, 'South Park', 'South Park');
  summarize('wrong-episode-request', wrongEpReq.results);
  const hasE3 = wrongEpReq.results.some((r) => r.releaseAttributes?.season === 27 && r.releaseAttributes?.episode === 3);
  const hasE5Leak = wrongEpReq.results.some((r) => r.releaseAttributes?.season === 27 && r.releaseAttributes?.episode === 5);
  assert(hasE3, `S27E3 candidates present`);
  assert(!hasE5Leak, `S27E5 (other episode) does NOT leak into S27E3`);

  // ── Test 3: WRONG SEASON REQUEST (S01E1) ──────────────────────────────
  console.log(`\n=== Test 3: WRONG SEASON REQUEST — South Park S01E1 ===`);
  const wrongSeasonReq = await searchCorpus('tt0121955:1:1', 1, 1, 'South Park', 'South Park');
  summarize('wrong-season-request', wrongSeasonReq.results);
  const hasS01E01 = wrongSeasonReq.results.some((r) => r.releaseAttributes?.season === 1 && r.releaseAttributes?.episode === 1);
  const s27Leak = wrongSeasonReq.results.filter((r) => r.releaseAttributes?.season === 27);
  assert(hasS01E01, `S01E01 candidates present`);
  assert(s27Leak.length === 0, `S27 candidates do NOT leak into S01E01 (leak: ${s27Leak.length})`);

  // ── Test 4: UNRELATED SERIES REQUEST (Stranger Things S04E01) ─────────
  console.log(`\n=== Test 4: UNRELATED SERIES — Stranger Things S04E01 ===`);
  const unrelated = await searchCorpus('tt4574334:4:1', 4, 1, 'Stranger Things', 'Stranger Things');
  summarize('unrelated', unrelated.results);
  const spLeak = unrelated.results.filter((r) => /south park/i.test(r.filename || '') || /south park/i.test(r.releaseAttributes?.title || ''));
  assert(spLeak.length === 0, `South Park does NOT leak into Stranger Things results (leak: ${spLeak.length})`);

  // ── Test 5: EPISODE-RANGE / SEASON-PACK gate semantics (unit) ─────────
  console.log(`\n=== Test 5: coversEpisode() per-row semantics ===`);
  const cases = [
    { name: 'S27E1-5 range, request E5', attrs: { season: 27, episode: null, episodeRange: '1-5' }, requestedS: 27, requestedE: 5, expect: 'in-range' },
    { name: 'S27E2-4 range, request E5', attrs: { season: 27, episode: null, episodeRange: '2-4' }, requestedS: 27, requestedE: 5, expect: 'out-of-range' },
    { name: 'S27E1-5 range, request E1', attrs: { season: 27, episode: null, episodeRange: '1-5' }, requestedS: 27, requestedE: 1, expect: 'in-range' },
    { name: 'S27E01 exact', attrs: { season: 27, episode: 1, episodeRange: null }, requestedS: 27, requestedE: 1, expect: 'exact-episode' },
    { name: 'S27E05 exact', attrs: { season: 27, episode: 5, episodeRange: null }, requestedS: 27, requestedE: 5, expect: 'exact-episode' },
    { name: 'S27E03 wrong-ep', attrs: { season: 27, episode: 3, episodeRange: null }, requestedS: 27, requestedE: 5, expect: 'wrong-episode' },
    { name: 'S01E01 wrong-season', attrs: { season: 1, episode: 1, episodeRange: null }, requestedS: 27, requestedE: 5, expect: 'wrong-season' },
    { name: 'S27 no ep data', attrs: { season: 27, episode: null, episodeRange: null }, requestedS: 27, requestedE: 5, expect: 'unknown-episode-coverage' },
    { name: 'S27 seasonOnly=true', attrs: { season: 27, episode: null, episodeRange: null, seasonOnly: true }, requestedS: 27, requestedE: 5, expect: 'season-pack' },
    { name: 'S27 mediaType=season', attrs: { season: 27, episode: null, episodeRange: null, mediaType: 'season' }, requestedS: 27, requestedE: 5, expect: 'season-pack' },
    { name: 'malformed range "5-3"', attrs: { season: 27, episode: null, episodeRange: '5-3' }, requestedS: 27, requestedE: 5, expect: 'malformed-range' },
    { name: 'non-numeric range "x-y"', attrs: { season: 27, episode: null, episodeRange: 'x-y' }, requestedS: 27, requestedE: 5, expect: 'malformed-range' },
  ];
  for (const c of cases) {
    const v = coversEpisode(c.attrs, c.requestedS, c.requestedE);
    const ok = v.reason === c.expect;
    console.log(`    ${ok ? 'PASS' : 'FAIL'}: ${c.name} -> ${v.reason} (expected ${c.expect})`);
    if (!ok) pass = false;
  }

  // ── Test 6: S27E1 — exact + 1-5 range should pass; 2-4 must NOT ───────
  console.log(`\n=== Test 6: South Park S27E1 — exact + 1-5 in-range ===`);
  const spE1 = await searchCorpus('tt0121955:27:1', 27, 1, 'South Park', 'South Park');
  summarize('S27E1', spE1.results);
  const spE1Exact = spE1.results.filter((r) => r.releaseAttributes?.season === 27 && r.releaseAttributes?.episode === 1);
  const spE1Range = spE1.results.filter((r) => r.releaseAttributes?.season === 27 && r.releaseAttributes?.episodeRange);
  const spE1OutOfRange = spE1.results.filter((r) => r.releaseAttributes?.season === 27 && r.releaseAttributes?.episodeRange && !rangeCovers(r.releaseAttributes.episodeRange, 1));
  assert(spE1Exact.length > 0, `S27E1 exact candidates present`);
  assert(spE1OutOfRange.length === 0, `Out-of-range S27 ranges are rejected (count: ${spE1OutOfRange.length})`);

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(`\n=== SUMMARY ===`);
  console.log(pass ? 'TV IDENTITY HARD GATE (corpus path): PASS' : 'TV IDENTITY HARD GATE (corpus path): FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('CANARY ERROR:', err);
  process.exit(2);
});
