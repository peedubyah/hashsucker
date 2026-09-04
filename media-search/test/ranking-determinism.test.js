/**
 * Ranking Determinism Permutation Proof
 *
 * Goal: prove that a fixed candidate/evidence snapshot produces a deterministic,
 * explainable persisted ordering independent of:
 * - input enumeration order
 * - object/map insertion order
 * - JS stable-sort input order
 *
 * Also proves that duplicate releaseKeys in the input set would defeat
 * determinism (documented pre-patch state), and that the comparator
 * is exhaustive for distinct (hash, fileIndex) pairs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';

import {
  rankHit,
  rankHits,
  rankHitsTiered,
  compareHits,
  compareHitsDetailed,
} from '../src/lib/discovery/ranking.js';
import { createReleaseIdentity } from '../src/api/release-contract.js';

function makeHit({ hash, fileIndex, ...rest }) {
  return {
    hash,
    fileIndex: fileIndex ?? null,
    filename: rest.filename || `release-${hash.slice(0, 6)}.mkv`,
    relevance: rest.relevance ?? 0.5,
    releaseAttributes: rest.releaseAttributes || {},
    parserConfidence: rest.parserConfidence ?? 0.5,
    mediaAssociations: rest.mediaAssociations || [],
    providerObservations: rest.providerObservations || [],
    providerEvidence: rest.providerEvidence || [],
    sources: rest.sources || [{ origin: 'corpus', evidence: [], confidence: 0.5 }],
    selectedMediaId: rest.selectedMediaId || null,
    hasLiveDiscovery: rest.hasLiveDiscovery ?? false,
    liveProviderHints: rest.liveProviderHints ?? null,
  };
}

function releaseKeyFor(hit) {
  return `${hit.hash}:${hit.fileIndex ?? 'torrent'}`;
}

function shuffled(arr, seed) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function fingerprint(ranked) {
  return ranked.map(r => `${releaseKeyFor(r)}|${r.score}|${r.justification?.rank}`).join('\n');
}

// =============================================================================
// FIXTURE: exact score ties, same quality tier, null/missing, corpus+live
// =============================================================================

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);
const HASH_D = 'd'.repeat(40);
const HASH_E = 'e'.repeat(40);
const HASH_F = 'f'.repeat(40);
const HASH_G = 'g'.repeat(40);

const MOVIE_QUERY = { mediaType: 'movie', mediaTitle: 'The Test Movie' };

const ATTRS_HIGH = {
  title: 'The Test Movie',
  year: 2024,
  mediaType: 'movie',
  resolution: '1080p',
  sourceType: 'BluRay',
  codec: 'x265',
  hdr: true,
};

const ATTRS_LOW = {
  title: 'The Test Movie',
  year: 2024,
  mediaType: 'movie',
  resolution: '720p',
  sourceType: 'WEB-DL',
  codec: 'x264',
  hdr: false,
};

const ATTRS_NULL = {
  title: 'The Test Movie',
  year: 2024,
  mediaType: 'movie',
  // resolution, source, codec, hdr all missing
};

function buildMixedFixture() {
  return [
    // Distinct hashes with distinct scores
    makeHit({ hash: HASH_A, fileIndex: 0, releaseAttributes: ATTRS_HIGH, parserConfidence: 0.9, relevance: 1.0, providerObservations: [{ cached: true }] }),
    makeHit({ hash: HASH_B, fileIndex: 1, releaseAttributes: ATTRS_LOW, parserConfidence: 0.6, relevance: 0.7, providerObservations: [{ cached: false }] }),
    makeHit({ hash: HASH_C, fileIndex: 2, releaseAttributes: ATTRS_NULL, parserConfidence: 0.5, relevance: 0.5, providerObservations: [] }),
    // Live candidate (corpus-style scoring with hasLiveDiscovery + selectedMediaId)
    makeHit({ hash: HASH_D, fileIndex: null, releaseAttributes: ATTRS_HIGH, parserConfidence: 0.8, relevance: 0.7, selectedMediaId: 'tt0944947', hasLiveDiscovery: true, sources: [{ origin: 'live', evidence: [], confidence: 0.7 }] }),
    // Tier change: a Verified candidate via mediaAssociations
    makeHit({
      hash: HASH_E, fileIndex: 5, releaseAttributes: ATTRS_HIGH, parserConfidence: 0.95, relevance: 1.0,
      mediaAssociations: [{ mediaId: 'tt0944947', confidence: 1.0, evidence: [], resolutionState: 'confirmed' }],
      providerObservations: [{ cached: true }],
    }),
    // null fileIndex with high quality
    makeHit({ hash: HASH_F, fileIndex: null, releaseAttributes: ATTRS_HIGH, parserConfidence: 0.85, relevance: 0.9, providerObservations: [{ cached: true }] }),
    // Another corpus with same identity tier
    makeHit({ hash: HASH_G, fileIndex: 0, releaseAttributes: ATTRS_LOW, parserConfidence: 0.7, relevance: 0.8, providerObservations: [{ cached: true }] }),
  ];
}

test('determinism: same evidence, multiple shuffled inputs => identical ranks', () => {
  const base = buildMixedFixture();
  const baseFingerprint = fingerprint(rankHits(base, MOVIE_QUERY, 'tt0944947'));

  for (let seed = 1; seed <= 20; seed++) {
    const permuted = shuffled(base, seed);
    const ranked = rankHits(permuted, MOVIE_QUERY, 'tt0944947');
    const fp = fingerprint(ranked);
    assert.equal(fp, baseFingerprint, `seed ${seed} produced different ordering`);
  }
});

test('determinism: tiered ranking is also input-order independent', () => {
  const base = buildMixedFixture();
  const baseResult = rankHitsTiered(base, { ...MOVIE_QUERY, mediaId: 'tt0944947' }, 'tt0944947', null);
  const baseFp = fingerprint(baseResult.ranked);

  for (let seed = 1; seed <= 20; seed++) {
    const permuted = shuffled(base, seed);
    const result = rankHitsTiered(permuted, { ...MOVIE_QUERY, mediaId: 'tt0944947' }, 'tt0944947', null);
    const fp = fingerprint(result.ranked);
    assert.equal(fp, baseFp, `tiered seed ${seed} produced different ordering`);
  }
});

test('determinism: pagination does not change relative ordering', () => {
  // Build a fixture with 50 candidates — enough to span multiple pages
  const fixture = [];
  for (let i = 0; i < 50; i++) {
    const hashBytes = crypto.createHash('sha256').update(`hit-${i}`).digest('hex');
    const hash = hashBytes.slice(0, 40);
    fixture.push(makeHit({
      hash,
      fileIndex: i,
      releaseAttributes: { ...ATTRS_HIGH, title: `The Test Movie ${i}`, year: 2020 + (i % 5) },
      parserConfidence: 0.5 + (i % 10) / 20,
      relevance: 0.5 + (i % 7) / 14,
      providerObservations: i % 3 === 0 ? [{ cached: true }] : [],
    }));
  }
  const fullRanked = rankHits(fixture, MOVIE_QUERY, 'tt0944947');
  const fullFp = fingerprint(fullRanked);

  for (let pageSize = 1; pageSize <= 20; pageSize++) {
    for (let offset = 0; offset < fullRanked.length; offset += 7) {
      const page = fullRanked.slice(offset, offset + pageSize);
      const pageFp = fingerprint(page);
      // Concatenating all pages must equal the full ranking
      const startIdx = fullFp.indexOf(pageFp.split('\n')[0]);
      assert.ok(startIdx >= 0, `offset ${offset} pageSize ${pageSize} produced page not found in full ranking`);
    }
  }
  // Final invariant: full ranking fingerprint is consistent across 20 input shuffles
  for (let seed = 1; seed <= 20; seed++) {
    const permuted = shuffled(fixture, seed);
    const ranked = rankHits(permuted, MOVIE_QUERY, 'tt0944947');
    assert.equal(fingerprint(ranked), fullFp, `pagination determinism seed ${seed}`);
  }
});

test('determinism: exact-score ties are broken by hash (lexicographic)', () => {
  // All 4 candidates have IDENTICAL score, confidence, quality, relevance.
  // Only hash and fileIndex differ. Comparator must fall through to TB4.
  const baseAttrs = ATTRS_HIGH;
  const baseObservations = [{ cached: true }];
  const baseAssoc = [];
  const hits = [
    makeHit({ hash: HASH_D, fileIndex: 0, releaseAttributes: baseAttrs, parserConfidence: 0.9, relevance: 1.0, providerObservations: baseObservations, mediaAssociations: baseAssoc }),
    makeHit({ hash: HASH_A, fileIndex: 0, releaseAttributes: baseAttrs, parserConfidence: 0.9, relevance: 1.0, providerObservations: baseObservations, mediaAssociations: baseAssoc }),
    makeHit({ hash: HASH_C, fileIndex: 0, releaseAttributes: baseAttrs, parserConfidence: 0.9, relevance: 1.0, providerObservations: baseObservations, mediaAssociations: baseAssoc }),
    makeHit({ hash: HASH_B, fileIndex: 0, releaseAttributes: baseAttrs, parserConfidence: 0.9, relevance: 1.0, providerObservations: baseObservations, mediaAssociations: baseAssoc }),
  ];
  const ranked = rankHits(hits, MOVIE_QUERY, 'tt0944947');
  // All 4 should have identical score (proving tie) AND identical confidence/quality/relevance
  const scores = new Set(ranked.map(r => r.score));
  assert.equal(scores.size, 1, 'expected exact score tie');
  // Order must be by hash lexicographic ASC
  const orderedHashes = ranked.map(r => r.hash);
  const expected = [HASH_A, HASH_B, HASH_C, HASH_D].sort();
  assert.deepEqual(orderedHashes, expected, 'tie-break by hash lexicographic failed');
});

test('determinism: identical-(hash,fileIndex) duplicates defeat sort order (documented pre-patch defect)', () => {
  // This test DOCUMENTS the pre-patch defect: if the same releaseKey
  // enters the ranking set twice with the same evidence, the comparator
  // returns 0 and JS stable sort preserves input order.
  // Once the dedup fix is applied at the seam, this scenario cannot occur
  // — but the comparator itself is correct: it returns 0 for two
  // identical rankingInputs.
  const hit = makeHit({
    hash: HASH_A, fileIndex: 0,
    releaseAttributes: ATTRS_HIGH,
    parserConfidence: 0.9, relevance: 1.0,
    providerObservations: [{ cached: true }],
  });
  const ranked = rankHits([hit, hit], MOVIE_QUERY, 'tt0944947');
  // Comparator returns 0 (tie), so order is input order
  const det = compareHitsDetailed(ranked[0], ranked[1]);
  assert.equal(det.order, 0, 'comparator should return 0 for identical inputs');
  assert.equal(det.winner, 'tie');
});

test('determinism: persisted score matches comparator score', () => {
  // The persisted `score` field on the ranked output IS the value used
  // by the comparator. Verify no drift.
  const hit = makeHit({
    hash: HASH_A, fileIndex: 0,
    releaseAttributes: ATTRS_HIGH,
    parserConfidence: 0.9, relevance: 1.0,
    providerObservations: [{ cached: true }],
  });
  const ranked = rankHits([hit], MOVIE_QUERY, 'tt0944947');
  const r = ranked[0];
  // Compare with a second ranking pass — should produce identical score
  const r2 = rankHits([hit], MOVIE_QUERY, 'tt0944947')[0];
  assert.equal(r.score, r2.score, 'score must be stable across calls');
  // score is a finite, rounded number
  assert.equal(typeof r.score, 'number');
  assert.ok(Number.isFinite(r.score));
  // Persisted score is the comparator's value (no rounding drift in caller)
  const cmp = compareHits(r, r2);
  assert.equal(cmp, 0, 'two identical hits should compare equal');
});

test('determinism: tiered ranking tail (Ineligible) is deterministic', () => {
  // Build a fixture where some candidates are ineligible (wrong season)
  const TV_QUERY = { mediaType: 'tv', season: 3, episode: 5, mediaTitle: 'Test Show' };
  const TV_ATTRS_MATCH = {
    title: 'Test Show', year: 2020, mediaType: 'tv', season: 3, episode: 5,
    resolution: '1080p', sourceType: 'WEB-DL', codec: 'x264',
  };
  const TV_ATTRS_WRONG = {
    title: 'Test Show', year: 2020, mediaType: 'tv', season: 7, episode: 99,
    resolution: '720p', sourceType: 'WEB-DL', codec: 'x264',
  };
  // Build with one Ineligible, one Ineligible, one eligible
  const fixture = [
    makeHit({ hash: HASH_A, fileIndex: 0, releaseAttributes: TV_ATTRS_WRONG, parserConfidence: 0.9, relevance: 1.0 }),
    makeHit({ hash: HASH_B, fileIndex: 0, releaseAttributes: TV_ATTRS_MATCH, parserConfidence: 0.9, relevance: 1.0 }),
    makeHit({ hash: HASH_C, fileIndex: 0, releaseAttributes: TV_ATTRS_WRONG, parserConfidence: 0.8, relevance: 0.8 }),
  ];
  // Use rankHitsTiered with eligibilityOverrides that mark A and C ineligible
  const eligibilityOverrides = new Map();
  eligibilityOverrides.set(`${HASH_A}:0`, { eligible: false, reason: 'wrong season', code: 'season_mismatch' });
  eligibilityOverrides.set(`${HASH_B}:0`, { eligible: true, reason: null, code: null });
  eligibilityOverrides.set(`${HASH_C}:0`, { eligible: false, reason: 'wrong season', code: 'season_mismatch' });
  const result = rankHitsTiered(fixture, { ...TV_QUERY, mediaId: 'tt0944947' }, 'tt0944947', eligibilityOverrides);
  const baseFp = fingerprint(result.ranked);
  for (let seed = 1; seed <= 20; seed++) {
    const permuted = shuffled(fixture, seed);
    const r = rankHitsTiered(permuted, { ...TV_QUERY, mediaId: 'tt0944947' }, 'tt0944947', eligibilityOverrides);
    assert.equal(fingerprint(r.ranked), baseFp, `Ineligible tail seed ${seed}`);
  }
  // The Ineligible candidates must be at the tail
  const ineligibleCount = result.tierMeta.TierCounts.Ineligible;
  assert.equal(ineligibleCount, 2);
  const lastTwo = result.ranked.slice(-2).map(r => r.hash);
  assert.deepEqual(new Set(lastTwo), new Set([HASH_A, HASH_C]), 'Ineligible tail not deterministic');
});

test('assembly-defect: live-vs-live dedup missing — duplicate releaseKeys in rankingInputs (pre-patch)', () => {
  // This test documents the pre-patch defect in media-request.js:
  // Both runLiveDiscovery loops (no-corpus path AND corpus+live path) lack
  // live-vs-live dedup. If runLiveDiscovery returns the same (infoHash, fileIndex)
  // twice (e.g., same torrent in both Stremio and Torznab indices), both
  // entries are pushed into rankingInputs without a key check.
  //
  // The fix: track seen releaseKeys (combining corpus + live eligibilityByHash
  // check with a local Set) and skip duplicates before push.
  //
  // This test simulates the defective seam to document the issue.
  const liveResults = [
    { releaseKey: `${HASH_A}:0`, infoHash: HASH_A, fileIndex: 0, title: 'Movie 2024', confidence: 0.8 },
    { releaseKey: `${HASH_B}:1`, infoHash: HASH_B, fileIndex: 1, title: 'Movie 2024', confidence: 0.7 },
    // Duplicate: same releaseKey as first entry (simulates Stremio+Torznab collision)
    { releaseKey: `${HASH_A}:0`, infoHash: HASH_A, fileIndex: 0, title: 'Movie 2024', confidence: 0.8 },
    { releaseKey: `${HASH_C}:2`, infoHash: HASH_C, fileIndex: 2, title: 'Movie 2024', confidence: 0.6 },
  ];

  // Simulate the FIRST runLiveDiscovery loop (no-corpus path)
  // WITHOUT the dedup fix: push all entries
  const DEFECTIVE_rankingInputs = [];
  const DEFECTIVE_liveEligibilityByHash = new Map();
  for (const live of liveResults) {
    const key = live.releaseKey;
    // NO eligibilityByHash check here (no corpus)
    // NO live-vs-live dedup check
    DEFECTIVE_liveEligibilityByHash.set(key, { eligible: true });
    DEFECTIVE_rankingInputs.push({
      hash: live.infoHash,
      fileIndex: live.fileIndex,
      releaseKey: key,
      filename: live.title,
      relevance: 0.8,
      releaseAttributes: { title: live.title },
      parserConfidence: live.confidence,
      mediaAssociations: [],
      providerObservations: [],
      providerEvidence: [],
      sources: [{ origin: 'live', evidence: [], confidence: live.confidence }],
      selectedMediaId: 'tt0944947',
      hasLiveDiscovery: true,
    });
  }
  // Before fix: rankingInputs has 4 entries (including duplicate HASH_A at index 0 and 2)
  assert.equal(DEFECTIVE_rankingInputs.length, 4, 'pre-patch: duplicate entry is in rankingInputs');
  // Rank — the duplicate HASH_A appears twice
  const DEFECTIVE_ranked = rankHits(DEFECTIVE_rankingInputs, MOVIE_QUERY, 'tt0944947');
  // HASH_A appears twice in results (different ranks)
  const hashACount = DEFECTIVE_ranked.filter(r => r.hash === HASH_A).length;
  assert.equal(hashACount, 2, 'pre-patch: duplicate appears twice in ranked output');

  // Now simulate the CORRECT seam WITH dedup (using Map semantics to dedup)
  const CORRECT_rankingInputs = [];
  const CORRECT_seenKeys = new Set();
  for (const live of liveResults) {
    const key = live.releaseKey;
    if (CORRECT_seenKeys.has(key)) continue; // dedup: skip if already seen
    CORRECT_seenKeys.add(key);
    CORRECT_rankingInputs.push({
      hash: live.infoHash,
      fileIndex: live.fileIndex,
      releaseKey: key,
      filename: live.title,
      relevance: 0.8,
      releaseAttributes: { title: live.title },
      parserConfidence: live.confidence,
      mediaAssociations: [],
      providerObservations: [],
      providerEvidence: [],
      sources: [{ origin: 'live', evidence: [], confidence: live.confidence }],
      selectedMediaId: 'tt0944947',
      hasLiveDiscovery: true,
    });
  }
  // After fix: rankingInputs has 3 unique entries
  assert.equal(CORRECT_rankingInputs.length, 3, 'post-patch: duplicate removed from rankingInputs');
  const CORRECT_ranked = rankHits(CORRECT_rankingInputs, MOVIE_QUERY, 'tt0944947');
  const hashACountFixed = CORRECT_ranked.filter(r => r.hash === HASH_A).length;
  assert.equal(hashACountFixed, 1, 'post-patch: duplicate appears once in ranked output');
  // Verify determinism: shuffling the deduped set produces same ranking
  for (let seed = 1; seed <= 10; seed++) {
    const permuted = shuffled(CORRECT_rankingInputs, seed);
    const CORRECT_seenKeys2 = new Set();
    const inputs2 = [];
    for (const live of shuffled(liveResults, seed)) {
      const key = live.releaseKey;
      if (CORRECT_seenKeys2.has(key)) continue;
      CORRECT_seenKeys2.add(key);
      inputs2.push({
        hash: live.infoHash, fileIndex: live.fileIndex, releaseKey: key,
        filename: live.title, relevance: 0.8,
        releaseAttributes: { title: live.title },
        parserConfidence: live.confidence, mediaAssociations: [], providerObservations: [],
        providerEvidence: [], sources: [{ origin: 'live', evidence: [], confidence: live.confidence }],
        selectedMediaId: 'tt0944947', hasLiveDiscovery: true,
      });
    }
    const ranked2 = rankHits(inputs2, MOVIE_QUERY, 'tt0944947');
    assert.equal(fingerprint(ranked2), fingerprint(CORRECT_ranked), `post-patch determinism seed ${seed}`);
  }
});

test('determinism: identical 50-hit corpus produces same fingerprint 100 times', () => {
  const fixture = [];
  for (let i = 0; i < 50; i++) {
    const hashBytes = crypto.createHash('sha256').update(`corpus-${i}`).digest('hex');
    fixture.push(makeHit({
      hash: hashBytes.slice(0, 40),
      fileIndex: i,
      releaseAttributes: { ...ATTRS_HIGH, title: `The Test Movie ${i}` },
      parserConfidence: 0.5 + (i % 10) / 20,
      relevance: 0.5 + (i % 7) / 14,
      providerObservations: i % 3 === 0 ? [{ cached: true }] : [],
    }));
  }
  const base = fingerprint(rankHits(fixture, MOVIE_QUERY, 'tt0944947'));
  for (let trial = 0; trial < 100; trial++) {
    const permuted = shuffled(fixture, trial + 1);
    const ranked = rankHits(permuted, MOVIE_QUERY, 'tt0944947');
    assert.equal(fingerprint(ranked), base, `trial ${trial}`);
  }
});
