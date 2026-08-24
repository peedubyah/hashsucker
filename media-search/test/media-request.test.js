/**
 * Media Request API Tests
 *
 * Tests the POST /api/media-request endpoint and searchByMedia() pipeline.
 * Covers:
 * - known media ID with enriched candidates
 * - known media ID without enrichment
 * - no candidates found
 * - ranking order respects identity tier
 * - response shape includes explainability fields
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import http from 'node:http';

import { searchByMedia } from '../src/api/media-request.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';

const HASH_FAMILY_GUY = 'aabbccddeeff00112233445566778899aabbccdd';
const HASH_OTHER_SHOW = '11223344556677889900aabbccddeeff00112233';

// =============================================================================
// Test: searchByMedia returns ranked candidates for enriched media
// =============================================================================

test('searchByMedia: returns ranked candidates for known media with enrichment', () => {
  const cache = createDiscoveryCache();

  // Seed a candidate with release attributes
  cache.upsertCandidate({
    infoHash: HASH_FAMILY_GUY,
    fileIndex: null,
    filename: 'Family.Guy.S05E12.1080p.mkv',
    title: 'Family Guy',
  });

  storeReleaseAttributes(cache, {
    infoHash: HASH_FAMILY_GUY,
    fileIndex: null,
    filename: 'Family.Guy.S05E12.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Family Guy',
      year: 2005,
      season: 5,
      episode: 12,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });

  // Seed identity association (enriched, episode verified)
  cache.associateMedia(HASH_FAMILY_GUY, null, 'tt0182576', {
    source: 'enrichment',
    confidence: 0.65,
    evidence: ['title_exact_match', 'series_match', 'episode_verified'],
    resolverSource: 'cinemeta',
    resolverVersion: '1.0',
    matchMethod: 'title_exact_match,series_match,episode_verified',
    resolutionState: 'probable',
  });

  const result = searchByMedia(cache, {
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
  });

  // Should find at least one candidate
  assert.ok(result.total >= 1, 'Expected at least one candidate');
  assert.ok(result.results.length >= 1, 'Expected at least one result');

  const top = result.results[0];

  // Verify response shape
  assert.ok(top.infoHash, 'Expected infoHash');
  assert.ok(top.filename, 'Expected filename');
  assert.ok(top.score !== undefined, 'Expected score');
  assert.ok(top.identity, 'Expected identity object');
  assert.ok(top.identity.tier, 'Expected identity tier');
  assert.ok(top.identity.confidence !== undefined, 'Expected identity confidence');
  assert.ok(Array.isArray(top.identity.evidence), 'Expected evidence array');

  // Verify identity state is present
  assert.ok(top.identity.state, 'Expected resolution state');
  assert.equal(top.identity.state, 'probable', 'Expected state to be probable');

  // Verify ranking respects identity tier
  assert.ok(top.score > 0, 'Expected positive score');

  cache.close();
});

// =============================================================================
// Test: searchByMedia with media ID but no enrichment
// =============================================================================

test('searchByMedia: handles known media ID without enrichment', () => {
  const cache = createDiscoveryCache();

  // Seed a candidate without any identity association
  cache.upsertCandidate({
    infoHash: HASH_OTHER_SHOW,
    fileIndex: null,
    filename: 'Unknown.Show.S01E01.720p.mkv',
    title: 'Unknown Show',
  });

  storeReleaseAttributes(cache, {
    infoHash: HASH_OTHER_SHOW,
    fileIndex: null,
    filename: 'Unknown.Show.S01E01.720p.mkv',
    source: 'ptn-regex',
    confidence: 0.7,
    parsed: {
      title: 'Unknown Show',
      year: 2023,
      season: 1,
      episode: 1,
      resolution: '720p',
    },
    evidence: ['title_extracted'],
  });

  // No candidate_media association for this media

  const result = searchByMedia(cache, {
    mediaId: 'tt9999999',
    mediaType: 'series',
    season: 1,
    episode: 1,
  });

  // Should return empty results (no candidates match this media)
  assert.equal(result.total, 0, 'Expected no candidates');
  assert.equal(result.results.length, 0, 'Expected empty results');
  assert.equal(result.query.mediaId, 'tt9999999', 'Expected query mediaId');

  cache.close();
});

// =============================================================================
// Test: searchByMedia with no candidates found
// =============================================================================

test('searchByMedia: returns empty results when no candidates match', () => {
  const cache = createDiscoveryCache();

  // No candidates seeded at all

  const result = searchByMedia(cache, {
    mediaId: 'tt1234567',
    mediaType: 'movie',
  });

  assert.equal(result.total, 0, 'Expected no candidates');
  assert.equal(result.results.length, 0, 'Expected empty results');
  assert.equal(result.identitySummary.tier, 'none', 'Expected tier none');

  cache.close();
});

// =============================================================================
// Test: searchByMedia ranking order respects identity tier
// =============================================================================

test('searchByMedia: ranking order respects identity tier', () => {
  const cache = createDiscoveryCache();

  // Seed two candidates
  const hash1 = '1111111111111111111111111111111111111111';
  const hash2 = '2222222222222222222222222222222222222222';

  cache.upsertCandidate({
    infoHash: hash1,
    fileIndex: null,
    filename: 'Better.Match.S01E01.1080p.mkv',
    title: 'Better Match',
  });

  storeReleaseAttributes(cache, {
    infoHash: hash1,
    fileIndex: null,
    filename: 'Better.Match.S01E01.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.95,
    parsed: {
      title: 'Better Match',
      year: 2024,
      season: 1,
      episode: 1,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });

  cache.upsertCandidate({
    infoHash: hash2,
    fileIndex: null,
    filename: 'Weaker.Match.S01E01.720p.mkv',
    title: 'Weaker Match',
  });

  storeReleaseAttributes(cache, {
    infoHash: hash2,
    fileIndex: null,
    filename: 'Weaker.Match.S01E01.720p.mkv',
    source: 'ptn-regex',
    confidence: 0.7,
    parsed: {
      title: 'Weaker Match',
      year: 2024,
      season: 1,
      episode: 1,
      resolution: '720p',
    },
    evidence: ['title_extracted'],
  });

  // Both associated with same media, but different confidence
  cache.associateMedia(hash1, null, 'tt5555555', {
    source: 'enrichment',
    confidence: 0.95,
    evidence: ['title_exact_match', 'year_match'],
    resolverSource: 'cinemeta',
    resolutionState: 'confirmed',
  });

  cache.associateMedia(hash2, null, 'tt5555555', {
    source: 'enrichment',
    confidence: 0.5,
    evidence: ['title_prefix_match'],
    resolverSource: 'cinemeta',
    resolutionState: 'ambiguous',
  });

  const result = searchByMedia(cache, {
    mediaId: 'tt5555555',
    mediaType: 'series',
    season: 1,
    episode: 1,
  });

  assert.ok(result.total >= 2, 'Expected at least 2 candidates');

  // Higher confidence match should be ranked first
  const top = result.results[0];
  const second = result.results[1];

  assert.ok(top.score >= second.score, 'First result should have >= score');
  assert.ok(
    top.identity.confidence >= second.identity.confidence,
    'First result should have >= identity confidence'
  );

  cache.close();
});

// =============================================================================
// Test: searchByMedia response includes explainability fields
// =============================================================================

test('searchByMedia: response includes explainability fields', () => {
  const cache = createDiscoveryCache();

  cache.upsertCandidate({
    infoHash: '3333333333333333333333333333333333333333',
    fileIndex: null,
    filename: 'Explainable.Show.S01E01.1080p.mkv',
    title: 'Explainable Show',
  });

  storeReleaseAttributes(cache, {
    infoHash: '3333333333333333333333333333333333333333',
    fileIndex: null,
    filename: 'Explainable.Show.S01E01.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.85,
    parsed: {
      title: 'Explainable Show',
      year: 2024,
      season: 1,
      episode: 1,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia('3333333333333333333333333333333333333333', null, 'tt7777777', {
    source: 'enrichment',
    confidence: 0.8,
    evidence: ['title_exact_match', 'series_match', 'episode_verified'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match,series_match,episode_verified',
    resolutionState: 'probable',
  });

  const result = searchByMedia(cache, {
    mediaId: 'tt7777777',
    mediaType: 'series',
    season: 1,
    episode: 1,
  });

  const top = result.results[0];

  // Verify score breakdown is present
  assert.ok(top.scoreBreakdown, 'Expected scoreBreakdown');
  assert.ok(top.scoreBreakdown.qualityScore !== undefined, 'Expected qualityScore');
  assert.ok(top.scoreBreakdown.sourceScore !== undefined, 'Expected sourceScore');

  // Verify release metadata
  assert.ok(top.release, 'Expected release object');
  assert.equal(top.release.title, 'Explainable Show', 'Expected title');
  assert.equal(top.release.season, 1, 'Expected season');
  assert.equal(top.release.episode, 1, 'Expected episode');

  // Verify identity summary at top level
  assert.ok(result.identitySummary, 'Expected identitySummary');
  assert.ok(result.identitySummary.resolutionStates, 'Expected resolutionStates in summary');

  cache.close();
});
