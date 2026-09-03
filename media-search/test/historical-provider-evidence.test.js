/**
 * Historical Provider Evidence Tests — source-vs-snapshot model
 *
 * Proves the durable historical-provider-evidence landing zone and its
 * integration into the confidence projection.
 *
 * Source-vs-snapshot semantics (this slice):
 *
 *   Aggregate identity = (provider, source_id, infoHash, fileIndexKey,
 *                         evidenceType)
 *   Snapshot identity  = (provider, source_id, source_version,
 *                         infoHash, fileIndexKey, evidenceType)
 *
 *   Replay (same source_id + same source_version) is idempotent at both
 *   the sightings table and the aggregate. Distinct source_versions
 *   of the SAME source_id are repeated sightings, not corroboration.
 *
 * Proof tests (spec section "PROVE"):
 *
 *   P1.  S/V1 contains X               → sightings=1,  aggregate DSC=1
 *   P2.  Replay S/V1                   → sightings=1,  aggregate DSC=1,
 *                                          full state identical
 *   P3.  S/V2 contains X               → sightings=2,  aggregate DSC=2,
 *                                          same independent source count=1
 *   P4.  Independent source T/V1       → sightings+=1, aggregate DSC for
 *                                          T=1, independent sources=2
 *   P5.  S/V1 + S/V2                   → corroboration unchanged from S/V1
 *   P6.  S/V1 + T/V1                   → corroboration += 1
 *   P7.  Shuffled order                → identical state, identical proj
 *   P8.  firstSeen/lastSeen monotonic
 *   P9.  Fresh provider precedence unchanged
 *   P10. No identity mutation
 *
 * Plus:
 *   - infoHash validation narrowed to 40-char SHA-1 (HashSucker canonical)
 *   - 100k-row synthetic perf / idempotency test
 *   - Persistence across cache close/reopen
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

// Convenience: ingest one observation set.
function ingest(cache, opts) {
  return cache.ingestHistoricalProviderEvidence({
    now: NOW,
    evidenceType: 'historical_hit',
    ...opts,
  });
}

// =============================================================================
// P1. S/V1 contains X  → sightings=1, aggregate DSC=1
// =============================================================================
test('P1. S/V1 contains X: sightings=1, aggregate DSC=1', () => {
  const cache = makeCache();
  const r = ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  assert.equal(r.ingested, 1);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.errors, []);
  assert.equal(r.aggregateRows, 1);
  assert.equal(r.snapshots, 1);

  // Sightings and aggregate counts both 1
  assert.equal(cache.countHistoricalProviderSightings(), 1);
  assert.equal(cache.countHistoricalProviderEvidence(), 1);

  const rows = cache.getHistoricalProviderEvidence(HASH_X, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'realdebrid');
  assert.equal(rows[0].source_id, 'rd-history');
  assert.equal(rows[0].evidence_type, 'historical_hit');
  assert.equal(rows[0].distinct_snapshot_count, 1);
  cache.close();
});

// =============================================================================
// P2. Replay S/V1  → sightings still 1, aggregate DSC still 1, state identical
// =============================================================================
test('P2. replay S/V1: sightings unchanged, aggregate DSC unchanged, state identical', () => {
  const cache = makeCache();
  const opts = {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations: [
      { infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY, firstSeenAt: NOW - 30 * DAY },
    ],
  };
  ingest(cache, opts);
  const before = cache.getHistoricalProviderEvidence(HASH_X, null);
  const beforeSightings = cache.countHistoricalProviderSightings();
  const beforeAggregate = cache.countHistoricalProviderEvidence();
  const r2 = ingest(cache, opts);
  // ingest returns ingested=1 (the call attempted 1 row); replay is a no-op
  assert.equal(r2.ingested, 1);
  // but neither table actually gained a row
  assert.equal(cache.countHistoricalProviderSightings(), beforeSightings);
  assert.equal(cache.countHistoricalProviderEvidence(), beforeAggregate);

  const after = cache.getHistoricalProviderEvidence(HASH_X, null);
  assert.deepEqual(after, before, 'aggregate row must be byte-identical after replay');
  assert.equal(after[0].distinct_snapshot_count, 1,
    'distinct_snapshot_count must NOT increment on replay');
  cache.close();
});

// =============================================================================
// P3. S/V2 contains X  → sightings=2, aggregate DSC=2, source-count=1
// =============================================================================
test('P3. S/V2 contains X: aggregate DSC=2, but independent source-count=1', () => {
  const cache = makeCache();
  ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 5 * DAY }],
  });
  ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V2',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY }],
  });
  // Sightings: 2 (one per snapshot)
  assert.equal(cache.countHistoricalProviderSightings(), 2);
  // Aggregate: 1 row (same source_id)
  assert.equal(cache.countHistoricalProviderEvidence(), 1);
  const rows = cache.getHistoricalProviderEvidence(HASH_X, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_id, 'rd-history');
  assert.equal(rows[0].distinct_snapshot_count, 2);

  // Projection: still ONE independent family from this source.
  const proj = createConfidenceProjection(cache);
  const result = proj.project(HASH_X, null, { now: NOW });
  // The aggregate contributes to ONE corroboration family, not two.
  // (Corroboration may include other families depending on what else is
  // present; here we expect corroboration = 1 from this one source +
  // the generic provider family that PROVIDER_HISTORICAL maps to.)
  // More importantly: the historicalSourceId collapses V1+V2 to a single
  // string ("realdebrid:rd-history") — that's the unit of corroboration.
  const histEvidence = result.evidence.filter((e) => e.kind === 'PROVIDER_HISTORICAL');
  assert.equal(histEvidence.length, 1,
    'aggregate must collapse to a single PROVIDER_HISTORICAL item');
  assert.equal(histEvidence[0].historicalSourceId, 'realdebrid:rd-history');
  cache.close();
});

// =============================================================================
// P4. Independent source T/V1 contains X  → aggregate DSC for T=1, sources=2
// =============================================================================
test('P4. independent source T/V1 contains X: independent source count = 2', () => {
  const cache = makeCache();
  ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  ingest(cache, {
    provider: 'other-provider',
    sourceId: 'op-history',
    sourceVersion: 'V1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  // Two aggregate rows (two independent sources)
  assert.equal(cache.countHistoricalProviderEvidence(), 2);
  const rows = cache.getHistoricalProviderEvidence(HASH_X, null);
  const sources = rows.map((r) => r.source_id).sort();
  assert.deepEqual(sources, ['op-history', 'rd-history']);

  const proj = createConfidenceProjection(cache);
  const result = proj.project(HASH_X, null, { now: NOW });
  // Two distinct historicalSourceIds ⇒ two corroboration families.
  const histEvidence = result.evidence.filter((e) => e.kind === 'PROVIDER_HISTORICAL');
  const ids = histEvidence.map((e) => e.historicalSourceId).sort();
  assert.deepEqual(ids, ['other-provider:op-history', 'realdebrid:rd-history'].sort());
  assert.ok(result.corroboration >= 2,
    `corroboration should be >= 2, got ${result.corroboration}`);
  cache.close();
});

// =============================================================================
// P5. S/V1 + S/V2 must NOT produce more corroboration families than S/V1 alone
// =============================================================================
test('P5. S/V1 + S/V2 do not raise corroboration beyond S/V1 alone', () => {
  // Cache A: only S/V1
  const a = makeCache();
  ingest(a, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  const projA = createConfidenceProjection(a);
  const corA = projA.project(HASH_X, null, { now: NOW }).corroboration;

  // Cache B: S/V1 + S/V2
  const b = makeCache();
  ingest(b, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  ingest(b, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V2',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  const projB = createConfidenceProjection(b);
  const corB = projB.project(HASH_X, null, { now: NOW }).corroboration;

  assert.equal(corB, corA,
    `corroboration with V2 must equal corroboration without V2, got ${corB} vs ${corA}`);
  // availabilityPrior must also be the same: distinct_snapshot_count went
  // up but the family is still ONE, contributing +0.20 once.
  const priA = projA.project(HASH_X, null, { now: NOW }).availabilityPrior;
  const priB = projB.project(HASH_X, null, { now: NOW }).availabilityPrior;
  assert.equal(priA, priB,
    `availabilityPrior with V2 must equal availabilityPrior without V2, got ${priB} vs ${priA}`);
  a.close(); b.close();
});

// =============================================================================
// P6. S/V1 + T/V1 MUST increase corroboration
// =============================================================================
test('P6. S/V1 + T/V1 raises corroboration vs S/V1 alone', () => {
  const a = makeCache();
  ingest(a, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  const projA = createConfidenceProjection(a);
  const corA = projA.project(HASH_X, null, { now: NOW }).corroboration;

  const b = makeCache();
  ingest(b, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  ingest(b, {
    provider: 'torbox',
    sourceId: 'torbox-history',
    sourceVersion: 'V1',
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }],
  });
  const projB = createConfidenceProjection(b);
  const corB = projB.project(HASH_X, null, { now: NOW }).corroboration;

  assert.ok(corB > corA,
    `corroboration with T/V1 must be > corroboration without, got ${corB} vs ${corA}`);
  // availabilityPrior must increase (one more family adds +0.20×decay).
  const priA = projA.project(HASH_X, null, { now: NOW }).availabilityPrior;
  const priB = projB.project(HASH_X, null, { now: NOW }).availabilityPrior;
  assert.ok(priB > priA,
    `availabilityPrior with T/V1 must be > availabilityPrior without, got ${priB} vs ${priA}`);
  a.close(); b.close();
});

// =============================================================================
// P7. Shuffled import/replay order produces identical logical state
// =============================================================================
test('P7. shuffled import/replay order produces identical logical state and projection', () => {
  function build(seedOrder) {
    const c = makeCache();
    for (const step of seedOrder) {
      ingest(c, step);
    }
    return c;
  }

  const orderA = [
    { provider: 'realdebrid', sourceId: 'rd-history', sourceVersion: 'V1',
      observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 5 * DAY }] },
    { provider: 'realdebrid', sourceId: 'rd-history', sourceVersion: 'V1',
      observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 5 * DAY }] },
    { provider: 'realdebrid', sourceId: 'rd-history', sourceVersion: 'V2',
      observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY }] },
    { provider: 'torbox', sourceId: 'torbox-history', sourceVersion: 'V1',
      observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }] },
  ];
  const orderB = [
    { provider: 'torbox', sourceId: 'torbox-history', sourceVersion: 'V1',
      observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 2 * DAY }] },
    { provider: 'realdebrid', sourceId: 'rd-history', sourceVersion: 'V2',
      observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY }] },
    { provider: 'realdebrid', sourceId: 'rd-history', sourceVersion: 'V1',
      observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 5 * DAY }] },
    { provider: 'realdebrid', sourceId: 'rd-history', sourceVersion: 'V1',
      observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 5 * DAY }] },
  ];

  const a = build(orderA);
  const b = build(orderB);

  // Same aggregate row count and per-candidate state
  assert.equal(a.countHistoricalProviderEvidence(), b.countHistoricalProviderEvidence());
  assert.equal(a.countHistoricalProviderSightings(), b.countHistoricalProviderSightings());

  const ra = a.getHistoricalProviderEvidence(HASH_X, null);
  const rb = b.getHistoricalProviderEvidence(HASH_X, null);
  // Sort by source_id so order doesn't matter
  const sortKey = (r) => `${r.provider}|${r.source_id}`;
  const sa = [...ra].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  const sb = [...rb].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  assert.deepEqual(sa, sb, 'aggregate state must be identical regardless of import order');

  // Projections match
  const pa = createConfidenceProjection(a);
  const pb = createConfidenceProjection(b);
  const resA = pa.project(HASH_X, null, { now: NOW });
  const resB = pb.project(HASH_X, null, { now: NOW });
  assert.equal(resA.availabilityPrior, resB.availabilityPrior);
  assert.equal(resA.identityConfidence, resB.identityConfidence);
  assert.equal(resA.corroboration, resB.corroboration);
  assert.equal(resA.freshness, resB.freshness);
  assert.equal(resA.freshProvider, resB.freshProvider);
  assert.deepEqual(resA.reasons, resB.reasons);

  a.close(); b.close();
});

// =============================================================================
// P8. firstSeenAt / lastSeenAt remain monotonic across snapshot evolution
// =============================================================================
test('P8. firstSeenAt/lastSeenAt remain monotonic across V1→V2 with later/earlier timestamps', () => {
  const cache = makeCache();

  // V1 observed 30 days ago
  ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations: [{ infoHash: HASH_X, fileIndex: null, firstSeenAt: NOW - 30 * DAY, lastSeenAt: NOW - 30 * DAY }],
  });
  // V2 observed 5 days ago — later than V1
  ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V2',
    observations: [{ infoHash: HASH_X, fileIndex: null, firstSeenAt: NOW - 5 * DAY, lastSeenAt: NOW - 5 * DAY }],
  });

  let row = cache.getHistoricalProviderEvidence(HASH_X, null)[0];
  assert.equal(row.first_seen_at, NOW - 30 * DAY, 'first_seen_at = MIN across snapshots');
  assert.equal(row.last_seen_at, NOW - 5 * DAY, 'last_seen_at = MAX across snapshots');

  // V3 with earlier timestamps (out-of-order replay) — neither field moves backward
  ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V3',
    observations: [{ infoHash: HASH_X, fileIndex: null, firstSeenAt: NOW - 60 * DAY, lastSeenAt: NOW - 60 * DAY }],
  });
  row = cache.getHistoricalProviderEvidence(HASH_X, null)[0];
  assert.equal(row.first_seen_at, NOW - 60 * DAY, 'first_seen_at absorbs an even earlier snapshot');
  assert.equal(row.last_seen_at, NOW - 5 * DAY, 'last_seen_at is preserved against an earlier snapshot');
  assert.equal(row.distinct_snapshot_count, 3);
  cache.close();
});

// =============================================================================
// P9. Existing fresh-provider positive/negative precedence remains unchanged
// =============================================================================
test('P9a. historical + fresh negative: freshProvider=negative, history survives in reasons', () => {
  const cache = makeCache();
  ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
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
    state: 'uncached',
    observedAt: NOW - 5 * 60 * 1000,
    expiresAt: NOW + 24 * HOUR,
    source: 'rd-probe',
    evidence: 'uncached:no-match',
  });
  const proj = createConfidenceProjection(cache);
  const result = proj.project(HASH_X, null, { now: NOW });
  assert.equal(result.freshProvider, 'negative');
  assert.ok(result.reasons.includes('provider-fresh-negative'));
  assert.ok(result.reasons.includes('provider-historical'),
    'history survives in reasons even when fresh is negative');
  cache.close();
});

test('P9b. historical + fresh positive: freshProvider=positive', () => {
  const cache = makeCache();
  ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
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
    evidence: 'cached:hash-match',
  });
  const proj = createConfidenceProjection(cache);
  const result = proj.project(HASH_X, null, { now: NOW });
  assert.equal(result.freshProvider, 'positive');
  assert.ok(result.reasons.includes('provider-fresh-positive'));
  cache.close();
});

// =============================================================================
// P10. No identity mutation (file_index_key convention; release vs file level)
// =============================================================================
test('P10. release-level (fileIndex=null) and file-level (fileIndex=0) remain distinct identities', () => {
  const cache = makeCache();
  ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations: [
      { infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY },
      { infoHash: HASH_X, fileIndex: 0, lastSeenAt: NOW - 1 * DAY },
    ],
  });
  // Two aggregate rows (release-level + file-level)
  assert.equal(cache.countHistoricalProviderEvidence(), 2);
  assert.equal(cache.countHistoricalProviderEvidenceForCandidate(HASH_X, null), 1);
  assert.equal(cache.countHistoricalProviderEvidenceForCandidate(HASH_X, 0), 1);
  assert.equal(cache.countHistoricalProviderEvidenceForCandidate(HASH_X, 1), 0);
  cache.close();
});

// =============================================================================
// infoHash validation: 40-char SHA-1 only (no BitTorrent v2 in project)
// =============================================================================
test('infoHash: 40-char SHA-1 accepted; 64-char SHA-256 rejected; malformed rejected', () => {
  const cache = makeCache();
  const sha256 = 'a'.repeat(64);
  const r = ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations: [
      { infoHash: 'not-a-hash', fileIndex: null },
      { infoHash: HASH_X, fileIndex: null },
      { infoHash: 'cafebabe', fileIndex: null },
      { infoHash: null, fileIndex: null },
      { infoHash: sha256, fileIndex: null },         // 64-char rejected
      { infoHash: HASH_Y.toUpperCase(), fileIndex: 0 }, // upper-case normalized
    ],
  });
  assert.equal(r.ingested, 2);
  assert.equal(r.skipped, 4);
  assert.equal(r.errors.length, 4);
  // The two valid rows ARE persisted
  assert.equal(cache.countHistoricalProviderEvidence(), 2);
  // No row exists for the SHA-256 string
  assert.equal(cache.countHistoricalProviderEvidenceForCandidate(sha256, null), 0);
  // The upper-case SHA-1 was normalized to lowercase
  assert.equal(cache.countHistoricalProviderEvidenceForCandidate(HASH_Y, 0), 1);
  cache.close();
});

test('infoHash: sourceVersion is required (snapshot identity must be tracked)', () => {
  const cache = makeCache();
  const r = ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: '', // empty — not allowed
    observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY }],
  });
  assert.equal(r.ingested, 0);
  assert.equal(r.skipped, 0);
  assert.ok(r.errors.some((e) => /sourceVersion/.test(e.message)),
    `expected sourceVersion error, got: ${JSON.stringify(r.errors)}`);
  assert.equal(cache.countHistoricalProviderEvidence(), 0);
  cache.close();
});

// =============================================================================
// No historical evidence: projection behavior is unchanged from baseline
// =============================================================================
test('no historical evidence: projection matches the empty-prior baseline', () => {
  const cache = makeCache();
  const proj = createConfidenceProjection(cache);
  const result = proj.project(HASH_X, null, { now: NOW });
  assert.equal(result.availabilityPrior, 0);
  assert.equal(result.identityConfidence, 0);
  assert.equal(result.corroboration, 0);
  assert.equal(result.freshProvider, null);
  cache.close();
});

// =============================================================================
// Partial batch failure: invalid rows skipped, valid rows committed
// =============================================================================
test('partial batch: invalid rows skipped, valid rows committed', () => {
  const cache = makeCache();
  const r = ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
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
// 100k-row synthetic perf / idempotency
// =============================================================================
test('performance: 100k historical sightings ingest; replay is no-op; aggregate correct', () => {
  const cache = makeCache();
  const N = 100_000;
  const observations = [];
  for (let i = 0; i < N; i++) {
    // Deterministic 40-char hex hashes
    const h = (i.toString(16).padStart(8, '0') + '0'.repeat(32)).slice(0, 40);
    observations.push({ infoHash: h, fileIndex: null, lastSeenAt: NOW - 1 * DAY });
  }
  const t0 = Date.now();
  const r1 = ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations,
  });
  const t1 = Date.now();
  assert.equal(r1.ingested, N);
  assert.equal(r1.skipped, 0);
  assert.equal(cache.countHistoricalProviderSightings(), N);
  assert.equal(cache.countHistoricalProviderEvidence(), N);

  // Replay same snapshot
  const t2 = Date.now();
  const r2 = ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V1',
    observations,
  });
  const t3 = Date.now();
  assert.equal(r2.ingested, N);
  // Sightings and aggregate row counts unchanged
  assert.equal(cache.countHistoricalProviderSightings(), N,
    'replay must not duplicate sightings');
  assert.equal(cache.countHistoricalProviderEvidence(), N,
    'replay must not duplicate aggregate rows');
  // Each aggregate row's DSC must still be 1 (not 2)
  const sample = cache.getHistoricalProviderEvidence(observations[0].infoHash, null);
  assert.equal(sample[0].distinct_snapshot_count, 1,
    'distinct_snapshot_count must NOT increment on replay');

  // A new snapshot version bumps DSC and corroboration stays at 1 family
  ingest(cache, {
    provider: 'realdebrid',
    sourceId: 'rd-history',
    sourceVersion: 'V2',
    observations,
  });
  assert.equal(cache.countHistoricalProviderSightings(), N * 2,
    'V2 must double sightings count (one per hash)');
  assert.equal(cache.countHistoricalProviderEvidence(), N,
    'aggregate still one row per (provider, source_id, hash)');
  const sampleV2 = cache.getHistoricalProviderEvidence(observations[0].infoHash, null);
  assert.equal(sampleV2[0].distinct_snapshot_count, 2);

  // eslint-disable-next-line no-console
  console.log(
    `[perf] 100k first=${t1 - t0}ms replay=${t3 - t2}ms v2=${Date.now() - t3}ms rows=${N}`,
  );
  cache.close();
});

// =============================================================================
// Persistence across cache close/reopen
// =============================================================================
test('historical evidence persists across cache close/reopen', () => {
  const tmp = pathLib.join(os.tmpdir(), `hpe-test-${Date.now()}-${Math.random()}.db`);
  try {
    const c1 = createDiscoveryCache({ dbPath: tmp });
    ingest(c1, {
      provider: 'realdebrid',
      sourceId: 'rd-history',
      sourceVersion: 'V1',
      observations: [{ infoHash: HASH_X, fileIndex: null, lastSeenAt: NOW - 1 * DAY }],
    });
    c1.close();
    const c2 = createDiscoveryCache({ dbPath: tmp });
    const rows = c2.getHistoricalProviderEvidence(HASH_X, null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_id, 'rd-history');
    assert.equal(rows[0].distinct_snapshot_count, 1);
    c2.close();
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});