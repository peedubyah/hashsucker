import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../src/server/app.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';

async function requestRepublish({ searchByMedia } = {}) {
  const cache = createDiscoveryCache();
  const store = createControlPlaneStore();
  const app = createApp({ searchCache: cache, controlPlaneStore: store, searchByMedia, env: {} });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/library/republish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mediaId: 'tt_exact', mediaType: 'movie' }),
  });
  const body = await response.json();
  await new Promise((resolve) => server.close(resolve));
  cache.close();
  store.close();
  return { response, body };
}

test('library republish fails closed when exact durable truth is unavailable', async () => {
  const { response, body } = await requestRepublish();
  assert.equal(response.status, 409);
  assert.match(body.error, /exact durable publication/i);
});

test('library republish delegates only to the exact-truth reuse result', async () => {
  const { response, body } = await requestRepublish({
    searchByMedia: async () => ({ reuseMode: 'republish', handoff: { torrentFileId: 'tf_exact' } }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.republished, true);
  assert.equal(body.handoff.torrentFileId, 'tf_exact');
});
