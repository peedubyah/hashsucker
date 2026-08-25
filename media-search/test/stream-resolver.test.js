/**
 * Stream Resolver Interface Tests
 *
 * Tests for the stream resolver module.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStream, parseMediaIdentity, StreamResolverError } from '../src/lib/stream-resolver/index.js';

test('resolveStream: returns not_implemented stub for movie', async () => {
  const result = await resolveStream({
    mediaId: 'tt1234567',
    mediaType: 'movie',
  });

  assert.equal(result.status, 'not_implemented');
  assert.equal(result.provider, null);
  assert.equal(result.redirectUrl, null);
  assert.equal(result.mediaId, 'tt1234567');
  assert.equal(result.mediaType, 'movie');
  assert.equal(result.season, null);
  assert.equal(result.episode, null);
});

test('resolveStream: returns not_implemented stub for series', async () => {
  const result = await resolveStream({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
  });

  assert.equal(result.status, 'not_implemented');
  assert.equal(result.provider, null);
  assert.equal(result.redirectUrl, null);
  assert.equal(result.mediaId, 'tt0182576');
  assert.equal(result.mediaType, 'series');
  assert.equal(result.season, 5);
  assert.equal(result.episode, 12);
});

test('resolveStream: throws on missing mediaId', async () => {
  await assert.rejects(
    () => resolveStream({ mediaType: 'movie' }),
    (err) => {
      assert.ok(err instanceof StreamResolverError);
      assert.equal(err.code, 'MISSING_MEDIA_ID');
      return true;
    }
  );
});

test('resolveStream: throws on missing mediaType', async () => {
  await assert.rejects(
    () => resolveStream({ mediaId: 'tt1234567' }),
    (err) => {
      assert.ok(err instanceof StreamResolverError);
      assert.equal(err.code, 'MISSING_MEDIA_TYPE');
      return true;
    }
  );
});

test('resolveStream: throws on invalid mediaType', async () => {
  await assert.rejects(
    () => resolveStream({ mediaId: 'tt1234567', mediaType: 'invalid' }),
    (err) => {
      assert.ok(err instanceof StreamResolverError);
      assert.equal(err.code, 'INVALID_MEDIA_TYPE');
      return true;
    }
  );
});

test('resolveStream: throws on missing episode info for series', async () => {
  await assert.rejects(
    () => resolveStream({ mediaId: 'tt0182576', mediaType: 'series' }),
    (err) => {
      assert.ok(err instanceof StreamResolverError);
      assert.equal(err.code, 'MISSING_EPISODE_INFO');
      return true;
    }
  );
});

test('parseMediaIdentity: normalizes and validates movie', () => {
  const result = parseMediaIdentity({
    mediaId: 'tt1234567',
    mediaType: 'movie',
  });

  assert.deepEqual(result, {
    mediaId: 'tt1234567',
    mediaType: 'movie',
    season: null,
    episode: null,
  });
});

test('parseMediaIdentity: normalizes and validates series', () => {
  const result = parseMediaIdentity({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: '5',
    episode: '12',
  });

  assert.deepEqual(result, {
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
  });
});

test('parseMediaIdentity: trims whitespace from mediaId', () => {
  const result = parseMediaIdentity({
    mediaId: '  tt1234567  ',
    mediaType: 'movie',
  });

  assert.equal(result.mediaId, 'tt1234567');
});

test('parseMediaIdentity: lowercases mediaType', () => {
  const result = parseMediaIdentity({
    mediaId: 'tt1234567',
    mediaType: 'MOVIE',
  });

  assert.equal(result.mediaType, 'movie');
});

test('parseMediaIdentity: throws on empty mediaId', () => {
  assert.throws(
    () => parseMediaIdentity({ mediaId: '', mediaType: 'movie' }),
    (err) => {
      assert.ok(err instanceof StreamResolverError);
      assert.equal(err.code, 'MISSING_MEDIA_ID');
      return true;
    }
  );
});

test('parseMediaIdentity: throws on missing season for series', () => {
  assert.throws(
    () => parseMediaIdentity({ mediaId: 'tt0182576', mediaType: 'series', episode: 1 }),
    (err) => {
      assert.ok(err instanceof StreamResolverError);
      assert.equal(err.code, 'MISSING_EPISODE_INFO');
      return true;
    }
  );
});

test('parseMediaIdentity: throws on missing episode for series', () => {
  assert.throws(
    () => parseMediaIdentity({ mediaId: 'tt0182576', mediaType: 'series', season: 1 }),
    (err) => {
      assert.ok(err instanceof StreamResolverError);
      assert.equal(err.code, 'MISSING_EPISODE_INFO');
      return true;
    }
  );
});

test('StreamResolverError: has correct name and properties', () => {
  const err = new StreamResolverError('test message', 'TEST_CODE', 400);

  assert.equal(err.name, 'StreamResolverError');
  assert.equal(err.message, 'test message');
  assert.equal(err.code, 'TEST_CODE');
  assert.equal(err.status, 400);
});
