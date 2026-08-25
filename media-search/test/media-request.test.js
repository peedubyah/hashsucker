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

test('searchByMedia: returns ranked candidates for known media with enrichment', async () => {
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

  const result = await searchByMedia(cache, {
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

test('searchByMedia: handles known media ID without enrichment', async () => {
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

  const result = await searchByMedia(cache, {
    mediaId: 'tt9999999',
    mediaType: 'series',
    season: 1,
    episode: 1,
    skipLiveDiscovery: true,
    skipAvailability: true,
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

test('searchByMedia: returns empty results when no candidates match', async () => {
  const cache = createDiscoveryCache();

  // No candidates seeded at all

  const result = await searchByMedia(cache, {
    mediaId: 'tt1234567',
    mediaType: 'movie',
    skipLiveDiscovery: true,
    skipAvailability: true,
  });

  assert.equal(result.total, 0, 'Expected no candidates');
  assert.equal(result.results.length, 0, 'Expected empty results');
  assert.equal(result.identitySummary.tier, 'none', 'Expected tier none');

  cache.close();
});

// =============================================================================
// Test: searchByMedia ranking order respects identity tier
// =============================================================================

test('searchByMedia: ranking order respects identity tier', async () => {
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

  const result = await searchByMedia(cache, {
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

test('searchByMedia: response includes explainability fields', async () => {
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

  const result = await searchByMedia(cache, {
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

// =============================================================================
// Test: S05E12 request does not return S21E20 above valid S05E12
// =============================================================================

test('searchByMedia: episode mismatch is excluded from top results', async () => {
  const cache = createDiscoveryCache();

  const hashCorrect = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const hashWrongEpisode = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  // Correct episode candidate
  cache.upsertCandidate({
    infoHash: hashCorrect,
    fileIndex: null,
    filename: 'Family.Guy.S05E12.1080p.mkv',
    title: 'Family Guy',
  });

  storeReleaseAttributes(cache, {
    infoHash: hashCorrect,
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

  cache.associateMedia(hashCorrect, null, 'tt0182576', {
    source: 'enrichment',
    confidence: 0.9,
    evidence: ['title_exact_match', 'episode_verified'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match,episode_verified',
    resolutionState: 'confirmed',
  });

  // Wrong episode candidate (same show, different episode)
  cache.upsertCandidate({
    infoHash: hashWrongEpisode,
    fileIndex: null,
    filename: 'Family.Guy.S21E20.720p.mkv',
    title: 'Family Guy',
  });

  storeReleaseAttributes(cache, {
    infoHash: hashWrongEpisode,
    fileIndex: null,
    filename: 'Family.Guy.S21E20.720p.mkv',
    source: 'ptn-regex',
    confidence: 0.85,
    parsed: {
      title: 'Family Guy',
      year: 2022,
      season: 21,
      episode: 20,
      resolution: '720p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hashWrongEpisode, null, 'tt0182576', {
    source: 'enrichment',
    confidence: 0.85,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'ambiguous',
  });

  const result = await searchByMedia(cache, {
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
  });

  assert.ok(result.total >= 2, 'Expected both candidates in results');

  const top = result.results[0];
  const wrongEpisodeResult = result.results.find(r => r.infoHash === hashWrongEpisode);

  // Correct episode must be first
  assert.equal(top.infoHash, hashCorrect, 'Correct episode should be ranked first');
  assert.equal(top.identity.eligible, true, 'Correct episode should be eligible');
  assert.equal(top.release.season, 5, 'Top result should be season 5');
  assert.equal(top.release.episode, 12, 'Top result should be episode 12');

  // Wrong episode must not be ranked above correct episode
  assert.ok(wrongEpisodeResult, 'Wrong episode should still be in results');
  assert.equal(wrongEpisodeResult.identity.eligible, false, 'Wrong episode should be ineligible');
  assert.ok(
    wrongEpisodeResult.identity.ineligibleReason.includes('season_mismatch') ||
    wrongEpisodeResult.identity.ineligibleReason.includes('episode_mismatch'),
    'Wrong episode should have mismatch reason'
  );

  // Verify tier metadata includes ineligible count
  assert.ok(result.ranking.IneligibleCount >= 1, 'Should have ineligible candidates');

  cache.close();
});

// =============================================================================
// Test: Movie requests are unaffected by episode eligibility
// =============================================================================

test('searchByMedia: movie requests are not affected by episode eligibility', async () => {
  const cache = createDiscoveryCache();

  const hashMovie = 'cccccccccccccccccccccccccccccccccccccccc';

  cache.upsertCandidate({
    infoHash: hashMovie,
    fileIndex: null,
    filename: 'The.Matrix.1999.1080p.mkv',
    title: 'The Matrix',
  });

  storeReleaseAttributes(cache, {
    infoHash: hashMovie,
    fileIndex: null,
    filename: 'The.Matrix.1999.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.95,
    parsed: {
      title: 'The Matrix',
      year: 1999,
      season: null,
      episode: null,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hashMovie, null, 'tt0133093', {
    source: 'enrichment',
    confidence: 0.95,
    evidence: ['title_exact_match', 'year_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match,year_match',
    resolutionState: 'confirmed',
  });

  const result = await searchByMedia(cache, {
    mediaId: 'tt0133093',
    mediaType: 'movie',
  });

  assert.equal(result.total, 1, 'Expected one candidate');
  const top = result.results[0];
  assert.equal(top.identity.eligible, true, 'Movie should be eligible');
  assert.equal(top.identity.ineligibleReason, null, 'Movie should not have ineligible reason');
  assert.equal(top.release.title, 'The Matrix', 'Expected title');

  cache.close();
});

// =============================================================================
// Test: Series requests without episode constraints work
// =============================================================================

test('searchByMedia: series request without episode constraint returns season matches', async () => {
  const cache = createDiscoveryCache();

  const hashS05Pack = 'dddddddddddddddddddddddddddddddddddddddd';
  const hashS05E03 = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

  // Season 5 pack
  cache.upsertCandidate({
    infoHash: hashS05Pack,
    fileIndex: null,
    filename: 'Family.Guy.S05.1080p.mkv',
    title: 'Family Guy',
  });

  storeReleaseAttributes(cache, {
    infoHash: hashS05Pack,
    fileIndex: null,
    filename: 'Family.Guy.S05.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Family Guy',
      year: 2006,
      season: 5,
      episode: null,
      seasonOnly: true,
      mediaType: 'season',
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hashS05Pack, null, 'tt0182576', {
    source: 'enrichment',
    confidence: 0.9,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'probable',
  });

  // Specific episode in same season
  cache.upsertCandidate({
    infoHash: hashS05E03,
    fileIndex: null,
    filename: 'Family.Guy.S05E03.720p.mkv',
    title: 'Family Guy',
  });

  storeReleaseAttributes(cache, {
    infoHash: hashS05E03,
    fileIndex: null,
    filename: 'Family.Guy.S05E03.720p.mkv',
    source: 'ptn-regex',
    confidence: 0.85,
    parsed: {
      title: 'Family Guy',
      year: 2006,
      season: 5,
      episode: 3,
      resolution: '720p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hashS05E03, null, 'tt0182576', {
    source: 'enrichment',
    confidence: 0.85,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'probable',
  });

  // Request season 5 only (no episode constraint)
  const result = await searchByMedia(cache, {
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
  });

  assert.equal(result.total, 2, 'Expected both candidates');
  assert.equal(result.results[0].identity.eligible, true, 'Top result should be eligible');
  assert.equal(result.results[1].identity.eligible, true, 'Second result should be eligible');

  cache.close();
});

// =============================================================================
// Test: Ineligible candidates appear below eligible ones
// =============================================================================

test('searchByMedia: ineligible candidates rank below eligible ones', async () => {
  const cache = createDiscoveryCache();

  const hashCorrectS03E05 = 'ffffffffffffffffffffffffffffffffffffffff';
  const hashWrongS07E01 = '1111111111111111111111111111111111111112';

  // Correct episode
  cache.upsertCandidate({
    infoHash: hashCorrectS03E05,
    fileIndex: null,
    filename: 'Archer.S03E05.1080p.mkv',
    title: 'Archer',
  });

  storeReleaseAttributes(cache, {
    infoHash: hashCorrectS03E05,
    fileIndex: null,
    filename: 'Archer.S03E05.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Archer',
      year: 2012,
      season: 3,
      episode: 5,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hashCorrectS03E05, null, 'tt1486217', {
    source: 'enrichment',
    confidence: 0.9,
    evidence: ['title_exact_match', 'episode_verified'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match,episode_verified',
    resolutionState: 'confirmed',
  });

  // Wrong season candidate
  cache.upsertCandidate({
    infoHash: hashWrongS07E01,
    fileIndex: null,
    filename: 'Archer.S07E01.720p.mkv',
    title: 'Archer',
  });

  storeReleaseAttributes(cache, {
    infoHash: hashWrongS07E01,
    fileIndex: null,
    filename: 'Archer.S07E01.720p.mkv',
    source: 'ptn-regex',
    confidence: 0.95, // Higher quality, but wrong season
    parsed: {
      title: 'Archer',
      year: 2016,
      season: 7,
      episode: 1,
      resolution: '720p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hashWrongS07E01, null, 'tt1486217', {
    source: 'enrichment',
    confidence: 0.95,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'ambiguous',
  });

  const result = await searchByMedia(cache, {
    mediaId: 'tt1486217',
    mediaType: 'series',
    season: 3,
    episode: 5,
  });

  assert.ok(result.total >= 2, 'Expected both candidates');

  // Correct episode must be first
  const top = result.results[0];
  assert.equal(top.infoHash, hashCorrectS03E05, 'Correct episode should be ranked first');
  assert.equal(top.identity.eligible, true, 'Correct episode should be eligible');

  // Wrong season candidate should be ranked lower
  const wrongResult = result.results.find(r => r.infoHash === hashWrongS07E01);
  assert.ok(wrongResult, 'Wrong season candidate should be in results');
  assert.equal(wrongResult.identity.eligible, false, 'Wrong season candidate should be ineligible');
  assert.ok(
    wrongResult.identity.ineligibleReason.includes('season_mismatch'),
    'Should have season mismatch reason'
  );

  // Wrong season should not be ranked above correct episode
  assert.ok(
    result.results.findIndex(r => r.infoHash === hashCorrectS03E05) <
    result.results.findIndex(r => r.infoHash === hashWrongS07E01),
    'Correct episode must rank above wrong season'
  );

  cache.close();
});

// =============================================================================
// Test: Persistence includes eligibility fields
// =============================================================================

test('searchByMedia: persistence includes eligibility state and reason', async () => {
  const cache = createDiscoveryCache();

  const hashCorrect = '1111111111111111111111111111111111111111';
  const hashWrong = '2222222222222222222222222222222222222222';

  cache.upsertCandidate({
    infoHash: hashCorrect,
    fileIndex: null,
    filename: 'Show.S03E05.1080p.mkv',
    title: 'Show',
  });

  storeReleaseAttributes(cache, {
    infoHash: hashCorrect,
    fileIndex: null,
    filename: 'Show.S03E05.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Show',
      year: 2023,
      season: 3,
      episode: 5,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hashCorrect, null, 'tt1234567', {
    source: 'enrichment',
    confidence: 0.9,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'confirmed',
  });

  cache.upsertCandidate({
    infoHash: hashWrong,
    fileIndex: null,
    filename: 'Show.S07E01.720p.mkv',
    title: 'Show',
  });

  storeReleaseAttributes(cache, {
    infoHash: hashWrong,
    fileIndex: null,
    filename: 'Show.S07E01.720p.mkv',
    source: 'ptn-regex',
    confidence: 0.85,
    parsed: {
      title: 'Show',
      year: 2023,
      season: 7,
      episode: 1,
      resolution: '720p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hashWrong, null, 'tt1234567', {
    source: 'enrichment',
    confidence: 0.85,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'ambiguous',
  });

  const result = await searchByMedia(cache, {
    mediaId: 'tt1234567',
    mediaType: 'series',
    season: 3,
    episode: 5,
  });

  assert.ok(result.requestId, 'Should persist request');

  const persisted = cache.getMediaRequestResults(result.requestId);
  assert.equal(persisted.length, 2, 'Should have 2 persisted results');

  const eligibleRow = persisted.find(r => r.info_hash === hashCorrect);
  assert.equal(eligibleRow.eligible, 1, 'Correct episode should be eligible');
  assert.equal(eligibleRow.ineligible_reason, null, 'No reason for eligible');
  assert.equal(eligibleRow.expected_media_scope, 'series:S03:E05', 'Expected scope should be set');
  assert.ok(eligibleRow.parsed_candidate_scope, 'Parsed scope should be set');

  const ineligibleRow = persisted.find(r => r.info_hash === hashWrong);
  assert.equal(ineligibleRow.eligible, 0, 'Wrong season should be ineligible');
  assert.ok(ineligibleRow.ineligible_reason, 'Should have reason');
  assert.ok(ineligibleRow.ineligible_code === 'season_mismatch', 'Should have code');

  cache.close();
});

// =============================================================================
// Test: Diagnostics summary includes eligibility counts
// =============================================================================

test('searchByMedia: diagnostics include eligibility breakdown', async () => {
  const cache = createDiscoveryCache();

  const hash1 = '3333333333333333333333333333333333333333';
  const hash2 = '4444444444444444444444444444444444444444';
  const hash3 = '5555555555555555555555555555555555555555';

  // Eligible episode
  cache.upsertCandidate({
    infoHash: hash1,
    fileIndex: null,
    filename: 'Show.S05E12.1080p.mkv',
    title: 'Show',
  });

  storeReleaseAttributes(cache, {
    infoHash: hash1,
    fileIndex: null,
    filename: 'Show.S05E12.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Show',
      year: 2024,
      season: 5,
      episode: 12,
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hash1, null, 'tt1111111', {
    source: 'enrichment',
    confidence: 0.9,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'confirmed',
  });

  // Ineligible: wrong season
  cache.upsertCandidate({
    infoHash: hash2,
    fileIndex: null,
    filename: 'Show.S03E01.720p.mkv',
    title: 'Show',
  });

  storeReleaseAttributes(cache, {
    infoHash: hash2,
    fileIndex: null,
    filename: 'Show.S03E01.720p.mkv',
    source: 'ptn-regex',
    confidence: 0.85,
    parsed: {
      title: 'Show',
      year: 2024,
      season: 3,
      episode: 1,
      resolution: '720p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hash2, null, 'tt1111111', {
    source: 'enrichment',
    confidence: 0.85,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'ambiguous',
  });

  // Ineligible: wrong episode
  cache.upsertCandidate({
    infoHash: hash3,
    fileIndex: null,
    filename: 'Show.S05E20.720p.mkv',
    title: 'Show',
  });

  storeReleaseAttributes(cache, {
    infoHash: hash3,
    fileIndex: null,
    filename: 'Show.S05E20.720p.mkv',
    source: 'ptn-regex',
    confidence: 0.85,
    parsed: {
      title: 'Show',
      year: 2024,
      season: 5,
      episode: 20,
      resolution: '720p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hash3, null, 'tt1111111', {
    source: 'enrichment',
    confidence: 0.85,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'ambiguous',
  });

  const result = await searchByMedia(cache, {
    mediaId: 'tt1111111',
    mediaType: 'series',
    season: 5,
    episode: 12,
  });

  assert.equal(result.total, 3, 'Expected 3 candidates');

  // Check diagnostics
  const summary = result.identitySummary;
  assert.equal(summary.eligibleCount, 1, 'Should have 1 eligible candidate');
  assert.equal(summary.ineligibleCount, 2, 'Should have 2 ineligible candidates');
  assert.ok(summary.ineligibleByCode.season_mismatch >= 1, 'Should have season_mismatch');
  assert.ok(summary.ineligibleByCode.episode_mismatch >= 1, 'Should have episode_mismatch');
  assert.equal(summary.exactEpisodeMatches, 1, 'Should have 1 exact episode match');
  assert.ok(summary.tierCounts.Ineligible >= 2, 'Should have Ineligible tier count');

  cache.close();
});

// =============================================================================
// Test: Season pack matches are counted correctly
// =============================================================================

test('searchByMedia: season pack matches are counted in diagnostics', async () => {
  const cache = createDiscoveryCache();

  const hashPack = '6666666666666666666666666666666666666666';
  const hashEpisode = '7777777777777777777777777777777777777777';

  // Season pack
  cache.upsertCandidate({
    infoHash: hashPack,
    fileIndex: null,
    filename: 'Show.S05.1080p.Pack.mkv',
    title: 'Show',
  });

  storeReleaseAttributes(cache, {
    infoHash: hashPack,
    fileIndex: null,
    filename: 'Show.S05.1080p.Pack.mkv',
    source: 'ptn-regex',
    confidence: 0.9,
    parsed: {
      title: 'Show',
      year: 2024,
      season: 5,
      episode: null,
      seasonOnly: true,
      mediaType: 'season',
      resolution: '1080p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hashPack, null, 'tt2222222', {
    source: 'enrichment',
    confidence: 0.9,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'probable',
  });

  // Specific episode
  cache.upsertCandidate({
    infoHash: hashEpisode,
    fileIndex: null,
    filename: 'Show.S05E03.720p.mkv',
    title: 'Show',
  });

  storeReleaseAttributes(cache, {
    infoHash: hashEpisode,
    fileIndex: null,
    filename: 'Show.S05E03.720p.mkv',
    source: 'ptn-regex',
    confidence: 0.85,
    parsed: {
      title: 'Show',
      year: 2024,
      season: 5,
      episode: 3,
      resolution: '720p',
    },
    evidence: ['title_extracted'],
  });

  cache.associateMedia(hashEpisode, null, 'tt2222222', {
    source: 'enrichment',
    confidence: 0.85,
    evidence: ['title_exact_match'],
    resolverSource: 'cinemeta',
    matchMethod: 'title_exact_match',
    resolutionState: 'probable',
  });

  const result = await searchByMedia(cache, {
    mediaId: 'tt2222222',
    mediaType: 'series',
    season: 5,
  });

  assert.equal(result.total, 2, 'Expected 2 candidates');

  const summary = result.identitySummary;
  assert.equal(summary.seasonPackMatches, 1, 'Should have 1 season pack match');
  assert.equal(summary.exactEpisodeMatches, 1, 'Should have 1 exact episode match');

  cache.close();
});
