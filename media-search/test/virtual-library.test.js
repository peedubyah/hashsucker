import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createRequestIntent } from '../src/lib/requests/intent.js';
import { fulfillVirtualSelection } from '../src/lib/requests/virtual-library.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';

test('virtual fulfillment persists the exact selected movie before publishing STRM', async () => {
  const cache = createDiscoveryCache();
  let publishedHandoff = null;
  const result = await fulfillVirtualSelection({
    cache,
    intent: createRequestIntent({ type: 'movie', mediaId: 'tt0082971' }),
    release: {
      infoHash: HASH,
      fileIndex: null,
      releaseKey: `${HASH}:torrent`,
      title: 'Raiders of the Lost Ark (1981)',
      filename: 'Raiders.of.the.Lost.Ark.1981.mkv',
      resolution: '1080p',
    },
    publishStrm: async ({ handoff }) => {
      publishedHandoff = handoff;
      const durable = cache.getPlaybackHandoffByMediaId('tt0082971');
      assert.equal(durable.requestId, handoff.requestId);
      assert.equal(durable.releaseKey, handoff.releaseKey);
      assert.equal(durable.infoHash, handoff.infoHash);
      assert.equal(durable.filename, handoff.filename);
      return { published: true, path: '/strm/Movies/Raiders/Raiders.strm' };
    },
  });

  assert.equal(result.handoff.releaseKey, `${HASH}:torrent`);
  assert.equal(result.handoff.mediaType, 'movie');
  assert.equal(result.handoff.filename, 'Raiders.of.the.Lost.Ark.1981.mkv');
  assert.equal(publishedHandoff.requestId, result.mediaRequestId);
  assert.equal(cache.getMediaRequests()[0].source, 'operator-api');
});

test('virtual fulfillment preserves explicit episode identity', async () => {
  const cache = createDiscoveryCache();
  const result = await fulfillVirtualSelection({
    cache,
    intent: createRequestIntent({ type: 'series', mediaId: 'tt2085059:7:3' }),
    release: {
      infoHash: HASH,
      fileIndex: 4,
      releaseKey: `${HASH}:4`,
      filename: 'Black.Mirror.S07E03.mkv',
    },
    publishStrm: async () => ({ published: true, path: '/strm/TV Shows/Black Mirror/Season 07/Black Mirror - S07E03.strm' }),
  });

  assert.equal(result.handoff.mediaType, 'series');
  assert.equal(result.handoff.mediaId, 'tt2085059:7:3');
  assert.equal(result.handoff.season, 7);
  assert.equal(result.handoff.episode, 3);
  assert.equal(result.handoff.fileIndex, 4);
});

test('virtual fulfillment never publishes before durable handoff persistence', async () => {
  const cache = {
    persistMediaRequest() { return 7; },
    persistPlaybackHandoff() { throw new Error('disk full'); },
  };
  let publishCalled = false;

  await assert.rejects(
    fulfillVirtualSelection({
      cache,
      intent: createRequestIntent({ type: 'movie', mediaId: 'tt0082971' }),
      release: {
        infoHash: HASH,
        fileIndex: null,
        releaseKey: `${HASH}:torrent`,
        filename: 'Raiders.mkv',
      },
      publishStrm: async () => {
        publishCalled = true;
        return { published: true, path: '/strm/file.strm' };
      },
    }),
    /disk full/,
  );
  assert.equal(publishCalled, false);
});
