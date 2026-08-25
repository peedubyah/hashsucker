/**
 * Playback Handoff Builder Tests
 *
 * Tests for buildPlaybackHandoff pure function.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlaybackHandoff, validatePlaybackHandoff } from '../src/lib/discovery/playback-handoff.js';

const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('buildPlaybackHandoff: valid cached selection builds handoff', () => {
  const selection = {
    selected: {
      infoHash: HASH,
      fileIndex: 12,
      filename: 'Family.Guy.S05E12.720p.mkv',
      rank: 1,
      score: 0.6,
      identityTier: 'ProviderConfirmed',
      torboxState: 'cached',
      torboxCheckedAt: Date.now(),
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
    requestId: 123,
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
  };

  const handoff = buildPlaybackHandoff(selection, request);

  assert.ok(handoff);
  assert.equal(handoff.requestId, 123);
  assert.equal(handoff.mediaId, 'tt0182576');
  assert.equal(handoff.mediaType, 'series');
  assert.equal(handoff.season, 5);
  assert.equal(handoff.episode, 12);
  assert.equal(handoff.releaseKey, `${HASH}:12`);
  assert.equal(handoff.infoHash, HASH);
  assert.equal(handoff.fileIndex, 12);
  assert.equal(handoff.filename, 'Family.Guy.S05E12.720p.mkv');
  assert.equal(handoff.provider, 'torbox');
  assert.equal(handoff.providerState, 'cached');
  assert.equal(handoff.identityTier, 'ProviderConfirmed');
  assert.equal(handoff.resolutionState, 'resolved');
  assert.equal(handoff.selectionReason, 'highest-ranked cached eligible candidate');
  assert.ok(typeof handoff.selectedAt === 'number');
});

test('buildPlaybackHandoff: null fileIndex stays null', () => {
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
    requestId: 456,
    mediaId: 'tt1234567',
    mediaType: 'movie',
  };

  const handoff = buildPlaybackHandoff(selection, request);

  assert.ok(handoff);
  assert.equal(handoff.fileIndex, null);
  assert.equal(handoff.releaseKey, `${HASH}:torrent`);
  assert.equal(handoff.season, null);
  assert.equal(handoff.episode, null);
});

test('buildPlaybackHandoff: ineligible candidate cannot build handoff', () => {
  const selection = {
    selected: null,
    reason: 'no eligible candidates',
    alternates: [],
  };

  const request = {
    requestId: 789,
    mediaId: 'tt0458290',
    mediaType: 'series',
    season: 1,
    episode: 1,
  };

  const handoff = buildPlaybackHandoff(selection, request);

  assert.equal(handoff, null);
});

test('buildPlaybackHandoff: missing requestId throws error', () => {
  const selection = {
    selected: {
      infoHash: HASH,
      fileIndex: 1,
      filename: 'test.mkv',
      rank: 1,
      score: 0.5,
      identityTier: 'ProviderConfirmed',
      torboxState: 'cached',
    },
    reason: 'highest-ranked cached eligible candidate',
    alternates: [],
  };

  // Missing requestId should throw
  const request = {};

  assert.throws(() => {
    buildPlaybackHandoff(selection, request);
  }, /requestId is required/);
});

test('buildPlaybackHandoff: provider comes from availability state', () => {
  const selection = {
    selected: {
      infoHash: HASH,
      fileIndex: 1,
      filename: 'test.mkv',
      rank: 1,
      score: 0.5,
      identityTier: 'ProviderConfirmed',
      torboxState: 'cached',
    },
    reason: 'highest-ranked cached eligible candidate',
    alternates: [],
  };

  const request = {
    requestId: 100,
    mediaId: 'tt123',
    mediaType: 'movie',
  };

  const handoff = buildPlaybackHandoff(selection, request);

  assert.ok(handoff);
  assert.equal(handoff.provider, 'torbox');
  assert.equal(handoff.providerState, 'cached');
});

test('buildPlaybackHandoff: requestId is preserved as number', () => {
  const selection = {
    selected: {
      infoHash: HASH,
      fileIndex: 1,
      filename: 'test.mkv',
      rank: 1,
      score: 0.5,
      identityTier: 'ProviderConfirmed',
      torboxState: 'cached',
    },
    reason: 'highest-ranked cached eligible candidate',
    alternates: [],
  };

  const request = {
    requestId: 42,
    mediaId: 'tt123',
    mediaType: 'movie',
  };

  const handoff = buildPlaybackHandoff(selection, request);

  assert.ok(handoff);
  assert.equal(handoff.requestId, 42);
  assert.strictEqual(typeof handoff.requestId, 'number');
});

test('validatePlaybackHandoff: valid handoff passes', () => {
  const handoff = {
    requestId: 123,
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    releaseKey: `${HASH}:12`,
    infoHash: HASH,
    fileIndex: 12,
    filename: 'Family.Guy.S05E12.720p.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'ProviderConfirmed',
    resolutionState: 'resolved',
    selectionReason: 'highest-ranked cached eligible candidate',
    selectedAt: Date.now(),
  };

  const result = validatePlaybackHandoff(handoff);

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('validatePlaybackHandoff: invalid handoff fails with errors', () => {
  const handoff = {
    requestId: 123,
    mediaId: 'tt0182576',
    mediaType: 'invalid',
    releaseKey: `${HASH}:12`,
    infoHash: '',
    fileIndex: 12,
    filename: 'test.mkv',
    provider: 'torbox',
    providerState: 'cached',
  };

  const result = validatePlaybackHandoff(handoff);

  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.includes('infoHash is required'));
  assert.ok(result.errors.includes('mediaType must be movie or series'));
});

test('validatePlaybackHandoff: null handoff fails', () => {
  const result = validatePlaybackHandoff(null);

  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('handoff must be an object'));
});
