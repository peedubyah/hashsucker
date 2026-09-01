import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { buildPlaybackHandoff } from '../src/lib/discovery/playback-handoff.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';
import { createMovieWebDav } from '../src/lib/vfs/movie-webdav.js';

const HASH = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

function persistHandoff(cache, handoff) {
  const requestId = cache.persistMediaRequest({
    mediaId: handoff.mediaId,
    mediaType: 'movie',
    source: 'test',
  }, []);
  cache.persistPlaybackHandoff({
    requestId,
    mediaId: handoff.mediaId,
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: handoff.releaseKey,
    infoHash: handoff.infoHash,
    fileIndex: handoff.fileIndex,
    filename: handoff.filename,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'test',
    selectedAt: 1_700_000_000_000,
  });
}

function buildHandoffRequest(extra = {}) {
  return {
    requestId: 1,
    mediaId: 'tt15239678',
    mediaType: 'movie',
    season: null,
    episode: null,
    ...extra,
  };
}

test('buildPlaybackHandoff surfaces canonicalTitle and canonicalYear on the handoff', () => {
  const selection = {
    selected: {
      infoHash: HASH,
      fileIndex: null,
      filename: 'Dune - Parte Due - Part Two (2024) WebDl Rip 2160p H265 10 bit DV HDR10+ ita eng AC3 5.1 sub ita eng Licdom.mkv',
      torboxState: 'cached',
      identityTier: 'Verified',
      release: { resolution: '2160p' },
    },
    reason: 'test',
  };
  const handoff = buildPlaybackHandoff(selection, buildHandoffRequest({
    canonicalTitle: 'Dune: Part Two',
    canonicalYear: 2024,
  }));
  assert.equal(handoff.canonicalTitle, 'Dune: Part Two');
  assert.equal(handoff.canonicalYear, 2024);
  // Provider filename must be untouched
  assert.ok(handoff.filename.includes('Dune - Parte Due - Part Two'));
  assert.equal(handoff.infoHash, HASH);
});

test('buildPlaybackHandoff omits canonical fields when not provided (existing callers unaffected)', () => {
  const selection = {
    selected: {
      infoHash: HASH,
      fileIndex: null,
      filename: 'Dune.mkv',
      torboxState: 'cached',
      identityTier: 'Verified',
      release: { resolution: '2160p' },
    },
    reason: 'test',
  };
  const handoff = buildPlaybackHandoff(selection, buildHandoffRequest());
  assert.equal(handoff.canonicalTitle, undefined);
  assert.equal(handoff.canonicalYear, undefined);
});

test('materializeVfsEntry uses canonical title/year when present on handoff', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const handoff = buildPlaybackHandoff({
    selected: {
      infoHash: HASH,
      fileIndex: null,
      filename: 'Dune - Parte Due - Part Two (2024) WebDl Rip 2160p H265 10 bit DV HDR10+ ita eng AC3 5.1 sub ita eng Licdom.mkv',
      torboxState: 'cached',
      identityTier: 'Verified',
      release: { resolution: '2160p' },
    },
    reason: 'test',
  }, buildHandoffRequest({ canonicalTitle: 'Dune: Part Two', canonicalYear: 2024 }));
  persistHandoff(cache, handoff);

  const entry = materializeVfsEntry(cache, handoff);
  assert.equal(entry.canonicalPath, 'Movies/Dune Part Two (2024)/Dune Part Two (2024).mkv');
  // The provider identity is preserved
  assert.equal(entry.infoHash, HASH);
  assert.equal(entry.releaseKey, handoff.releaseKey);
});

test('materializeVfsEntry falls back to filename-derived identity when no canonical fields', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  // Use a clean filename that the existing movieIdentity parser will
  // collapse to a known stable path. The exact path the parser picks
  // is not the assertion under test — the assertion is that canonical
  // title/year are NOT used and the filename-derived path is taken.
  const handoff = buildPlaybackHandoff({
    selected: {
      infoHash: HASH,
      fileIndex: null,
      filename: 'Knives.Out.2019.2160p.mkv',
      torboxState: 'cached',
      identityTier: 'Verified',
      release: { resolution: '2160p' },
    },
    reason: 'test',
  }, buildHandoffRequest());
  persistHandoff(cache, handoff);

  const entry = materializeVfsEntry(cache, handoff);
  // Without canonical fields, the existing filename-derived path is used
  assert.equal(entry.canonicalPath, 'Movies/Knives Out (2019)/Knives Out (2019).mkv');
});

test('materializeVfsEntry is idempotent when canonical fields are absent and entry already exists', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const handoff = buildPlaybackHandoff({
    selected: {
      infoHash: HASH,
      fileIndex: null,
      filename: 'Knives.Out.2019.2160p.mkv',
      torboxState: 'cached',
      identityTier: 'Verified',
      release: { resolution: '2160p' },
    },
    reason: 'test',
  }, buildHandoffRequest());
  persistHandoff(cache, handoff);

  const first = materializeVfsEntry(cache, handoff);
  const second = materializeVfsEntry(cache, handoff);
  assert.equal(first.canonicalPath, second.canonicalPath);
});

test('PROPFIND after canonical-path materialization advertises the canonical title in d:displayname', async (t) => {
  const cache = createDiscoveryCache();
  t.after(() => cache.close());

  const handoff = buildPlaybackHandoff({
    selected: {
      infoHash: HASH,
      fileIndex: null,
      filename: 'Dune - Parte Due - Part Two (2024) WebDl Rip 2160p H265 10 bit DV HDR10+ ita eng AC3 5.1 sub ita eng Licdom.mkv',
      torboxState: 'cached',
      identityTier: 'Verified',
      release: { resolution: '2160p' },
    },
    reason: 'test',
  }, buildHandoffRequest({ canonicalTitle: 'Dune: Part Two', canonicalYear: 2024 }));
  persistHandoff(cache, handoff);
  materializeVfsEntry(cache, handoff);

  const handler = createMovieWebDav({
    searchCache: cache,
    controlPlaneStore: { findPlacementByInfoHash: () => null, findFileMapping: () => null, listProviderFiles: () => [] },
    rdClient: null,
    rdResolutionCache: { get: () => null, delete: () => {}, set: () => {}, async getOrInFlight() {} },
    resolveTorBoxDeliverySeam: async () => ({ url: 'https://provider.test/file', size: null, recovered: false }),
    torBoxDownloadUrlCache: { get: () => null, set: () => {}, delete: () => {}, async getOrInFlight() {} },
  });

  function createReq(handler) {
    return async (url, { method = 'GET', headers = {} } = {}) => {
      const input = Readable.from([]);
      input.method = method;
      input.url = url;
      input.headers = headers;
      return new Promise((resolve, reject) => {
        const chunks = [];
        const response = new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
        });
        response.writeHead = function writeHead(status, responseHeaders) {
          this.status = status;
          this.headers = responseHeaders;
        };
        response.on('finish', () => resolve({
          status: response.status,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
        response.on('error', reject);
        handler(input, response, new URL(url, 'http://localhost')).catch(reject);
      });
    };
  }

  const request = createReq(handler);
  const response = await request('/vfs/Movies/Dune%20Part%20Two%20(2024)/', {
    method: 'PROPFIND',
    headers: { depth: '1' },
  });
  assert.equal(response.status, 207);
  const xml = response.body.toString('utf8');
  // Canonical displayname present
  assert.match(xml, /Dune%20Part%20Two%20\(2024\)/);
  // Noisy release name absent
  assert.doesNotMatch(xml, /Licdom/);
  assert.doesNotMatch(xml, /Parte%20Due/);
});
