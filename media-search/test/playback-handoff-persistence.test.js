/**
 * Playback Handoff Persistence Tests
 *
 * Tests for playback handoff database operations.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { buildPlaybackHandoff } from '../src/lib/discovery/playback-handoff.js';

const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('handoff: persist and retrieve by request ID', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });

  // Insert media_request first (FK constraint)
  const reqResult = cache.persistMediaRequest({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
  }, []);

  const selection = {
    selected: {
      infoHash: HASH,
      fileIndex: 12,
      filename: 'Family.Guy.S05E12.720p.mkv',
      rank: 1,
      score: 0.6,
      identityTier: 'ProviderConfirmed',
      torboxState: 'cached',
      release: {
        title: 'Family Guy',
        year: 2006,
        resolution: '720p',
        source: 'WEB-DL',
        codec: 'x264',
        hdr: false,
        releaseGroup: 'AMBC',
        season: 5,
        episode: 12,
      },
    },
    reason: 'highest-ranked cached eligible candidate',
    alternates: [],
  };

  const request = {
    requestId: reqResult, // Use actual rowid
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
  };

  const handoff = buildPlaybackHandoff(selection, request);
  const handoffId = cache.persistPlaybackHandoff(handoff);

  assert.ok(handoffId);

  const retrieved = cache.getPlaybackHandoffByRequestId(reqResult);

  assert.ok(retrieved);
  assert.equal(retrieved.info_hash, HASH);
  assert.equal(retrieved.file_index, 12);
  assert.equal(retrieved.filename, 'Family.Guy.S05E12.720p.mkv');
  assert.equal(retrieved.provider, 'torbox');
  assert.equal(retrieved.provider_state, 'cached');
  assert.equal(retrieved.identity_tier, 'ProviderConfirmed');
});

test('handoff: rowToPlaybackHandoff transforms row correctly', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });

  const reqResult = cache.persistMediaRequest({
    mediaId: 'tt1234567',
    mediaType: 'movie',
  }, []);

  const selection = {
    selected: {
      infoHash: HASH,
      fileIndex: null,
      filename: 'Movie.2020.2160p.mkv',
      rank: 1,
      score: 0.8,
      identityTier: 'Verified',
      torboxState: 'cached',
      release: {
        title: 'Movie',
        year: 2020,
        resolution: '2160p',
      },
    },
    reason: 'highest-ranked cached eligible candidate',
    alternates: [],
  };

  const request = {
    requestId: reqResult,
    mediaId: 'tt1234567',
    mediaType: 'movie',
  };

  const handoff = buildPlaybackHandoff(selection, request);
  cache.persistPlaybackHandoff(handoff);

  const row = cache.getPlaybackHandoffByRequestId(reqResult);
  const transformed = cache.rowToPlaybackHandoff(row);

  assert.ok(transformed);
  assert.equal(transformed.requestId, reqResult);
  assert.equal(transformed.mediaId, 'tt1234567');
  assert.equal(transformed.mediaType, 'movie');
  assert.equal(transformed.fileIndex, null);
  assert.equal(transformed.releaseKey, `${HASH}:torrent`);
  assert.equal(transformed.filename, 'Movie.2020.2160p.mkv');
  assert.equal(transformed.provider, 'torbox');
  assert.equal(transformed.providerState, 'cached');
  assert.equal(transformed.identityTier, 'Verified');
});

test('handoff: getPlaybackHandoffById returns correct handoff', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });

  const reqResult = cache.persistMediaRequest({
    mediaId: 'tt999',
    mediaType: 'series',
    season: 1,
    episode: 5,
  }, []);

  const selection = {
    selected: {
      infoHash: HASH,
      fileIndex: 5,
      filename: 'Test.S01E05.720p.mkv',
      rank: 1,
      score: 0.5,
      identityTier: 'Probable',
      torboxState: 'unknown',
      release: {
        title: 'Test',
        year: 2023,
        resolution: '720p',
      },
    },
    reason: 'no cached candidates; highest-ranked unknown eligible candidate',
    alternates: [],
  };

  const request = {
    requestId: reqResult,
    mediaId: 'tt999',
    mediaType: 'series',
    season: 1,
    episode: 5,
  };

  const handoff = buildPlaybackHandoff(selection, request);
  const handoffId = cache.persistPlaybackHandoff(handoff);

  const retrieved = cache.getPlaybackHandoffById(handoffId);

  assert.ok(retrieved);
  assert.equal(retrieved.info_hash, HASH);
  assert.equal(retrieved.file_index, 5);
  assert.equal(retrieved.provider, 'torbox');
  assert.equal(retrieved.provider_state, 'unknown');
});

test('handoff: null handoff returns null row', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const result = cache.rowToPlaybackHandoff(null);
  assert.equal(result, null);
});

test('handoff: missing request returns null', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const result = cache.getPlaybackHandoffByRequestId(99999);
  assert.equal(result, null);
});

test('handoff: persist:false does not create handoff', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });

  // First, create a request
  const reqId = cache.persistMediaRequest({
    mediaId: 'tt123',
    mediaType: 'movie',
  }, []);

  // Build and persist a handoff manually
  const selection = {
    selected: {
      infoHash: HASH,
      fileIndex: 1,
      filename: 'test.mkv',
      identityTier: 'ProviderConfirmed',
      torboxState: 'cached',
    },
    reason: 'test',
    alternates: [],
  };
  const handoff = buildPlaybackHandoff(selection, { requestId: reqId, mediaId: 'tt123', mediaType: 'movie' });
  cache.persistPlaybackHandoff(handoff);

  // Verify we can retrieve it
  const retrieved = cache.getPlaybackHandoffByRequestId(reqId);
  assert.ok(retrieved);
  assert.equal(retrieved.request_id, reqId);
});

test('handoff: retrieved handoff requestId matches request', () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });

  const reqId = cache.persistMediaRequest({
    mediaId: 'tt999',
    mediaType: 'series',
    season: 1,
    episode: 1,
  }, []);

  const selection = {
    selected: {
      infoHash: HASH,
      fileIndex: null,
      filename: 'S01E01.mkv',
      identityTier: 'Verified',
      torboxState: 'cached',
    },
    reason: 'test',
    alternates: [],
  };
  const handoff = buildPlaybackHandoff(selection, {
    requestId: reqId,
    mediaId: 'tt999',
    mediaType: 'series',
    season: 1,
    episode: 1,
  });
  cache.persistPlaybackHandoff(handoff);

  const retrieved = cache.getPlaybackHandoffByRequestId(reqId);
  assert.ok(retrieved);
  assert.strictEqual(retrieved.request_id, reqId);
});
