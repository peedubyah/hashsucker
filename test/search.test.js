import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestIntent } from '../src/lib/requests/intent.js';
import { searchMedia } from '../src/lib/search.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

test('TorBox cached state is enrichment and provider failures become unknown', async () => {
  const intent = createRequestIntent({ type: 'series', mediaId: 'tt1:7:3' });
  const result = await searchMedia(intent, {
    searchStremio: async () => [{ infoHash: HASH, title: 'Season pack' }],
    checkTorBoxCached: async () => ({ cached: new Set([HASH]), details: new Map() }),
  });
  assert.equal(result.results[0].providers.torbox.cached, true);
  assert.equal(typeof result.timings.discoveryMs, 'number');
  assert.equal(typeof result.timings.torboxMs, 'number');
  assert.equal(typeof result.timings.totalMs, 'number');
  assert.deepEqual(result.intent.episodes, [3]);
  assert.equal('providers' in result.intent, false);

  const unknown = await searchMedia(intent, {
    searchStremio: async () => [{ infoHash: HASH }],
    checkTorBoxCached: async () => { throw new Error('offline'); },
  });
  assert.equal(unknown.results[0].providers.torbox.cached, null);
  assert.equal(unknown.providerStatus.torbox, 'unknown');
});
