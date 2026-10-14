/**
 * Plex scanner-pressure regression.
 *
 * Root cause (proven live): the TV WebDAV collection advertised
 * `modifiedAt: now()` on every PROPFIND, so Plex saw every directory as
 * perpetually newer than its last refresh and rescanned continuously. That
 * scanner is the SQLite lock holder behind the PMS `/playQueues`
 * busy-database 500s. The fix derives collection mtime from durable
 * handoff identity (max selectedAt), mirroring movie-webdav.
 *
 * These tests pin the property that matters, not the implementation:
 *   C1  an unchanged collection returns the SAME last-modified on repeated
 *       PROPFINDs (no now()-derived mtime);
 *   C2  the advertised mtime is derived from durable truth, so a later
 *       request cannot make the collection look newer than its content;
 *   C3  adding newer durable content moves the mtime forward (a real
 *       change is still visible to the scanner);
 *   C4  movie and TV collections share the same semantics.
 */

import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createTvWebDav } from '../src/lib/vfs/tv-webdav.js';
import { createMovieWebDav } from '../src/lib/vfs/movie-webdav.js';

const HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RELEASE_KEY = `${HASH}:12`;

function propfind(pathname) {
  const request = Readable.from([]);
  request.method = 'PROPFIND';
  request.headers = { depth: '1' };
  return { request, url: new URL(`http://localhost${pathname}`) };
}

function collectingResponse() {
  const chunks = [];
  const headers = {};
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.writeHead = (status, hdrs = {}) => {
    Object.assign(headers, hdrs);
    response.statusCode = status;
  };
  response.body = () => Buffer.concat(chunks).toString('utf8');
  response.headersActual = headers;
  return response;
}

function lastModifiedOf(body, href) {
  // Pull the <d:getlastmodified> that belongs to the given href.
  const blocks = body.split('<d:response>').slice(1);
  for (const block of blocks) {
    if (!block.includes(`<d:href>${href}</d:href>`)) continue;
    const m = block.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/);
    return m ? m[1] : null;
  }
  return null;
}

function seedEpisode(cache, { episode = 12, selectedAt = 1_700_000_000_000, hash = HASH } = {}) {
  const releaseKey = `${hash}:12`;
  const requestId = cache.persistMediaRequest({
    mediaId: 'tt0182576', mediaType: 'series', season: 5, episode,
    source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: 'tt0182576', mediaType: 'series', season: 5, episode,
    releaseKey, infoHash: hash, fileIndex: 12,
    filename: `Family.Guy.S05E${String(episode).padStart(2, '0')}.720p.mkv`,
    provider: 'torbox', providerState: 'cached',
    identityTier: 'ProviderConfirmed', resolutionState: 'confirmed',
    selectionReason: 'test', selectedAt,
  });
  const code = `S05E${String(episode).padStart(2, '0')}`;
  cache.createVfsTvEntry({
    mediaId: 'tt0182576', season: 5, episode, releaseKey,
    infoHash: hash, fileIndex: 12,
    canonicalPath: `TV/Family Guy/Season 05/Family Guy - ${code}.mkv`,
    size: 100, createdAt: selectedAt, updatedAt: selectedAt,
  });
}

function tvHandler(cache) {
  return createTvWebDav({
    searchCache: cache,
    rdClient: null,
    rdResolutionCache: { delete() {} },
    resolveTorBoxDeliverySeam: async () => {
      throw new Error('no provider I/O expected in a PROPFIND');
    },
    torBoxDownloadUrlCache: { delete() {}, get() { return null; }, getOrInFlight() { throw new Error('unexpected'); } },
  });
}

test('C1 — repeated PROPFIND on an unchanged TV collection returns the same last-modified', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  seedEpisode(cache);
  const handler = tvHandler(cache);
  const href = '/vfs/TV/Family%20Guy/Season%2005/';

  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    const { request, url } = propfind(href);
    const response = collectingResponse();
    await handler(request, response, url);
    seen.push(lastModifiedOf(response.body(), href));
  }

  assert.equal(seen[0], 'Tue, 14 Nov 2023 22:13:20 GMT', 'mtime derived from the durable handoff selectedAt');
  assert.deepEqual(seen, [seen[0], seen[0], seen[0]],
    'an unchanged collection must not look newer on every request (that is what drives scanner churn)');
});

test('C2 — the collection mtime is not wall-clock derived', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  seedEpisode(cache);
  const handler = tvHandler(cache);
  const href = '/vfs/TV/Family%20Guy/Season%2005/';

  const { request, url } = propfind(href);
  const response = collectingResponse();
  await handler(request, response, url);
  const advertised = lastModifiedOf(response.body(), href);

  // A now()-derived mtime would be within the last minute; the durable one is
  // pinned to the fixture timestamp years in the past.
  assert.notEqual(advertised, null);
  const advertisedMs = Date.parse(advertised);
  assert.ok(Number.isFinite(advertisedMs), 'advertised mtime parses as an HTTP date');
  assert.ok(Math.abs(Date.now() - advertisedMs) > 60_000,
    'collection mtime must come from durable truth, not the request clock');
});

test('C3 — newer durable content moves the collection mtime forward', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());
  seedEpisode(cache, { selectedAt: 1_700_000_000_000 });
  const handler = tvHandler(cache);
  const href = '/vfs/TV/Family%20Guy/Season%2005/';

  const first = collectingResponse();
  await handler(propfind(href).request, first, propfind(href).url);
  const before = lastModifiedOf(first.body(), href);

  // A genuinely newer publication for the same season.
  seedEpisode(cache, { episode: 13, selectedAt: 1_800_000_000_000, hash: 'b'.repeat(40) });

  const second = collectingResponse();
  await handler(propfind(href).request, second, propfind(href).url);
  const after = lastModifiedOf(second.body(), href);

  assert.ok(Date.parse(after) > Date.parse(before),
    'a real content change must still be visible to the scanner');
});

test('C4 — movie and TV collections share the same mtime semantics', async (t) => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  t.after(() => cache.close());

  // Movie: durable handoff drives the collection mtime.
  const movieRequestId = cache.persistMediaRequest({
    mediaId: 'tt0111161', mediaType: 'movie', source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId: movieRequestId,
    mediaId: 'tt0111161', mediaType: 'movie',
    releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
    filename: 'The.Shawshank.Redemption.1994.mkv',
    provider: 'torbox', providerState: 'cached',
    identityTier: 'ProviderConfirmed', resolutionState: 'confirmed',
    selectionReason: 'test', selectedAt: 1_700_000_000_000,
  });
  cache.createVfsMovieEntry({
    mediaId: 'tt0111161', releaseKey: `${HASH}:torrent`, infoHash: HASH, fileIndex: null,
    canonicalPath: 'Movies/The Shawshank Redemption (1994)/The Shawshank Redemption (1994).mkv',
    size: 100, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  });

  const movieHandler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: null,
    resolveTorBoxDeliverySeam: async () => {
      throw new Error('no provider I/O expected in a PROPFIND');
    },
    torBoxDownloadUrlCache: { delete() {}, get() { return null; }, getOrInFlight() { throw new Error('unexpected'); } },
  });

  const href = '/vfs/Movies/The%20Shawshank%20Redemption%20(1994)/';
  const seen = [];
  for (let i = 0; i < 2; i += 1) {
    const { request, url } = propfind(href);
    const response = collectingResponse();
    await movieHandler(request, response, url);
    seen.push(lastModifiedOf(response.body(), href));
  }
  assert.deepEqual(seen, [seen[0], seen[0]],
    'movie collections must also be stable across repeated PROPFINDs');
});
