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
  assert.deepEqual(results.map(({ id, type }) => [id, type]), [
    ['movie-1', 'movie'], ['movie-2', 'movie'], ['series-1', 'series'],
  ]);
});
