/**
 * Historical Provider Evidence Tests
 *
 * Proves the durable historical-provider-evidence landing zone and its
 * integration into the confidence projection.
 *
 * 11 spec cases (see README in the audit report):
 *   1. Import RD historical release X once
 *   2. Import exact same snapshot twice => row count unchanged
 *   3. Observe X again in later snapshot => lastSeen/observationCount advance
 *   4. Same X from independent source => independent corroboration preserved
 *   5. Release-level X (fileIndex=null) and file-level X:0 remain distinct
 *   6. Malformed hash rejected
 *   7. Historical RD hit raises availabilityPrior (projection)
 *   8. Historical RD hit + fresh RD negative => negative wins; history survives
 *   9. Historical RD hit + fresh RD positive => fresh positive wins
 *  10. Shuffled historical observation input => identical stored state + identical projection
 *  11. No historical evidence => existing projection behavior unchanged
 *
 * Plus:
 *  - 100k-row synthetic performance / idempotency test
 *  - Round-trip projection through createConfidenceProjection(cache)
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import pathLib from 'node:path';
import os from 'node:os';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createConfidenceProjection } from '../src/lib/discovery/confidence-projection.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000; // pinned clock

const HASH_X = 'a'.repeat(40);
const HASH_Y = 'b'.repeat(40);
const HASH_Z = 'c'.repeat(40);

function makeCache() {
  return createDiscoveryCache({ dbPath: ':memory:' });
}

// =============================================================================
// 1. Import RD historical release X once
// =============================================================================
test('1. ingest RD historical release X once creates a single row', () => {
  const cache = makeCache();
  const r = cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [
      { infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY },
    ],
  });
  assert.equal(r.ingested, 1);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.errors, []);
  assert.equal(cache.countHistoricalProviderEvidence(), 1);

  const rows = cache.getHistoricalProviderEvidence(HASH_X, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'realdebrid');
  assert.equal(rows[0].source_id, 'rd-history-2024');
  assert.equal(rows[0].source_version, 'v1');
  assert.equal(rows[0].evidence_type, 'historical_hit');
  assert.equal(rows[0].observation_count, 1);
  cache.close();
});

// =============================================================================
// 2. Import exact same snapshot twice => row count unchanged
// =============================================================================
test('2. re-import of identical snapshot does not duplicate rows', () => {
  const cache = makeCache();
  const opts = {
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [
      { infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY },
    ],
  };
  const r1 = cache.ingestHistoricalProviderEvidence(opts);
  const r2 = cache.ingestHistoricalProviderEvidence(opts);
  assert.equal(r1.ingested, 1);
  assert.equal(r2.ingested, 1);
  assert.equal(cache.countHistoricalProviderEvidence(), 1);
  const rows = cache.getHistoricalProviderEvidence(HASH_X, null);
  assert.equal(rows.length, 1);
  // observation_count accumulates: 1 + 1 = 2
  assert.equal(rows[0].observation_count, 2);
  // last_seen_at is monotonic: MAX preserves the later value
  // (both calls passed NOW - 2 * DAY, so last_seen_at stays at that value)
  assert.equal(rows[0].last_seen_at, NOW - 2 * DAY);
  cache.close();
});

// =============================================================================
// 3. Observe X again in later snapshot => lastSeen/observationCount advance
// =============================================================================
test('3. re-import with later timestamp advances last_seen_at monotonically', () => {
  const cache = makeCache();
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [
      { infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 5 * DAY, firstSeenAt: NOW - 5 * DAY },
    ],
  });
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [
      { infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY, firstSeenAt: NOW - 1 * DAY },
    ],
  });
  const rows = cache.getHistoricalProviderEvidence(HASH_X, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].first_seen_at, NOW - 5 * DAY, 'first_seen_at must NOT move forward');
  assert.equal(rows[0].last_seen_at, NOW - 1 * DAY, 'last_seen_at must move to the later value');
  assert.equal(rows[0].observation_count, 2);
  cache.close();
});

test('3b. re-import with earlier timestamp is absorbed (first_seen preserves earliest)', () => {
  const cache = makeCache();
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [
      { infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY },
    ],
  });
  // A re-import that arrives with an earlier timestamp (e.g. out-of-order
  // snapshot replay) must NOT rewind first_seen and must NOT advance
  // last_seen past the existing value.
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [
      { infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 30 * DAY, firstSeenAt: NOW - 30 * DAY },
    ],
  });
  const rows = cache.getHistoricalProviderEvidence(HASH_X, null);
  assert.equal(rows[0].first_seen_at, NOW - 30 * DAY, 'first_seen_at absorbs an earlier re-import');
  assert.equal(rows[0].last_seen_at, NOW - 1 * DAY, 'last_seen_at is preserved against an earlier re-import');
  cache.close();
});

// =============================================================================
// 4. Same X from independent source => independent corroboration preserved
// =============================================================================
test('4. two independent historical sources for the same release => 2 distinct rows', () => {
  const cache = makeCache();
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY }],
  });
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2023',
    sourceVersion: 'v1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  assert.equal(cache.countHistoricalProviderEvidence(), 2);
  const rows = cache.getHistoricalProviderEvidence(HASH_X, null);
  const sourceIds = rows.map((r) => r.source_id).sort();
  assert.deepEqual(sourceIds, ['rd-history-2023', 'rd-history-2024']);
  cache.close();
});

// =============================================================================
// 5. Release-level vs file-level: HASH_X (null) and HASH_X:0 remain distinct
// =============================================================================
test('5. release-level (fileIndex=null) and file-level (fileIndex=0) remain distinct identities', () => {
  const cache = makeCache();
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [
      { infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY },
      { infoHash: HASH_X, fileIndex: 0, lastSeenAt: NOW - 1 * DAY },
    ],
  });
  assert.equal(cache.countHistoricalProviderEvidence(), 2);
  assert.equal(cache.countHistoricalProviderEvidenceForCandidate(HASH_X, null), 1);
  assert.equal(cache.countHistoricalProviderEvidenceForCandidate(HASH_X, 0), 1);
  assert.equal(cache.countHistoricalProviderEvidenceForCandidate(HASH_X, 1), 0);
  cache.close();
});

// =============================================================================
// 6. Malformed hash rejected
// =============================================================================
test('6. malformed hashes are rejected without aborting the batch', () => {
  const cache = makeCache();
  const r = cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [
      { infoHash: 'not-a-hash', fileIndex: null },
      { infoHash: HASH_X, fileIndex: null },
      { infoHash: 'cafebabe', fileIndex: null }, // too short
      { infoHash: null, fileIndex: null },
      { infoHash: HASH_Y, fileIndex: 0 },
    ],
  });
  assert.equal(r.ingested, 2);
  assert.equal(r.skipped, 3);
  assert.equal(r.errors.length, 3);
  // The valid rows ARE persisted
  assert.equal(cache.countHistoricalProviderEvidence(), 2);
  cache.close();
});

test('6b. valid 64-char SHA-256 hashes are accepted', () => {
  const cache = makeCache();
  const sha256 = 'a'.repeat(64);
  const r = cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [{ infoHash: sha256, fileIndex: null, lastSeenAt: NOW - 1 * DAY }],
  });
  assert.equal(r.ingested, 1);
  assert.equal(cache.countHistoricalProviderEvidence(), 1);
  cache.close();
});

test('6c. infoHash is normalized to lowercase', () => {
  const cache = makeCache();
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [
      { infoHash: HASH_X.toUpperCase(), fileIndex: null, lastSeenAt: NOW - 1 * DAY },
    ],
  });
  const rows = cache.getHistoricalProviderEvidence(HASH_X.toLowerCase(), null);
  assert.equal(rows.length, 1);
  cache.close();
});

// =============================================================================
// 7. Historical RD hit raises availabilityPrior modestly
// =============================================================================
test('7. historical RD hit raises availabilityPrior modestly', () => {
  const cache = makeCache();
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  const proj = createConfidenceProjection(cache);
  const result = proj.project(HASH_X, null, { now: NOW });
  // availabilityPrior: base 0 + 0.20 * decay(2d, 24h TTL) ≈ 0.20 * (0.5^(2d/7d)) ≈ 0.20 * 0.82 ≈ 0.164
  assert.ok(result.availabilityPrior > 0 && result.availabilityPrior < 0.20,
    `availabilityPrior should be modest provider prior, got ${result.availabilityPrior}`);
  // corroboration: 1 family (provider, since historicalSourceId is set)
  assert.ok(result.corroboration >= 1, `corroboration should be at least 1, got ${result.corroboration}`);
  // reasons include provider-historical
  assert.ok(result.reasons.includes('provider-historical'),
    `reasons should include provider-historical, got: ${result.reasons}`);
  // freshProvider: still null (history is a prior, not a current observation)
  assert.equal(result.freshProvider, null);
  cache.close();
});

// =============================================================================
// 8. Historical RD hit + fresh RD negative => negative wins current; history survives
// =============================================================================
test('8. historical RD hit + fresh RD negative => freshProvider=negative, history survives', () => {
  const cache = makeCache();
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  // Append a fresh negative provider observation
  cache.appendProviderObservation({
    provider: 'realdebrid',
    accountScope: 'default',
    scope: 'torrent',
    subjectType: 'torrent',
    subjectKey: HASH_X,
    infoHash: HASH_X,
    fileIndex: null,
    kind: 'authoritative',
    state: 'uncached',
    observedAt: NOW - 5 * 60 * 1000, // 5 min ago
    expiresAt: NOW + 24 * HOUR,
    source: 'rd-probe',
  });
  const proj = createConfidenceProjection(cache);
  const result = proj.project(HASH_X, null, { now: NOW });
  // Fresh negative outranks the historical prior for current interpretation
  assert.equal(result.freshProvider, 'negative');
  assert.ok(result.reasons.includes('provider-fresh-negative'),
    `reasons should include provider-fresh-negative, got: ${result.reasons}`);
  // Historical evidence SURVIVES in reasons
  assert.ok(result.reasons.includes('provider-historical'),
    `historical evidence should survive, got: ${result.reasons}`);
  // availabilityPrior still reflects the historical prior
  assert.ok(result.availabilityPrior > 0,
    `availabilityPrior should still reflect the historical prior, got ${result.availabilityPrior}`);
  // And the row is still in the table
  assert.equal(cache.countHistoricalProviderEvidenceForCandidate(HASH_X, null), 1);
  cache.close();
});

// =============================================================================
// 9. Historical RD hit + fresh RD positive => fresh positive wins
// =============================================================================
test('9. historical RD hit + fresh RD positive => freshProvider=positive', () => {
  const cache = makeCache();
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  cache.appendProviderObservation({
    provider: 'realdebrid',
    accountScope: 'default',
    scope: 'torrent',
    subjectType: 'torrent',
    subjectKey: HASH_X,
    infoHash: HASH_X,
    fileIndex: null,
    kind: 'authoritative',
    state: 'cached',
    observedAt: NOW - 5 * 60 * 1000,
    expiresAt: NOW + 24 * HOUR,
    source: 'rd-probe',
  });
  const proj = createConfidenceProjection(cache);
  const result = proj.project(HASH_X, null, { now: NOW });
  assert.equal(result.freshProvider, 'positive');
  assert.ok(result.reasons.includes('provider-fresh-positive'),
    `reasons should include provider-fresh-positive, got: ${result.reasons}`);
  assert.ok(result.reasons.includes('provider-historical'),
    `historical evidence survives, got: ${result.reasons}`);
  cache.close();
});

// =============================================================================
// 10. Shuffled historical observation input => identical stored state + identical projection
// =============================================================================
test('10. shuffled historical observation input produces identical stored state and identical projection', () => {
  function buildCache() {
    const c = makeCache();
    // Same set of observations, two different orderings
    // Pass explicit firstSeenAt so the auto-fallback (`now`) doesn't differ
    // between the two calls below.
    const obs = [
      { infoHash: HASH_X, fileIndex: null, firstSeenAt: NOW - 30 * DAY, lastSeenAt: NOW - 1 * DAY },
      { infoHash: HASH_Y, fileIndex: 0, firstSeenAt: NOW - 30 * DAY, lastSeenAt: NOW - 2 * DAY },
      { infoHash: HASH_Z, fileIndex: null, firstSeenAt: NOW - 30 * DAY, lastSeenAt: NOW - 3 * DAY },
    ];
    c.ingestHistoricalProviderEvidence({
      provider: 'realdebrid',
      sourceId: 'rd-history-2024',
      sourceVersion: 'v1',
      observations: obs.slice().reverse(),
    });
    return c;
  }
  const cache1 = buildCache();
  const cache2 = makeCache();
  cache2.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [
      { infoHash: HASH_Z, fileIndex: null, firstSeenAt: NOW - 30 * DAY, lastSeenAt: NOW - 3 * DAY },
      { infoHash: HASH_X, fileIndex: null, firstSeenAt: NOW - 30 * DAY, lastSeenAt: NOW - 1 * DAY },
      { infoHash: HASH_Y, fileIndex: 0, firstSeenAt: NOW - 30 * DAY, lastSeenAt: NOW - 2 * DAY },
    ],
  });
  // Row counts match
  assert.equal(cache1.countHistoricalProviderEvidence(), cache2.countHistoricalProviderEvidence());
  // Per-candidate counts match
  for (const h of [HASH_X, HASH_Y, HASH_Z]) {
    assert.deepEqual(
      cache1.getHistoricalProviderEvidence(h, null),
      cache2.getHistoricalProviderEvidence(h, null),
    );
  }
  // Projections match (deterministic + pure)
  const proj1 = createConfidenceProjection(cache1);
  const proj2 = createConfidenceProjection(cache2);
  for (const h of [HASH_X, HASH_Y, HASH_Z]) {
    const r1 = proj1.project(h, null, { now: NOW });
    const r2 = proj2.project(h, null, { now: NOW });
    assert.equal(r1.availabilityPrior, r2.availabilityPrior);
    assert.equal(r1.identityConfidence, r2.identityConfidence);
    assert.equal(r1.corroboration, r2.corroboration);
    assert.equal(r1.freshness, r2.freshness);
    assert.equal(r1.freshProvider, r2.freshProvider);
    assert.deepEqual(r1.reasons, r2.reasons);
  }
  cache1.close();
  cache2.close();
});

// =============================================================================
// 11. No historical evidence => existing projection behavior unchanged
// =============================================================================
test('11. with no historical evidence, projection matches the empty-prior baseline', () => {
  const cache = makeCache();
  // No historical ingest at all
  const proj = createConfidenceProjection(cache);
  const result = proj.project(HASH_X, null, { now: NOW });
  // No evidence at all
  assert.equal(result.availabilityPrior, 0);
  assert.equal(result.identityConfidence, 0);
  assert.equal(result.corroboration, 0);
  assert.equal(result.freshProvider, null);
  assert.equal(result.evidenceCount, 0);
  assert.deepEqual(result.reasons, ['no-evidence']);
  // No provider-historical reason
  assert.ok(!result.reasons.includes('provider-historical'));
  // No rows in the store
  assert.equal(cache.countHistoricalProviderEvidence(), 0);
  cache.close();
});

// =============================================================================
// Independent historical sources raise corroboration
// =============================================================================
test('12. two independent historical sources raise corroboration to 2', () => {
  const cache = makeCache();
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY }],
  });
  cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2023',
    sourceVersion: 'v1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  const proj = createConfidenceProjection(cache);
  const result = proj.project(HASH_X, null, { now: NOW });
  // Two distinct historical sources => two distinct corroboration families
  assert.equal(result.corroboration, 2, `corroboration should be 2, got ${result.corroboration}`);
  // availabilityPrior: 0.20 * decay(1d, 24h) + 0.20 * decay(2d, 24h)
  //   ≈ 0.20 * 0.91 + 0.20 * 0.41 ≈ 0.18 + 0.08 ≈ 0.26 (past-TTL taper kicks in
  //   at 24h). The exact value is not part of the contract; we just check
  //   it's strictly greater than a single historical source would give and
  //   less than the 0.40 max.
  assert.ok(result.availabilityPrior > 0.20 && result.availabilityPrior <= 0.40,
    `availabilityPrior should be in (0.20, 0.40], got ${result.availabilityPrior}`);
  cache.close();
});

// =============================================================================
// 100k-row synthetic performance / idempotency test
// =============================================================================
test('performance: 100k historical rows ingest without amplification on second pass', () => {
  const cache = makeCache();
  const N = 100_000;
  const observations = [];
  for (let i = 0; i < N; i++) {
    // Generate deterministic 40-char hex hashes
    const h = (i.toString(16).padStart(8, '0') + '0'.repeat(32)).slice(0, 40);
    observations.push({ infoHash: h, fileIndex: null, lastSeenAt: NOW - 1 * DAY });
  }
  const t0 = Date.now();
  const r1 = cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations,
  });
  const t1 = Date.now();
  assert.equal(r1.ingested, N);
  assert.equal(r1.skipped, 0);
  assert.equal(cache.countHistoricalProviderEvidence(), N);

  // Re-ingest the same batch
  const r2 = cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations,
  });
  const t2 = Date.now();
  assert.equal(r2.ingested, N);
  // Row count must NOT double
  assert.equal(cache.countHistoricalProviderEvidence(), N, 'second pass must not duplicate rows');
  // observation_count for each row should now be 2
  const sample = cache.getHistoricalProviderEvidence(observations[0].infoHash, null);
  assert.equal(sample[0].observation_count, 2);

  // Report timings as a hint, not an assertion (CI noise):
  // First pass: ~hundreds of ms; second pass: comparable.
  // eslint-disable-next-line no-console
  console.log(`[perf] 100k ingest first=${t1 - t0}ms, second=${t2 - t1}ms, rows=${N}`);
  cache.close();
});

// =============================================================================
// Batch in single transaction; partial failures don't lose committed rows
// =============================================================================
test('13. partial batch failure: invalid rows are skipped, valid rows are committed', () => {
  const cache = makeCache();
  const r = cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    sourceVersion: 'v1',
    observations: [
      { infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY },
      { infoHash: 'bad', fileIndex: null },
      { infoHash: HASH_Y, fileIndex: null, lastSeenAt: NOW - 2 * DAY },
    ],
  });
  assert.equal(r.ingested, 2);
  assert.equal(r.skipped, 1);
  assert.equal(cache.countHistoricalProviderEvidence(), 2);
  cache.close();
});

// =============================================================================
// Missing required fields return early without error
// =============================================================================
test('14. missing provider or sourceId is a no-op (returns 0)', () => {
  const cache = makeCache();
  const r1 = cache.ingestHistoricalProviderEvidence({
    sourceId: 'rd-history-2024',
    observations: [{ infoHash: HASH_X, fileIndex: null }],
  });
  assert.equal(r1.ingested, 0);
  const r2 = cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    observations: [{ infoHash: HASH_X, fileIndex: null }],
  });
  assert.equal(r2.ingested, 0);
  const r3 = cache.ingestHistoricalProviderEvidence({
    provider: 'realdebrid',
    sourceId: 'rd-history-2024',
    observations: [],
  });
  assert.equal(r3.ingested, 0);
  assert.equal(cache.countHistoricalProviderEvidence(), 0);
  cache.close();
});

// =============================================================================
// Persistence across cache reopen
// =============================================================================
test('15. historical evidence persists across cache close/reopen', () => {
  const tmp = pathLib.join(os.tmpdir(), `hpe-test-${Date.now()}-${Math.random()}.db`);
  try {
    const c1 = createDiscoveryCache({ dbPath: tmp });
    c1.ingestHistoricalProviderEvidence({
      provider: 'realdebrid',
      sourceId: 'rd-history-2024',
      sourceVersion: 'v1',
      observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY }],
    });
    c1.close();
    const c2 = createDiscoveryCache({ dbPath: tmp });
    const rows = c2.getHistoricalProviderEvidence(HASH_X, null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].observation_count, 1);
    c2.close();
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});
