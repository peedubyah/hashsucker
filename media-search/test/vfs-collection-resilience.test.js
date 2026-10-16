/**
 * VFS collection traversal resilience.
 *
 * The discovery cache keeps ONE playback_handoffs row per media slot, and the
 * upsert overwrites in place when a later request selects a different
 * authoritative TorrentFile. A published VFS row therefore ends up naming a
 * release whose handoff no longer exists, and the old catalog path threw
 * HANDOFF_MISSING — which made the ENTIRE collection unlistable.
 *
 * Contracts pinned here:
 *
 *   C1  a collection listing still succeeds (207) when one entry's published
 *       handoff was superseded by a later selection;
 *   C2  that entry resolves through the active Binding (Binding authority
 *       wins), and its bytes route to the SAME TorrentFile;
 *   C3  neighbouring titles are unaffected (still listed, still readable);
 *   C4  an entry with no handoff and no authoritative Binding is ISOLATED:
 *       it is reported and skipped, never served, and never blocks others;
 *   C5  the legacy discovery path (no control plane) still works when the
 *       handoff is present.
 */

import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createMovieWebDav } from '../src/lib/vfs/movie-webdav.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_NEW = 'cccccccccccccccccccccccccccccccccccccccc';

function persistMovie(cache, { mediaId, infoHash, filename = 'Movie.mkv' }) {
  const requestId = cache.persistMediaRequest({ mediaId, mediaType: 'movie', source: 'test' }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId,
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: `${infoHash}:torrent`,
    infoHash,
    fileIndex: null,
    filename,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_700_000_000_000,
  });
}

function vfsRow(cache, { mediaId, infoHash, title, size }) {
  cache.createVfsMovieEntry({
    mediaId,
    releaseKey: `${infoHash}:torrent`,
    infoHash,
    fileIndex: null,
    canonicalPath: `Movies/${title}/${title}.mkv`,
    size,
    createdAt: 1,
    updatedAt: 1,
  });
}

/** A control plane exposing an active Binding for one media coordinate. */
function controlPlaneWithBinding({
  mediaId, infoHash, torrentFileId, internalPath = 'Show/S.mkv', size = 4096,
}) {
  return {
    getLibraryItemByIdentityKey(key) {
      return key === `movie:${mediaId}:default` ? { id: `li-${mediaId}` } : null;
    },
    getActiveBindingForLibraryItem() {
      return {
        binding: {
          id: 'bd-1', releaseKey: `${infoHash}:torrent`, infoHash,
          fileIndex: null, torrentFileId, placementId: 'pl-1', providerFileId: '0',
          status: 'active', validFrom: 1_700_000_000_000,
        },
        torrentFile: { id: torrentFileId, infoHash, internalPath, size },
      };
    },
  };
}

const NO_STITCHES = {
  resolveTorBoxDeliverySeam: async () => ({ url: 'https://provider.test/file', size: null, recovered: false }),
  torBoxDownloadUrlCache: { get() { return null; }, set() {}, delete() {}, async getOrInFlight() { throw new Error('unused'); } },
  torBoxRedirectOptions: { apiKey: 'test-token', apiBase: 'https://provider.test' },
  fetchFn: async () => providerResponse(206, { body: 'bytes!!', contentRange: 'bytes 0-6/4096' }),
};

function providerResponse(status, { body, contentRange }) {
  const headers = new Headers();
  if (contentRange) headers.set('content-range', contentRange);
  return new Response(Buffer.from(body), { status, headers });
}

function createRequest(handler) {
  return async (url, { method = 'GET', headers = {} } = {}) => {
    const input = Readable.from([]);
    input.method = method;
    input.url = url;
    input.headers = headers;
    return new Promise((resolve, reject) => {
      const chunks = [];
      const response = new Writable({
        write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
      });
      response.writeHead = function writeHead(status, responseHeaders) {
        this.status = status;
        this.headers = responseHeaders;
      };
      response.on('finish', () => resolve({ status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
      try {
        const result = handler(input, response, new URL(url, 'http://localhost'));
        Promise.resolve(result).catch((error) => {
          response.end(JSON.stringify({ code: error?.code ?? 'THROWN', message: error?.message ?? String(error) }));
        });
      } catch (error) {
        reject(error);
      }
    });
  };
}

test('C1/C2/C3 — one superseded handoff does not make the collection unlistable', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  // Healthy neighbour: handoff present and matching its row.
  persistMovie(cache, { mediaId: 'tt-neighbour', infoHash: HASH_B });
  vfsRow(cache, { mediaId: 'tt-neighbour', infoHash: HASH_B, title: 'Neighbour', size: 4096 });

  // Divergent title: published row for HASH_A, but the handoff was overwritten
  // by a later selection of a DIFFERENT release (HASH_NEW).
  persistMovie(cache, { mediaId: 'tt-divergent', infoHash: HASH_NEW });
  vfsRow(cache, { mediaId: 'tt-divergent', infoHash: HASH_A, title: 'Divergent', size: 4096 });

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: controlPlaneWithBinding({
      mediaId: 'tt-divergent', infoHash: HASH_A, torrentFileId: 'tf-divergent', size: 4096,
    }),
    rdClient: null,
    rdResolutionCache: { get() { return null; }, set() {}, delete() {} },
    ...NO_STITCHES,
  });

  const request = createRequest(handler);
  const listing = await request('/vfs/Movies/', { method: 'PROPFIND', headers: { depth: '1' } });
  assert.equal(listing.status, 207, `the collection lists, got ${listing.status}: ${listing.body.slice(0, 120)}`);
  assert.ok(listing.body.includes('Neighbour'), 'the healthy neighbour is still listed');
  assert.ok(listing.body.includes('Divergent'), 'the divergent title is still listed (recovered)');

  // Its bytes route to the authoritative TorrentFile, byte-exact.
  const read = await request('/vfs/Movies/Divergent/Divergent.mkv', {
    method: 'GET', headers: { range: 'bytes=0-6' },
  });
  assert.equal(read.status, 206);
  assert.equal(read.body, 'bytes!!', 'bytes are exact through the recovered authority');

  // The neighbour still serves.
  const neighbourRead = await request('/vfs/Movies/Neighbour/Neighbour.mkv', {
    method: 'GET', headers: { range: 'bytes=0-6' },
  });
  assert.equal(neighbourRead.status, 206, 'a neighbouring title does not regress');
});

test('C4 — an unbackable entry is isolated and reported, never blocks others', async (t) => {
  const restoreConsole = () => { console.warn = savedWarn; console.log = savedLog; };
  t.after(restoreConsole);
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  persistMovie(cache, { mediaId: 'tt-healthy', infoHash: HASH_B });
  vfsRow(cache, { mediaId: 'tt-healthy', infoHash: HASH_B, title: 'Healthy', size: 4096 });

  // A row with NO handoff for its release and NO Binding backing it.
  vfsRow(cache, { mediaId: 'tt-unbacked', infoHash: HASH_A, title: 'Unbacked', size: 4096 });

  const reports = [];
  const capture = (...args) => reports.push(args.join(' '));
  const savedWarn = console.warn;
  const savedLog = console.log;
  console.warn = capture;
  console.log = capture;
  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: { getLibraryItemByIdentityKey: () => null, getActiveBindingForLibraryItem: () => null },
    rdClient: null,
    rdResolutionCache: { get() { return null; }, set() {}, delete() {} },
    ...NO_STITCHES,
  });
  t.after(() => { console.warn = savedWarn; console.log = savedLog; });

  const request = createRequest(handler);
  const listing = await request('/vfs/Movies/', { method: 'PROPFIND', headers: { depth: '1' } });
  assert.equal(listing.status, 207, `the collection still lists, got ${listing.status}`);
  assert.ok(listing.body.includes('Healthy'), 'the healthy title is listed');
  assert.ok(!listing.body.includes('Unbacked'), 'the unbackable entry is not served');
  assert.ok(
    reports.some((w) => w.includes('isolated') && w.includes('tt-unbacked')),
    `the isolated entry is reported, got: ${reports.join(' | ').slice(0, 200)}`,
  );
});

test('C5 — the legacy discovery path is unchanged when the handoff is present', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());
  persistMovie(cache, { mediaId: 'tt-legacy', infoHash: HASH_A, filename: 'Legacy.mkv' });
  vfsRow(cache, { mediaId: 'tt-legacy', infoHash: HASH_A, title: 'Legacy', size: 4096 });

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: null, // no control plane at all: legacy behaviour
    rdClient: null,
    rdResolutionCache: { get() { return null; }, set() {}, delete() {} },
    ...NO_STITCHES,
  });
  const request = createRequest(handler);
  const listing = await request('/vfs/Movies/', { method: 'PROPFIND', headers: { depth: '1' } });
  assert.equal(listing.status, 207);
  assert.ok(listing.body.includes('Legacy'), 'the legacy title still lists');
});
