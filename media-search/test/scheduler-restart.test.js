/**
 * Scheduler durability across a real process restart.
 *
 * The scheduler's lifecycle state is durable truth: a restart must not lose
 * obligations, must not reset retry budgets, and must not resurrect
 * exhausted work into a hot loop. These tests re-open the SAME database
 * files with a fresh store (the way a restart does) instead of
 * reconstructing equivalent in-memory objects, and then drive the real
 * `tickOnce()` entry path.
 *
 * Contracts proven:
 *   R1  a season-owned exhaustion stays obligated: its park, attempts, and
 *       season ownership survive restart, and it is cold-actionable only
 *       after the cold park elapses;
 *   R2  a one-shot exhaustion stays terminal across restart (no cold retry
 *       without a season owner) and never head-of-line blocks;
 *   R3  a future-not-released row keeps its parked prepare-window poll
 *       across restart and only becomes actionable at that window;
 *   R4  the release wake survives restart: a row whose air date passed
 *       while the process was down still gets its one-time rearm;
 *   R5  publication/pending ownership survives restart: a handoff whose
 *       consumer confirmation has not converged is still retry-owned, not
 *       re-driven from scratch.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';
import { createAnticipationScheduler } from '../src/lib/anticipation/scheduler.js';
import { MAX_ATTEMPTS } from '../src/lib/anticipation/scheduler.js';

const BASE = 1_800_000_000_000;
const DAY = 86_400_000;
const OWNER = 'season:tt0159187:s01';

/**
 * A file-backed store pair, the way production holds it. The clock is shared
 * between the store and every scheduler built from it — production has one
 * time source, and a store clock disagreeing with the scheduler clock makes
 * due() invisible (which is exactly the kind of drift that hides bugs).
 */
function openStores(dir, clock = () => BASE) {
  const cache = createDiscoveryCache({ dbPath: join(dir, 'discovery.db') });
  const store = createFutureIntentStore({ db: cache.db, clock });
  return { cache, store, scheduler: (opts = {}) => schedulerFor(store, clock, opts) };
}

function schedulerFor(store, clock, { fetchFn, httpCalls = [] } = {}) {
  return createAnticipationScheduler({
    store,
    baseUrl: 'http://restart.test',
    dataPlaneBaseUrl: null,
    fetchFn: fetchFn ?? (async (url) => { httpCalls.push(url); throw new Error('prepare unavailable'); }),
    clock,
    log: () => {},
    tvPrepareDays: 3, tvPublishDays: 1,
  });
}

test('R1 — season-owned exhaustion survives restart and stays cold-bounded', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Before the restart: exhaust a season-owned row and let it park.
  let now = BASE;
  const clock = () => now;
  let first = openStores(dir, clock);
  let seededId;
  try {
    const { intent } = first.store.seed({
      mediaType: 'series', mediaId: 'tt0159187', season: 1, episode: 3,
      source: 'seerr:req', expectedAt: BASE - 30 * DAY, deferReason: 'released-no-candidate',
    });
    seededId = intent.id;
    first.store.setSeasonOwner?.(intent.id, OWNER);
    // Ensure the owner is recorded durably the way season reconciliation does.
    if (!first.store.findByIdentity({ mediaId: 'tt0159187', season: 1, episode: 3 }).season_owners) {
      first.cache.db.prepare('UPDATE future_intents SET season_owners = ? WHERE id = ?').run(OWNER, intent.id);
    }
    first.store.transition(intent.id, 'failed', {
      last_error: 'attempts-exhausted:parked', next_check_at: BASE + 7 * DAY,
    });
    first.cache.db.prepare('UPDATE future_intents SET attempts = ? WHERE id = ?').run(MAX_ATTEMPTS, intent.id);
  } finally {
    first.cache.close();
  }

  // Restart: re-open the same files.
  const second = openStores(dir, clock);
  t.after(() => second.cache.close());
  const row = second.store.findByIdentity({ mediaId: 'tt0159187', season: 1, episode: 3 });
  assert.equal(row.state, 'failed', 'state survives restart');
  assert.equal(row.attempts, MAX_ATTEMPTS, 'attempt history survives restart');
  assert.equal(row.season_owners, OWNER, 'the season obligation survives restart');

  // Still parked: no action before the cold park elapses.
  const r1 = await second.scheduler().tickOnce();
  assert.equal(r1.acted, false, 'a re-opened row does not act before its cold park elapses');

  // After the park elapses it is cold-actionable exactly once.
  const httpCalls = [];
  now = BASE + 7 * DAY + 1;
  const r2 = await second.scheduler({ httpCalls }).tickOnce();
  assert.equal(r2.intentId, seededId, 'the cold retry re-attempted the same obligation');
  const after = second.store.findByIdentity({ mediaId: 'tt0159187', season: 1, episode: 3 });
  assert.equal(after.attempts, MAX_ATTEMPTS + 1, 'attempts increment, never reset');
});

test('R2 — one-shot exhaustion stays terminal across restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let first = openStores(dir);
  let behindId;
  try {
    const { intent } = first.store.seed({
      mediaType: 'movie', mediaId: 'ttOneshot', source: 'operator',
      expectedAt: BASE - DAY, deferReason: 'released-no-candidate',
    });
    first.store.transition(intent.id, 'failed', { last_error: 'exhausted', next_check_at: BASE - 1 });
    first.cache.db.prepare('UPDATE future_intents SET attempts = ? WHERE id = ?').run(MAX_ATTEMPTS, intent.id);
    // Genuine work waiting behind it.
    const behind = first.store.seed({
      mediaType: 'movie', mediaId: 'ttBehind', source: 'seerr:x',
      expectedAt: BASE - DAY, deferReason: 'released-no-candidate',
    }).intent;
    behindId = behind.id;
  } finally {
    first.cache.close();
  }

  const second = openStores(dir);
  t.after(() => second.cache.close());
  const httpCalls = [];
  const r = await second.scheduler({ httpCalls }).tickOnce();
  assert.equal(r.intentId, behindId, 'the exhausted row must not block the queue after restart');
  const row = second.store.findByIdentity({ mediaId: 'ttOneshot' });
  assert.equal(row.state, 'failed', 'one-shot exhaustion stays terminal');
  assert.equal(row.attempts, MAX_ATTEMPTS, 'no cold retry without a season owner');
});

test('R3 — a parked prepare window survives restart and wakes on time', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const AIR = BASE + 10 * DAY;
  let now = BASE;
  let first = openStores(dir, () => now);
  try {
    first.store.seed({
      mediaType: 'series', mediaId: 'ttFuture', season: 2, episode: 4,
      source: 'seerr:req-f', expectedAt: AIR, deferReason: 'future-not-released',
    });
    // The scheduler parks the poll at the window open.
    await first.scheduler().tickOnce();
    const parked = first.store.findByIdentity({ mediaId: 'ttFuture', season: 2, episode: 4 });
    assert.equal(parked.next_check_at, AIR - 3 * DAY, 'poll parked at the prepare window');
  } finally {
    first.cache.close();
  }

  const second = openStores(dir, () => now);
  t.after(() => second.cache.close());
  const row = second.store.findByIdentity({ mediaId: 'ttFuture', season: 2, episode: 4 });
  assert.equal(row.next_check_at, AIR - 3 * DAY, 'the parked poll survives restart');

  // Before the window: nothing happens. At the window: preparation is due.
  now = BASE + 6 * DAY;
  const early = await second.scheduler().tickOnce();
  assert.equal(early.acted, false, 'still waiting after restart');
  const httpCalls = [];
  now = AIR - 3 * DAY + 1;
  const due = await second.scheduler({ httpCalls }).tickOnce();
  assert.equal(due.intentId, row.id, 'the window wakes the row after restart');
  assert.ok(httpCalls.some((u) => u.includes('/api/media-prepare')), 'preparation attempted');
});

test('R4 — the release wake survives restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let first = openStores(dir);
  let id;
  try {
    const { intent } = first.store.seed({
      mediaType: 'series', mediaId: 'ttWake', season: 1, episode: 8,
      source: 'seerr:req-w', expectedAt: BASE - 1, deferReason: 'future-not-released',
    });
    id = intent.id;
    first.store.transition(intent.id, 'failed', { last_error: 'prepare-http-200', next_check_at: BASE + 30 * DAY });
    first.cache.db.prepare('UPDATE future_intents SET attempts = ? WHERE id = ?').run(MAX_ATTEMPTS, intent.id);
  } finally {
    first.cache.close();
  }

  const second = openStores(dir);
  t.after(() => second.cache.close());
  const httpCalls = [];
  const r = await second.scheduler({ httpCalls }).tickOnce();
  assert.equal(r.intentId, id, 'the released-wake row is selected after restart');
  const row = second.store.findByIdentity({ mediaId: 'ttWake', season: 1, episode: 8 });
  assert.equal(row.defer_reason, 'released-no-candidate', 'pre-release classification cleared');
  assert.equal(row.state, 'anticipated', 'one further attempt granted after restart');
});

test('R5 — pending publication survives restart and repairs presentation only', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let first = openStores(dir);
  const TF = 'tf_durable_1';
  try {
    const { intent } = first.store.seed({
      mediaType: 'series', mediaId: 'ttPub', season: 1, episode: 9,
      source: 'seerr:req-p', expectedAt: BASE - DAY, deferReason: 'released-no-candidate',
    });
    first.store.transition(intent.id, 'published_preparing', {
      torrent_file_id: TF,
      last_error: 'consumer-publication-unconfirmed',
      next_check_at: BASE + 60 * 60 * 1000,
    });
  } finally {
    first.cache.close();
  }

  // Restart and re-open the same durable truth.
  const second = openStores(dir, () => BASE + 60 * 60 * 1000 + 1);
  t.after(() => second.cache.close());
  const row = second.store.findByIdentity({ mediaId: 'ttPub', season: 1, episode: 9 });
  assert.equal(row.state, 'published_preparing', 'pending publication survives restart');
  assert.equal(row.torrent_file_id, TF, 'the authoritative TorrentFile pointer survives');

  // The retry repair path: quality probe (prepare endpoint, reuse-shaped) and
  // an idempotent republish that reports the SAME TorrentFile. Presentation is
  // repaired; representation is never chosen again here.
  const vfsCache = createDiscoveryCache({ dbPath: join(dir, 'discovery.db') });
  t.after(() => vfsCache.close());
  const httpCalls = [];
  const sched = schedulerFor(second.store, () => BASE + 60 * 60 * 1000 + 1, {
    fetchFn: async (url) => {
      httpCalls.push(url);
      if (url.includes('/api/media-prepare')) {
        return {
          status: 200,
          text: async () => JSON.stringify({
            prepared: true,
            handoff: { torrentFileId: TF },
            selection: { selected: { infoHash: 'f'.repeat(40), fileIndex: null } },
            results: [{ infoHash: 'f'.repeat(40), fileIndex: null, release: { source: 'WEB-DL' } }],
          }),
        };
      }
      // Republish reuses the exact prepared truth: same TorrentFile, already
      // fulfilled so no consumer confirmation is outstanding.
      return {
        status: 200,
        text: async () => JSON.stringify({
          handoff: { torrentFileId: TF }, reuseMode: 'republish', fulfilled: true,
        }),
      };
    },
    cache: vfsCache,
    confirmConsumerPublicationFn: async () => ({ visible: true, mediaPart: { id: '1', file: '/vfs/x.mkv', size: 100 } }),
    dataPlaneBaseUrl: null,
  });
  const r = await sched.tickOnce();
  const after = second.store.findByIdentity({ mediaId: 'ttPub', season: 1, episode: 9 });

  assert.equal(after.torrent_file_id, TF,
    'the exact TorrentFile survives the repair; representation is never re-chosen');
  assert.ok(after.state === 'published_preparing' || after.state === 'playable',
    `repair keeps the publication owned, got ${after.state}`);
  assert.equal(httpCalls.filter((u) => u.includes('/api/media-prepare')).length, 1,
    'exactly one bounded quality probe per retry');
  assert.equal(httpCalls.filter((u) => u.includes('/api/media-request')).length, 1,
    'exactly one idempotent republish per retry');
  void r;
});
