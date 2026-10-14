/**
 * Autonomous core hardening (acceptance Parts 6/7/8 + 9C support).
 *
 * Deterministic, zero-network tests proving the retry/recovery topology:
 *
 * Part 6 — Plex convergence without rediscovery: Binding/VFS good but
 *   Plex absent retries presentation only (republish path). No live
 *   discovery, no reranking, no representation change.
 * Part 7 — cheapest-next-action per failure class:
 *   7.1 corpus-bindable success never invokes live discovery;
 *   7.2 TorBox route failure falls back to the RD route for the SAME hash
 *       (no rediscovery);
 *   7.3/7.4 covered by recent-release-bloodhound.test.js (bloodhound on
 *       unbindable; miss stays retry-owned and retries live later);
 *   7.5 scoped wake: only the woken identity acts (see tickOnce test).
 * Part 8 — future → due → attempt → owned failure → retry → fulfillment →
 *   terminal, driven by an injected clock (no calendar waiting).
 * Part 9C support — wake locality: one tick acts on the woken identity
 *   only; unrelated intents are untouched (no global churn).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { searchByMedia } from '../src/api/media-request.js';
import { selectBindableCandidate } from '../src/lib/discovery/selection.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';
import { createAnticipationScheduler } from '../src/lib/anticipation/scheduler.js';

const MOVIE_ID = 'tt9000001';
const MOVIE_HASH = 'aabbccddeeff00112233445566778899aabbcc01';
const SERIES_ID = 'tt9000002';

function withTmpStrm(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-harden-strm-'));
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

// Global fetch stub: anything touching the network fails loudly, while
// recording every attempted URL so tests can prove which I/O did (not)
// happen. Consumer-notification and metadata fallbacks must swallow these.
function stubNoNetwork(t, seen) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    throw new Error(`no-network-fixture: ${String(url).slice(0, 120)}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
}

function tf(id, infoHash, size, internalPath) {
  return { id, infoHash, size, internalPath };
}

function seedMovie(cache, { infoHash = MOVIE_HASH, mediaId = MOVIE_ID } = {}) {
  cache.upsertCandidate({
    infoHash, fileIndex: null, filename: 'Core.Movie.2020.1080p.WEB-DL.mkv', title: 'Core Movie',
  });
  storeReleaseAttributes(cache, {
    infoHash, fileIndex: null, filename: 'Core.Movie.2020.1080p.WEB-DL.mkv',
    source: 'test', confidence: 0.9,
    parsed: { title: 'Core Movie', year: 2020, resolution: '1080p', mediaType: 'movie' },
    evidence: ['test'],
  });
  cache.associateMedia(infoHash, null, mediaId, {
    source: 'test', confidence: 0.8, evidence: ['test'],
    resolutionState: 'probable', matchMethod: 'test', resolverSource: 'test', resolverVersion: '1.0',
  });
}

// ---------------------------------------------------------------------------
// Part 6 — Plex convergence retries presentation only (no rediscovery)
// ---------------------------------------------------------------------------

test('part6: Binding/VFS-good + Plex-absent republishes with zero discovery I/O', async (t) => {
  const strmDir = withTmpStrm(t);
  const seenFetch = [];
  stubNoNetwork(t, seenFetch);
  const cache = createDiscoveryCache();
  try {
    seedMovie(cache);
    const torrentFile = tf('tf_core_1', MOVIE_HASH, 424242, 'Core/Movie.mkv');
    const coords = [{ provider: 'torbox', account_scope: 'default', provider_resource_id: 'r1', provider_file_id: 'f1', size: 424242 }];
    const store = {
      getTorrentFile: (id) => (id === torrentFile.id ? { ...torrentFile } : null),
      listDataPlaneCoordinates: (id) => (id === torrentFile.id ? [...coords] : []),
      listTorrentFilesForRelease: () => [{ ...torrentFile }],
      listProviderRefsForTorrentFile: () => [{ placementId: 'pl1', present: true, providerFileId: 'f1' }],
      getLibraryItemByIdentityKey: () => ({ id: 'lib_core_1', desiredState: 'present' }),
      getActiveBindingForLibraryItem: () => ({
        torrentFile: { ...torrentFile },
        binding: { releaseKey: `${MOVIE_HASH}:torrent`, infoHash: MOVIE_HASH, fileIndex: null },
      }),
      getActiveCanonicalPath: () => 'Core Movie (2020)/Core Movie (2020).mkv',
    };
    const ensureCalls = [];
    const ensure = async ({ skipSizeMatch } = {}) => {
      ensureCalls.push(!!skipSizeMatch);
      if (skipSizeMatch) return { placementId: 'pl1', torrentFiles: [{ ...torrentFile }] };
      return { placementId: 'pl1', providerFileId: 'f1', torrentFileId: torrentFile.id, size: torrentFile.size };
    };

    // Stage durable truth first (no presentation).
    const prep = await searchByMedia(cache, {
      mediaId: MOVIE_ID, mediaType: 'movie', prepareOnly: true,
      skipLiveDiscovery: true, skipAvailability: true,
      controlPlaneStore: store, ensureTorBoxFileIdentity: ensure,
    });
    assert.equal(prep.prepared, true, 'durable truth prepared');
    assert.equal(cache.getVfsMovieEntry(MOVIE_ID), null, 'prepare publishes nothing');

    // Plex convergence retry: VFS missing (→ republish), Plex absent
    // (confirmPlexEpisode is N/A for movies; the republish path runs).
    // Live discovery would throw if touched; any live HTTP would record.
    let liveCalls = 0;
    const req = await searchByMedia(cache, {
      mediaId: MOVIE_ID, mediaType: 'movie',
      skipAvailability: true,
      controlPlaneStore: store, ensureTorBoxFileIdentity: ensure,
      liveDiscoveryFn: async () => { liveCalls++; throw new Error('rediscovery must not run'); },
    });
    assert.equal(req.reuseMode, 'republish', 'convergence uses the republish path');
    assert.equal(liveCalls, 0, 'no live discovery on the convergence retry');
    assert.ok(!seenFetch.some((u) => /stream\/|manifest|torznab|prowlarr/i.test(u)),
      'no discovery HTTP on the convergence retry');
    assert.equal(req.handoff.torrentFileId, torrentFile.id, 'same representation (no rerank/reselect)');
    const vfs = cache.getVfsMovieEntry(MOVIE_ID);
    assert.ok(vfs, 'VFS materialized');
    assert.equal(vfs.torrentFileId, torrentFile.id, 'VFS matches the binding');
    assert.ok(collectStrmFiles(strmDir).length >= 1, 'STRM (re)published for Plex convergence');
  } finally {
    cache.close();
  }
});

// ---------------------------------------------------------------------------
// Part 7.1 — bindable corpus never restarts into live discovery
// ---------------------------------------------------------------------------

test('part7.1: corpus-bindable success performs zero live I/O', async (t) => {
  withTmpStrm(t);
  const seenFetch = [];
  stubNoNetwork(t, seenFetch);
  const cache = createDiscoveryCache();
  try {
    seedMovie(cache);
    const torrentFile = tf('tf_core_2', MOVIE_HASH, 424242, 'Core/Movie.mkv');
    const store = {
      getTorrentFile: (id) => (id === torrentFile.id ? { ...torrentFile } : null),
      listTorrentFilesForRelease: () => [{ ...torrentFile }],
      listProviderRefsForTorrentFile: () => [{ placementId: 'pl1', present: true, providerFileId: 'f1' }],
      listDataPlaneCoordinates: () => [],
    };
    let liveCalls = 0;
    const result = await searchByMedia(cache, {
      mediaId: MOVIE_ID, mediaType: 'movie',
      skipLiveDiscovery: false, skipAvailability: true,
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: async ({ skipSizeMatch } = {}) => {
        if (skipSizeMatch) return { placementId: 'pl1', torrentFiles: [{ ...torrentFile }] };
        throw Object.assign(new Error('no size path'), { code: 'NO_PLACEMENT' });
      },
      liveDiscoveryFn: async () => { liveCalls++; throw new Error('live must not run'); },
    });
    assert.ok(result.selection.selected, 'corpus candidate bound');
    assert.equal(liveCalls, 0, 'bindable corpus never invokes live discovery');
    assert.equal(result.discovery.liveDiscoveryTriggered, false);
    assert.ok(!seenFetch.some((u) => /stream\/|manifest|torznab|prowlarr/i.test(u)), 'no discovery HTTP');
  } finally {
    cache.close();
  }
});

// ---------------------------------------------------------------------------
// Part 7.2 — same-X alternate route (TorBox fails → RD binds, no rediscovery)
// ---------------------------------------------------------------------------

test('part7.2: TorBox route failure falls back to RD for the same hash', async () => {
  const H = 'rd'.padEnd(40, '0');
  const order = [];
  const torboxEnsure = async () => {
    order.push('torbox');
    throw Object.assign(new Error('No TorBox placement'), { code: 'NO_PLACEMENT' });
  };
  const rdEnsure = async ({ infoHash }) => {
    order.push('realdebrid');
    assert.equal(String(infoHash).toLowerCase(), H, 'same exact hash retried on the alternate route');
    return { status: 'ready', torrentFileId: 'tf_rd_1', placementId: 'pl_rd', providerFileId: 'pf_rd', size: 777, source: 'probe' };
  };
  const store = {
    getTorrentFile: (id) => (id === 'tf_rd_1'
      ? { id, infoHash: H, size: 777, internalPath: 'Show/movie.mkv' }
      : null),
  };
  const candidate = {
    infoHash: H, fileIndex: null, filename: 'Show.Movie.2020.1080p.mkv', rank: 1, score: 0.9,
    identity: { eligible: true, tier: 'Verified', confidence: 0.9 },
    availability: {}, release: { title: 'Show Movie' },
    exactFileSize: null, selectedFileSize: null,
  };
  const result = await selectBindableCandidate([candidate], {
    ensureTorBoxFileIdentityFn: torboxEnsure,
    ensureRealDebridFileIdentityFn: rdEnsure,
    resolveTvTorrentFileFn: null,
    tvCoordinates: null,
    controlPlaneStore: store,
  });
  assert.ok(result.selected, 'alternate route bound the same hash');
  assert.equal(result.selected.infoHash, H);
  assert.match(result.reason, /^rd-cached bound/, 'RD binding reason recorded');
  assert.deepEqual(order, ['torbox', 'realdebrid'], 'TorBox attempted first, RD second, same X');
});

// ---------------------------------------------------------------------------
// Parts 7.5 / 9C — scoped wake: one tick acts on the woken identity only
// ---------------------------------------------------------------------------

test('part7.5/9C: tick acts on the woken identity only, no global churn', async () => {  const db = new DatabaseSync(':memory:');
  let nowMs = Date.now();
  const store = createFutureIntentStore({ db, clock: () => nowMs });
  store.seed({ mediaType: 'movie', mediaId: 'ttW1', source: 'test', expectedAt: null, deferReason: 'released-no-candidate' });
  store.seed({ mediaType: 'movie', mediaId: 'ttW2', source: 'test', expectedAt: null, deferReason: 'released-no-candidate', checkInMs: 10_000_000 });
  // Only ttW1 is woken (due now); ttW2 sleeps far in the future.
  assert.equal(store.wakeMedia(['ttW1'], nowMs), 1, 'exactly one row woken');

  let httpCalls = 0;
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: null,
    fetchFn: async () => { httpCalls++; throw new Error('prepare transport down'); },
    clock: () => nowMs, log: () => {},
  });
  const acted = await sched.tickOnce();
  assert.equal(acted.acted, true, 'tick acted');
  const w1 = store.list({}).find((r) => r.media_id === 'ttW1');
  assert.equal(acted.intentId, w1.id, 'only the woken identity acted upon');
  const after = Object.fromEntries(store.list({}).map((r) => [r.media_id, r]));
  assert.notEqual(after.ttW1.last_error, null, 'woken row attempted and owned its failure');
  assert.equal(after.ttW2.last_error, null, 'unrelated row untouched');
  assert.ok(after.ttW2.next_check_at > nowMs, 'unrelated row still sleeping');
});

// ---------------------------------------------------------------------------
// Part 8 — future → due → owned failure → retry → fulfillment → terminal
// ---------------------------------------------------------------------------

test('part8: future intent lifecycle completes on the clock with no second request', async () => {
  const db = new DatabaseSync(':memory:');
  const DAY = 86_400_000;
  // Fake clock shared by the store and the scheduler: the only time source
  // in this lifecycle (no calendar waiting, no real now leaking in).
  let nowMs = Date.now();
  const store = createFutureIntentStore({ db, clock: () => nowMs });
  const T0 = nowMs;
  const expectedAt = T0 + 10 * DAY; // TV episode airing in 10 days
  const seeded = store.seed({
    mediaType: 'series', mediaId: SERIES_ID, season: 1, episode: 7,
    source: 'seerr:test', expectedAt, deferReason: 'future-not-released',
  }).intent;

  const httpCalls = [];
  let prepareBehavior = 'fail';
  const fetchFn = async (url, opts = {}) => {
    httpCalls.push(url);
    if (url.endsWith('/api/media-prepare')) {
      if (prepareBehavior === 'fail') {
        return { status: 500, text: async () => JSON.stringify({ error: 'boom' }) };
      }
      return {
        status: 200,
        text: async () => JSON.stringify({
          prepared: true,
          handoff: { torrentFileId: 'tf_future_1', filename: 'Show.S01E07.1080p.WEB-DL.mkv' },
          selection: { selected: { infoHash: 'f'.repeat(40), fileIndex: null } },
          results: [{
            infoHash: 'f'.repeat(40), fileIndex: null,
            filename: 'Show.S01E07.1080p.WEB-DL.mkv', release: { source: 'WEB-DL' },
          }],
        }),
      };
    }
    if (url.endsWith('/api/media-request')) {
      return {
        status: 200,
        text: async () => JSON.stringify({ handoff: { torrentFileId: 'tf_future_1' }, reuseMode: 'republish' }),
      };
    }
    if (url.includes('/files/')) {
      return {
        status: 206, text: async () => '',
        body: { getReader: () => ({ read: async () => ({ done: false, value: Buffer.from('x'.repeat(100)) }), cancel: async () => {} }) },
      };
    }
    throw new Error(`unexpected ${url}`);
  };
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://dp',
    fetchFn, clock: () => nowMs, log: () => {},
    tvPrepareDays: 3, tvPublishDays: 1,
  });
  const row = () => store.list({}).find((r) => r.id === seeded.id);

  // 1. Future: waits cheaply (TV prepare window opens 3d before air).
  let r = await sched.tickOnce();
  assert.equal(r.acted, true);
  assert.equal(httpCalls.length, 0, 'no provider calls while outside the window');
  assert.equal(row().state, 'anticipated');
  assert.equal(row().next_check_at, expectedAt - 3 * DAY, 'sleep until prepare window');

  // 2. Due: first attempt fails → owned failure with backoff (not terminal).
  nowMs = expectedAt - 3 * DAY + 1;
  r = await sched.tickOnce();
  assert.equal(r.from, 'anticipated');
  assert.equal(row().state, 'anticipated', 'failure remains owned, not terminal');
  const afterFailCheck = row().next_check_at;
  assert.ok(afterFailCheck > nowMs, 'backoff scheduled');
  const callsAfterFail = httpCalls.length;
  assert.equal(callsAfterFail, 1, 'exactly one prepare attempt (no retry storm)');

  // 3. Later retry: market has the release → prepared (durable truth, no presentation).
  prepareBehavior = 'ok';
  nowMs = afterFailCheck + 1;
  r = await sched.tickOnce();
  assert.equal(r.to, 'prepared');
  assert.equal(row().torrent_file_id, 'tf_future_1');
  assert.ok(httpCalls.length > callsAfterFail, 'retry re-attempted preparation');

  // 4. Publish waits for the publish window (1d before air), then publishes.
  const pubRow = row();
  assert.ok(pubRow.next_check_at <= nowMs || pubRow.state === 'prepared', 'prepared state reached');
  nowMs = expectedAt - 1 * DAY + 1;
  r = await sched.tickOnce();
  assert.equal(r.to, 'playable', 'fulfillment completes inside the publish window');
  assert.equal(row().state, 'playable');

  // 5. Terminal: further ticks do nothing (no second user request, no churn).
  const callsBefore = httpCalls.length;
  nowMs += DAY;
  r = await sched.tickOnce();
  assert.equal(r.acted, false, 'terminal intent takes no further action');
  assert.equal(httpCalls.length, callsBefore, 'no further I/O after terminal');
});

// ---------------------------------------------------------------------------
// Part 5 — exhausted rows must not head-of-line-block the due queue
// ---------------------------------------------------------------------------

test('part5: exhausted non-retryable row parks instead of starving the queue', async () => {
  const db = new DatabaseSync(':memory:');
  let nowMs = Date.now();
  const store = createFutureIntentStore({ db, clock: () => nowMs });
  // Ancient exhausted blocker at the head of the due queue (attempts maxed,
  // no retryable defer reason, next_check long past).
  const blocker = store.seed({
    mediaType: 'movie', mediaId: 'ttBlocker', source: 'operator',
    expectedAt: null, deferReason: null,
  }).intent;
  db.prepare(`UPDATE future_intents SET state='failed', attempts=6, next_check_at=? WHERE id=?`)
    .run(nowMs - 1_000_000, blocker.id);
  // Genuine released-unfulfilled work waiting behind it.
  const queued = store.seed({
    mediaType: 'movie', mediaId: 'ttQueued', source: 'test',
    expectedAt: null, deferReason: 'released-no-candidate',
  }).intent;

  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: null,
    fetchFn: async () => { throw new Error('no network'); },
    clock: () => nowMs, log: () => {},
  });

  // Tick 1 parks the blocker (state/history preserved, poll moved out).
  let r = await sched.tickOnce();
  assert.equal(r.acted, true, 'blocker tick acts');
  const parked = store.list({}).find((x) => x.media_id === 'ttBlocker');
  assert.equal(parked.state, 'failed', 'blocker state preserved');
  assert.equal(parked.attempts, 6, 'blocker history preserved');
  assert.ok(parked.next_check_at > nowMs, 'blocker poll parked in the future');

  // Tick 2 reaches the queued work (previously starved forever).
  r = await sched.tickOnce();
  assert.equal(r.acted, true, 'queued work acted upon');
  assert.equal(r.intentId, queued.id, 'queue advanced past the parked blocker');
});
