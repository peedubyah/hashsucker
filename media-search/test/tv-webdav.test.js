import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createTvWebDav } from '../src/lib/vfs/tv-webdav.js';

const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RELEASE_KEY = `${HASH}:12`;

function persistEpisode(cache) {
  const requestId = cache.persistMediaRequest({
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: 'tt0182576',
    mediaType: 'series',
    season: 5,
    episode: 12,
    releaseKey: RELEASE_KEY,
    infoHash: HASH,
    fileIndex: 12,
    filename: 'Family.Guy.S05E12.720p.mkv',
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'ProviderConfirmed',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_700_000_000_000,
  });
  cache.createVfsTvEntry({
    mediaId: 'tt0182576',
    season: 5,
    episode: 12,
    releaseKey: RELEASE_KEY,
    infoHash: HASH,
    fileIndex: 12,
    canonicalPath: 'TV/Family Guy/Season 05/Family Guy - S05E12.mkv',
    size: 100,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
}

function createRequest(range) {
  const request = Readable.from([]);
  request.method = 'GET';
  request.headers = { range };
  return request;
}

function createResponse() {
  const response = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  response.writeHead = () => {
    throw new Error('VFS must not send headers for a rejected provider response');
  };
  return response;
}

test('TV VFS does not amplify a TorBox range rate limit with a fresh retry', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  persistEpisode(cache);

  let deliveryResolutions = 0;
  let providerOpens = 0;
  const deletedRdResolutions = [];
  const handler = createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: {
      delete(infoHash, fileIndex) {
        deletedRdResolutions.push(`${infoHash}:${fileIndex}`);
      },
    },
    // Shared authoritative TorBox delivery seam — simulates what the seam
    // returns: a resolved downstream URL (not the requestdl permalink).
    resolveTorBoxDeliverySeam: async () => {
      deliveryResolutions += 1;
      return { url: 'https://provider.test/file', size: 100, recovered: false };
    },
    torBoxDownloadUrlCache: {
      delete() {},
      get() { return null; },
      getOrInFlight() { throw new Error('unexpected cache call'); },
    },
    fetchFn: async (_url, options) => {
      providerOpens += 1;
      assert.equal(options.headers.range, 'bytes=10-19');
      return new Response('rate limited', { status: 429 });
    },
  });

  await assert.rejects(
    handler(
      createRequest('bytes=10-19'),
      createResponse(),
      new URL('http://localhost/vfs/TV/Family%20Guy/Season%2005/Family%20Guy%20-%20S05E12.mkv'),
    ),
    (error) => error.status === 502 && error.code === 'PROVIDER_RANGE_FAILED',
  );

  assert.equal(deliveryResolutions, 1);
  assert.equal(providerOpens, 1);
  assert.deepEqual(deletedRdResolutions, []);
});
