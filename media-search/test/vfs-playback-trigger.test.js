import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createMovieWebDav } from '../src/lib/vfs/movie-webdav.js';
import { createTvWebDav } from '../src/lib/vfs/tv-webdav.js';

// ---------------------------------------------------------------------------
// T10 — playback Range intent wired into the redundancy coordinator.
// Drives the real movie + TV VFS factories with a fake data plane;
// zero live HTTP, zero provider calls.
// ---------------------------------------------------------------------------

const HASH = '06bfe49fdc99ad0c6fef1f761382a8181490e456';
const PATH = 'Oppenheimer.2023/Oppenheimer.2023.mkv';
const SIZE = 100;
const HASH_TV = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function seedTf(cpStore) {
  const placement = cpStore.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: HASH,
    providerResourceId: 'TB1', state: 'ready', ownership: 'external',
    ownerKey: null, provenance: 'test-seed',
    observedAt: 1000, expiresAt: 2000,
  });
  const inv = cpStore.replaceProviderFileInventory(placement.id, [{
    providerFileId: '1', path: PATH, name: 'Oppenheimer.2023.mkv',
    size: SIZE, selected: true, corpusFileIndex: 1,
  }], { authoritative: true, complete: false, expiresAt: 2000, evidence: { source: 'test-seed' } });
  const mapped = inv.find((r) => r.mappingState === 'mapped');
  assert.ok(mapped, 'seed must map the exact TorrentFile');
  return mapped.torrentFileId;
}

function seedMovie(disc, tfId) {
  const requestId = disc.persistMediaRequest({
    mediaId: 'tt0000001', mediaType: 'movie', source: 'test',
  }, []);
  disc.persistPlaybackHandoff({
    requestId, mediaId: 'tt0000001', mediaType: 'movie',
    season: null, episode: null, releaseKey: `${HASH}:torrent`,
    infoHash: HASH, fileIndex: null, filename: 'Oppenheimer.2023.2160p.mkv',
    provider: 'torbox', providerState: 'cached', identityTier: 'Verified',
    resolutionState: 'confirmed', selectionReason: 'test', selectedAt: 1,
    torrentFileId: tfId,
  });
  disc.createVfsMovieEntry({
    mediaId: 'tt0000001', releaseKey: `${HASH}:torrent`, infoHash: HASH,
    fileIndex: null, canonicalPath: 'Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv',
    torrentFileId: tfId, size: SIZE, createdAt: 1, updatedAt: 1,
  });
}

function seedEpisode(disc, cpStore) {
  const nowMs = Date.now();
  const placement = cpStore.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: HASH_TV,
    providerResourceId: 'TB2', state: 'ready', ownership: 'external',
    ownerKey: null, provenance: 'test-seed',
    observedAt: nowMs, expiresAt: nowMs + 3600000,
  });
  const inv = cpStore.replaceProviderFileInventory(placement.id, [{
    providerFileId: '2', path: 'Family.Guy/Family.Guy.S05E12.mkv',
    name: 'Family.Guy.S05E12.mkv', size: SIZE, selected: true, corpusFileIndex: 12,
  }], { authoritative: true, complete: true, expiresAt: nowMs + 3600000, evidence: { source: 'test-seed' } });
  const mapped = inv.find((r) => r.mappingState === 'mapped');
  assert.ok(mapped, 'seed must map the exact TorrentFile');
  const tfId = mapped.torrentFileId;
  cpStore.recordFileMapping({
    releaseKey: `${HASH_TV}:12`, infoHash: HASH_TV, fileIndex: 12,
    placementId: placement.id, providerFileId: '2', method: 'test',
    authoritative: true, evidence: { source: 'test-seed' },
  });
  const requestId = disc.persistMediaRequest({
    mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, source: 'test',
  }, []);
  disc.persistPlaybackHandoff({
    requestId, mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12,
    releaseKey: `${HASH_TV}:12`, infoHash: HASH_TV, fileIndex: 12,
    filename: 'Family.Guy.S05E12.720p.mkv', provider: 'torbox',
    providerState: 'cached', identityTier: 'ProviderConfirmed',
    resolutionState: 'confirmed', selectionReason: 'test',
    selectedAt: nowMs, torrentFileId: tfId,
  });
  // No manual VFS entry: tv materialize derives the canonical path at
  // catalog time. Callers discover it via PROPFIND, like real clients.
  return tfId;
}

async function propfindFileHref(handler, rootUrl) {
  // Walk collections breadth-first like a real client; the file may sit
  // two levels down (show -> season -> file).
  const queue = [rootUrl];
  for (let depth = 0; depth < 4 && queue.length > 0; depth += 1) {
    const next = [];
    for (const url of queue) {
      const res = await createRequest(handler)(url, {
        method: 'PROPFIND', headers: { depth: '1' },
      });
      assert.equal(res.status, 207, `PROPFIND ${url}`);
      const xml = res.body.toString('utf8');
      const file = xml.match(/<d:href>([^<]*\.mkv)<\/d:href>/);
      if (file) return file[1];
      for (const m of xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)) {
        if (m[1] !== url && m[1] !== `${url}/` && !queue.includes(m[1]) && !next.includes(m[1])) {
          next.push(m[1]);
        }
      }
    }
    queue.splice(0, queue.length, ...next);
  }
  assert.fail('catalog publishes no file href');
}

function stubSeams() {
  return {
    rdResolutionCache: {
      get() { return null; },
      set() {},
      delete() {},
      async getOrInFlight(_a, _b, factory) { return factory(); },
    },
    resolveTorBoxDeliverySeam: async () => ({ url: 'https://provider.test/file', size: null, recovered: false }),
    torBoxDownloadUrlCache: { get() { return null; }, set() {}, delete() {}, async getOrInFlight() { throw new Error('unused'); } },
  };
}

function fakeController() {
  const notifies = [];
  const reports = [];
  return {
    notifies,
    reports,
    notifyForegroundDemand(a) { notifies.push(a); return { scheduled: true }; },
    reportServingPrimary(a) { reports.push(a); return { recorded: true }; },
  };
}

function headersOf(obj) {
  return { get: (name) => obj[String(name).toLowerCase()] ?? null };
}

function webBody(chunks) {
  const nodeStream = new Readable({
    read() {
      if (chunks.length === 0) { this.push(null); return; }
      this.push(chunks.shift());
    },
  });
  return Readable.toWeb(nodeStream);
}

function dpFetch(calls, markers, headers, bodyBytes = Buffer.from('0123456789')) {
  return async (_url, _init) => {
    markers.push('fetch');
    calls.push(1);
    return { status: 206, headers: headersOf(headers), body: webBody([bodyBytes]) };
  };
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

const MOVIE_URL = '/vfs/Movies/Oppenheimer%20(2023)/Oppenheimer%20(2023).mkv';

// ---- T1: valid Range GET triggers once per path and streams immediately ----
test('T1 Range GET notifies once with exact TF and streams without waiting', async (t) => {
  const cpStore = createControlPlaneStore();
  const tfId = seedTf(cpStore);
  const disc = createDiscoveryCache();
  t.after(() => { disc.close(); cpStore.close?.(); });
  seedMovie(disc, tfId);
  const controller = fakeController();
  const markers = [];
  const calls = [];
  const handler = createMovieWebDav({
    searchCache: disc, controlPlaneStore: cpStore, rdClient: null,
    ...stubSeams(),
    fetchFn: dpFetch(calls, markers, { 'content-range': 'bytes 10-19/100' }),
    playbackRedundancy: controller,
  });
  const response = await createRequest(handler)(MOVIE_URL, {
    method: 'GET', headers: { range: 'bytes=10-19' },
  });
  assert.equal(response.status, 206);
  assert.deepEqual(controller.notifies, [{ torrentFileId: tfId }], 'T1: exactly one notify, exact TF, no extras');
  assert.deepEqual(markers, ['fetch'], 'T1: data-plane streaming started');
  assert.ok(controller.notifies.length === 1 && calls.length === 1);

  // TV path: same contract on the separate TV seam (catalog-discovered href).
  const tvTfId = seedEpisode(disc, cpStore);
  const tvController = fakeController();
  const tvMarkers = [];
  const tvHandler = createTvWebDav({
    searchCache: disc, controlPlaneStore: cpStore, rdClient: null,
    ...stubSeams(),
    fetchFn: dpFetch([], tvMarkers, { 'content-range': 'bytes 10-19/100' }),
    playbackRedundancy: tvController,
  });
  const tvHref = await propfindFileHref(tvHandler, '/vfs/TV');
  const tvResponse = await createRequest(tvHandler)(tvHref, {
    method: 'GET', headers: { range: 'bytes=10-19' },
  });
  assert.equal(tvResponse.status, 206);
  assert.deepEqual(tvController.notifies, [{ torrentFileId: tvTfId }], 'T1: TV path notifies with its own TF');
  assert.deepEqual(tvMarkers, ['fetch']);
  console.log('T1 ok: movie+TV trigger once, streaming immediate');
});

// ---- T2: HEAD / PROPFIND / malformed Range / legacy entries never trigger ----
test('T2 non-qualifying requests never notify', async (t) => {
  const cpStore = createControlPlaneStore();
  const tfId = seedTf(cpStore);
  const disc = createDiscoveryCache();
  t.after(() => { disc.close(); cpStore.close?.(); });
  seedMovie(disc, tfId);
  // Legacy entry without exact TF id (mirrors the pre-T10 serving path).
  const legacyReqId = disc.persistMediaRequest({ mediaId: 'tt0000002', mediaType: 'movie', source: 'test' }, []);
  disc.persistPlaybackHandoff({
    requestId: legacyReqId, mediaId: 'tt0000002', mediaType: 'movie',
    season: null, episode: null, releaseKey: `${HASH}:torrent`,
    infoHash: HASH, fileIndex: null, filename: 'Companion.2025.mkv',
    provider: 'torbox', providerState: 'cached', identityTier: 'Verified',
    resolutionState: 'confirmed', selectionReason: 'test', selectedAt: 2,
  });
  disc.createVfsMovieEntry({
    mediaId: 'tt0000002', releaseKey: `${HASH}:torrent`, infoHash: HASH,
    fileIndex: null, canonicalPath: 'Movies/Companion (2025)/Companion (2025).mkv',
    size: SIZE, createdAt: 2, updatedAt: 2,
  });
  const controller = fakeController();
  const handler = createMovieWebDav({
    searchCache: disc, controlPlaneStore: cpStore, rdClient: null,
    ...stubSeams(),
    fetchFn: dpFetch([], [], { 'content-range': 'bytes 10-19/100' }),
    playbackRedundancy: controller,
  });
  const request = createRequest(handler);
  await request(MOVIE_URL, { method: 'HEAD' });
  await request('/vfs/Movies', { method: 'PROPFIND', headers: { depth: '1' } });
  await request(MOVIE_URL, { method: 'GET', headers: { range: 'bytes=zzz' } });
  await request('/vfs/Movies/Companion%20(2025)/Companion%20(2025).mkv', {
    method: 'GET', headers: { range: 'bytes=10-19' },
  });
  assert.deepEqual(controller.notifies, [], 'T2: HEAD/PROPFIND/malformed/legacy never notify');
  assert.deepEqual(controller.reports, [], 'T2: no attribution reports without a qualifying forward');
  console.log('T2 ok: exclusions hold');
});

// ---- T3: provider-backed attribution is reported to the same TF ----
test('T3 upstream serving headers are reported under the exact TF', async (t) => {
  const cpStore = createControlPlaneStore();
  const tfId = seedTf(cpStore);
  const disc = createDiscoveryCache();
  t.after(() => { disc.close(); cpStore.close?.(); });
  seedMovie(disc, tfId);
  const controller = fakeController();
  const handler = createMovieWebDav({
    searchCache: disc, controlPlaneStore: cpStore, rdClient: null,
    ...stubSeams(),
    fetchFn: dpFetch([], [], {
      'content-range': 'bytes 10-19/100',
      'x-hashsucker-serving-provider': 'torbox',
      'x-hashsucker-serving-resource-id': 'TB1',
      'x-hashsucker-serving-file-id': '1',
      'x-hashsucker-serving-cap-id': 'torbox-1-0',
    }),
    playbackRedundancy: controller,
  });
  const response = await createRequest(handler)(MOVIE_URL, {
    method: 'GET', headers: { range: 'bytes=10-19' },
  });
  assert.equal(response.status, 206);
  assert.deepEqual(controller.reports, [{
    torrentFileId: tfId, provider: 'torbox', providerResourceId: 'TB1',
    providerFileId: '1', capId: 'torbox-1-0',
  }], 'T3: attribution reported to the same TF activation');
  assert.ok(!('x-hashsucker-serving-provider' in (response.headers ?? {})), 'T3: internal headers stripped from player');
  console.log('T3 ok: provider-backed attribution reported, player clean');
});

// ---- T4: cache-hit null attribution is reported as null, never guessed ----
test('T4 null attribution is reported verbatim with zero provider guess', async (t) => {
  const cpStore = createControlPlaneStore();
  const tfId = seedTf(cpStore);
  const disc = createDiscoveryCache();
  t.after(() => { disc.close(); cpStore.close?.(); });
  seedMovie(disc, tfId);
  const controller = fakeController();
  const handler = createMovieWebDav({
    searchCache: disc, controlPlaneStore: cpStore, rdClient: null,
    ...stubSeams(),
    fetchFn: dpFetch([], [], { 'content-range': 'bytes 10-19/100' }),
    playbackRedundancy: controller,
  });
  const response = await createRequest(handler)(MOVIE_URL, {
    method: 'GET', headers: { range: 'bytes=10-19' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.body.toString('utf8'), '0123456789');
  assert.deepEqual(controller.notifies, [{ torrentFileId: tfId }]);
  assert.deepEqual(controller.reports, [{ torrentFileId: tfId }], 'T4: null reported as TF-only, no provider key guessed');
  console.log('T4 ok: null attribution verbatim, bytes intact');
});
