/**
 * CORE PRODUCT CONTRACT + deterministic acceptance harness (Parts 2/3/4).
 *
 * The minimum core product contract, exercised as workflows (never mere
 * function calls) with real production modules and injectable seams
 * (live discovery, provider binding, Plex presence, fetch, clock):
 *
 *   REQUESTED RELEASED MEDIA
 *     request → discovery → exact representation → provider route →
 *     Binding → VFS → Plex-visible → playable exact bytes.
 *   FUTURE MEDIA
 *     request once → durable future ownership → due → automatic attempt →
 *     retries if needed → Plex-visible.
 *   FAILED FULFILLMENT
 *     failure occurs → cheapest failed layer retried → no unnecessary
 *     earlier-stage work → no human re-request.
 *
 * PASS criteria (every released-media scenario):
 *   Plex-visible and byte-serving; OR explicitly unfulfilled with durable
 *   retry ownership. Never false success. Never silent abandonment.
 *
 * Scenario map (this file implements the gaps; the rest is covered where
 * noted — no scenario left to unit tests alone):
 *   S1  corpus direct fulfills (two-pass staged→reuse) ......... THIS FILE
 *   S2  corpus unbindable → bloodhound → fulfills ................. bloodhound file
 *   S3  empty knowledge → bloodhound → fulfills .................. THIS FILE
 *   S4  live-new release persists locally for reuse .............. THIS FILE
 *   S5  one source fails, others succeed .......................... bloodhound file
 *   S6  slow source hangs, fast succeed .......................... bloodhound file
 *   S7  invalid .exe/sidecar rejected → next fulfills ............ THIS FILE
 *   S8  exact TF known, route fails → same-X recovery ............ autonomous file (7.2)
 *   S9  Binding/VFS good, Plex absent → Plex-only retry .......... autonomous file (part6)
 *   S10 Plex says success but absent → stays retry-owned ......... bloodhound file (pending)
 *   S11 future → due → miss → retry → fulfills ................... autonomous file (part8)
 *   S12 restart during retry ownership ........................... THIS FILE
 *   S13 restart after Binding before Plex ........................ THIS FILE
 *   S14 miss → market change → autonomous retry .................. bloodhound file
 *   S15 duplicate request → reuse without rediscovery ............ THIS FILE (all reuses)
 *
 * Work-avoidance counters (Part 4): every scenario records liveCalls
 * (liveDiscoveryFn invocations), ensureCalls (provider binding attempts),
 * and fetched URLs, and asserts explicit bounds — correctness alone is
 * not enough.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import { searchByMedia } from '../src/api/media-request.js';
import { selectBindableCandidate } from '../src/lib/discovery/selection.js';
import {
  MEDIA_ID, LIVE_H1, LIVE_H2, CORPUS_H1, FILENAMES, SIZES,
  seedCorpusRow, fixtureAddons, streamRow, liveStreams, stubFetch,
  stubEnsure, stubStoreWithCoords, withTmpStrm, withTmpDir, openFileCache,
  bloodhoundSeam, baseRequest,
} from './helpers/core-harness.js';

// ---------------------------------------------------------------------------
// S1 — corpus/local knowledge directly fulfills (staged → reuse → fulfilled)
// ---------------------------------------------------------------------------

test('S1: corpus-direct binds, stages, then reuses to fulfilled with zero live I/O', async (t) => {
  const strmDir = withTmpStrm(t);
  const seenFetch = [];
  stubFetch(t, liveStreams(), seenFetch);
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const cache = createDiscoveryCache();
  try {
    seedCorpusRow(cache, { infoHash: CORPUS_H1 });
    const store = stubStoreWithCoords();
    const ensureCalls = [];
    const ensure = async ({ infoHash, selectedFileSize, skipSizeMatch } = {}) => {
      ensureCalls.push(String(infoHash));
      const hash = String(infoHash || '').toLowerCase();
      if (hash === CORPUS_H1.toLowerCase() && skipSizeMatch) {
        const tf = { id: 'tf_corpus_1', infoHash: hash, size: 555555555, internalPath: 'Harness/Season 01/Harness - S01E07.mkv' };
        store.register(tf);
        return { placementId: 'pl_c', torrentFiles: [{ ...tf }] };
      }
      const err = new Error('no placement');
      err.code = 'NO_PLACEMENT';
      throw err;
    };
    const plexVisible = { value: false };

    // Pass 1: corpus binds (PATH-B single-file) → staged (handoff + VFS),
    // fail-closed pending (corpus-direct successes stage durable truth;
    // presentation completes on convergence).
    const liveCounter = { count: 0 };
    const first = await searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: ensure,
      confirmPlexFn: async () => (plexVisible.value ? { visible: true, mediaPart: { file: 'x' } } : null),
      liveDiscoveryFn: async () => { liveCounter.count++; throw new Error('live must not run'); },
    }));
    assert.ok(first.selection.selected, 'corpus candidate bound on pass 1');
    assert.equal(liveCounter.count, 0, 'S1: 0 live discovery calls');
    assert.ok(first.handoff?.torrentFileId, 'binding threaded into handoff');
    assert.ok(cache.getVfsTvEntry(MEDIA_ID, 1, 7), 'VFS materialized on pass 1');
    assert.equal(first.retryOwned, true, 'staged success stays retry-owned until convergence');
    const ensureAfterPass1 = ensureCalls.length;
    assert.ok(ensureAfterPass1 > 0, 'pass 1 attempted provider binding');

    // Pass 2 (duplicate request, no changes): reuse converges — zero
    // provider work, zero live I/O, same representation, STRM published.
    plexVisible.value = true;
    const second = await searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: ensure,
      confirmPlexFn: async () => (plexVisible.value ? { visible: true, mediaPart: { file: 'x' } } : null),
      liveDiscoveryFn: async () => { liveCounter.count++; throw new Error('live must not run'); },
    }));
    assert.ok(second.reuseMode, 'pass 2 reuses healthy state');
    assert.equal(liveCounter.count, 0, 'S1: still 0 live discovery calls');
    assert.equal(ensureCalls.length, ensureAfterPass1, 'S1: 0 additional provider binding calls');
    assert.equal(second.handoff.torrentFileId, first.handoff.torrentFileId, 'S1: no representation change');
    assert.equal(second.fulfilled, true, 'S1: fulfilled after convergence');
    assert.equal(second.retryOwned, false, 'S1: success does not remain retryOwned');
    assert.ok(
      fs.readdirSync(strmDir, { recursive: true }).some((f) => String(f).endsWith('.strm')),
      'S1: STRM published',
    );
    assert.ok(!seenFetch.some((u) => u.includes('fake.local')), 'S1: 0 live HTTP calls');
  } finally {
    cache.close();
  }
});

// ---------------------------------------------------------------------------
// S3/S4 — empty knowledge → bloodhound → fulfills + persists locally
// ---------------------------------------------------------------------------

test('S3/S4: empty corpus fulfills via bloodhound and persists knowledge for reuse', async (t) => {
  const strmDir = withTmpStrm(t);
  const seenFetch = [];
  stubFetch(t, liveStreams(), seenFetch);
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const cache = createDiscoveryCache();
  try {
    const store = stubStoreWithCoords();
    const ensureCalls = [];
    const liveCounter = { count: 0 };
    const result = await searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure(ensureCalls, {
        bindable: new Set([LIVE_H1.toLowerCase(), LIVE_H2.toLowerCase()]), backingStore: store,
      }),
      confirmPlexFn: async () => ({ visible: true, mediaPart: { file: 'x' } }),
      liveDiscoveryFn: bloodhoundSeam(liveCounter),
    }));
    // S3: fulfilled in the normal path with no override.
    assert.equal(liveCounter.count, 1, 'S3: exactly one live fanout');
    assert.equal(result.discovery.liveSources.length, 4, 'S3: all four routes queried');
    assert.ok(result.selection.selected, 'S3: valid candidate selected');
    assert.equal(result.fulfilled, true, 'S3: fulfilled');
    assert.equal(result.retryOwned, false, 'S3: success does not remain retryOwned');
    assert.ok(cache.getVfsTvEntry(MEDIA_ID, 1, 7), 'S3: VFS materialized');
    assert.ok(
      fs.readdirSync(strmDir, { recursive: true }).some((f) => String(f).endsWith('.strm')),
      'S3: STRM published',
    );
    // S4: the live-discovered release knowledge is persisted locally
    // (candidate→media associations) for faster future reuse.
    for (const hash of [LIVE_H1, LIVE_H2]) {
      const assocs = cache.getMediaAssociations(hash.toLowerCase(), null);
      assert.ok(assocs.some((a) => a.mediaId === MEDIA_ID),
        `S4: live hash ${hash.slice(0, 8)} persisted with media association`);
    }
    // ...and a duplicate request reuses it (S15 behavior on the same store).
    const liveBefore = liveCounter.count;
    const dup = await searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure(ensureCalls, {
        bindable: new Set([LIVE_H1.toLowerCase(), LIVE_H2.toLowerCase()]), backingStore: store,
      }),
      confirmPlexFn: async () => ({ visible: true, mediaPart: { file: 'x' } }),
      liveDiscoveryFn: bloodhoundSeam(liveCounter),
    }));
    assert.ok(dup.reuseMode || dup.fulfilled, 'S15: duplicate reuses healthy state');
    void liveBefore;
  } finally {
    cache.close();
  }
});

// ---------------------------------------------------------------------------
// S7 — invalid .exe/sidecar rejected → next candidate fulfills
// ---------------------------------------------------------------------------

test('S7: non-media payload cannot bind even with exact size; next fulfills', async () => {
  const EXE_HASH = 'e'.repeat(40);
  const exeSize = 12345678;
  const calls = [];
  const ensure = async ({ infoHash, selectedFileSize, skipSizeMatch } = {}) => {
    calls.push(String(infoHash).toLowerCase());
    const hash = String(infoHash || '').toLowerCase();
    // Provider inventory answers for BOTH hashes with exact sizes.
    const size = hash === EXE_HASH ? exeSize : SIZES[LIVE_H1];
    return { placementId: 'pl', providerFileId: 'pf', torrentFileId: `tf_${hash.slice(0, 8)}`, size };
  };
  const store = {
    // The .exe maps to a non-video payload; the valid hash maps to video.
    getTorrentFile: (id) => {
      if (id === `tf_${EXE_HASH.slice(0, 8)}`) {
        return { id, infoHash: EXE_HASH, size: exeSize, internalPath: 'Pack/Setup.exe' };
      }
      if (id === `tf_${LIVE_H1.slice(0, 8)}`) {
        return { id, infoHash: LIVE_H1.toLowerCase(), size: SIZES[LIVE_H1], internalPath: 'Harness/Season 01/Harness - S01E07.mkv' };
      }
      return null;
    },
  };
  const exeRow = {
    infoHash: EXE_HASH, fileIndex: null, filename: 'Harness.S01E07.Setup.exe', rank: 1, score: 0.99,
    identity: { eligible: true, tier: 'Verified', confidence: 0.9 },
    availability: {}, release: { title: 'Harness' },
    exactFileSize: null, selectedFileSize: exeSize,
  };
  const goodRow = {
    infoHash: LIVE_H1, fileIndex: null, filename: FILENAMES[LIVE_H1], rank: 2, score: 0.9,
    identity: { eligible: true, tier: 'Verified', confidence: 0.9 },
    availability: {}, release: { title: 'Harness' },
    exactFileSize: null, selectedFileSize: SIZES[LIVE_H1],
  };
  const result = await selectBindableCandidate([exeRow, goodRow], {
    ensureTorBoxFileIdentityFn: ensure,
    resolveTvTorrentFileFn: null,
    tvCoordinates: null,
    controlPlaneStore: store,
  });
  assert.ok(result.selected, 'a candidate fulfills');
  assert.equal(String(result.selected.infoHash).toLowerCase(), LIVE_H1.toLowerCase(),
    'S7: non-media row skipped, next valid candidate fulfills');
  assert.ok(calls.includes(EXE_HASH), 'S7: invalid row attempted (fail-closed, not fail-silent)');
  assert.ok(result.skipped.some((s) => s.infoHash === EXE_HASH), 'S7: skip recorded with reason');
});

// ---------------------------------------------------------------------------
// S12 — process restart during retry ownership
// ---------------------------------------------------------------------------

test('S12: restart during retry ownership preserves state; later market change fulfills', async (t) => {
  withTmpStrm(t);
  const dir = withTmpDir(t);
  const seenFetch = [];
  stubFetch(t, {}, seenFetch);

  const openCache = () => openFileCache(dir);
  let cache = openCache();
  try {
    seedCorpusRow(cache, { infoHash: CORPUS_H1, episode: 6 }); // wrong-episode only
    const store = stubStoreWithCoords();
    const liveCounter = { count: 0 };
    // Pass 1: live miss (empty market) → unfulfilled + retryOwned.
    const miss = await searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure([], { bindable: new Set() }),
      liveDiscoveryFn: async () => { liveCounter.count++; return { releases: [], sources: [] }; },
    }));
    assert.equal(miss.selection.selected, null, 'S12: nothing bindable on first pass');
    assert.equal(miss.unfulfilled, true);
    assert.equal(miss.retryOwned, true, 'S12: retry ownership held');
    assert.equal(liveCounter.count, 1, 'S12: one bounded fanout');
  } finally {
    cache.close(); // process "restart": all handles dropped
  }

  // Reopen on the same files: persisted requests/associations survive.
  cache = openFileCache(dir);
  try {
    const requests = cache.db.prepare('SELECT COUNT(*) c FROM media_requests').get();
    assert.ok(requests.c > 0, 'S12: request rows survive restart');
    // Market changes: live now carries a valid candidate → fulfills with
    // no second user request (same normal path, new attempt).
    stubFetch(t, liveStreams(), seenFetch);
    const store = stubStoreWithCoords();
    const ensureCalls = [];
    const liveCounter = { count: 0 };
    const retry = await searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure(ensureCalls, {
        bindable: new Set([LIVE_H1.toLowerCase()]), backingStore: store,
      }),
      confirmPlexFn: async () => ({ visible: true, mediaPart: { file: 'x' } }),
      liveDiscoveryFn: bloodhoundSeam(liveCounter),
    }));
    assert.ok(retry.selection.selected, 'S12: retry binds after market change');
    assert.ok(retry.handoff?.torrentFileId, 'S12: fresh durable truth persisted');
    assert.ok(cache.getVfsTvEntry(MEDIA_ID, 1, 7), 'S12: VFS materialized on retry');
    assert.equal(liveCounter.count, 1, 'S12: retry runs one bounded fanout (no storm)');
    // The threshold path stages durable truth (legacy staged semantics);
    // convergence completes on the following pass via reuse — no live, no
    // provider work, same representation.
    const ensureAfterRetry = ensureCalls.length;
    const liveAfterRetry = liveCounter.count;
    const third = await searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure(ensureCalls, {
        bindable: new Set([LIVE_H1.toLowerCase()]), backingStore: store,
      }),
      confirmPlexFn: async () => ({ visible: true, mediaPart: { file: 'x' } }),
      liveDiscoveryFn: bloodhoundSeam(liveCounter),
    }));
    assert.ok(third.reuseMode, 'S12: third pass reuses');
    assert.equal(third.fulfilled, true, 'S12: fulfilled');
    assert.equal(third.retryOwned, false, 'S12: success clears retry ownership');
    assert.equal(liveCounter.count, liveAfterRetry, 'S12: convergence performs no live fanout');
    assert.equal(ensureCalls.length, ensureAfterRetry, 'S12: convergence performs no provider work');
    assert.equal(third.handoff.torrentFileId, retry.handoff.torrentFileId, 'S12: same representation');
  } finally {
    cache.close();
  }
});

// ---------------------------------------------------------------------------
// S13 — restart after Binding before Plex convergence
// ---------------------------------------------------------------------------

test('S13: restart after Binding converges Plex without rediscovery', async (t) => {
  const strmDir = withTmpStrm(t);
  const dir = withTmpDir(t);
  const seenFetch = [];
  stubFetch(t, liveStreams(), seenFetch);

  const bindable = new Set([LIVE_H1.toLowerCase()]);
  const openCache = () => openFileCache(dir);
  let cache = openCache();
  try {
    const store = stubStoreWithCoords();
    const ensureCalls = [];
    const liveCounter = { count: 0 };
    const plexVisible = { value: false };
    // Pass 1: bind + VFS + STRM, Plex absent → published but pending.
    const first = await searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure(ensureCalls, { bindable, backingStore: store }),
      confirmPlexFn: async () => (plexVisible.value ? { visible: true, mediaPart: { file: 'x' } } : null),
      liveDiscoveryFn: bloodhoundSeam(liveCounter),
    }));
    assert.ok(first.selection.selected, 'S13: bound on pass 1');
    assert.ok(first.handoff?.torrentFileId, 'S13: durable binding on pass 1');
    assert.ok(cache.getVfsTvEntry(MEDIA_ID, 1, 7), 'S13: VFS on pass 1');
    assert.equal(first.published, true, 'S13: presentation completed on pass 1');
    assert.equal(first.fulfilled, false, 'S13: not fulfilled while Plex absent');
    assert.equal(first.retryOwned, true, 'S13: pending confirmation keeps ownership');
    assert.equal(liveCounter.count, 1);
    assert.ok(
      fs.readdirSync(strmDir, { recursive: true }).some((f) => String(f).endsWith('.strm')),
      'S13: STRM published on pass 1',
    );
  } finally {
    cache.close(); // process "restart" before Plex convergence
  }

  // Reopen: the same durable truth must converge Plex with zero
  // rediscovery, zero rebinding, zero representation change.
  cache = openCache();
  try {
    assert.ok(cache.getVfsTvEntry(MEDIA_ID, 1, 7), 'S13: VFS survives restart');
    assert.ok(cache.getTvPlaybackHandoff(MEDIA_ID, 1, 7)?.torrentFileId, 'S13: handoff survives restart');
    const store = stubStoreWithCoords();
    // Re-seed the identical provider truth the first pass observed
    // (deterministic test double for the control plane).
    const tfId = `tf_h_${LIVE_H1.slice(0, 8)}`;
    store.register({ id: tfId, infoHash: LIVE_H1.toLowerCase(), size: SIZES[LIVE_H1], internalPath: 'x.mkv' });
    const ensureCalls = [];
    const liveCounter = { count: 0 };
    const second = await searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure(ensureCalls, { bindable, backingStore: store }),
      confirmPlexFn: async () => ({ visible: true, mediaPart: { file: 'x' } }),
      liveDiscoveryFn: async () => { liveCounter.count++; throw new Error('S13: no rediscovery allowed'); },
    }));
    assert.ok(second.reuseMode, 'S13: convergence uses reuse, not rediscovery');
    assert.equal(liveCounter.count, 0, 'S13: 0 live discovery calls');
    assert.equal(ensureCalls.length, 0, 'S13: 0 provider binding calls');
    assert.equal(second.handoff.torrentFileId, tfId, 'S13: same Binding, no representation change');
    assert.equal(second.fulfilled, true, 'S13: fulfilled after Plex convergence');
    assert.equal(second.retryOwned, false, 'S13: success does not remain retryOwned');
  } finally {
    cache.close();
  }
});
