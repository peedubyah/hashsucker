/**
 * Requested-season convergence invariants (autonomous lifecycle slice).
 *
 * Deterministic clock-controlled tests for the real gaps found in the
 * production audit:
 *  - future release boundaries wake the scheduler (nextWakeAt), instead of
 *    waiting out a full fixed tick interval;
 *  - every non-playable episode maps to one small operator cause set
 *    (explainIntent);
 *  - market-miss cold retry stays bounded (one attempt per cold cycle,
 *    never a fresh hot budget).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import {
  createFutureIntentStore,
  explainIntent,
} from '../src/lib/anticipation/future-intents.js';
import {
  createAnticipationScheduler,
  isColdRetryEligible,
} from '../src/lib/anticipation/scheduler.js';

function stubBody() {
  const chunks = [Buffer.from('x'.repeat(70000))];
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
      cancel: async () => {},
    }),
  };
}

const T0 = 1_000_000;

function memStore(clock = () => T0) {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createFutureIntentStore({ db: cache.db, clock });
  return { cache, store };
}

test('nextWakeAt accounts for a future release boundary sooner than the next poll', () => {
  const { cache, store } = memStore();
  // Ordinary row polling in 15 minutes.
  store.seed({ mediaType: 'series', mediaId: 'tt-wake1', season: 1, episode: 1, checkInMs: 15 * 60 * 1000 });
  // Future episode airing in 2 minutes.
  store.seed({
    mediaType: 'series', mediaId: 'tt-wake1', season: 1, episode: 2,
    expectedAt: T0 + 2 * 60 * 1000, deferReason: 'future-not-released', checkInMs: 60 * 60 * 1000,
  });
  const wake = store.nextWakeAt();
  assert.equal(wake, T0 + 2 * 60 * 1000, 'wake at the release boundary, not the next poll');
  cache.close();
});

test('nextWakeAt surfaces an already-passed release boundary as due now', () => {
  const { cache, store } = memStore();
  store.seed({ mediaType: 'series', mediaId: 'tt-wake2', season: 1, episode: 1, checkInMs: 15 * 60 * 1000 });
  const { intent } = store.seed({
    mediaType: 'series', mediaId: 'tt-wake2', season: 1, episode: 2,
    expectedAt: T0 - 1000, deferReason: 'future-not-released', checkInMs: 60 * 60 * 1000,
  });
  assert.ok(intent);
  const wake = store.nextWakeAt();
  assert.ok(wake <= T0, 'passed boundary wakes immediately');
  cache.close();
});

test('explainIntent maps every non-playable state to one small cause set', () => {
  const cases = [
    [null, 'no-obligation'],
    [{ state: 'playable' }, 'playable'],
    [{ state: 'withdrawn' }, 'withdrawn'],
    [{ state: 'anticipated', defer_reason: 'future-not-released', expected_at: T0 + 1000 }, 'future'],
    [{ state: 'anticipated', defer_reason: 'released-no-candidate', next_check_at: T0 + 1 }, 'no-cached-route'],
    [{ state: 'anticipated', defer_reason: 'candidate-not-fulfillable', next_check_at: T0 + 1 }, 'candidate-not-fulfillable'],
    [{ state: 'prepared', last_error: null, next_check_at: T0 + 1 }, 'prepared-publication-pending'],
    [{ state: 'prepared', last_error: 'waiting-for-acceptable-quality:unknown', next_check_at: T0 + 1 }, 'prepared-waiting-quality'],
    [{ state: 'published_preparing', next_check_at: T0 + 1 }, 'publication-unconfirmed'],
    [{ state: 'failed', attempts: 6, defer_reason: 'released-no-candidate', next_check_at: T0 + 1 }, 'no-cached-route-cold-park'],
    [{ state: 'failed', attempts: 6, defer_reason: 'released-unfulfilled', next_check_at: T0 + 1 }, 'no-cached-route-cold-park'],
    [{ state: 'failed', attempts: 6, defer_reason: 'hard-failure', next_check_at: T0 + 1 }, 'exhausted-terminal'],
  ];
  for (const [intent, cause] of cases) {
    assert.equal(explainIntent(intent, T0).cause, cause, JSON.stringify(intent));
  }
});

test('cold retry stays bounded: eligible once per park, never a fresh hot budget', () => {
  const marketMiss = {
    state: 'failed', attempts: 6, season_owners: 'season:tt-x:s01',
    defer_reason: 'released-no-candidate', next_check_at: T0,
  };
  assert.equal(isColdRetryEligible(marketMiss, T0), true, 'parked market miss re-arms');
  const terminal = { ...marketMiss, defer_reason: 'hard-failure' };
  assert.equal(isColdRetryEligible(terminal, T0), false, 'deterministic failure stays terminal');
  const followUp = { ...marketMiss, defer_reason: 'released-unfulfilled' };
  assert.equal(isColdRetryEligible(followUp, T0), true, 'released follow-up is the same market miss');
  const oneShot = { ...marketMiss, season_owners: '' };
  assert.equal(isColdRetryEligible(oneShot, T0), false, 'one-shot exhaustion stays permanent');
  const early = { ...marketMiss, next_check_at: T0 + 1000 };
  assert.equal(isColdRetryEligible(early, T0), false, 'park must elapse first');
});

test('publish gate falls back to prepared truth when the fresh probe finds nothing', async () => {
  // Production case tt10986410 S04: prepared 1080p x265 with NULL source
  // tag; the zero-write live probe returns zero results, so the gate
  // would park forever on UNKNOWN despite bound, ready home quality.
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createFutureIntentStore({ db: cache.db, clock: () => T0 });
  const { intent } = store.seed({
    mediaType: 'series', mediaId: 'tt-fb', season: 4, episode: 2, expectedAt: T0 - 10_000,
  });
  store.transition(intent.id, 'prepared', { torrent_file_id: 'tf_elite', next_check_at: 0 });
  const fetchFn = async (url) => {
    if (url.endsWith('/api/media-prepare')) {
      return { status: 200, text: async () => JSON.stringify({ prepared: true, results: [] }) };
    }
    if (url.endsWith('/api/media-request')) {
      return { status: 200, text: async () => JSON.stringify({ handoff: { torrentFileId: 'tf_elite' }, fulfilled: true, published: true, vfsPublished: true }) };
    }
    if (url.includes('/files/')) return { status: 206, text: async () => '', body: stubBody() };
    throw new Error('unexpected ' + url);
  };
  const stubCache = {
    getReleaseAttributes: () => [{
      filename: 'Show.S04E02.1080p.x265-ELiTE.mkv', resolution: '1080p',
      sourceType: null, confidence: 0.95,
    }],
  };
  // NOTE: the real control-plane store maps rows to camelCase
  // (rowToTorrentFile); a snake_case stub here once masked a shape bug
  // that silently disabled this fallback in production.
  const stubCP = {
    getTorrentFile: () => ({ id: 'tf_elite', infoHash: 'abc123', internalPath: 'Show.S04E02.1080p.x265-ELiTE/Show.S04E02.1080p.x265-ELiTE.mkv' }),
  };
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d',
    cache: stubCache, controlPlaneStore: stubCP, fetchFn, clock: () => T0, log: () => {},
  });
  await sched.tickOnce();
  const row = store.findByIdentity({ mediaId: 'tt-fb', season: 4, episode: 2 });
  assert.equal(row.state, 'playable', `must publish via durable-truth fallback, got ${row.state}:${row.last_error}`);
  cache.close();
});

test('durable-truth fallback still blocks theatrical captures', async () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createFutureIntentStore({ db: cache.db, clock: () => T0 });
  const { intent } = store.seed({
    mediaType: 'series', mediaId: 'tt-cam', season: 4, episode: 2, expectedAt: T0 - 10_000,
  });
  store.transition(intent.id, 'prepared', { torrent_file_id: 'tf_cam', next_check_at: 0 });
  const fetchFn = async (url) => {
    if (url.endsWith('/api/media-prepare')) {
      return { status: 200, text: async () => JSON.stringify({ prepared: true, results: [] }) };
    }
    throw new Error('must never publish a CAM (unexpected ' + url + ')');
  };
  const stubCache = {
    getReleaseAttributes: () => [{
      filename: 'Show.S04E02.CAM.H264-XYZ.mkv', resolution: null,
      sourceType: null, confidence: 0.9,
    }],
  };
  const stubCP = {
    getTorrentFile: () => ({ id: 'tf_cam', info_hash: 'def456', internal_path: 'Show.S04E02.CAM.H264-XYZ/Show.S04E02.CAM.H264-XYZ.mkv' }),
  };
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d',
    cache: stubCache, controlPlaneStore: stubCP, fetchFn, clock: () => T0, log: () => {},
  });
  await sched.tickOnce();
  const row = store.findByIdentity({ mediaId: 'tt-cam', season: 4, episode: 2 });
  assert.equal(row.state, 'prepared', 'CAM stays parked, never publishes');
  assert.ok(String(row.last_error || '').startsWith('waiting-for-acceptable-quality'),
    'parks with explicit quality reason, got: ' + row.last_error);
  cache.close();
});

test('movie confirmation builds the authoritative VFS part file and converges', async () => {
  // Production case: six published movies wedged in published_preparing
  // because confirmation only handled TV episodes (null VFS entry, and a
  // TV-only Plex lookup). A visible movie must now converge to playable.
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createFutureIntentStore({ db: cache.db, clock: () => T0 });
  const { intent } = store.seed({ mediaType: 'movie', mediaId: 'tt-movie-confirm' });
  store.transition(intent.id, 'prepared', { torrent_file_id: 'tf_movie', next_check_at: 0 });
  const seen = [];
  const fetchFn = async (url) => {
    if (url.endsWith('/api/media-prepare')) {
      return { status: 200, text: async () => JSON.stringify({ prepared: true, handoff: { torrentFileId: 'tf_movie' } }) };
    }
    if (url.endsWith('/api/media-request')) {
      return { status: 200, text: async () => JSON.stringify({ handoff: { torrentFileId: 'tf_movie' }, fulfilled: false, published: true, vfsPublished: true }) };
    }
    if (url.includes('/files/')) return { status: 206, text: async () => '', body: stubBody() };
    throw new Error('unexpected ' + url);
  };
  const stubCache = {
    getReleaseAttributes: () => [],
    getVfsMovieEntry: () => ({ canonicalPath: 'Movies/Barbie/Barbie.mkv' }),
  };
  const confirmCalls = [];
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d',
    cache: stubCache, controlPlaneStore: {}, fetchFn, clock: () => T0, log: () => {},
    confirmConsumerPublicationFn: async (args) => {
      confirmCalls.push(args);
      return { visible: true, mediaPart: { file: args.expectedPartFile, size: 1, container: 'mkv' } };
    },
  });
  await sched.tickOnce();
  const row = store.findByIdentity({ mediaId: 'tt-movie-confirm' });
  assert.equal(confirmCalls.length, 1, 'confirmation attempted exactly once');
  assert.equal(confirmCalls[0].expectedPartFile, '/mnt/hashsucker-vfs/Movies/Barbie/Barbie.mkv');
  assert.equal(row.state, 'playable', `visible movie converges, got ${row.state}:${row.last_error}`);
  cache.close();
});

test('confirmPlexEpisode matches movies by IMDb guid in the movies section', async () => {
  const { confirmPlexEpisode } = await import('../src/lib/consumers/plex.js');
  const prev = {
    PLEX_URL: process.env.PLEX_URL, PLEX_TOKEN: process.env.PLEX_TOKEN,
    PLEX_MOVIES_SECTION_ID: process.env.PLEX_MOVIES_SECTION_ID,
  };
  process.env.PLEX_URL = 'http://plex.test:32400';
  process.env.PLEX_TOKEN = 'test-token';
  process.env.PLEX_MOVIES_SECTION_ID = '2';
  const realFetch = globalThis.fetch;
  const partFile = '/mnt/hashsucker-vfs/Movies/12 Angry Men/12 Angry Men [4dc32e0f3b].mkv';
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = async () => {
      if (u.includes('/library/metadata/')) {
        // Multi-edition item: ours is listed second, so a take-first
        // implementation would misconfirm against the wrong edition.
        return { MediaContainer: { Metadata: [{ ratingKey: '418', Media: [{ Part: [
          { id: 1, file: '/mnt/hashsucker-vfs/Movies/12 Angry Men/12 Angry Men.mkv', size: 5, container: 'mkv' },
          { id: 930, file: partFile, size: 7, container: 'mkv' },
        ] }] }] } };
      }
      return { MediaContainer: { Metadata: [{ ratingKey: '418', key: '/library/metadata/418', Guid: [{ id: 'imdb://tt0050083' }] }] } };
    };
    return { ok: true, json };
  };
  try {
    const hit = await confirmPlexEpisode({ mediaId: 'tt0050083', season: null, episode: null, expectedPartFile: partFile });
    assert.equal(hit.visible, true, 'exact visible movie confirms');
    const miss = await confirmPlexEpisode({ mediaId: 'tt0000000', season: null, episode: null, expectedPartFile: partFile });
    assert.equal(miss.visible, false, 'absent movie does not confirm');
    const wrong = await confirmPlexEpisode({ mediaId: 'tt0050083', season: null, episode: null, expectedPartFile: '/mnt/hashsucker-vfs/Movies/Other/Other.mkv' });
    assert.equal(wrong.visible, false, 'path mismatch does not confirm');
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('stale playable with no binding and no VFS demotes to reconverge', async () => {
  // Production case tt0159187 S1E1: playable, but its binding is gone
  // and no VFS projection exists. It must re-enter the normal path,
  // not claim playable forever.
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createFutureIntentStore({ db: cache.db, clock: () => T0 });
  const { intent } = store.seed({ mediaType: 'movie', mediaId: 'tt-stale' });
  store.transition(intent.id, 'playable', { torrent_file_id: 'tf_gone', next_check_at: T0 });
  const stubCache = { getVfsTvEntry: () => null, getVfsMovieEntry: () => null };
  const stubCP = { hasActiveBindingForTorrentFile: () => false };
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d',
    cache: stubCache, controlPlaneStore: stubCP,
    fetchFn: async () => { throw new Error('must not do market work on audit tick'); },
    clock: () => T0, log: () => {},
  });
  const r = await sched.tickOnce();
  assert.equal(r.stalePlayable, true);
  const row = store.findByIdentity({ mediaId: 'tt-stale' });
  assert.equal(row.state, 'anticipated');
  assert.equal(row.last_error, 'stale-playable-demoted:no-binding-no-vfs');
  assert.equal(row.torrent_file_id, 'tf_gone', 'durable truth kept for reconvergence');
  cache.close();
});

test('healthy playable with a VFS projection is never demoted', async () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createFutureIntentStore({ db: cache.db, clock: () => T0 });
  const { intent } = store.seed({ mediaType: 'movie', mediaId: 'tt-healthy' });
  store.transition(intent.id, 'playable', { torrent_file_id: 'tf_ok', next_check_at: T0 });
  const stubCache = { getVfsTvEntry: () => null, getVfsMovieEntry: () => ({ canonicalPath: 'Movies/X/X.mkv' }) };
  const stubCP = { hasActiveBindingForTorrentFile: () => false };
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d',
    cache: stubCache, controlPlaneStore: stubCP,
    fetchFn: async () => { throw new Error('unexpected'); },
    clock: () => T0, log: () => {},
  });
  await sched.tickOnce();
  const row = store.findByIdentity({ mediaId: 'tt-healthy' });
  assert.equal(row.state, 'playable');
  cache.close();
});

test('stale-playable audit fails closed without evidence accessors', async () => {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const store = createFutureIntentStore({ db: cache.db, clock: () => T0 });
  const { intent } = store.seed({ mediaType: 'movie', mediaId: 'tt-noev' });
  store.transition(intent.id, 'playable', { torrent_file_id: 'tf_x', next_check_at: T0 });
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d',
    cache: null, controlPlaneStore: {},
    fetchFn: async () => { throw new Error('unexpected'); },
    clock: () => T0, log: () => {},
  });
  await sched.tickOnce();
  const row = store.findByIdentity({ mediaId: 'tt-noev' });
  assert.equal(row.state, 'playable', 'never demote on missing evidence');
  cache.close();
});

test('season reconcile never clobbers scheduler backoff for existing owners', () => {
  // Production hot loop: ensureSeasonEpisode took min(next_check, now)
  // on every reconcile, converting bounded 7-day parks into ~15-minute
  // retries (attempts +192/day observed). The scheduler owns retry
  // timing; reconcile only owns membership.
  const { cache, store } = memStore();
  const { intent } = store.seed({
    mediaType: 'series', mediaId: 'tt-park', season: 1, episode: 2, checkInMs: 7 * 24 * 3600 * 1000,
  });
  store.transition(intent.id, 'failed', { last_error: 'prepare:no-handoff', next_check_at: T0 + 7 * 24 * 3600 * 1000 });
  store.ensureSeasonEpisode({ mediaId: 'tt-park', season: 1, episode: 2, owner: 'season:tt-park:s01' });
  // Re-park (simulating the scheduler's bounded park after the wake).
  store.transition(intent.id, 'failed', { last_error: 'prepare:no-handoff', next_check_at: T0 + 7 * 24 * 3600 * 1000 });
  const parked = store.findByIdentity({ mediaId: 'tt-park', season: 1, episode: 2 }).next_check_at;
  // Repeat reconciles with the SAME owner must not touch the park.
  store.ensureSeasonEpisode({ mediaId: 'tt-park', season: 1, episode: 2, owner: 'season:tt-park:s01' });
  store.ensureSeasonEpisode({ mediaId: 'tt-park', season: 1, episode: 2, owner: 'season:tt-park:s01' });
  const row = store.findByIdentity({ mediaId: 'tt-park', season: 1, episode: 2 });
  assert.equal(row.next_check_at, parked, 'existing owner preserves the park');
  assert.ok(row.season_owners.includes('season:tt-park:s01'));
  cache.close();
});

test('season reconcile wakes promptly for a genuinely new owner', () => {
  const { cache, store } = memStore();
  const { intent } = store.seed({
    mediaType: 'series', mediaId: 'tt-new', season: 1, episode: 2, checkInMs: 7 * 24 * 3600 * 1000,
  });
  store.transition(intent.id, 'failed', { last_error: 'x', next_check_at: T0 + 7 * 24 * 3600 * 1000 });
  store.ensureSeasonEpisode({ mediaId: 'tt-new', season: 1, episode: 2, owner: 'season:tt-new:s01' });
  const row = store.findByIdentity({ mediaId: 'tt-new', season: 1, episode: 2 });
  assert.equal(row.next_check_at, T0, 'fresh demand wakes now');
  cache.close();
});

test('future episode obligation is created once and converges, never clobbers', () => {
  const { cache, store } = memStore();
  const first = store.seed({
    mediaType: 'series', mediaId: 'tt-once', season: 2, episode: 3,
    source: 'seerr:1', expectedAt: T0 + 86400 * 1000, deferReason: 'future-not-released',
  });
  assert.equal(first.created, true);
  const second = store.seed({
    mediaType: 'series', mediaId: 'tt-once', season: 2, episode: 3,
    source: 'seerr:1', expectedAt: T0 + 86400 * 1000, deferReason: 'future-not-released',
  });
  assert.equal(second.created, false, 'duplicate seed converges, never duplicates');
  assert.equal(second.intent.id, first.intent.id);
  cache.close();
});
