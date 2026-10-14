/**
 * Recent-release bloodhound regression tests.
 *
 * Encodes the proven Lanterns S01E07 defect shape: the corpus holds many
 * rows for the media item, but none of them can produce a bindable exact
 * S01E07 representation — while every configured live source holds valid
 * candidates. The normal request path (no liveOnly override, no manual
 * second request) must automatically bloodhound live discovery, select a
 * valid exact candidate, bind it, and proceed to VFS publication.
 *
 * Zero network: the real runBloodhoundDiscovery runner fans out over four
 * fixture Stremio addons served by a stubbed global fetch; Torznab and
 * Prowlarr stay unconfigured (as in a Stremio-only deployment).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { searchByMedia, isReleasedRequest, normalizeLiveDiscoveryResult } from '../src/api/media-request.js';
import { runBloodhoundDiscovery, mergeBloodhoundRows, classifyBloodhoundEpisode } from '../src/lib/discovery/live-bridge.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';

// ---------------------------------------------------------------------------
// Fixture identities (synthetic 40-hex infoHashes; no real torrents)
// ---------------------------------------------------------------------------

const MEDIA_ID = 'tt7770001';

// Corpus rows: exact S01E07 on paper, but unbindable (no exact size, no
// cached provider inventory).
const CORPUS_E07 = [
  'c01111111111111111111111111111111111111',
  'c02222222222222222222222222222222222222',
  'c03333333333333333333333333333333333333',
];
// Corpus rows: wrong episode (S01E06) — present but ineligible.
const CORPUS_E06 = [
  'c04444444444444444444444444444444444444',
  'c05555555555555555555555555555555555555',
];
// Live rows: valid exact S01E07 candidates (L1 served by TWO addons to prove
// cross-source merge; X1 is a wrong-episode payload that must be rejected).
const LIVE_L1 = '1b01111111111111111111111111111111111111';
const LIVE_L2 = '1b02222222222222222222222222222222222222';
const LIVE_L3 = '1b03333333333333333333333333333333333333';
const LIVE_L4 = '1b04444444444444444444444444444444444444';
const LIVE_X1 = '1b05555555555555555555555555555555555555';
const LIVE_SET = new Set([LIVE_L1, LIVE_L2, LIVE_L3, LIVE_L4]);

const E07_FILENAMES = {
  [LIVE_L1]: 'Lanterns.S01E07.1080p.WEB-DL.DD5.1.H.264-GROUP1.mkv',
  [LIVE_L2]: 'Lanterns.S01E07.1080p.WEB-DL.DD5.1.H.264-GROUP2.mkv',
  [LIVE_L3]: 'Lanterns.S01E07.720p.HDTV.x264-GROUP3.mkv',
  [LIVE_L4]: 'Lanterns.S01E07.1080p.WEB-DL.DD5.1.H.264-GROUP4.mkv',
};
const E07_SIZES = {
  [LIVE_L1]: 2147483648,
  [LIVE_L2]: 2147483000,
  [LIVE_L3]: 1073741824,
  [LIVE_L4]: 2147483900,
};

function seedCorpus(cache) {
  for (const [i, infoHash] of CORPUS_E07.entries()) {
    const filename = `Lanterns.S01E07.1080p.WEB-DL.DD5.1.H.264-CORPUS${i}.mkv`;
    cache.upsertCandidate({ infoHash, fileIndex: null, filename, title: 'Lanterns' });
    storeReleaseAttributes(cache, {
      infoHash, fileIndex: null, filename, source: 'fixture', confidence: 0.9,
      parsed: { title: 'Lanterns', year: 2026, season: 1, episode: 7, resolution: '1080p', mediaType: 'series' },
      evidence: ['fixture'],
    });
    cache.associateMedia(infoHash, null, MEDIA_ID, {
      source: 'fixture', confidence: 0.8, evidence: ['fixture'],
      resolutionState: 'probable', matchMethod: 'fixture', resolverSource: 'fixture', resolverVersion: '1.0',
    });
  }
  for (const [i, infoHash] of CORPUS_E06.entries()) {
    const filename = `Lanterns.S01E06.1080p.WEB-DL.DD5.1.H.264-CORPUS${i}.mkv`;
    cache.upsertCandidate({ infoHash, fileIndex: null, filename, title: 'Lanterns' });
    storeReleaseAttributes(cache, {
      infoHash, fileIndex: null, filename, source: 'fixture', confidence: 0.9,
      parsed: { title: 'Lanterns', year: 2026, season: 1, episode: 6, resolution: '1080p', mediaType: 'series' },
      evidence: ['fixture'],
    });
    cache.associateMedia(infoHash, null, MEDIA_ID, {
      source: 'fixture', confidence: 0.8, evidence: ['fixture'],
      resolutionState: 'probable', matchMethod: 'fixture', resolverSource: 'fixture', resolverVersion: '1.0',
    });
  }
}

// Fixture Stremio addons mirroring the four production live routes.
function fixtureAddons() {
  return [
    { id: 'torrentio-torbox', provider: 'torrentio', debridProvider: 'torbox', manifestUrl: 'https://fake.local/torrentio-torbox/manifest.json', enabled: true },
    { id: 'torrentio-realdebrid', provider: 'torrentio', debridProvider: 'realdebrid', manifestUrl: 'https://fake.local/torrentio-realdebrid/manifest.json', enabled: true },
    { id: 'comet-torbox', provider: 'comet', debridProvider: 'torbox', manifestUrl: 'https://fake.local/comet-torbox/manifest.json', enabled: true },
    { id: 'comet-realdebrid', provider: 'comet', debridProvider: 'realdebrid', manifestUrl: 'https://fake.local/comet-realdebrid/manifest.json', enabled: true },
  ];
}

function streamRow(infoHash, filename, { videoSize = null } = {}) {
  return {
    infoHash,
    name: 'Fixture',
    title: 'Fixture 1080p',
    description: filename,
    behaviorHints: {
      ...(filename ? { filename } : {}),
      ...(videoSize != null ? { videoSize } : {}),
    },
  };
}

function fixtureStreamsByAddon() {
  return {
    // Served by TWO addons: the merge must collapse them to one release
    // with two-source provenance.
    'torrentio-torbox': [
      streamRow(LIVE_L1, E07_FILENAMES[LIVE_L1], { videoSize: E07_SIZES[LIVE_L1] }),
      streamRow(LIVE_L2, E07_FILENAMES[LIVE_L2], { videoSize: E07_SIZES[LIVE_L2] }),
    ],
    'torrentio-realdebrid': [
      streamRow(LIVE_L3, E07_FILENAMES[LIVE_L3], { videoSize: E07_SIZES[LIVE_L3] }),
      // Malformed payload: no listable source — parser must drop it while
      // the raw count still proves the source responded.
      { name: 'Broken', title: 'no hash here', description: 'nothing listable', behaviorHints: {} },
    ],
    'comet-torbox': [
      streamRow(LIVE_L1, E07_FILENAMES[LIVE_L1], { videoSize: E07_SIZES[LIVE_L1] }),
      streamRow(LIVE_L4, E07_FILENAMES[LIVE_L4], { videoSize: E07_SIZES[LIVE_L4] }),
    ],
    // Wrong-episode payload WITH an exact size: structurally invalid for
    // S01E07. It must be rejected by identity eligibility and can never
    // bind — not even via the exact-size fast path, which never inspects
    // content. This is the sharp edge the S/E fill in toBloodhoundRelease
    // closes.
    'comet-realdebrid': [
      streamRow(LIVE_X1, 'Lanterns.S01E06.1080p.WEB-DL.DD5.1.H.264-WRONG.mkv', { videoSize: 1999999999 }),
    ],
  };
}

// Stub global fetch for fake.local addon manifests. Records every queried
// URL; anything else throws so stray network access fails loudly.
function stubFetch(t, streamsByAddon, seenUrls) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (!href.includes('fake.local')) {
      throw new Error(`unexpected network access in fixture: ${href}`);
    }
    seenUrls.push(href);
    const key = Object.keys(streamsByAddon).find((k) => href.includes(k));
    return {
      ok: true,
      status: 200,
      json: async () => ({ streams: streamsByAddon[key] ?? [] }),
    };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
}

// Provider seams: corpus hashes can never bind (nothing cached); live E07
// hashes bind via the exact-size fast path.
function stubEnsure(calls, store = null) {
  return async ({ infoHash, selectedFileSize, skipSizeMatch } = {}) => {
    calls.push({ infoHash, selectedFileSize: selectedFileSize ?? null, skipSizeMatch: !!skipSizeMatch });
    const hash = String(infoHash || '').toLowerCase();
    if (LIVE_SET.has(hash) && !skipSizeMatch && Number.isSafeInteger(selectedFileSize)) {
      const tf = {
        id: `tf_live_${hash.slice(0, 8)}`, infoHash: hash, size: selectedFileSize,
        internalPath: 'Lanterns/Season 01/Lanterns - S01E07.mkv',
      };
      store?.register?.(tf);
      return {
        placementId: 'pl_live', providerFileId: 'pf_live',
        torrentFileId: tf.id, size: selectedFileSize,
      };
    }
    const err = new Error(`No cached placement for ${hash}`);
    err.code = 'NO_PLACEMENT';
    throw err;
  };
}

function stubStore() {
  return {
    getTorrentFile: (id) => {
      if (typeof id === 'string' && id.startsWith('tf_live_')) {
        const hash = [...LIVE_SET].find((h) => id === `tf_live_${h.slice(0, 8)}`);
        if (!hash) return null;
        return {
          id, infoHash: hash, size: E07_SIZES[hash] ?? 100,
          internalPath: 'Lanterns/Season 01/Lanterns - S01E07.mkv',
        };
      }
      return null;
    },
    listTorrentFilesForRelease: () => [],
    listProviderRefsForTorrentFile: () => [],
    listDataPlaneCoordinates: () => [],
  };
}

// Control-plane stub with library/binding readback: the live-bound
// TorrentFile is registered by the ensure stub, so the authoritative
// verification and VFS materialization see a consistent binding.
function stubStoreWithBindings() {
  const tfs = new Map();
  const store = {
    getTorrentFile: (id) => tfs.get(id) ?? null,
    listTorrentFilesForRelease: () => [],
    listProviderRefsForTorrentFile: () => [],
    listDataPlaneCoordinates: () => [],
    getLibraryItemByIdentityKey: () => ({ id: 'lib_fixture' }),
    getActiveBindingForLibraryItem: () => {
      const tf = [...tfs.values()][0];
      if (!tf) return null;
      return {
        torrentFile: { ...tf },
        binding: { releaseKey: `${tf.infoHash}:torrent`, infoHash: tf.infoHash, fileIndex: null },
      };
    },
    getActiveCanonicalPath: () => 'Lanterns (2026)/Season 01/Lanterns - S01E07.mkv',
    register: (tf) => { tfs.set(tf.id, tf); },
  };
  return store;
}

function withTmpStrm(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloodhound-strm-'));
  const saved = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = dir;
  t.after(() => {
    if (saved === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function collectStrmFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.strm')) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function baseRequest(extra = {}) {
  return {
    mediaId: MEDIA_ID,
    mediaType: 'series',
    mediaTitle: 'Lanterns',
    canonicalTitle: 'Lanterns',
    canonicalYear: 2026,
    season: 1,
    episode: 7,
    skipAvailability: true,
    persist: true,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Released-request predicate
// ---------------------------------------------------------------------------

test('isReleasedRequest: defaults to released, opts out only on future evidence', () => {
  assert.equal(isReleasedRequest({}), true, 'no metadata → released');
  assert.equal(isReleasedRequest({ mediaId: MEDIA_ID }), true);
  assert.equal(isReleasedRequest({ airDate: '2020-01-01' }), true, 'past air date → released');
  assert.equal(
    isReleasedRequest({ airDate: new Date(Date.now() + 86400000).toISOString() }),
    false,
    'future air date → unreleased (no bloodhound)',
  );
  assert.equal(isReleasedRequest({ unreleased: true }), false);
  assert.equal(
    isReleasedRequest({ releaseDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10) }),
    false,
  );
});

test('normalizeLiveDiscoveryResult: accepts legacy arrays and bloodhound shape', () => {
  assert.deepEqual(normalizeLiveDiscoveryResult([{ infoHash: 'x' }]), {
    rows: [{ infoHash: 'x' }], sources: [],
  });
  const shaped = { releases: [{ infoHash: 'y' }], sources: [{ id: 's' }] };
  assert.deepEqual(normalizeLiveDiscoveryResult(shaped), { rows: [{ infoHash: 'y' }], sources: [{ id: 's' }] });
  assert.deepEqual(normalizeLiveDiscoveryResult(null), { rows: [], sources: [] });
});

// ---------------------------------------------------------------------------
// Bloodhound runner unit: fan-out, merge, observability
// ---------------------------------------------------------------------------

test('bloodhound queries every configured source and merges by exact identity', async (t) => {
  const seenUrls = [];
  stubFetch(t, fixtureStreamsByAddon(), seenUrls);

  const { releases, sources } = await runBloodhoundDiscovery(MEDIA_ID, {
    season: 1, episode: 7, addons: fixtureAddons(), torznabIndexers: [],
  });

  // All four configured live routes queried — never stops after the first.
  assert.equal(seenUrls.length, 4, 'one query per configured source');
  for (const addon of fixtureAddons()) {
    assert.ok(seenUrls.some((u) => u.includes(addon.id)), `${addon.id} queried`);
  }
  // Episode-scoped Stremio query (full :S:E suffix, not series-level).
  for (const url of seenUrls) {
    assert.ok(url.includes('%3A1%3A7'), `episode-scoped query: ${url}`);
  }

  // Per-source observability present for every source.
  assert.equal(sources.length, 4, 'one observation per source');
  const byId = new Map(sources.map((s) => [s.id, s]));
  for (const addon of fixtureAddons()) {
    const obs = byId.get(addon.id);
    assert.ok(obs, `${addon.id} observed`);
    assert.equal(obs.disposition, 'queried_success', `${addon.id} disposition`);
    assert.ok(Number.isFinite(obs.latencyMs), `${addon.id} latency recorded`);
    assert.equal(obs.error, null, `${addon.id} no error`);
  }
  // Source has rows vs parser dropped them is distinguishable.
  assert.equal(byId.get('torrentio-torbox').rawCount, 2);
  assert.equal(byId.get('torrentio-torbox').parsedCount, 2);
  assert.equal(byId.get('torrentio-torbox').exactEpisodeCount, 2);
  assert.equal(byId.get('torrentio-realdebrid').rawCount, 2, 'malformed row still counts as raw');
  assert.equal(byId.get('torrentio-realdebrid').parsedCount, 1, 'malformed row dropped by parser');
  assert.equal(byId.get('torrentio-realdebrid').exactEpisodeCount, 1);
  assert.equal(byId.get('comet-realdebrid').exactEpisodeCount, 0, 'wrong-episode payload is not exact');
  assert.equal(byId.get('comet-realdebrid').wrongEpisodeCount, 1);

  // Merge: L1 served by two addons collapses to one release with both
  // provenances retained.
  const l1 = releases.filter((r) => String(r.infoHash).toLowerCase() === LIVE_L1);
  assert.equal(l1.length, 1, 'L1 merged to a single release');
  const provenance = (l1[0].sources || []).map((s) => s.addonId || s.observer);
  assert.ok(provenance.includes('torrentio-torbox'), 'torrentio-torbox provenance retained');
  assert.ok(provenance.includes('comet-torbox'), 'comet-torbox provenance retained');
  // Exact file size survives the merge for the identity binder.
  assert.equal(l1[0].selectedFileSize, E07_SIZES[LIVE_L1]);
});

test('classifyBloodhoundEpisode: exact / wrong / unknown / na', () => {
  assert.equal(
    classifyBloodhoundEpisode({ filename: E07_FILENAMES[LIVE_L1] }, 1, 7), 'exact');
  assert.equal(
    classifyBloodhoundEpisode({ filename: 'Lanterns.S01E06.1080p.mkv' }, 1, 7), 'wrong');
  assert.equal(
    classifyBloodhoundEpisode({ filename: 'Some.Unparseable.Label.mkv' }, 1, 7), 'unknown');
  assert.equal(
    classifyBloodhoundEpisode({ filename: E07_FILENAMES[LIVE_L1] }, null, null), 'na');
});

test('mergeBloodhoundRows: field-level union keeps parsed S/E and exact sizes', () => {
  const stremioRow = {
    infoHash: LIVE_L1, fileIndex: null, releaseKey: `${LIVE_L1}:torrent`,
    filename: E07_FILENAMES[LIVE_L1], season: null, episode: null,
    exactFileSize: E07_SIZES[LIVE_L1],
    sources: [{ origin: 'live', addonId: 'torrentio-torbox' }],
  };
  const prowlarrRow = {
    infoHash: LIVE_L1, fileIndex: null, releaseKey: `${LIVE_L1}:torrent`,
    filename: E07_FILENAMES[LIVE_L1], season: 1, episode: 7,
    exactFileSize: null,
    sources: [{ origin: 'prowlarr', indexer: 'idx' }],
  };
  const [merged] = mergeBloodhoundRows([[stremioRow], [prowlarrRow]]);
  assert.equal(merged.season, 1, 'parsed season fills the gap');
  assert.equal(merged.episode, 7, 'parsed episode fills the gap');
  assert.equal(merged.exactFileSize, E07_SIZES[LIVE_L1], 'exact size preserved');
  assert.equal(merged.sources.length, 2, 'both provenances retained');
});

// ---------------------------------------------------------------------------
// Core regression: corpus present but unbindable → normal path bloodhounds
// ---------------------------------------------------------------------------

test('E07 regression: corpus present but unbindable, normal path auto-discovers live and binds', async (t) => {
  const strmDir = withTmpStrm(t);
  const cache = createDiscoveryCache();
  try {
    seedCorpus(cache);
    const seenUrls = [];
    stubFetch(t, fixtureStreamsByAddon(), seenUrls);
    const ensureCalls = [];
    const store = stubStore();

    // Pre-condition: corpus alone cannot fulfill. Same request with live
    // discovery skipped selects nothing despite 5 corpus rows / 3 eligible.
    const corpusOnly = await searchByMedia(cache, baseRequest({
      skipLiveDiscovery: true,
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure(ensureCalls),
    }));
    assert.equal(corpusOnly.selection.selected, null, 'corpus alone binds nothing');
    assert.ok(corpusOnly.identitySummary.totalCandidates >= 5, 'corpus rows present');
    assert.ok(corpusOnly.identitySummary.eligibleCount >= 3, 'eligible corpus rows present');
    assert.ok(ensureCalls.length > 0, 'corpus candidates were actually attempted');

    // Normal path: no liveOnly override, no manual second request. The live
    // seam is the REAL bloodhound runner over the four fixture addons. The
    // binding store exposes library readback and the Plex probe is stubbed
    // visible, so the full success truth is reachable deterministically.
    const fullStore = stubStoreWithBindings();
    let liveInvocations = 0;
    const result = await searchByMedia(cache, baseRequest({
      controlPlaneStore: fullStore,
      ensureTorBoxFileIdentity: stubEnsure(ensureCalls, fullStore),
      confirmPlexFn: async () => ({ visible: true, mediaPart: { file: 'Lanterns/Season 01/Lanterns - S01E07.mkv' } }),
      liveDiscoveryFn: async (mediaId, opts) => {
        liveInvocations++;
        return runBloodhoundDiscovery(mediaId, { ...opts, addons: fixtureAddons(), torznabIndexers: [] });
      },
    }));

    // NORMAL PATH INVOKES LIVE DISCOVERY: YES (exactly once, unprompted —
    // the pass is bounded to one fanout per request attempt).
    assert.equal(liveInvocations, 1, 'live discovery invoked once by the normal path');
    assert.equal(result.discovery.liveDiscoveryTriggered, true);
    // ALL CONFIGURED LIVE SOURCES QUERIED: YES.
    assert.equal(result.discovery.liveSources.length, 4, 'all four live routes observed');
    assert.deepEqual(
      result.discovery.liveSources.map((s) => s.id).sort(),
      ['comet-realdebrid', 'comet-torbox', 'torrentio-realdebrid', 'torrentio-torbox'],
    );
    for (const source of result.discovery.liveSources) {
      assert.equal(source.error, null, `${source.id}: no error`);
    }
    assert.equal(seenUrls.length, 4, 'one live query per configured source');

    // VALID EXACT EPISODE FOUND + ACTIVE BINDING: YES.
    assert.ok(result.selection.selected, 'a bindable candidate was selected');
    assert.ok(
      LIVE_SET.has(String(result.selection.selected.infoHash).toLowerCase()),
      `selected a valid live S01E07 candidate (got ${result.selection.selected.infoHash})`,
    );
    assert.ok(!CORPUS_E07.includes(String(result.selection.selected.infoHash).toLowerCase()),
      'corpus rows never win when they cannot bind');
    assert.equal(result.selection.reason, 'exact-size bound');
    assert.ok(result.handoff, 'playback handoff built');
    assert.equal(result.handoff.infoHash, result.selection.selected.infoHash);
    assert.ok(result.handoff.torrentFileId, 'durable TorrentFile binding threaded into handoff');

    // Duplicate hashes merge provenance rather than multiply candidates:
    // L1 served by two addons appears exactly once in the results.
    const l1Rows = result.results.filter(
      (r) => String(r.infoHash).toLowerCase() === LIVE_L1);
    assert.equal(l1Rows.length, 1, 'merged duplicate hash appears once');
    assert.ok((l1Rows[0].sources || []).length >= 2, 'merged row retains multi-source provenance');

    // Wrong-episode live payload is rejected and can never bind, even with
    // an exact size available: it is ineligible with episode_mismatch.
    const x1Rows = result.results.filter(
      (r) => String(r.infoHash).toLowerCase() === LIVE_X1);
    assert.equal(x1Rows.length, 1, 'wrong-episode row survives to results (as ineligible, not silently dropped)');
    for (const row of x1Rows) {
      assert.equal(row.identity.eligible, false, 'wrong-episode live row ineligible');
      assert.equal(row.identity.ineligibleCode, 'episode_mismatch');
    }

    // VFS: YES — publication matches the binding.
    const vfs = cache.getVfsTvEntry(MEDIA_ID, 1, 7);
    assert.ok(vfs, 'VFS TV entry materialized');
    assert.equal(vfs.torrentFileId, result.handoff.torrentFileId);
    assert.equal(String(vfs.infoHash).toLowerCase(), String(result.selection.selected.infoHash).toLowerCase());

    // STRM published for the bound representation.
    assert.ok(collectStrmFiles(strmDir).length >= 1, 'STRM artifact published');

    // SUCCESS TRUTH: fulfilled, published, and NOT retryOwned.
    // EXPLICIT LIVE-ONLY OVERRIDE USED: NO. RECENT RELEASE BLOODHOUND: PASS.
    assert.equal(result.published, true, 'bloodhound success publishes');
    assert.equal(result.fulfilled, true, 'bloodhound success fulfills');
    assert.equal(result.unfulfilled, false);
    assert.equal(result.retryOwned, false, 'success does not remain retryOwned');
    assert.ok(result.plex?.visible, 'Plex visibility confirmed');
  } finally {
    cache.close();
  }
});

test('bloodhound success without Plex visibility stays pending with retryOwned', async (t) => {
  withTmpStrm(t);
  const cache = createDiscoveryCache();
  try {
    seedCorpus(cache);
    const seenUrls = [];
    stubFetch(t, fixtureStreamsByAddon(), seenUrls);
    const fullStore = stubStoreWithBindings();
    const result = await searchByMedia(cache, baseRequest({
      controlPlaneStore: fullStore,
      ensureTorBoxFileIdentity: stubEnsure([], fullStore),
      // Plex not yet visible (probe finds nothing).
      confirmPlexFn: async () => null,
      liveDiscoveryFn: async (mediaId, opts) =>
        runBloodhoundDiscovery(mediaId, { ...opts, addons: fixtureAddons(), torznabIndexers: [] }),
    }));
    assert.ok(result.selection.selected, 'candidate bound');
    assert.ok(result.handoff?.torrentFileId, 'binding threaded into handoff');
    assert.ok(cache.getVfsTvEntry(MEDIA_ID, 1, 7), 'VFS materialized');
    assert.equal(result.published, true, 'presentation completed');
    assert.equal(result.fulfilled, false, 'not fulfilled without Plex visibility');
    assert.equal(result.retryOwned, true, 'pending confirmation keeps retry ownership');
    assert.equal(result.reason, 'plex-confirmation-pending');
    void seenUrls;
  } finally {
    cache.close();
  }
});

test('bloodhound does not fire for unreleased requests or when opted out', async (t) => {
  const cache = createDiscoveryCache();
  try {
    seedCorpus(cache);
    const seenUrls = [];
    stubFetch(t, fixtureStreamsByAddon(), seenUrls);
    const store = stubStore();

    // Future air date → unreleased → no live queries at all.
    const future = await searchByMedia(cache, baseRequest({
      airDate: new Date(Date.now() + 86400000).toISOString(),
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure([]),
      liveDiscoveryFn: async (mediaId, opts) =>
        runBloodhoundDiscovery(mediaId, { ...opts, addons: fixtureAddons(), torznabIndexers: [] }),
    }));
    assert.equal(future.selection.selected, null);
    assert.equal(future.discovery.liveDiscoveryTriggered, false);
    assert.equal(seenUrls.length, 0, 'unreleased request performs no live I/O');

    // Explicit opt-out → no live queries either.
    const skipped = await searchByMedia(cache, baseRequest({
      skipLiveDiscovery: true,
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure([]),
      liveDiscoveryFn: async () => { throw new Error('must not be called'); },
    }));
    assert.equal(skipped.discovery.liveDiscoveryTriggered, false);
  } finally {
    cache.close();
  }
});

test('future-gate: unreleased requests never burn live on any path', async (t) => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const failingLive = async () => { throw new Error('live must not run for unreleased media'); };

  // Empty corpus + future air date → no live fanout (waits cheaply).
  {
    const cache = createDiscoveryCache();
    try {
      const seenUrls = [];
      stubFetch(t, fixtureStreamsByAddon(), seenUrls);
      const result = await searchByMedia(cache, baseRequest({
        airDate: future,
        controlPlaneStore: stubStore(),
        ensureTorBoxFileIdentity: stubEnsure([]),
        liveDiscoveryFn: failingLive,
      }));
      assert.equal(result.selection.selected, null);
      assert.equal(result.discovery.liveDiscoveryTriggered, false);
      assert.equal(seenUrls.length, 0, 'empty-corpus future request performs no live I/O');
    } finally {
      cache.close();
    }
  }

  // Ineligible-only corpus (eligible 0 → threshold shape) + future air
  // date → threshold fallback0837 skipped: no live fanout.
  {
    const cache = createDiscoveryCache();
    try {
      for (const infoHash of CORPUS_E06) {
        const filename = `Lanterns.S01E06.1080p-CORPUS${infoHash.slice(1, 2)}.mkv`;
        cache.upsertCandidate({ infoHash, fileIndex: null, filename, title: 'Lanterns' });
        storeReleaseAttributes(cache, {
          infoHash, fileIndex: null, filename, source: 'fixture', confidence: 0.9,
          parsed: { title: 'Lanterns', year: 2026, season: 1, episode: 6, resolution: '1080p', mediaType: 'series' },
          evidence: ['fixture'],
        });
        cache.associateMedia(infoHash, null, MEDIA_ID, {
          source: 'fixture', confidence: 0.8, evidence: ['fixture'],
          resolutionState: 'probable', matchMethod: 'fixture', resolverSource: 'fixture', resolverVersion: '1.0',
        });
      }
      const seenUrls = [];
      stubFetch(t, fixtureStreamsByAddon(), seenUrls);
      const result = await searchByMedia(cache, baseRequest({
        airDate: future,
        controlPlaneStore: stubStore(),
        ensureTorBoxFileIdentity: stubEnsure([]),
        liveDiscoveryFn: failingLive,
      }));
      assert.equal(result.selection.selected, null);
      assert.equal(result.discovery.liveDiscoveryTriggered, false, 'threshold fallback skipped for future media');
      assert.equal(seenUrls.length, 0, 'threshold-shape future request performs no live I/O');
    } finally {
      cache.close();
    }
  }

  // Explicit liveOnly still honors the caller override even when dated
  // future (operator/manual recovery intent wins over the gate).
  {
    const cache = createDiscoveryCache();
    try {
      const seenUrls = [];
      stubFetch(t, fixtureStreamsByAddon(), seenUrls);
      let invoked = 0;
      const result = await searchByMedia(cache, baseRequest({
        airDate: future,
        liveOnly: true,
        skipAvailability: true,
        persist: false,
        liveDiscoveryFn: async (mediaId, opts) => {
          invoked++;
          return runBloodhoundDiscovery(mediaId, { ...opts, addons: fixtureAddons(), torznabIndexers: [] });
        },
      }));
      assert.equal(invoked, 1, 'explicit liveOnly bypasses the future gate');
      assert.equal(result.discovery.liveDiscoveryTriggered, true);
      void seenUrls;
    } finally {
      cache.close();
    }
  }
});

test('bloodhound miss stays retry-owned and never poisons later retries', async (t) => {
  const cache = createDiscoveryCache();
  try {
    seedCorpus(cache);
    const seenUrls = [];
    // All four sources answer, but with nothing usable for S01E07.
    stubFetch(t, {
      'torrentio-torbox': [],
      'torrentio-realdebrid': [],
      'comet-torbox': [],
      'comet-realdebrid': [streamRow(LIVE_X1, 'Lanterns.S01E06.1080p.mkv')],
    }, seenUrls);
    const store = stubStore();

    const first = await searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure([]),
      liveDiscoveryFn: async (mediaId, opts) =>
        runBloodhoundDiscovery(mediaId, { ...opts, addons: fixtureAddons(), torznabIndexers: [] }),
    }));
    assert.equal(first.selection.selected, null, 'nothing bindable on the first pass');
    assert.equal(first.discovery.liveDiscoveryTriggered, true, 'bloodhound ran');
    assert.equal(first.unfulfilled, true);
    assert.equal(first.retryOwned, true, 'retry ownership persisted');

    // A later retry runs live discovery AGAIN (market availability changes;
    // the earlier miss is not trusted).
    let secondInvocations = 0;
    const second = await searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure([]),
      liveDiscoveryFn: async (mediaId, opts) => {
        secondInvocations++;
        return runBloodhoundDiscovery(mediaId, { ...opts, addons: fixtureAddons(), torznabIndexers: [] });
      },
    }));
    assert.equal(secondInvocations, 1, 'retry re-runs live discovery');
    assert.equal(second.discovery.liveDiscoveryTriggered, true);
    assert.equal(second.retryOwned, true);
    void second;
  } finally {
    cache.close();
  }
});

test('wrong-episode live row with exact size is never attempted nor selected', async (t) => {
  withTmpStrm(t);
  const cache = createDiscoveryCache();
  try {
    seedCorpus(cache);
    const seenUrls = [];
    stubFetch(t, fixtureStreamsByAddon(), seenUrls);
    const ensureCalls = [];
    const fullStore = stubStoreWithBindings();
    const result = await searchByMedia(cache, baseRequest({
      controlPlaneStore: fullStore,
      ensureTorBoxFileIdentity: stubEnsure(ensureCalls, fullStore),
      confirmPlexFn: async () => ({ visible: true, mediaPart: { file: 'x' } }),
      liveDiscoveryFn: async (mediaId, opts) =>
        runBloodhoundDiscovery(mediaId, { ...opts, addons: fixtureAddons(), torznabIndexers: [] }),
    }));
    // X1 carries an exact size (1999999999) yet must never reach the
    // binder: identity eligibility rejects it first.
    assert.ok(!ensureCalls.some((c) => String(c.infoHash).toLowerCase() === LIVE_X1),
      'wrong-episode hash never attempted by the binder');
    assert.ok(!String(result.selection.selected.infoHash).toLowerCase().includes(LIVE_X1.slice(0, 8)),
      'wrong-episode hash never selected');
    assert.ok(LIVE_SET.has(String(result.selection.selected.infoHash).toLowerCase()),
      'winner is a valid exact-episode candidate');
    void seenUrls;
  } finally {
    cache.close();
  }
});

test('threshold-path live rows keep exact size for PATH-A binding', async (t) => {
  withTmpStrm(t);
  // Corpus holds ONLY wrong-episode rows (eligible count 0) so the
  // retrieval-threshold fallback — not the bloodhound pass — runs live.
  // The threshold path keeps its legacy staged terminal semantics; this
  // test proves the exact size survives to selection on that path too.
  const cache2 = createDiscoveryCache();
  try {
    for (const infoHash of CORPUS_E06) {
      const filename = `Lanterns.S01E06.1080p.WEB-DL-CORPUS${infoHash.slice(1, 2)}.mkv`;
      cache2.upsertCandidate({ infoHash, fileIndex: null, filename, title: 'Lanterns' });
      storeReleaseAttributes(cache2, {
        infoHash, fileIndex: null, filename, source: 'fixture', confidence: 0.9,
        parsed: { title: 'Lanterns', year: 2026, season: 1, episode: 6, resolution: '1080p', mediaType: 'series' },
        evidence: ['fixture'],
      });
      cache2.associateMedia(infoHash, null, MEDIA_ID, {
        source: 'fixture', confidence: 0.8, evidence: ['fixture'],
        resolutionState: 'probable', matchMethod: 'fixture', resolverSource: 'fixture', resolverVersion: '1.0',
      });
    }
    const seenUrls = [];
    stubFetch(t, {
      'torrentio-torbox': [streamRow(LIVE_L1, E07_FILENAMES[LIVE_L1], { videoSize: E07_SIZES[LIVE_L1] })],
      'torrentio-realdebrid': [],
      'comet-torbox': [],
      'comet-realdebrid': [],
    }, seenUrls);
    const fullStore = stubStoreWithBindings();
    const ensureCalls = [];
    const result = await searchByMedia(cache2, baseRequest({
      controlPlaneStore: fullStore,
      ensureTorBoxFileIdentity: stubEnsure(ensureCalls, fullStore),
      liveDiscoveryFn: async (mediaId, opts) =>
        runBloodhoundDiscovery(mediaId, { ...opts, addons: fixtureAddons(), torznabIndexers: [] }),
    }));
    // Threshold fallback ran (corpus eligible 0 < 1); the bloodhound
    // viability pass did NOT run a second fanout.
    assert.equal(result.discovery.liveDiscoveryTriggered, true);
    assert.equal(seenUrls.length, 4, 'exactly one fanout total');
    // The live row's exact size survived to selection: PATH-A bound it.
    assert.equal(result.selection.reason, 'exact-size bound');
    assert.equal(String(result.selection.selected.infoHash).toLowerCase(), LIVE_L1);
    const liveRow = result.results.find((r) => String(r.infoHash).toLowerCase() === LIVE_L1);
    assert.equal(liveRow.selectedFileSize, E07_SIZES[LIVE_L1], 'exact size preserved to selection');
    // Threshold path keeps legacy staged semantics (unchanged by this
    // slice): bound + VFS, fail-closed pending with retry ownership.
    assert.ok(result.handoff?.torrentFileId, 'binding threaded into handoff');
    assert.ok(cache2.getVfsTvEntry(MEDIA_ID, 1, 7), 'VFS materialized');
    assert.equal(result.retryOwned, true, 'staged threshold success keeps retry ownership');
  } finally {
    cache2.close();
  }
});

test('one failing source never aborts the bloodhound pass', async (t) => {
  const realFetch = globalThis.fetch;
  const seenUrls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    seenUrls.push(href);
    if (href.includes('torrentio-torbox')) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    if (href.includes('comet-torbox')) {
      const err = new Error('fetch failed: timeout');
      err.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
      throw err;
    }
    if (href.includes('torrentio-realdebrid')) {
      return { ok: true, status: 200, json: async () => { throw new Error('bad json'); } };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ streams: [streamRow(LIVE_L4, E07_FILENAMES[LIVE_L4], { videoSize: E07_SIZES[LIVE_L4] })] }),
    };
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const { releases, sources } = await runBloodhoundDiscovery(MEDIA_ID, {
    season: 1, episode: 7, addons: fixtureAddons(), torznabIndexers: [],
  });
  const byId = new Map(sources.map((s) => [s.id, s]));
  // Three broken sources, three distinct dispositions — the pass survives.
  assert.equal(byId.get('torrentio-torbox').disposition, 'upstream_error');
  assert.ok(byId.get('torrentio-torbox').error, 'HTTP 500 recorded');
  assert.equal(byId.get('comet-torbox').disposition, 'timeout');
  assert.equal(byId.get('torrentio-realdebrid').disposition, 'upstream_error');
  assert.ok(byId.get('torrentio-realdebrid').error, 'invalid JSON recorded');
  assert.equal(byId.get('comet-realdebrid').disposition, 'queried_success');
  // The healthy source's candidate still merges through.
  assert.ok(releases.some((r) => String(r.infoHash).toLowerCase() === LIVE_L4),
    'healthy source candidate survives peer failures');
  assert.equal(seenUrls.length, 4, 'every source attempted exactly once');
});

test('prowlarr escalation: skipped when fast layer is viable', async (t) => {
  const seenUrls = [];
  stubFetch(t, fixtureStreamsByAddon(), seenUrls);
  let prowlarrCalls = 0;
  const prowlarrClient = {
    search: async () => { prowlarrCalls++; return []; },
  };
  const { releases, sources } = await runBloodhoundDiscovery(MEDIA_ID, {
    season: 1, episode: 7, addons: fixtureAddons(), torznabIndexers: [],
    prowlarrClient,
  });
  assert.equal(prowlarrCalls, 0, 'Prowlarr never queried when fast sources yield viable rows');
  const prowlarr = sources.find((s) => s.id === 'prowlarr');
  assert.ok(prowlarr, 'skipped Prowlarr still observed');
  assert.equal(prowlarr.disposition, 'skipped_fast_sufficient');
  assert.ok(releases.length > 0, 'fast-layer releases returned immediately');
});

test('prowlarr escalation: runs when fast layer yields nothing viable', async (t) => {
  const seenUrls = [];
  // Fast layer answers, but only with wrong-episode payloads.
  stubFetch(t, {
    'torrentio-torbox': [streamRow(LIVE_X1, 'Lanterns.S01E06.1080p.mkv', { videoSize: 100 })],
    'torrentio-realdebrid': [],
    'comet-torbox': [],
    'comet-realdebrid': [],
  }, seenUrls);
  const PROWLARR_HASH = '9b09999999999999999999999999999999999999';
  let prowlarrCalls = 0;
  const prowlarrClient = {
    search: async () => {
      prowlarrCalls++;
      return [{
        infoHash: PROWLARR_HASH,
        fileName: 'Lanterns.S01E07.1080p.WEB-DL.mkv',
        title: 'Lanterns S01E07',
        size: 2000000000,
        indexer: 'fixture-tracker',
      }];
    },
  };
  const { releases, sources } = await runBloodhoundDiscovery(MEDIA_ID, {
    season: 1, episode: 7, title: 'Lanterns', addons: fixtureAddons(), torznabIndexers: [],
    prowlarrClient,
  });
  assert.equal(prowlarrCalls, 1, 'Prowlarr escalated exactly once');
  const prowlarr = sources.find((s) => s.id === 'prowlarr');
  assert.equal(prowlarr.disposition, 'queried_success');
  assert.ok(releases.some((r) => String(r.infoHash).toLowerCase() === PROWLARR_HASH),
    'unique Prowlarr discovery merges into the set');
});

test('slow source hang does not stall the fast layer', async (t) => {
  const realFetch = globalThis.fetch;
  const seenUrls = [];
  globalThis.fetch = (url, init = {}) => {
    const href = String(url);
    if (!href.includes('fake.local')) return Promise.reject(new Error(`unexpected: ${href}`));
    seenUrls.push(href);
    if (href.includes('comet-torbox')) {
      // Hangs until aborted: honors AbortSignal like a real fetch.
      return new Promise((_, reject) => {
        const signal = init.signal;
        if (signal?.aborted) {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        signal?.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    const key = Object.keys(fixtureStreamsByAddon()).find((k) => href.includes(k));
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ streams: fixtureStreamsByAddon()[key] ?? [] }),
    });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const startedAt = Date.now();
  const { releases, sources } = await runBloodhoundDiscovery(MEDIA_ID, {
    season: 1, episode: 7, addons: fixtureAddons(), torznabIndexers: [],
  });
  const elapsed = Date.now() - startedAt;
  const byId = new Map(sources.map((s) => [s.id, s]));
  assert.equal(byId.get('comet-torbox').disposition, 'timeout', 'hung source recorded as timeout');
  assert.ok(byId.get('comet-torbox').error, 'hung source error recorded');
  assert.ok(releases.length > 0, 'fast sources merged despite the hang');
  assert.ok(elapsed < 30000, `pass bounded (took ${elapsed}ms)`);
  assert.equal(seenUrls.filter((u) => u.includes('comet-torbox')).length, 1,
    'hung source attempted exactly once');
});
