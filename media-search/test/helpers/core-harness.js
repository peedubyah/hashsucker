/**
 * Core acceptance harness (shared fixtures).
 *
 * Deterministic end-to-end fixtures for the core product contract, using
 * real production modules (searchByMedia, runBloodhoundDiscovery,
 * selectBindableCandidate, future-intent store/scheduler) with injectable
 * seams for live discovery, provider binding, Plex presence, fetch, and
 * clock. Nothing here hits the network; global fetch is stubbed per test.
 *
 * Scenario coverage lives in core-acceptance-harness.test.js; related
 * workflow coverage in recent-release-bloodhound.test.js (bloodhound
 * trigger/merge/observability) and autonomous-core-hardening.test.js
 * (retry topology, scheduler lifecycle).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDiscoveryCache } from '../../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../../src/lib/discovery/release-attributes.js';
import { runBloodhoundDiscovery } from '../../src/lib/discovery/live-bridge.js';

export const MEDIA_ID = 'tt8880001';
export const LIVE_H1 = 'c111111111111111111111111111111111111111';
export const LIVE_H2 = 'c222222222222222222222222222222222222222';
export const CORPUS_H1 = 'd111111111111111111111111111111111111111';
export const FILENAMES = {
  [LIVE_H1]: 'Harness.S01E07.1080p.WEB-DL.DD5.1.H.264-G1.mkv',
  [LIVE_H2]: 'Harness.S01E07.720p.HDTV.x264-G2.mkv',
};
export const SIZES = { [LIVE_H1]: 2147483648, [LIVE_H2]: 1073741824 };

export function seedCorpusRow(cache, { infoHash, season = 1, episode = 7, title = 'Harness' }) {
  const filename = `${title}.S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.1080p.WEB-DL.mkv`;
  cache.upsertCandidate({ infoHash, fileIndex: null, filename, title });
  storeReleaseAttributes(cache, {
    infoHash, fileIndex: null, filename, source: 'harness', confidence: 0.9,
    parsed: { title, year: 2026, season, episode, resolution: '1080p', mediaType: 'series' },
    evidence: ['harness'],
  });
  cache.associateMedia(infoHash, null, MEDIA_ID, {
    source: 'harness', confidence: 0.8, evidence: ['harness'],
    resolutionState: 'probable', matchMethod: 'harness', resolverSource: 'harness', resolverVersion: '1.0',
  });
}

export function fixtureAddons() {
  return [
    { id: 'torrentio-torbox', provider: 'torrentio', debridProvider: 'torbox', manifestUrl: 'https://fake.local/torrentio-torbox/manifest.json', enabled: true },
    { id: 'torrentio-realdebrid', provider: 'torrentio', debridProvider: 'realdebrid', manifestUrl: 'https://fake.local/torrentio-realdebrid/manifest.json', enabled: true },
    { id: 'comet-torbox', provider: 'comet', debridProvider: 'torbox', manifestUrl: 'https://fake.local/comet-torbox/manifest.json', enabled: true },
    { id: 'comet-realdebrid', provider: 'comet', debridProvider: 'realdebrid', manifestUrl: 'https://fake.local/comet-realdebrid/manifest.json', enabled: true },
  ];
}

export function streamRow(infoHash, filename, { videoSize = null } = {}) {
  return {
    infoHash, name: 'Harness', title: 'Harness 1080p', description: filename,
    behaviorHints: { ...(filename ? { filename } : {}), ...(videoSize != null ? { videoSize } : {}) },
  };
}

export function liveStreams() {
  return {
    'torrentio-torbox': [
      streamRow(LIVE_H1, FILENAMES[LIVE_H1], { videoSize: SIZES[LIVE_H1] }),
      streamRow(LIVE_H2, FILENAMES[LIVE_H2], { videoSize: SIZES[LIVE_H2] }),
    ],
    'torrentio-realdebrid': [],
    'comet-torbox': [
      streamRow(LIVE_H1, FILENAMES[LIVE_H1], { videoSize: SIZES[LIVE_H1] }),
    ],
    'comet-realdebrid': [],
  };
}

// Global fetch stub: fixture addon manifests answer from the map; every
// other URL fails loudly (unexpected network) while recording attempts.
export function stubFetch(t, streamsByAddon, seen) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (seen) seen.push(href);
    if (!href.includes('fake.local')) {
      throw new Error(`unexpected network access in harness: ${href.slice(0, 140)}`);
    }
    const key = Object.keys(streamsByAddon).find((k) => href.includes(k));
    return { ok: true, status: 200, json: async () => ({ streams: streamsByAddon[key] ?? [] }) };
  };
  t.after(() => { globalThis.fetch = realFetch; });
}

// Provider ensure stub: binds exactly the hashes in bindableSet.
// PATH A (exact size): returns the identity triple. PATH B/TV + movie
// (skipSizeMatch inventory probe): returns placement inventory so episode
// resolution / single-file cardinality can bind. Everything else fails
// NO_PLACEMENT. Bound TorrentFiles mirror into the backing store.
export function stubEnsure(calls, { bindable = new Set(), backingStore = null } = {}) {
  return async ({ infoHash, selectedFileSize, skipSizeMatch, controlPlaneStore } = {}) => {
    calls.push({ infoHash, selectedFileSize: selectedFileSize ?? null, skipSizeMatch: !!skipSizeMatch, controlPlaneStore: controlPlaneStore ?? null });
    const hash = String(infoHash || '').toLowerCase();
    if (!bindable.has(hash)) {
      const err = new Error(`No cached placement for ${hash}`);
      err.code = 'NO_PLACEMENT';
      throw err;
    }
    const size = Number.isSafeInteger(selectedFileSize) && selectedFileSize > 0
      ? selectedFileSize
      : (SIZES[hash] ?? 100);
    const tf = {
      id: `tf_h_${hash.slice(0, 8)}`, infoHash: hash, size,
      internalPath: `Harness/Season 01/Harness - S01E07-${hash.slice(0, 4)}.mkv`,
    };
    backingStore?.register?.(tf);
    if (skipSizeMatch) {
      return { placementId: 'pl_h', torrentFiles: [{ ...tf }] };
    }
    if (!Number.isSafeInteger(selectedFileSize)) {
      const err = new Error(`No exact size for ${hash}`);
      err.code = 'NO_PLACEMENT';
      throw err;
    }
    return { placementId: 'pl_h', providerFileId: 'pf_h', torrentFileId: tf.id, size };
  };
}

// Control-plane stub with library/binding readback over registered files.
export function stubStoreWithCoords() {
  const tfs = new Map();
  const coords = [];
  const store = {
    getTorrentFile: (id) => tfs.get(id) ?? null,
    listTorrentFilesForRelease: () => [],
    listProviderRefsForTorrentFile: () => [],
    listDataPlaneCoordinates: (id) => coords.filter((c) => c.torrentFileId === id),
    getLibraryItemByIdentityKey: () => ({ id: 'lib_h', desiredState: 'present' }),
    getActiveBindingForLibraryItem: () => {
      const tf = [...tfs.values()][0];
      if (!tf) return null;
      return {
        torrentFile: { ...tf },
        binding: { releaseKey: `${tf.infoHash}:torrent`, infoHash: tf.infoHash, fileIndex: null },
      };
    },
    getActiveCanonicalPath: () => 'Harness (2026)/Season 01/Harness - S01E07.mkv',
    register: (tf) => {
      tfs.set(tf.id, tf);
      coords.push({ torrentFileId: tf.id, provider: 'torbox', present: true, size: tf.size });
    },
  };
  return store;
}

export function withTmpStrm(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-harness-strm-'));
  const saved = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export function withTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-harness-db-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

export function openFileCache(dir, name = 'cache.db') {
  return createDiscoveryCache({ dbPath: path.join(dir, name) });
}

// Live seam using the REAL bloodhound runner over fixture addons.
// (The stubbed fetch installed by stubFetch serves the rows.)
export function bloodhoundSeam(liveCounter) {
  return async (mediaId, opts) => {
    liveCounter.count++;
    return runBloodhoundDiscovery(mediaId, { ...opts, addons: fixtureAddons(), torznabIndexers: [] });
  };
}

export function baseRequest(extra = {}) {
  return {
    mediaId: MEDIA_ID,
    mediaType: 'series',
    mediaTitle: 'Harness',
    canonicalTitle: 'Harness',
    canonicalYear: 2026,
    season: 1,
    episode: 7,
    skipAvailability: true,
    persist: true,
    ...extra,
  };
}
