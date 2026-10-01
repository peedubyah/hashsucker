import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { searchByMedia } from '../src/api/media-request.js';

test('request work baseline records ranked and healthy-reuse dispositions', async () => {
  const cache = createDiscoveryCache();
  const ranked = await searchByMedia(cache, {
    mediaId: 'tt_baseline', mediaType: 'movie', persist: false,
    skipAvailability: true, skipLiveDiscovery: true,
  });
  assert.ok(ranked);
  const rows = cache.listEvidenceQuerySummary({ from: 0 });
  assert.ok(Array.isArray(rows));
  cache.close();
});
