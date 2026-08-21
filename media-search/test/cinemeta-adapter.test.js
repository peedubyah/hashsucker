/**
 * Cinemeta Adapter Tests
 *
 * Proves:
 * - Adapter conforms to provider interface
 * - Cinemeta responses are normalized correctly
 * - Year parsing handles various formats
 * - Error handling for invalid inputs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createCinemetaAdapter } from '../src/lib/metadata/cinemeta-adapter.js';
import { createNormalizedMedia, validateNormalizedMedia } from '../src/lib/metadata/types.js';

test('adapter has required provider interface', () => {
  const adapter = createCinemetaAdapter();
  assert.equal(adapter.name, 'cinemeta');
  assert.equal(typeof adapter.search, 'function');
  assert.equal(typeof adapter.getMedia, 'function');
  assert.equal(typeof adapter.healthCheck, 'function');
});

test('search normalizes Cinemeta response to provider-agnostic shape', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      if (url.includes('/series/')) {
        return {
          metas: [{
            id: 'tt2085059',
            type: 'series',
            name: 'Black Mirror',
            poster: 'https://example.com/poster.jpg',
            year: '2011-',
            description: 'A dark anthology series',
          }],
        };
      }
      return { metas: [] };
    },
  });

  const adapter = createCinemetaAdapter({ fetchImpl });
  const results = await adapter.search('Black Mirror');

  assert.ok(results.length > 0);
  const first = results[0];
  assert.equal(first.id, 'tt2085059');
  assert.equal(first.type, 'series');
  assert.equal(first.title, 'Black Mirror');
  assert.equal(first.year, 2011);
  assert.equal(first.posterUrl, 'https://example.com/poster.jpg');
  assert.equal(first.overview, 'A dark anthology series');
});

test('search parses year ranges correctly', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        metas: [
          { id: '1', type: 'series', name: 'Show A', year: '2011-2019' },
          { id: '2', type: 'series', name: 'Show B', year: '2015-' },
          { id: '3', type: 'series', name: 'Show C', year: '2020' },
          { id: '4', type: 'series', name: 'Show D' },
        ],
      };
    },
  });

  const adapter = createCinemetaAdapter({ fetchImpl });
  const results = await adapter.search('show');

  assert.equal(results[0].year, 2011);
  assert.equal(results[1].year, 2015);
  assert.equal(results[2].year, 2020);
  assert.equal(results[3].year, null);
});

test('search throws on query too short', async () => {
  const adapter = createCinemetaAdapter();
  await assert.rejects(() => adapter.search('a'), /2–120 characters/);
});

test('search throws on query too long', async () => {
  const adapter = createCinemetaAdapter();
  const longQuery = 'a'.repeat(121);
  await assert.rejects(() => adapter.search(longQuery), /2–120 characters/);
});

test('search handles upstream failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const adapter = createCinemetaAdapter({ fetchImpl });
  await assert.rejects(() => adapter.search('matrix'), /HTTP 500/);
});

test('getMedia returns normalized media for valid ID', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      return {
        meta: {
          id: 'tt2085059',
          type: 'series',
          name: 'Black Mirror',
          poster: 'https://example.com/poster.jpg',
          year: '2011-',
          description: 'A dark anthology series',
          videos: [
            { id: 'tt2085059:1:1', season: 1, episode: 1, title: 'The National Anthem' },
          ],
        },
      };
    },
  });

  const adapter = createCinemetaAdapter({ fetchImpl });
  const media = await adapter.getMedia('series', 'tt2085059');

  assert.ok(media);
  assert.equal(media.id, 'tt2085059');
  assert.equal(media.videos.length, 1);
  assert.equal(media.videos[0].season, 1);
  assert.equal(media.videos[0].episode, 1);
});

test('getMedia returns null for not found', async () => {
  const fetchImpl = async () => ({ ok: true, async json() { return { meta: null }; } });
  const adapter = createCinemetaAdapter({ fetchImpl });
  const media = await adapter.getMedia('series', 'tt0000000');
  assert.equal(media, null);
});

test('getMedia throws on invalid type', async () => {
  const adapter = createCinemetaAdapter();
  await assert.rejects(() => adapter.getMedia('invalid', 'tt123'), /Invalid media type/);
});

test('getMedia throws on invalid ID', async () => {
  const adapter = createCinemetaAdapter();
  await assert.rejects(() => adapter.getMedia('series', 'invalid id!'), /Invalid media ID/);
});

test('healthCheck returns true when reachable', async () => {
  const fetchImpl = async () => ({ ok: true, async json() { return { metas: [] }; } });
  const adapter = createCinemetaAdapter({ fetchImpl });
  assert.equal(await adapter.healthCheck(), true);
});

test('healthCheck returns false when unreachable', async () => {
  const fetchImpl = async () => { throw new Error('Connection refused'); };
  const adapter = createCinemetaAdapter({ fetchImpl });
  assert.equal(await adapter.healthCheck(), false);
});

test('all results pass normalized media validation', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        metas: [
          { id: 'tt1', type: 'movie', name: 'Movie', year: '2020', poster: 'http://example.com/p.jpg', description: 'Desc' },
          { id: 'tt2', type: 'series', name: 'Series' },
        ],
      };
    },
  });

  const adapter = createCinemetaAdapter({ fetchImpl });
  const results = await adapter.search('test');

  for (const media of results) {
    const errors = validateNormalizedMedia(media);
    assert.deepEqual(errors, [], `Validation errors for ${media.id}: ${errors.join(', ')}`);
  }
});
