/**
 * Canonical Normalization Tests
 *
 * Proves:
 * - Local and live results normalize to the same candidate shape
 * - Exact duplicate releaseKeys merge evidence
 * - Same hash/different fileIndex remain separate
 * - Null vs zero fileIndex remain separate
 * - Live does not manufacture candidate_media or authoritative observations
 * - Provider hints remain evidence only
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  toCanonicalLocal,
  toCanonicalLive,
  mergeExactDuplicates,
  deduplicateByReleaseKey,
  toRankingInput,
} from '../src/lib/discovery/canonical.js';
import { rankHit } from '../src/lib/discovery/ranking.js';
import { createReleaseKey } from '../src/api/release-contract.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccccccccccc';

// =============================================================================
// Local Normalization Tests
// =============================================================================

test('toCanonicalLocal: preserves exact identity', () => {
  const row = {
    hash: HASH_A,
    fileIndex: 0,
    releaseKey: createReleaseKey(HASH_A, 0),
    filename: 'Movie.2024.1080p.mkv',
    relevance: 0.85,
    parsed: {
      title: 'Movie',
      year: 2024,
      resolution: '1080p',
      sourceType: 'BluRay',
    },
    confidence: 0.9,
    components: { relevance: 0.85, releaseConfidence: 0.9 },
    media: [{ mediaId: 'tt123', confidence: 0.95 }],
    providers: [{ provider: 'torbox', cached: true, evidence: ['api-response'] }],
  };

  const canonical = toCanonicalLocal(row);

  assert.equal(canonical.hash, HASH_A);
  assert.equal(canonical.fileIndex, 0);
  assert.equal(canonical.releaseKey, `${HASH_A}:0`);
  assert.equal(canonical.filename, 'Movie.2024.1080p.mkv');
  assert.equal(canonical.relevance, 0.85);
  assert.equal(canonical.parserConfidence, 0.9);
  assert.equal(canonical.mediaAssociations.length, 1);
  assert.equal(canonical.mediaAssociations[0].mediaId, 'tt123');
  assert.equal(canonical.providerObservations.length, 1);
  assert.equal(canonical.providerObservations[0].provider, 'torbox');
  assert.equal(canonical.sources.length, 1);
  assert.equal(canonical.sources[0].origin, 'corpus');
});

test('toCanonicalLocal: null fileIndex remains distinct from zero', () => {
  const row = {
    hash: HASH_A,
    fileIndex: null,
    releaseKey: createReleaseKey(HASH_A, null),
    filename: 'Movie.2024.1080p.mkv',
    relevance: 0.5,
    parsed: { title: 'Movie' },
    confidence: 0.8,
    components: {},
    media: [],
    providers: [],
  };

  const canonical = toCanonicalLocal(row);

  assert.equal(canonical.fileIndex, null);
  assert.equal(canonical.releaseKey, `${HASH_A}:torrent`);
});

test('toCanonicalLocal: preserves null fileIndex vs zero', () => {
  const rowNull = {
    hash: HASH_A,
    fileIndex: null,
    releaseKey: createReleaseKey(HASH_A, null),
    filename: 'torrent-level.mkv',
    relevance: 0.5,
    parsed: {},
    confidence: 0.5,
    components: {},
    media: [],
    providers: [],
  };
  const rowZero = {
    hash: HASH_A,
    fileIndex: 0,
    releaseKey: createReleaseKey(HASH_A, 0),
    filename: 'file-zero.mkv',
    relevance: 0.5,
    parsed: {},
    confidence: 0.5,
    components: {},
    media: [],
    providers: [],
  };

  const canonNull = toCanonicalLocal(rowNull);
  const canonZero = toCanonicalLocal(rowZero);

  assert.notEqual(canonNull.releaseKey, canonZero.releaseKey);
  assert.equal(canonNull.releaseKey, `${HASH_A}:torrent`);
  assert.equal(canonZero.releaseKey, `${HASH_A}:0`);
});

// =============================================================================
// Live Normalization Tests
// =============================================================================

test('toCanonicalLive: normalizes to same shape as local', () => {
  const raw = {
    infoHash: HASH_B,
    fileIndex: null,
    filename: 'Movie.2024.720p.mkv',
    title: 'Movie',
    year: 2024,
    resolution: '720p',
    source: 'WEB-DL',
    codec: 'x264',
    confidence: 0.7,
    sources: [{ addonId: 'torrentio.torbox', addonName: 'Torrentio' }],
  };

  const canonical = toCanonicalLive(raw);

  assert.equal(canonical.hash, HASH_B);
  assert.equal(canonical.fileIndex, null);
  assert.equal(canonical.releaseKey, `${HASH_B}:torrent`);
  assert.equal(canonical.filename, 'Movie.2024.720p.mkv');
  assert.equal(canonical.relevance, 0.5); // NEUTRAL for live
  assert.equal(canonical.parserConfidence, 0.7);
  assert.equal(canonical.mediaAssociations.length, 0); // No manufactured associations
  assert.equal(canonical.providerObservations.length, 0); // No authoritative observations
  assert.equal(canonical.sources.length, 1);
  assert.equal(canonical.sources[0].origin, 'live');
});

test('toCanonicalLive: does not manufacture candidate_media from hints', () => {
  const raw = {
    infoHash: HASH_B,
    fileIndex: 0,
    filename: 'Movie.2024.720p.mkv',
    title: 'Movie',
    confidence: 0.8,
    // Simulating a live source that includes media-like hints
    mediaId: 'tt999',
  };

  const canonical = toCanonicalLive(raw);

  // Live normalization must NOT create media associations from hints
  assert.equal(canonical.mediaAssociations.length, 0);
});

test('toCanonicalLive: provider cache hints remain evidence only', () => {
  const raw = {
    infoHash: HASH_B,
    fileIndex: null,
    filename: 'Movie.2024.720p.mkv',
    title: 'Movie',
    confidence: 0.6,
    // Simulating Torrentio cache hint
    providers: { torbox: { cached: true, evidence: ['torrentio-hint'] } },
  };

  const canonical = toCanonicalLive(raw);

  // Provider hints from Torrentio must NOT become authoritative observations
  assert.equal(canonical.providerObservations.length, 0);

  // Provider hint MUST survive as non-authoritative source/provenance evidence
  assert.ok(canonical.sources.length > 0, 'Provider hint must survive as source evidence');
  const hintSource = canonical.sources.find(s => s.evidenceType === 'provider-hint:torbox');
  assert.ok(hintSource, 'Provider hint source must be present');
  assert.ok(hintSource.providerHint, 'Provider hint source must carry providerHint');
  assert.equal(hintSource.providerHint.cached, true, 'Provider hint cached state preserved');
  assert.deepEqual(hintSource.providerHint.evidence, ['torrentio-hint'], 'Provider hint evidence preserved');
  assert.equal(hintSource.origin, 'live', 'Provider hint source origin is live');
});

test('toCanonicalLive: preserves selectedMediaId as intent provenance', () => {
  const raw = {
    infoHash: HASH_B,
    fileIndex: null,
    filename: 'Breaking.Bad.S05E14.720p.mkv',
    title: 'Breaking Bad',
    season: 5,
    episode: 14,
    resolution: '720p',
    confidence: 0.8,
    sources: [{ addonId: 'torrentio.torbox' }],
  };

  const canonical = toCanonicalLive(raw, { selectedMediaId: 'tt0944947' });

  // selectedMediaId is preserved as intent provenance, NOT as persisted identity
  assert.equal(canonical.selectedMediaId, 'tt0944947', 'selectedMediaId preserved as provenance');

  // Live candidates never have candidate_media associations
  assert.equal(canonical.mediaAssociations.length, 0, 'No candidate_media manufactured');

  // selectedMediaId does NOT become a media association
  // It's purely provenance showing live discovery was scoped by selected media
});

test('toCanonicalLive: uses provided releaseKey when available', () => {
  const raw = {
    infoHash: HASH_B,
    fileIndex: 2,
    releaseKey: `${HASH_B}:2`,
    filename: 'Movie.2024.720p.mkv',
    title: 'Movie',
    confidence: 0.7,
  };

  const canonical = toCanonicalLive(raw);

  assert.equal(canonical.releaseKey, `${HASH_B}:2`);
  assert.equal(canonical.fileIndex, 2);
});

test('toCanonicalLive: missing evidence is neutral, not penalized', () => {
  const raw = {
    infoHash: HASH_B,
    fileIndex: null,
    filename: 'unknown.mkv',
    // Minimal info — no resolution, source, etc.
  };

  const canonical = toCanonicalLive(raw);

  // Should still produce valid canonical shape with neutral defaults
  assert.equal(canonical.hash, HASH_B);
  assert.equal(canonical.relevance, 0.5); // NEUTRAL
  assert.equal(canonical.parserConfidence, 0.5); // NEUTRAL
  assert.equal(canonical.releaseAttributes.resolution, null);
  assert.equal(canonical.releaseAttributes.sourceType, null);
});

// =============================================================================
// Merge Tests
// =============================================================================

test('mergeExactDuplicates: preserves evidence from both sources', () => {
  const local = {
    hash: HASH_A,
    fileIndex: 0,
    releaseKey: `${HASH_A}:0`,
    filename: 'Movie.2024.1080p.mkv',
    relevance: 0.9,
    releaseAttributes: { title: 'Movie', year: 2024, resolution: '1080p', sourceType: 'BluRay' },
    parserConfidence: 0.95,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.9 }],
    providerObservations: [{ provider: 'torbox', cached: true }],
    sources: [{ origin: 'corpus', evidenceType: 'fts5-ranked', confidence: 0.95 }],
  };

  const live = {
    hash: HASH_A,
    fileIndex: 0,
    releaseKey: `${HASH_A}:0`,
    filename: 'Movie.2024.1080p.WEB-DL.mkv',
    relevance: 0.5,
    releaseAttributes: { title: 'Movie', year: 2024, resolution: '1080p', sourceType: 'WEB-DL' },
    parserConfidence: 0.7,
    mediaAssociations: [],
    providerObservations: [],
    sources: [{ origin: 'live', evidenceType: 'torrentio.torbox', confidence: 0.7 }],
  };

  const merged = mergeExactDuplicates(local, live);

  // Identity preserved
  assert.equal(merged.hash, HASH_A);
  assert.equal(merged.fileIndex, 0);
  assert.equal(merged.releaseKey, `${HASH_A}:0`);

  // Sources merged (both origins present)
  assert.equal(merged.sources.length, 2);
  assert.ok(merged.sources.some(s => s.origin === 'corpus'));
  assert.ok(merged.sources.some(s => s.origin === 'live'));

  // Media associations preserved
  assert.equal(merged.mediaAssociations.length, 1);
  assert.equal(merged.mediaAssociations[0].mediaId, 'tt123');

  // Provider observations preserved
  assert.equal(merged.providerObservations.length, 1);

  // Higher confidence wins for attributes
  assert.equal(merged.parserConfidence, 0.95);

  // Higher relevance wins
  assert.equal(merged.relevance, 0.9);
});

test('mergeExactDuplicates: does not overwrite high-confidence with weak', () => {
  const local = {
    hash: HASH_A,
    fileIndex: 0,
    releaseKey: `${HASH_A}:0`,
    filename: 'Movie.2024.1080p.mkv',
    relevance: 0.8,
    releaseAttributes: { resolution: '1080p', sourceType: 'BluRay', codec: 'x265' },
    parserConfidence: 0.95,
    mediaAssociations: [],
    providerObservations: [],
    sources: [{ origin: 'corpus', evidenceType: 'fts5-ranked', confidence: 0.95 }],
  };

  const live = {
    hash: HASH_A,
    fileIndex: 0,
    releaseKey: `${HASH_A}:0`,
    filename: 'Movie.mkv',
    relevance: 0.5,
    releaseAttributes: { resolution: '1080p', sourceType: 'WEB-DL', codec: null },
    parserConfidence: 0.6,
    mediaAssociations: [],
    providerObservations: [],
    sources: [{ origin: 'live', evidenceType: 'live-discovery', confidence: 0.6 }],
  };

  const merged = mergeExactDuplicates(local, live);

  // Stronger source's codec (x265) wins over weaker's null
  assert.equal(merged.releaseAttributes.codec, 'x265');
  // Stronger source's sourceType (BluRay) wins over weaker's WEB-DL
  assert.equal(merged.releaseAttributes.sourceType, 'BluRay');
});

test('mergeExactDuplicates: throws on different releaseKeys', () => {
  const a = {
    hash: HASH_A, fileIndex: 0, releaseKey: `${HASH_A}:0`,
    filename: '', relevance: 0, releaseAttributes: {}, parserConfidence: 0,
    mediaAssociations: [], providerObservations: [], sources: [],
  };
  const b = {
    hash: HASH_B, fileIndex: 0, releaseKey: `${HASH_B}:0`,
    filename: '', relevance: 0, releaseAttributes: {}, parserConfidence: 0,
    mediaAssociations: [], providerObservations: [], sources: [],
  };

  assert.throws(() => mergeExactDuplicates(a, b), /Cannot merge different releaseKeys/);
});

test('mergeExactDuplicates: throws on different fileIndex', () => {
  const a = {
    hash: HASH_A, fileIndex: 0, releaseKey: `${HASH_A}:0`,
    filename: '', relevance: 0, releaseAttributes: {}, parserConfidence: 0,
    mediaAssociations: [], providerObservations: [], sources: [],
  };
  const b = {
    hash: HASH_A, fileIndex: 1, releaseKey: `${HASH_A}:1`,
    filename: '', relevance: 0, releaseAttributes: {}, parserConfidence: 0,
    mediaAssociations: [], providerObservations: [], sources: [],
  };

  // Different fileIndex with same hash produces different releaseKey,
  // so releaseKey check fires first (which is correct behavior)
  assert.throws(() => mergeExactDuplicates(a, b), /Cannot merge different/);
});

// =============================================================================
// Dedup Tests
// =============================================================================

test('deduplicateByReleaseKey: merges exact duplicates', () => {
  const candidates = [
    {
      hash: HASH_A, fileIndex: 0, releaseKey: `${HASH_A}:0`,
      filename: 'local.mkv', relevance: 0.9, releaseAttributes: { resolution: '1080p' },
      parserConfidence: 0.9, mediaAssociations: [], providerObservations: [],
      sources: [{ origin: 'corpus', evidenceType: 'fts5', confidence: 0.9 }],
    },
    {
      hash: HASH_A, fileIndex: 0, releaseKey: `${HASH_A}:0`,
      filename: 'live.mkv', relevance: 0.5, releaseAttributes: { codec: 'x265' },
      parserConfidence: 0.7, mediaAssociations: [], providerObservations: [],
      sources: [{ origin: 'live', evidenceType: 'torrentio', confidence: 0.7 }],
    },
  ];

  const deduped = deduplicateByReleaseKey(candidates);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].sources.length, 2); // Both sources preserved
});

test('deduplicateByReleaseKey: keeps distinct releaseKeys', () => {
  const candidates = [
    {
      hash: HASH_A, fileIndex: 0, releaseKey: `${HASH_A}:0`,
      filename: 'a.mkv', relevance: 0.5, releaseAttributes: {}, parserConfidence: 0.5,
      mediaAssociations: [], providerObservations: [], sources: [],
    },
    {
      hash: HASH_A, fileIndex: 1, releaseKey: `${HASH_A}:1`,
      filename: 'b.mkv', relevance: 0.5, releaseAttributes: {}, parserConfidence: 0.5,
      mediaAssociations: [], providerObservations: [], sources: [],
    },
    {
      hash: HASH_B, fileIndex: null, releaseKey: `${HASH_B}:torrent`,
      filename: 'c.mkv', relevance: 0.5, releaseAttributes: {}, parserConfidence: 0.5,
      mediaAssociations: [], providerObservations: [], sources: [],
    },
  ];

  const deduped = deduplicateByReleaseKey(candidates);

  assert.equal(deduped.length, 3);
  const keys = deduped.map(c => c.releaseKey).sort();
  assert.deepEqual(keys, [`${HASH_A}:0`, `${HASH_A}:1`, `${HASH_B}:torrent`]);
});

test('deduplicateByReleaseKey: H:0 and H:null remain separate', () => {
  const candidates = [
    {
      hash: HASH_A, fileIndex: 0, releaseKey: `${HASH_A}:0`,
      filename: 'file0.mkv', relevance: 0.5, releaseAttributes: {}, parserConfidence: 0.5,
      mediaAssociations: [], providerObservations: [], sources: [],
    },
    {
      hash: HASH_A, fileIndex: null, releaseKey: `${HASH_A}:torrent`,
      filename: 'torrent.mkv', relevance: 0.5, releaseAttributes: {}, parserConfidence: 0.5,
      mediaAssociations: [], providerObservations: [], sources: [],
    },
  ];

  const deduped = deduplicateByReleaseKey(candidates);

  assert.equal(deduped.length, 2);
});

// =============================================================================
// Ranking Input Tests
// =============================================================================

test('toRankingInput: maps canonical to ranking shape', () => {
  const canonical = {
    hash: HASH_A,
    fileIndex: 0,
    releaseKey: `${HASH_A}:0`,
    filename: 'Movie.2024.1080p.mkv',
    relevance: 0.85,
    releaseAttributes: { title: 'Movie', resolution: '1080p' },
    parserConfidence: 0.9,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.95 }],
    providerObservations: [{ provider: 'torbox', cached: true }],
    sources: [{ origin: 'corpus', evidenceType: 'fts5-ranked', confidence: 0.9 }],
    selectedMediaId: null,
  };

  const ranking = toRankingInput(canonical);

  assert.equal(ranking.hash, HASH_A);
  assert.equal(ranking.fileIndex, 0);
  assert.equal(ranking.filename, 'Movie.2024.1080p.mkv');
  assert.equal(ranking.relevance, 0.85);
  assert.equal(ranking.parserConfidence, 0.9);
  assert.equal(ranking.mediaAssociations.length, 1);
  assert.equal(ranking.providerObservations.length, 1);
  // Sources and selectedMediaId ARE preserved through ranking boundary
  assert.ok(Array.isArray(ranking.sources), 'sources must be preserved');
  assert.equal(ranking.sources.length, 1);
  assert.equal(ranking.sources[0].origin, 'corpus');
  assert.equal(ranking.selectedMediaId, null);
});

// =============================================================================
// Provenance Through Ranking Tests
// =============================================================================

test('PROVENANCE: pure live result remains identifiable as live through ranking', () => {
  const liveCanonical = {
    hash: HASH_A,
    fileIndex: null,
    releaseKey: `${HASH_A}:torrent`,
    filename: 'Movie.2024.1080p.mkv',
    relevance: 0.5,
    releaseAttributes: { title: 'Movie', resolution: '1080p', sourceType: 'BluRay' },
    parserConfidence: 0.8,
    mediaAssociations: [],
    providerObservations: [],
    sources: [{ origin: 'live', evidenceType: 'torrentio.torbox', confidence: 0.8 }],
    selectedMediaId: null,
  };

  const rankingInput = toRankingInput(liveCanonical);
  const ranked = rankHit(rankingInput);

  // Sources must survive ranking
  assert.ok(Array.isArray(ranked.sources), 'ranked.sources must be an array');
  assert.equal(ranked.sources.length, 1);
  assert.equal(ranked.sources[0].origin, 'live', 'Pure live must retain live origin');
});

test('PROVENANCE: pure corpus result remains identifiable as corpus through ranking', () => {
  const corpusCanonical = {
    hash: HASH_A,
    fileIndex: 0,
    releaseKey: `${HASH_A}:0`,
    filename: 'Movie.2024.1080p.mkv',
    relevance: 0.85,
    releaseAttributes: { title: 'Movie', resolution: '1080p', sourceType: 'BluRay' },
    parserConfidence: 0.9,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.95 }],
    providerObservations: [],
    sources: [{ origin: 'corpus', evidenceType: 'fts5-ranked', confidence: 0.9 }],
    selectedMediaId: null,
  };

  const rankingInput = toRankingInput(corpusCanonical);
  const ranked = rankHit(rankingInput);

  assert.ok(Array.isArray(ranked.sources), 'ranked.sources must be an array');
  assert.equal(ranked.sources.length, 1);
  assert.equal(ranked.sources[0].origin, 'corpus', 'Pure corpus must retain corpus origin');
});

test('PROVENANCE: exact local+live duplicate retains both origins through ranking', () => {
  // Simulate merged local+live candidate (from deduplicateByReleaseKey)
  const mergedCanonical = {
    hash: HASH_A,
    fileIndex: null,
    releaseKey: `${HASH_A}:torrent`,
    filename: 'Movie.2024.1080p.mkv',
    relevance: 0.85,
    releaseAttributes: { title: 'Movie', resolution: '1080p', sourceType: 'BluRay' },
    parserConfidence: 0.9,
    mediaAssociations: [{ mediaId: 'tt123', confidence: 0.95 }],
    providerObservations: [],
    sources: [
      { origin: 'corpus', evidenceType: 'fts5-ranked', confidence: 0.9 },
      { origin: 'live', evidenceType: 'torrentio.torbox', confidence: 0.8 },
    ],
    selectedMediaId: null,
  };

  const rankingInput = toRankingInput(mergedCanonical);
  const ranked = rankHit(rankingInput);

  // Both origins must survive
  assert.ok(Array.isArray(ranked.sources), 'ranked.sources must be an array');
  assert.equal(ranked.sources.length, 2, 'Both sources must survive ranking');
  const origins = ranked.sources.map(s => s.origin).sort();
  assert.deepEqual(origins, ['corpus', 'live'], 'Both corpus and live origins preserved');
});

test('PROVENANCE: ranking does not erase sources', () => {
  const canonical = {
    hash: HASH_B,
    fileIndex: 1,
    releaseKey: `${HASH_B}:1`,
    filename: 'Movie.2024.720p.mkv',
    relevance: 0.5,
    releaseAttributes: { resolution: '720p', sourceType: 'WEB-DL' },
    parserConfidence: 0.7,
    mediaAssociations: [],
    providerObservations: [],
    sources: [
      { origin: 'live', evidenceType: 'provider-hint:torbox', confidence: 0.7, providerHint: { cached: true, evidence: ['hint'] } },
      { origin: 'live', evidenceType: 'torrentio.torbox', confidence: 0.7 },
    ],
    selectedMediaId: 'tt456',
  };

  const rankingInput = toRankingInput(canonical);
  const ranked = rankHit(rankingInput);

  // All sources must survive
  assert.equal(ranked.sources.length, 2, 'All sources must survive ranking');
  assert.equal(ranked.selectedMediaId, 'tt456', 'selectedMediaId preserved through ranking');
  // Provider hint source must still carry providerHint
  const hintSource = ranked.sources.find(s => s.evidenceType === 'provider-hint:torbox');
  assert.ok(hintSource, 'Provider hint source must survive ranking');
  assert.ok(hintSource.providerHint, 'providerHint must survive ranking');
  assert.equal(hintSource.providerHint.cached, true);
});

// =============================================================================
// Determinism Test
// =============================================================================

test('deduplicateByReleaseKey: deterministic output for same input', () => {
  const candidates = [
    {
      hash: HASH_A, fileIndex: 0, releaseKey: `${HASH_A}:0`,
      filename: 'a.mkv', relevance: 0.5, releaseAttributes: {}, parserConfidence: 0.5,
      mediaAssociations: [], providerObservations: [], sources: [],
    },
    {
      hash: HASH_B, fileIndex: null, releaseKey: `${HASH_B}:torrent`,
      filename: 'b.mkv', relevance: 0.5, releaseAttributes: {}, parserConfidence: 0.5,
      mediaAssociations: [], providerObservations: [], sources: [],
    },
  ];

  const run1 = deduplicateByReleaseKey(candidates).map(c => c.releaseKey);
  const run2 = deduplicateByReleaseKey(candidates).map(c => c.releaseKey);

  assert.deepEqual(run1, run2);
});
