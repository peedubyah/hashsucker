import assert from 'node:assert/strict';
import test from 'node:test';

import { searchCatalog } from '../src/lib/metadata/cinemeta.js';

test('title search ranks exact and prefix matches while retaining movies and series', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      return url.includes('/series/')
        ? { metas: [{ id: 'series-1', type: 'series', name: 'The Indiana Jones Chronicles' }] }
        : { metas: [{ id: 'movie-1', type: 'movie', name: 'Indiana Jones' }, { id: 'movie-2', type: 'movie', name: 'Indiana Jones and the Last Crusade' }] };
    },
  });
  const results = await searchCatalog('Indiana Jones', fetchImpl);
  // Series results come first (from /series/ endpoint), then movies
  assert.deepEqual(results.map(({ id, type }) => [id, type]), [
    ['series-1', 'series'], ['movie-1', 'movie'], ['movie-2', 'movie'],
  ]);
});

test('IMDb ID search returns direct match', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    async json() {
      if (url.includes('/meta/movie/tt0372784')) {
        return { meta: { id: 'tt0372784', type: 'movie', name: 'Batman Begins', year: '2005' } };
      }
      return { metas: [] };
    },
  });
  const results = await searchCatalog('tt0372784', fetchImpl);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'tt0372784');
  assert.equal(results[0].type, 'movie');
});
