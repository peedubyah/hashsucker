/**
 * Anticipation policy hardening tranche — focused proof.
 *
 *  1. envNumber: absent/empty/whitespace/valid/explicit-zero/invalid
 *  2. Movie vs TV staging windows + reason states
 *  3. Quality gate: CAM/TS/TC/SCR rejection, WEB/BluRay eligibility,
 *     unknown caution, group-suffix safety, no size inference
 *  4. Scheduler: garbage parks alive, reuse-blind probes the market,
 *     publish gated, upgrade CAM→WEB, horizon scoping preserves catalog
 *  5. Arr: series descriptors use the tighter TV window
 *
 * Run:
 *   node --test test/anticipation-policy.test.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { envNumber } from '../src/lib/config/env.js';
import { createFutureIntentStore, INTENT_STATES } from '../src/lib/anticipation/future-intents.js';
import { createAnticipationScheduler } from '../src/lib/anticipation/scheduler.js';
import { judgeReleaseQuality, ANTICIPATION_QUALITY } from '../src/lib/anticipation/quality-gate.js';
import { applyDescriptors } from '../src/lib/anticipation/arr-sync.js';

const DAY = 86400 * 1000;
const NOW = 1_800_000_000_000;

function memStore() {
  return createFutureIntentStore({ db: new DatabaseSync(':memory:') });
}

// ---------------------------------------------------------------------------
// 1. envNumber
// ---------------------------------------------------------------------------

test('envNumber: absent/null/undefined → fallback', () => {
  assert.equal(envNumber({}, 'X', { fallback: 30, min: 0 }), 30);
  assert.equal(envNumber({ X: null }, 'X', { fallback: 30, min: 0 }), 30);
  assert.equal(envNumber({ X: undefined }, 'X', { fallback: 30, min: 0 }), 30);
  assert.equal(envNumber(null, 'X', { fallback: 7, min: 0 }), 7);
});

test('envNumber: empty/whitespace → fallback (the compose bug)', () => {
  assert.equal(envNumber({ X: '' }, 'X', { fallback: 30, min: 0 }), 30);
  assert.equal(envNumber({ X: '   ' }, 'X', { fallback: 30, min: 0 }), 30);
  assert.equal(envNumber({ X: '\t\n' }, 'X', { fallback: 15, min: 1 }), 15);
});

test('envNumber: valid integers pass through', () => {
  assert.equal(envNumber({ X: '45' }, 'X', { fallback: 30, min: 0 }), 45);
  assert.equal(envNumber({ X: ' 45 ' }, 'X', { fallback: 30, min: 0 }), 45);
  assert.equal(envNumber({ X: 14 }, 'X', { fallback: 30, min: 0 }), 14);
  assert.equal(envNumber({ X: '1.5' }, 'X', { fallback: 6, min: 0.5 }), 1.5);
});

test('envNumber: explicit zero survives only where supported', () => {
  assert.equal(envNumber({ X: '0' }, 'X', { fallback: 30, min: 0 }), 0);
  assert.equal(envNumber({ X: '0' }, 'X', { fallback: 15, min: 1 }), 15);
});

test('envNumber: invalid/below-min → fallback', () => {
  assert.equal(envNumber({ X: 'soon' }, 'X', { fallback: 30, min: 0 }), 30);
  assert.equal(envNumber({ X: 'NaN' }, 'X', { fallback: 30, min: 0 }), 30);
  assert.equal(envNumber({ X: 'Infinity' }, 'X', { fallback: 30, min: 0 }), 30);
  assert.equal(envNumber({ X: '-5' }, 'X', { fallback: 30, min: 0 }), 30);
  assert.equal(envNumber({ X: '0.25' }, 'X', { fallback: 6, min: 0.5 }), 6);
});

// ---------------------------------------------------------------------------
// 2. Movie vs TV windows
// ---------------------------------------------------------------------------

function windowScheduler(store, fetchFn) {
  return createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d',
    fetchFn: fetchFn ?? (async () => { throw new Error('must not call network'); }),
    clock: () => NOW, log: () => {},
    prepareDays: 30, publishDays: 7, tvPrepareDays: 3, tvPublishDays: 1,
  });
}

test('windows: movie parks at -30d with reason, TV at -3d', async () => {
  const store = memStore();
  store.seed({ mediaType: 'movie', mediaId: 'ttM', expectedAt: NOW + 60 * DAY });
  store.seed({ mediaType: 'series', mediaId: 'ttS', season: 1, episode: 2, expectedAt: NOW + 60 * DAY });
  const sched = windowScheduler(store);
  const rows = store.list({});
  for (const row of rows) {
    const r = await sched.processIntent({ ...row });
    assert.equal(r.to, 'anticipated');
  }
  const movie = store.findByIdentity({ mediaId: 'ttM' });
  const ep = store.findByIdentity({ mediaId: 'ttS', season: 1, episode: 2 });
  assert.equal(movie.next_check_at, NOW + 60 * DAY - 30 * DAY);
  assert.equal(movie.last_error, 'outside-prepare-window');
  assert.equal(ep.next_check_at, NOW + 60 * DAY - 3 * DAY);
  assert.equal(ep.last_error, 'outside-prepare-window');
});

test('windows: publish sleep uses 7d movie / 1d TV with reason', async () => {
  const store = memStore();
  const m = store.seed({ mediaType: 'movie', mediaId: 'ttM', expectedAt: NOW + 60 * DAY });
  const s = store.seed({ mediaType: 'series', mediaId: 'ttS', season: 1, episode: 1, expectedAt: NOW + 60 * DAY });
  store.transition(m.intent.id, 'prepared', { torrent_file_id: 'tf_m', next_check_at: 0 });
  store.transition(s.intent.id, 'prepared', { torrent_file_id: 'tf_s', next_check_at: 0 });
  const sched = windowScheduler(store);
  // Quality horizon covers these (expected future) — but the publish
  // WINDOW check runs before any probe, so no network may occur.
  for (const row of store.list({})) {
    await sched.processIntent({ ...row });
  }
  const movie = store.findByIdentity({ mediaId: 'ttM' });
  const ep = store.findByIdentity({ mediaId: 'ttS', season: 1, episode: 1 });
  assert.equal(movie.next_check_at, NOW + 60 * DAY - 7 * DAY);
  assert.equal(movie.last_error, 'outside-publish-window');
  assert.equal(ep.next_check_at, NOW + 60 * DAY - 1 * DAY);
  assert.equal(ep.last_error, 'outside-publish-window');
});

// ---------------------------------------------------------------------------
// 3. Quality gate matrix
// ---------------------------------------------------------------------------

test('quality: theatrical captures are garbage', () => {
  const bad = [
    'Doomsday.2026.CAM.x264-GROUP',
    'Doomsday.2026.HD-CAM.x264-GROUP',
    'Doomsday.2026.HDCAM.x264-GROUP',
    'Doomsday.2026.TS.x264-GROUP',
    'Doomsday.2026.HDTS.x264-GROUP',
    'Doomsday.2026.HD-TS.x264-GROUP',
    'Doomsday.2026.TELESYNC.x264-GROUP',
    'Doomsday.2026.TC.DD5.1.x264-GROUP',
    'Doomsday.2026.HDTC.x264-GROUP',
    'Doomsday.2026.TELECINE.x264-GROUP',
    'Doomsday.2026.SCR.x264-GROUP',
    'Doomsday.2026.DVDSCR.x264-GROUP',
    'Doomsday.2026.DVD-SCR.XviD-GROUP',
    'Doomsday.2026.SCREENER.MP4-GROUP',
  ];
  for (const filename of bad) {
    assert.equal(judgeReleaseQuality({ filename }), ANTICIPATION_QUALITY.GARBAGE, filename);
  }
});

test('quality: home-quality classes are acceptable', () => {
  const good = [
    ['Doomsday.2026.1080p.WEB-DL.DDP5.1-GROUP', 'WEB-DL'],
    ['Doomsday.2026.2160p.WEB-DL.HDR-GROUP', 'WEB-DL'],
    ['Doomsday.2026.720p.WEBRip.x264-GROUP', 'WEBRip'],
    ['Doomsday.2026.1080p.BluRay.x264-GROUP', 'BluRay'],
    ['Doomsday.2026.1080p.Blu-ray.REMUX-GROUP', 'Remux'],
    ['Doomsday.2026.1080p.BDRip.x264-GROUP', 'BDRip'],
    ['Show.S01E01.1080p.HDTV.x264-GROUP', 'HDTV'],
    ['Show.S01E01.720p.WEB.x264-GROUP', 'WEB'],
  ];
  for (const [filename, sourceType] of good) {
    assert.equal(judgeReleaseQuality({ filename, sourceType }), ANTICIPATION_QUALITY.ACCEPTABLE, filename);
  }
  // Parser vocabulary forms (quality-features + parser-adapter).
  assert.equal(judgeReleaseQuality({ filename: 'x', sourceType: 'web-dl' }), 'acceptable');
  assert.equal(judgeReleaseQuality({ filename: 'x', sourceType: 'WEB-DL' }), 'acceptable');
  assert.equal(judgeReleaseQuality({ filename: 'x', sourceType: 'bluray' }), 'acceptable');
  assert.equal(judgeReleaseQuality({ filename: 'x', sourceType: 'Remux' }), 'acceptable');
});

test('quality: unknown stays unknown, group suffix never condemns', () => {
  assert.equal(judgeReleaseQuality({ filename: 'Мстители.Судный.День.2026.WEB.1080p' }), 'acceptable');
  assert.equal(judgeReleaseQuality({ filename: 'Some.Movie.2026.1080p-GROUP' }), 'unknown');
  assert.equal(judgeReleaseQuality({ filename: null, sourceType: null }), 'unknown');
  assert.equal(judgeReleaseQuality({}), 'unknown');
  // A release GROUP named TC must not condemn a clean WEB-DL.
  assert.equal(
    judgeReleaseQuality({ filename: 'Doomsday.2026.1080p.WEB-DL.DDP5.1.H.264-TC', sourceType: 'WEB-DL' }),
    'acceptable',
  );
  // DTS audio must not read as TS.
  assert.equal(
    judgeReleaseQuality({ filename: 'Doomsday.2026.1080p.BluRay.DTS.x264-GROUP', sourceType: 'BluRay' }),
    'acceptable',
  );
  // Container .ts extension must not read as telesync.
  assert.equal(judgeReleaseQuality({ filename: 'Episode.S01E01.1080p.HDTV.ts' }), 'acceptable');
});

test('quality: size never influences the verdict', () => {
  // Filenames carry no size; the judge signature has no size input by
  // construction — a tiny CAM and a huge CAM judge identically.
  assert.equal(judgeReleaseQuality({ filename: 'M.2026.CAM.x264-G' }), 'garbage');
  assert.equal(judgeReleaseQuality({ filename: 'M.2026.2160p.WEB-DL-G' }), 'acceptable');
});

// ---------------------------------------------------------------------------
// 4. Scheduler quality flow
// ---------------------------------------------------------------------------

function prepareResponse({ winner = null, alreadyPrepared = false, tf = 'tf_w1' } = {}) {
  const results = winner
    ? [{ infoHash: 'aabbcc', fileIndex: 0, filename: winner.filename, release: { source: winner.source ?? null } }]
    : [];
  return {
    status: 200,
    text: async () => JSON.stringify({
      prepared: true,
      alreadyPrepared: alreadyPrepared || undefined,
      handoff: { torrentFileId: tf, filename: winner?.filename ?? 'prior.CAM.x264-G' },
      results,
      selection: winner ? { selected: { infoHash: 'aabbcc', fileIndex: 0 }, reason: 'ranked' } : { selected: null, reason: 'already-prepared' },
      total: results.length,
    }),
  };
}

function policyScheduler(store, { prepareWinner = null, probeWinner = null, publishTf = 'tf_w1' } = {}) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ url, persist: body.persist });
    if (url.endsWith('/api/media-prepare')) {
      if (body.persist === false) {
        // Probe: market snapshot, zero writes.
        if (!probeWinner) {
          return { status: 200, text: async () => JSON.stringify({ prepared: false, results: [], selection: { selected: null }, total: 0 }) };
        }
        return {
          status: 200,
          text: async () => JSON.stringify({
            prepared: false,
            results: [{ infoHash: 'ddeeff', fileIndex: 0, filename: probeWinner.filename, release: { source: probeWinner.source ?? null } }],
            selection: { selected: { infoHash: 'ddeeff', fileIndex: 0 }, reason: 'ranked' },
            total: 1,
          }),
        };
      }
      return prepareResponse({ winner: prepareWinner });
    }
    if (url.endsWith('/api/media-request')) {
      return { status: 200, text: async () => JSON.stringify({ handoff: { torrentFileId: publishTf }, reuseMode: 'republish' }) };
    }
    if (url.includes('/files/')) {
      const chunks = [Buffer.from('x'.repeat(70000))];
      let i = 0;
      return {
        status: 206,
        text: async () => '',
        body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }), cancel: async () => {} }) },
      };
    }
    throw new Error('unexpected ' + url);
  };
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d',
    fetchFn, clock: () => NOW, log: () => {},
    checkTorBoxCachedFn: async (hashes) => hashes.map((h) => ({ infoHash: h, state: 'cached' })),
  });
  return { sched, calls };
}

test('scheduler: fresh CAM winner parks alive with reason, keeps truth', async () => {
  const store = memStore();
  store.seed({ mediaType: 'movie', mediaId: 'ttC', expectedAt: NOW + 10 * DAY, source: 'seerr:req-cam' });
  const { sched } = policyScheduler(store, {
    prepareWinner: { filename: 'Doomsday.2026.CAM.x264-GROUP', source: null },
  });
  const r = await sched.tickOnce();
  assert.equal(r.acted, true);
  assert.equal(r.to, 'anticipated', 'parked, not prepared');
  const row = store.findByIdentity({ mediaId: 'ttC' });
  assert.equal(row.state, 'anticipated');
  assert.match(row.last_error ?? '', /waiting-for-acceptable-quality:garbage/);
  assert.ok(row.next_check_at > NOW, 'bounded retry scheduled');
  assert.equal(row.defer_reason, null, 'no deferral clobbered (seed had none)');
  assert.equal(row.source, 'seerr:req-cam', 'provenance preserved');
});

test('scheduler: unknown winner parks cautiously, never publishes blind', async () => {
  const store = memStore();
  store.seed({ mediaType: 'movie', mediaId: 'ttU', expectedAt: NOW + 10 * DAY });
  const { sched } = policyScheduler(store, {
    prepareWinner: { filename: 'Мстители.Судный.День.2026.HD.1080p', source: null },
  });
  const r = await sched.tickOnce();
  assert.equal(r.to, 'anticipated');
  const row = store.findByIdentity({ mediaId: 'ttU' });
  assert.match(row.last_error ?? '', /waiting-for-acceptable-quality:unknown/);
});

test('scheduler: acceptable winner prepares and publishes', async () => {
  const store = memStore();
  // Inside both the 30d prepare and 7d publish movie windows.
  store.seed({ mediaType: 'movie', mediaId: 'ttW', expectedAt: NOW + 3 * DAY });
  const { sched, calls } = policyScheduler(store, {
    prepareWinner: { filename: 'Doomsday.2026.1080p.WEB-DL.DDP5.1-GROUP', source: 'WEB-DL' },
    probeWinner: { filename: 'Doomsday.2026.1080p.WEB-DL.DDP5.1-GROUP', source: 'WEB-DL' },
  });
  const r1 = await sched.tickOnce();
  assert.equal(r1.to, 'prepared');
  // Prepared is due-now; drive the publish tick (probe → publish → probe).
  store.transition(store.findByIdentity({ mediaId: 'ttW' }).id, 'prepared', { torrent_file_id: 'tf_w1', next_check_at: 0 });
  const r2 = await sched.tickOnce();
  assert.equal(r2.to, 'playable');
  assert.ok(calls.some((c) => c.url.endsWith('/api/media-request')), 'publish fired for acceptable winner');
});

test('scheduler: reuse-blind CAM probes the market, upgrades on WEB', async () => {
  const store = memStore();
  store.seed({ mediaType: 'movie', mediaId: 'ttG', expectedAt: NOW + 10 * DAY });
  // Prepare persists a CAM handoff (fresh), parks for quality.
  const cam = { filename: 'Doomsday.2026.HDTS.x264-GROUP', source: null };
  const web = { filename: 'Doomsday.2026.1080p.WEB-DL-GROUP', source: 'WEB-DL' };
  let marketAcceptable = false;
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ url, persist: body.persist });
    if (url.endsWith('/api/media-prepare')) {
      if (body.persist === false) {
        // Probe reflects the live market.
        const w = marketAcceptable ? web : cam;
        return {
          status: 200,
          text: async () => JSON.stringify({
            prepared: false,
            results: [{ infoHash: 'zz', fileIndex: 0, filename: w.filename, release: { source: w.source } }],
            selection: { selected: { infoHash: 'zz', fileIndex: 0 }, reason: 'ranked' },
            total: 1,
          }),
        };
      }
      // Persisting prepare: first fresh (CAM binds), then reuse-blind.
      if (!marketAcceptable) return prepareResponse({ winner: cam });
      return prepareResponse({ winner: null, alreadyPrepared: true, tf: 'tf_cam' });
    }
    if (url.endsWith('/api/media-request')) {
      return { status: 200, text: async () => JSON.stringify({ handoff: { torrentFileId: 'tf_web' } }) };
    }
    if (url.includes('/files/')) return { status: 206, text: async () => '' };
    throw new Error('unexpected ' + url);
  };
  const sched = createAnticipationScheduler({
    store, baseUrl: 'http://t', dataPlaneBaseUrl: 'http://d',
    fetchFn, clock: () => NOW, log: () => {},
    checkTorBoxCachedFn: async (hashes) => hashes.map((h) => ({ infoHash: h, state: 'cached' })),
  });
  // Tick 1: fresh CAM → parked, truth retained.
  const r1 = await sched.tickOnce();
  assert.equal(r1.to, 'anticipated');
  assert.match(store.findByIdentity({ mediaId: 'ttG' }).last_error ?? '', /waiting-for-acceptable-quality/);
  assert.ok(!calls.some((c) => c.url.endsWith('/api/media-request')), 'no publish for CAM');
  // Market upgrades to WEB-DL; force due and tick: reuse-blind prepare
  // must probe (not judge stale CAM) and advance to prepared.
  marketAcceptable = true;
  const row = store.findByIdentity({ mediaId: 'ttG' });
  store.transition(row.id, 'anticipated', { next_check_at: 0 });
  const r2 = await sched.tickOnce();
  assert.equal(r2.to, 'prepared', 'upgrade path: probe saw WEB, prepared');
  assert.ok(calls.some((c) => c.url.endsWith('/api/media-prepare') && c.persist === false), 'probe ran on reuse-blind prepare');
});

test('scheduler: outside the quality horizon catalog bypasses the gate', async () => {
  const store = memStore();
  // Expected 200 days ago: old catalog. CAM winner must NOT park.
  store.seed({ mediaType: 'movie', mediaId: 'ttOld', expectedAt: NOW - 200 * DAY });
  // Undated catalog: same.
  store.seed({ mediaType: 'movie', mediaId: 'ttNod' });
  const { sched } = policyScheduler(store, {
    prepareWinner: { filename: 'Old.Movie.1999.CAM.x264-GROUP', source: null },
  });
  await sched.tickOnce();
  await sched.tickOnce();
  assert.equal(store.findByIdentity({ mediaId: 'ttOld' }).state, 'prepared');
  assert.equal(store.findByIdentity({ mediaId: 'ttNod' }).state, 'prepared');
});

// ---------------------------------------------------------------------------
// 5. Arr series window
// ---------------------------------------------------------------------------

test('arr: series descriptors sleep on the tight TV window', async () => {
  const { createFutureIntentStore: mk } = await import('../src/lib/anticipation/future-intents.js');
  const { DatabaseSync: DB } = await import('node:sqlite');
  const store = mk({ db: new DB(':memory:') });
  const nowMs = NOW;
  const air = NOW + 60 * DAY;
  const { applyDescriptors: apply } = await import('../src/lib/anticipation/arr-sync.js');
  apply(store, [
    { mediaType: 'movie', mediaId: 'ttM', season: null, episode: null, source: 'radarr:movie:1', expectedAt: air, satisfied: false },
    { mediaType: 'series', mediaId: 'ttS', season: 2, episode: 3, source: 'sonarr:9:S02E03', expectedAt: air, satisfied: false },
  ], { prepareDays: 30, tvPrepareDays: 3, nowMs });
  const rows = store.list({});
  const movie = rows.find((r) => r.media_id === 'ttM');
  const ep = rows.find((r) => r.media_id === 'ttS');
  assert.equal(movie.next_check_at, air - 30 * DAY, 'movie keeps the broad horizon');
  assert.equal(ep.next_check_at, air - 3 * DAY, 'episode sleeps on the tight window');
});
