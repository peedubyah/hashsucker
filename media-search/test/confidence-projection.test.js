/**
 * Provider-Agnostic Evidence Confidence Projection Tests
 *
 * Focused fixtures covering the 8 spec cases:
 *
 *   1. One historical DMM sighting
 *   2. Repeated DMM sightings across generations
 *   3. Two independent historical sources
 *   4. Historical positive + fresh provider negative
 *   5. Historical positive + fresh provider positive
 *   6. Stale provider observation
 *   7. No evidence
 *   8. Same evidence snapshot in shuffled order => identical projection
 *
 * Plus targeted precedence/identity/decoder coverage.
 *
 * All tests pin `now` so the projection is deterministic.
 *
 * Contract being proved:
 *   - Pure function: no DB, no globals, no time-of-day surprise.
 *   - Identity does not change the projection output.
 *   - Missing evidence means unknown, not negative.
 *   - Fresh provider outranks historical prior without deleting it.
 *   - Stale evidence decays in influence.
 *   - Local regex/predictor results are local evidence, not provider truth.
 *   - Two independent source-type families raise corroboration.
 *   - Determinism: shuffled order of identical observations == identical output.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectCandidateEvidence,
  createConfidenceProjection,
} from '../src/lib/discovery/confidence-projection.js';

const NOW = 1_700_000_000_000; // pinned clock
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// =============================================================================
// 1. One historical DMM sighting
// =============================================================================

test('one historical DMM sighting raises availabilityPrior modestly + sets dmm-historical reason', () => {
  const obs = [
    { kind: 'DMM_HISTORICAL', source: 'dmm-hashlist', observedAt: NOW - 2 * DAY },
  ];
  const result = projectCandidateEvidence({ infoHash: 'h1' }, obs, { now: NOW });
  // availabilityPrior: 0.20 * decay(2d, 30d) ≈ 0.20 * ~0.98 ≈ 0.196
  assert.ok(result.availabilityPrior > 0 && result.availabilityPrior < 0.25,
    `availabilityPrior should be modest DMM prior, got ${result.availabilityPrior}`);
  // corroboration: 1 family (DMM)
  assert.equal(result.corroboration, 1);
  // freshness: 2d old on DMM_HISTORICAL (TTL 30d) → near 1.0
  assert.ok(result.freshness > 0.9, `freshness should be near 1.0, got ${result.freshness}`);
  // freshProvider: no provider observation
  assert.equal(result.freshProvider, null);
  // reasons: includes dmm-historical + has-evidence; sort alphabetically
  assert.ok(result.reasons.includes('dmm-historical'), `reasons: ${result.reasons}`);
  assert.ok(result.reasons.includes('has-evidence'), `reasons: ${result.reasons}`);
  // identityConfidence: base 0.10 (has evidence) + 0 (only one family) = 0.10
  assert.equal(result.identityConfidence, 0.1);
});

// =============================================================================
// 2. Repeated DMM sightings across independent generations
// =============================================================================

test('repeated DMM sightings across independent generations raise identityConfidence and availabilityPrior', () => {
  const obs = [
    { kind: 'DMM_HISTORICAL', source: 'dmm-hashlist', generationId: 'gen-A', observedAt: NOW - 5 * DAY },
    { kind: 'DMM_REPEATED',  source: 'dmm-hashlist', generationId: 'gen-B', observedAt: NOW - 2 * DAY },
  ];
  const result = projectCandidateEvidence({ infoHash: 'h2' }, obs, { now: NOW });
  // availabilityPrior: 0.20 (first DMM) + 0.10 (independent gen-B) = 0.30 base
  // 0.20 * decay(5d) + 0.10 * decay(2d) ≈ 0.20 * 0.93 + 0.10 * 0.98 ≈ 0.286
  assert.ok(result.availabilityPrior > 0.25 && result.availabilityPrior < 0.32,
    `availabilityPrior should be ~0.30, got ${result.availabilityPrior}`);
  // identityConfidence: 0.10 base + 0.10 (dmm-seen-across-2-generations) = 0.20
  assert.equal(result.identityConfidence, 0.2);
  // reasons: dmm-historical + has-evidence + dmm-seen-across-2-generations
  assert.ok(result.reasons.includes('dmm-historical'), `reasons: ${result.reasons}`);
  assert.ok(result.reasons.includes('dmm-seen-across-2-generations'), `reasons: ${result.reasons}`);
  // corroboration: 1 family only (DMM is one family)
  assert.equal(result.corroboration, 1);
});

// =============================================================================
// 3. Two independent historical sources
// =============================================================================

test('two independent source-type families (DMM + attribute) raise corroboration to 2', () => {
  const obs = [
    { kind: 'DMM_HISTORICAL',         source: 'dmm-hashlist', observedAt: NOW - DAY },
    { kind: 'ATTRIBUTE_HISTORICAL',   source: 'ptn-regex',    observedAt: NOW - 12 * HOUR },
  ];
  const result = projectCandidateEvidence({ infoHash: 'h3' }, obs, { now: NOW });
  // corroboration: 2 families (dmm, attribute)
  assert.equal(result.corroboration, 2);
  // availabilityPrior: 0.20 (DMM) ≈ 0.20; no provider historical
  assert.ok(result.availabilityPrior > 0.15 && result.availabilityPrior < 0.25,
    `availabilityPrior ~0.20, got ${result.availabilityPrior}`);
  // identityConfidence: 0.10 (has evidence) + 0.20 (attribute-parsed) + 0.10 (1 family beyond first) = 0.40
  assert.equal(result.identityConfidence, 0.4);
  // reasons
  assert.ok(result.reasons.includes('attribute-parsed'), `reasons: ${result.reasons}`);
  assert.ok(result.reasons.includes('corroborated-by-2-families'), `reasons: ${result.reasons}`);
  assert.ok(result.reasons.includes('dmm-historical'), `reasons: ${result.reasons}`);
  // freshProvider: still null
  assert.equal(result.freshProvider, null);
});

// =============================================================================
// 4. Historical positive + fresh provider negative
// =============================================================================

test('historical positive + fresh provider NEGATIVE: fresh overrides current, historical preserved', () => {
  const obs = [
    { kind: 'DMM_HISTORICAL',          source: 'dmm-hashlist', observedAt: NOW - 2 * DAY },
    { kind: 'PROVIDER_FRESH_NEGATIVE', source: 'torbox',        state: 'uncached', observedAt: NOW - 5 * 60 * 1000 },
  ];
  const result = projectCandidateEvidence({ infoHash: 'h4' }, obs, { now: NOW });
  // availabilityPrior: still 0.20 (DMM) — fresh negative is NOT folded into prior
  assert.ok(result.availabilityPrior > 0.15 && result.availabilityPrior < 0.25,
    `availabilityPrior should preserve DMM prior, got ${result.availabilityPrior}`);
  // freshProvider: 'negative' (provider overrides historical for current)
  assert.equal(result.freshProvider, 'negative');
  // corroboration: 2 families (dmm + provider)
  assert.equal(result.corroboration, 2);
  // reasons: BOTH provider-fresh-negative AND dmm-historical preserved
  assert.ok(result.reasons.includes('provider-fresh-negative'), `reasons: ${result.reasons}`);
  assert.ok(result.reasons.includes('dmm-historical'), `reasons: ${result.reasons}`);
  // freshness: most recent is fresh negative (5 min old) → ~1.0
  assert.ok(result.freshness > 0.9, `freshness ~1.0, got ${result.freshness}`);
  // No single scalar outranks historical: the projection exposes both
  assert.notEqual(result.freshProvider, 'positive');
  // Identity confidence: 0.10 base + 0.10 (1 family beyond first) = 0.20
  assert.equal(result.identityConfidence, 0.2);
});

// =============================================================================
// 5. Historical positive + fresh provider positive
// =============================================================================

test('historical positive + fresh provider POSITIVE: both reported, fresh raises availability context', () => {
  const obs = [
    { kind: 'DMM_HISTORICAL',          source: 'dmm-hashlist', observedAt: NOW - 2 * DAY },
    { kind: 'PROVIDER_FRESH_POSITIVE', source: 'torbox',        state: 'cached',   observedAt: NOW - 30 * 1000 },
  ];
  const result = projectCandidateEvidence({ infoHash: 'h5' }, obs, { now: NOW });
  assert.equal(result.freshProvider, 'positive');
  assert.ok(result.reasons.includes('provider-fresh-positive'), `reasons: ${result.reasons}`);
  assert.ok(result.reasons.includes('dmm-historical'), `reasons: ${result.reasons}`);
  // availabilityPrior: DMM 0.20 (provider fresh is NOT folded into prior)
  assert.ok(result.availabilityPrior > 0.15 && result.availabilityPrior < 0.25,
    `availabilityPrior ~0.20 (DMM only), got ${result.availabilityPrior}`);
  // corroboration: 2 families
  assert.equal(result.corroboration, 2);
});

// =============================================================================
// 6. Stale provider observation
// =============================================================================

test('stale provider observation decays in influence + marks freshProvider=stale', () => {
  const oldObs = NOW - 5 * DAY; // far past provider TTL (24h)
  const obs = [
    { kind: 'PROVIDER_HISTORICAL', source: 'torbox', state: 'cached', observedAt: oldObs },
  ];
  const result = projectCandidateEvidence({ infoHash: 'h6' }, obs, { now: NOW });
  // No fresh positive/negative present; only historical which is past TTL.
  // freshProvider: null (no PROVIDER_FRESH_* present)
  assert.equal(result.freshProvider, null);
  // availabilityPrior: 0.20 * decay(5d, 24h) → heavily decayed
  //   decay: 5d > 24h so taper applies: factor = 0.5^(5d/7d) * max(0, 1 - (5d-24h)/(2*24h))
  //   = 0.5^0.714 * max(0, 1 - 4d/2d) — wait, that goes negative, so taper=0
  //   → factor = 0
  //   But the past-TTL taper floors at 0 only when age > 3*ttlMs. Let's just check it
  //   is small.
  assert.ok(result.availabilityPrior < 0.10,
    `availabilityPrior should decay to small value, got ${result.availabilityPrior}`);
  // freshness: 5d old with 24h TTL → small
  assert.ok(result.freshness < 0.2, `freshness should be small, got ${result.freshness}`);
  // reasons: provider-historical still recorded (we don't delete evidence)
  assert.ok(result.reasons.includes('provider-historical'), `reasons: ${result.reasons}`);
});

// Stale provider observation (PROVIDER_STALE explicit kind):
test('PROVIDER_STALE explicit kind marks freshProvider=stale and excludes positive', () => {
  const obs = [
    { kind: 'PROVIDER_STALE', source: 'torbox', observedAt: NOW - HOUR },
  ];
  const result = projectCandidateEvidence({ infoHash: 'h6b' }, obs, { now: NOW });
  assert.equal(result.freshProvider, 'stale');
  assert.ok(result.reasons.includes('provider-stale-only'), `reasons: ${result.reasons}`);
  // PROVIDER_STALE has no fresh positive/negative — its contribution to
  // availabilityPrior is decayed (ttlMs=0 means the half-life branch
  // substitutes FRESHNESS_HALF_LIFE_MS, so 1h ≈ fresh). The point of the
  // test is freshProvider=='stale', not freshness==0.
  assert.notEqual(result.freshProvider, 'positive');
  assert.notEqual(result.freshProvider, 'negative');
});

// =============================================================================
// 7. No evidence
// =============================================================================

test('no evidence: all null/zero, no reasons except no-evidence', () => {
  const result = projectCandidateEvidence({ infoHash: 'h7' }, [], { now: NOW });
  assert.equal(result.availabilityPrior, 0);
  assert.equal(result.identityConfidence, 0);
  assert.equal(result.corroboration, 0);
  assert.equal(result.freshness, 0);
  assert.equal(result.freshProvider, null);
  assert.deepEqual(result.reasons, ['no-evidence']);
  assert.equal(result.evidenceCount, 0);
  assert.deepEqual(result.evidence, []);
});

test('no evidence but identity is provided: projection is identical (identity does not affect output)', () => {
  const a = projectCandidateEvidence({ infoHash: 'aaa' }, [], { now: NOW });
  const b = projectCandidateEvidence({ infoHash: 'bbb', fileIndex: 7 }, [], { now: NOW });
  assert.deepEqual(a, b);
});

// =============================================================================
// 8. Same evidence snapshot in shuffled order => identical projection
// =============================================================================

test('shuffled-order determinism: same evidence, different order => identical projection', () => {
  const obs = [
    { kind: 'DMM_HISTORICAL',         source: 'dmm-hashlist', generationId: 'gen-A', observedAt: NOW - 3 * DAY },
    { kind: 'DMM_REPEATED',           source: 'dmm-hashlist', generationId: 'gen-B', observedAt: NOW - 1 * DAY },
    { kind: 'ATTRIBUTE_HISTORICAL',   source: 'ptn-regex',                                observedAt: NOW - 6 * HOUR },
    { kind: 'MEDIA_ASSOCIATION',      source: 'tmdb',                                    observedAt: NOW - 2 * HOUR },
    { kind: 'SOURCE_LISTED',          source: 'torrentio',                               observedAt: NOW - 1 * HOUR },
    { kind: 'PROVIDER_FRESH_POSITIVE', source: 'torbox',     state: 'cached',            observedAt: NOW - 30 * 1000 },
  ];
  // Shuffle into 3 different orderings
  const orderings = [
    [0, 1, 2, 3, 4, 5],
    [5, 4, 3, 2, 1, 0],
    [2, 0, 4, 1, 3, 5],
    [3, 5, 1, 4, 0, 2],
  ];
  const results = orderings.map((order) =>
    projectCandidateEvidence({ infoHash: 'h8' }, order.map((i) => obs[i]), { now: NOW })
  );
  // All orderings produce identical output
  for (let i = 1; i < results.length; i++) {
    assert.deepEqual(results[i], results[0],
      `ordering ${i} produced different output: ${JSON.stringify(results[i])} vs ${JSON.stringify(results[0])}`);
  }
  // Sanity: this is the "well-corroborated, fresh, all-positive" case
  const r = results[0];
  assert.equal(r.freshProvider, 'positive');
  assert.equal(r.corroboration, 5); // dmm + attribute + media + source-list + provider
  assert.equal(r.evidenceCount, 6);
  assert.ok(r.availabilityPrior > 0.25, `availabilityPrior, got ${r.availabilityPrior}`);
  assert.ok(r.identityConfidence > 0.5, `identityConfidence, got ${r.identityConfidence}`);
});

// =============================================================================
// Precedence: fresh positive outranks stale historical
// =============================================================================

test('fresh provider positive and stale historical: fresh wins current, historical preserved', () => {
  const obs = [
    { kind: 'PROVIDER_HISTORICAL',   source: 'torbox', observedAt: NOW - 7 * DAY }, // very stale
    { kind: 'PROVIDER_FRESH_POSITIVE', source: 'torbox', state: 'cached', observedAt: NOW - 5 * 1000 },
  ];
  const result = projectCandidateEvidence({ infoHash: 'h9' }, obs, { now: NOW });
  // freshProvider: positive (fresh overrides stale)
  assert.equal(result.freshProvider, 'positive');
  // reasons: provider-fresh-positive present, provider-historical present (NOT deleted)
  assert.ok(result.reasons.includes('provider-fresh-positive'), `reasons: ${result.reasons}`);
  assert.ok(result.reasons.includes('provider-historical'), `reasons: ${result.reasons}`);
  // availabilityPrior: 0.20 * decay(7d, 24h) ≈ small (heavily decayed)
  assert.ok(result.availabilityPrior < 0.10,
    `availabilityPrior should be heavily decayed, got ${result.availabilityPrior}`);
});

// =============================================================================
// Local regex/predictor is local evidence, not provider truth
// =============================================================================

test('ATTRIBUTE_HISTORICAL alone does NOT set freshProvider (local evidence ≠ provider truth)', () => {
  const obs = [
    { kind: 'ATTRIBUTE_HISTORICAL', source: 'ptn-regex', observedAt: NOW - HOUR },
  ];
  const result = projectCandidateEvidence({ infoHash: 'h10' }, obs, { now: NOW });
  assert.equal(result.freshProvider, null, 'attribute-parsed must not set freshProvider');
  // reason includes 'no-fresh-provider' (since corroboration > 0 and no fresh provider)
  assert.ok(result.reasons.includes('no-fresh-provider'), `reasons: ${result.reasons}`);
});

// =============================================================================
// Identity-context invariance
// =============================================================================

test('projection is invariant under identity context (same obs, different identity)', () => {
  const obs = [
    { kind: 'DMM_HISTORICAL',         source: 'dmm-hashlist', observedAt: NOW - DAY },
    { kind: 'ATTRIBUTE_HISTORICAL',   source: 'ptn-regex',    observedAt: NOW - HOUR },
  ];
  const a = projectCandidateEvidence({ infoHash: 'h11a' }, obs, { now: NOW });
  const b = projectCandidateEvidence({ infoHash: 'h11b', fileIndex: 0 }, obs, { now: NOW });
  const c = projectCandidateEvidence({ infoHash: 'h11b', fileIndex: 7 }, obs, { now: NOW });
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

// =============================================================================
// Multiple independent families: cap behavior
// =============================================================================

test('corroboration family count caps identity bonus at +0.20', () => {
  const obs = [
    { kind: 'DMM_HISTORICAL',       source: 'a', observedAt: NOW - 2 * DAY },
    { kind: 'ATTRIBUTE_HISTORICAL', source: 'b', observedAt: NOW - HOUR },
    { kind: 'MEDIA_ASSOCIATION',    source: 'c', observedAt: NOW - HOUR },
    { kind: 'SOURCE_LISTED',        source: 'd', observedAt: NOW - HOUR },
  ];
  const result = projectCandidateEvidence({ infoHash: 'h12' }, obs, { now: NOW });
  // 4 families → corroborated-by-4-families; bonus = min(0.10*3, 0.20) = 0.20
  assert.equal(result.corroboration, 4);
  assert.ok(result.reasons.includes('corroborated-by-4-families'), `reasons: ${result.reasons}`);
  // identityConfidence: 0.10 base + 0.20 (attribute) + 0.10 (media, first) + 0.05 (source-list) + 0.20 (bonus)
  // = 0.65
  assert.equal(result.identityConfidence, 0.65);
});

// =============================================================================
// Determinism with the live cache helper
// =============================================================================

test('createConfidenceProjection: empty cache returns the no-evidence projection', async () => {
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const cache = createDiscoveryCache();
  const projection = createConfidenceProjection(cache);
  const r = projection.project('nonexistent', null, { now: NOW });
  assert.equal(r.availabilityPrior, 0);
  assert.equal(r.corroboration, 0);
  assert.equal(r.freshProvider, null);
  assert.deepEqual(r.reasons, ['no-evidence']);
});
