/**
 * Idle enrichment worker: targets, gates, hygiene, dedupe, backoff —
 * all against real in-memory stores with stubbed source discovery
 * (no network, no providers).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createDownloadStore } from '../src/lib/download/store.js';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';
import { createIdleEnrichment } from '../src/lib/discovery/idle-enrichment.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

function stores() {
  const cache = createDiscoveryCache({ db: new DatabaseSync(':memory:') });
  const cps = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  const dl = createDownloadStore({ db: cps.db });
  const intents = createFutureIntentStore({ db: cache.db });
  return { cache, cps, dl, intents };
}

function worker(stores, overrides = {}) {
  return createIdleEnrichment({
    cache: stores.cache,
    controlPlaneStore: stores.cps,
    downloadStore: stores.dl,
    futureIntentStore: stores.intents,
    measureLag: async () => 1,
    now: () => 1_000_000,
    env: {},
    ...overrides,
  });
}

const rel = (overrides = {}) => ({
  infoHash: HASH_A, fileIndex: null, filename: 'Harbor.Lights.S01E01.1080p.WEB-DL.mkv',
  title: 'Harbor Lights', year: 2024, season: 1, episode: 1, resolution: '1080p',
  source: 'WEB-DL', confidence: 0.8, exactFileSize: 123456789, _source: 'torrentio',
  ...overrides,
});

test('targets: future intent outranks recent request outranks thin library', () => {
  const s = stores();
  s.intents.seed({ mediaType: 'episode', mediaId: 'tt-intent', season: 1, episode: 2 });
  s.cache.db.prepare(`INSERT INTO media_requests (media_id, media_type, season, episode, source, status, candidate_count, created_at)
    VALUES ('tt-req', 'movie', NULL, NULL, 'seerr', 'done', 3, 999000)`).run();
  s.cps.ensureLibraryItem({ mediaType: 'movie', mediaId: 'tt-thin', title: 'Thin', desiredState: 'present' });
  const w = worker(s);
  const targets = w.buildTargets(20);
  const classes = targets.map((t) => t.class);
  assert.ok(classes.includes('future-intent'));
  assert.ok(classes.includes('recent-request'));
  assert.ok(classes.includes('thin-diversity'));
  assert.ok(classes.indexOf('future-intent') < classes.indexOf('recent-request'));
  assert.ok(classes.indexOf('recent-request') < classes.indexOf('thin-diversity'));
});

test('targets: system self-traffic never steers enrichment; humans do', () => {
  const s = stores();
  for (const [id, source] of [['tt-api', 'api'], ['tt-ant', 'anticipation'], ['tt-prep', 'prepare'], ['tt-test', 'test']]) {
    s.cache.db.prepare(`INSERT INTO media_requests (media_id, media_type, season, episode, source, status, candidate_count, created_at)
      VALUES (?, 'movie', NULL, NULL, ?, 'done', 1, 999000)`).run(id, source);
  }
  s.cache.db.prepare(`INSERT INTO media_requests (media_id, media_type, season, episode, source, status, candidate_count, created_at)
    VALUES ('tt-human', 'movie', NULL, NULL, 'seerr', 'done', 1, 999000)`).run();
  const w = worker(s);
  const ids = w.buildTargets(20).map((t) => t.mediaId);
  assert.ok(ids.includes('tt-human'));
  for (const sys of ['tt-api', 'tt-ant', 'tt-prep', 'tt-test']) {
    assert.ok(!ids.includes(sys), `${sys} must not steer enrichment`);
  }
});

test('targets: generic scavenging classes are gone', () => {
  const s = stores();
  // Published but mid-diversity (5): formerly sparse-coverage, now no target.
  s.cps.ensureLibraryItem({ mediaType: 'movie', mediaId: 'tt-mid', title: 'Mid', desiredState: 'present' });
  for (let i = 0; i < 5; i++) {
    const h = `m${i}`.repeat(10).slice(0, 40);
    s.cache.ingestCandidate({ infoHash: h, fileIndex: null, title: 'Mid' });
    s.cache.associateMedia(h, null, 'tt-mid', { source: 'test' });
  }
  // Published, rich, below any terminal: formerly below-terminal, now no target.
  s.cps.ensureLibraryItem({ mediaType: 'movie', mediaId: 'tt-rich-cold', title: 'RichCold', desiredState: 'present' });
  for (let i = 0; i < 12; i++) {
    const h = `c${i}`.repeat(10).slice(0, 40);
    s.cache.ingestCandidate({ infoHash: h, fileIndex: null, title: 'RichCold' });
    s.cache.associateMedia(h, null, 'tt-rich-cold', { source: 'test' });
  }
  const w = worker(s);
  const classes = w.buildTargets(20).map((t) => t.class);
  assert.ok(!classes.includes('sparse-coverage'));
  assert.ok(!classes.includes('below-terminal'));
});

test('targets: future intents sort soonest-expected, thinnest first', () => {
  const s = stores();
  s.intents.seed({ mediaType: 'movie', mediaId: 'tt-late', expectedAt: 9_000_000 });
  s.intents.seed({ mediaType: 'movie', mediaId: 'tt-soon', expectedAt: 1_100_000 });
  s.intents.seed({ mediaType: 'movie', mediaId: 'tt-undated' });
  const w = worker(s);
  const ids = w.buildTargets(20).filter((t) => t.class === 'future-intent').map((t) => t.mediaId);
  assert.deepEqual(ids, ['tt-soon', 'tt-late', 'tt-undated']);
});

test('gate: download work, recent requests, lag, busy hints, corpus all defer', async () => {
  const s = stores();
  const w = worker(s);
  // Quiet baseline: empty state is quiet.
  assert.equal((await w.isQuiet()).quiet, true);
  // Download work pending defers.
  const { download } = s.dl.request({ mediaId: 'tt-x', mediaType: 'movie' });
  void download;
  assert.ok((await w.isQuiet()).reasons.includes('download-work-pending'));
  // Recent foreground request defers (even with no download work).
  const s2 = stores();
  s2.cache.db.prepare(`INSERT INTO media_requests (media_id, media_type, season, episode, status, candidate_count, created_at)
    VALUES ('tt-new', 'movie', NULL, NULL, 'done', 1, 999999)`).run();
  const w2 = worker(s2);
  assert.ok((await w2.isQuiet()).reasons.includes('recent-foreground-request'));
  // Lag + busy hints + corpus defer.
  const w3 = worker(s, { measureLag: async () => 9999 });
  assert.ok((await w3.isQuiet()).reasons.some((r) => r.startsWith('event-loop-lag')));
  const w4 = worker(s, { busyHints: () => ({ anticipation: true }) });
  assert.ok((await w4.isQuiet()).reasons.includes('worker-busy:anticipation'));
  const w5 = worker(s, { isCorpusBusy: async () => true });
  assert.ok((await w5.isQuiet()).reasons.includes('corpus-bootstrap-busy'));
  // Background machinery rows (upgrade/anticipation/prepare) are not
  // foreground activity: the upgrade evaluator persisting prepare rows
  // must not defer enrichment forever.
  const s3 = stores();
  s3.cache.db.prepare(`INSERT INTO media_requests (media_id, media_type, season, episode, source, source_type, status, candidate_count, created_at)
    VALUES ('tt-bg', 'movie', NULL, NULL, 'upgrade-watch', 'upgrade-watch-prepare', 'done', 1, 999999)`).run();
  const w6 = worker(s3);
  assert.equal((await w6.isQuiet()).quiet, true);
});

test('tick: quiet run persists via normal path; duplicate refreshes', async () => {
  const s = stores();
  s.intents.seed({ mediaType: 'episode', mediaId: 'tt-enr', season: 1, episode: 1 });
  const discoverFn = async () => ({
    releases: [rel()],
    sources: { torrentio: { count: 1, error: null } },
  });
  const w = worker(s, { discoverFn, getMediaById: async () => ({ title: 'Harbor Lights', year: 2024 }) });
  const r1 = await w.tickOnce();
  assert.equal(r1.acted, true);
  assert.equal(r1.added, 1);
  const assoc = s.cache.db.prepare('SELECT * FROM candidate_media WHERE media_id = ?').all('tt-enr');
  assert.equal(assoc.length, 1);
  assert.equal(assoc[0].source, 'idle-enrichment');
  const cand = s.cache.db.prepare('SELECT * FROM candidates WHERE info_hash = ?').get(HASH_A);
  assert.ok(cand);
  // Second tick with the same hash refreshes instead of duplicating.
  const w2 = worker(s, { discoverFn, getMediaById: async () => ({ title: 'Harbor Lights', year: 2024 }) });
  // Silence the recent-request gate: no requests exist; quiet holds.
  const r2 = await w2.tickOnce();
  assert.equal(r2.acted, true);
  assert.equal(r2.added, 0);
  assert.equal(r2.refreshed, 1);
  const rows = s.cache.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE info_hash = ?').get(HASH_A);
  assert.equal(rows.n, 1);
  const st = w2.getStatus();
  assert.equal(st.newHashes, 0);
  assert.equal(st.refreshed, 1);
});

test('hygiene: wrong episode/show, year mismatch, low confidence rejected', () => {
  const s = stores();
  const w = worker(s);
  const ep = { mediaType: 'episode', mediaId: 'tt-e', season: 1, episode: 2, title: 'Harbor Lights', year: 2024 };
  const epRel = (o = {}) => rel({ filename: 'Harbor.Lights.S01E02.1080p.WEB-DL.mkv', title: 'Harbor Lights', season: 1, episode: 2, ...o });
  assert.equal(w.acceptRelease(ep, epRel()).accept, true);
  assert.equal(w.acceptRelease(ep, epRel({ season: 1, episode: 3, filename: 'Harbor.Lights.S01E03.1080p.WEB-DL.mkv' })).reason, 'wrong-episode');
  assert.equal(w.acceptRelease(ep, epRel({ confidence: 0.1 })).reason, 'low-confidence');
  // Right numbers, wrong show: title agreement refuses.
  assert.equal(w.acceptRelease(ep, {
    ...epRel(), filename: 'Portside.S01E02.1080p.WEB-DL.mkv', title: 'Portside',
  }).reason, 'title-mismatch');
  const mv = { mediaType: 'movie', mediaId: 'tt-m', title: 'Harbor Lights', year: 2024 };
  const mvRel = (o = {}) => rel({ filename: 'Harbor.Lights.2024.1080p.BluRay.mkv', title: 'Harbor Lights', season: null, episode: null, ...o });
  assert.equal(w.acceptRelease(mv, mvRel()).accept, true);
  assert.equal(w.acceptRelease(mv, mvRel({ year: 1990 })).reason, 'year-mismatch');
  assert.equal(w.acceptRelease({ mediaType: 'movie', mediaId: 'tt-m', title: 'Harbor Lights' }, mvRel({ year: null, confidence: 0.5 })).reason, 'low-confidence');
  // Garbage one-token resolution with no corpus consensus: refuse blind.
  const g = worker(stores());
  assert.equal(g.acceptRelease(
    { mediaType: 'movie', mediaId: 'tt-g', title: 'Mogul', year: 1965 },
    { infoHash: HASH_B, filename: 'Mini-Mogul.HDTV.mkv', title: 'Mini-Mogul', confidence: 0.9 },
  ).reason, 'no-reference-title');
});

test('hygiene: existing consensus anchors agreement without resolved title', () => {
  const s = stores();
  s.cache.ingestCandidate({ infoHash: HASH_A, fileIndex: null, title: 'Harbor Lights' });
  s.cache.associateMedia(HASH_A, null, 'tt-c', { source: 'test' });
  const w = worker(s);
  // No resolved title at all — consensus ("Harbor Lights") carries it.
  const ok = w.acceptRelease(
    { mediaType: 'movie', mediaId: 'tt-c', title: null, year: null },
    { infoHash: HASH_B, filename: 'Harbor.Lights.2024.720p.WEB-DL.mkv', title: 'Harbor Lights', year: 2024, confidence: 0.7 },
  );
  assert.equal(ok.accept, true);
});

test('backoff: all-sources failure defers next tick; partial failure proceeds', async () => {
  const s = stores();
  s.intents.seed({ mediaType: 'movie', mediaId: 'tt-bo' });
  let calls = 0;
  const failing = async () => {
    calls += 1;
    return { releases: [], sources: { torrentio: { count: 0, error: 'boom' }, torznab: { count: 0, error: 'boom' } } };
  };
  const w = worker(s, { discoverFn: failing });
  const r1 = await w.tickOnce();
  assert.equal(r1.acted, true);
  assert.equal(calls, 1);
  const r2 = await w.tickOnce();
  assert.equal(r2.acted, false);
  assert.equal(r2.reason, 'sources-backed-off');
  assert.equal(calls, 1);
  // Partial failure (one healthy source) still queries.
  const s2 = stores();
  s2.intents.seed({ mediaType: 'movie', mediaId: 'tt-bo2' });
  let calls2 = 0;
  const partial = async () => {
    calls2 += 1;
    return {
      releases: calls2 === 1 ? [] : [rel({ infoHash: HASH_B, season: null, episode: null, year: null, confidence: 0.7 })],
      sources: calls2 === 1
        ? { torrentio: { count: 0, error: 'boom' }, torznab: { count: 0, error: null } }
        : { torrentio: { count: 1, error: null }, torznab: { count: 0, error: null } },
    };
  };
  const w3 = worker(s2, { discoverFn: partial, getMediaById: async () => ({ title: 'Harbor Lights', year: null }) });
  await w3.tickOnce();
  const r3 = await w3.tickOnce();
  assert.equal(calls2, 2);
  assert.equal(r3.added, 1);
});

test('sufficiency + daily cap + status shape', async () => {
  const s = stores();
  s.intents.seed({ mediaType: 'movie', mediaId: 'tt-diverse' });
  for (let i = 0; i < 8; i++) {
    s.cache.ingestCandidate({ infoHash: `d${i}`.repeat(10).slice(0, 40), fileIndex: null, title: 'X' });
    s.cache.associateMedia(`d${i}`.repeat(10).slice(0, 40), null, 'tt-diverse', { source: 'test' });
  }
  const w = worker(s, { discoverFn: async () => { throw new Error('must not be called'); } });
  const r = await w.tickOnce();
  assert.equal(r.reason, 'sufficient-diversity');
  const sCap = stores();
  sCap.intents.seed({ mediaType: 'movie', mediaId: 'tt-cap' });
  const w2 = worker(sCap, { env: { ENRICHMENT_DAILY_CAP: 1 }, discoverFn: async () => ({ releases: [], sources: {} }) });
  await w2.tickOnce();
  const capped = await w2.tickOnce();
  assert.equal(capped.reason, 'daily-cap');
  const st = w2.getStatus();
  assert.ok(st.lastTickAt != null && typeof st.intervalMin === 'number');
});

test('sufficiency is per-target: rich show does not starve thin intent', async () => {
  const s = stores();
  s.intents.seed({ mediaType: 'episode', mediaId: 'tt-rich', season: 9, episode: 9 });
  for (let i = 0; i < 30; i++) {
    const h = `r${i}`.repeat(10).slice(0, 40);
    s.cache.ingestCandidate({ infoHash: h, fileIndex: null, title: 'R' });
    s.cache.associateMedia(h, null, 'tt-rich', { source: 'test' });
  }
  s.intents.seed({ mediaType: 'movie', mediaId: 'tt-thin-target' });
  const seen = [];
  const discoverFn = async (mediaId) => {
    seen.push(mediaId);
    return { releases: [], sources: {} };
  };
  const w = worker(s, { discoverFn });
  const r = await w.tickOnce();
  assert.equal(r.acted, true);
  // Unpublished episode has zero coverage by definition: picked first.
  assert.equal(seen[0], 'tt-rich');
  // Once that episode is published (media-level count now governs and is
  // sufficient), the thin movie behind it gets its turn.
  s.cps.ensureLibraryItem({ mediaType: 'episode', mediaId: 'tt-rich', title: 'R', season: 9, episode: 9, desiredState: 'present' });
  const r2 = await w.tickOnce();
  assert.equal(r2.acted, true);
  assert.equal(seen[1], 'tt-thin-target');
});

test('hygiene: published truth outranks polluted consensus', () => {
  const s = stores();
  // Polluted consensus: a wrong show associated at full confidence.
  s.cache.ingestCandidate({ infoHash: HASH_A, fileIndex: null, title: 'Portside' });
  s.cache.associateMedia(HASH_A, null, 'tt-pub', { source: 'test' });
  // Household-verified truth: published S01E01 binding.
  s.cps.ensureLibraryItem({ mediaType: 'episode', mediaId: 'tt-pub', title: 'Harbor Lights', season: 1, episode: 1, desiredState: 'present' });
  s.cps.db.prepare(`INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES ('tf-pub', ?, 'Harbor.Lights.S01E01.1080p.mkv', 100, 1)`).run('e'.repeat(40));
  s.cache.createVfsTvEntry({
    mediaId: 'tt-pub', season: 1, episode: 1, releaseKey: `${'e'.repeat(40)}:torrent`,
    infoHash: 'e'.repeat(40), fileIndex: null, canonicalPath: 'TV/Harbor/S01E01.mkv',
    torrentFileId: 'tf-pub', size: 100, createdAt: 1, updatedAt: 1,
  });
  s.cache.db.prepare(`INSERT INTO playback_handoffs
    (media_id, media_type, season, episode, release_key, info_hash, filename, torrent_file_id, selected_at)
    VALUES ('tt-pub', 'series', 1, 1, ?, ?, 'Harbor.Lights.S01E01.1080p.mkv', 'tf-pub', 1)`)
    .run(`${'e'.repeat(40)}:torrent`, 'e'.repeat(40));
  const w = worker(s);
  // Future episode: wrong-show row refused via published truth.
  const bad = w.acceptRelease(
    { mediaType: 'episode', mediaId: 'tt-pub', season: 1, episode: 2, title: 'Mogul', year: 1965 },
    { infoHash: HASH_B, filename: 'Portside.S01E02.1080p.mkv', title: 'Portside', season: 1, episode: 2, confidence: 0.9 },
  );
  assert.equal(bad.reason, 'title-mismatch');
  // Right show accepted.
  const good = w.acceptRelease(
    { mediaType: 'episode', mediaId: 'tt-pub', season: 1, episode: 2, title: 'Mogul', year: 1965 },
    { infoHash: HASH_B, filename: 'Harbor.Lights.S01E02.1080p.mkv', title: 'Harbor Lights', season: 1, episode: 2, confidence: 0.9 },
  );
  assert.equal(good.accept, true);
});

test('zero-yield targets back off for 24h so thinner targets rotate', async () => {
  const s = stores();
  s.intents.seed({ mediaType: 'movie', mediaId: 'tt-dead' });
  s.intents.seed({ mediaType: 'movie', mediaId: 'tt-live' });
  const seen = [];
  const discoverFn = async (mediaId) => {
    seen.push(mediaId);
    if (mediaId === 'tt-live') {
      return { releases: [{
        infoHash: HASH_B, fileIndex: null, filename: 'Live.Movie.2024.1080p.BluRay.mkv',
        title: 'Live Movie', year: 2024, confidence: 0.8, exactFileSize: 999, _source: 'torrentio',
      }], sources: {} };
    }
    return { releases: [], sources: {} };
  };
  const w = worker(s, { discoverFn, getMediaById: async () => ({ title: 'Live Movie', year: 2024 }) });
  // tt-dead yields nothing 3 times; on the 4th tick it is skipped and the
  // live target behind it gets its turn and persists.
  await w.tickOnce();
  await w.tickOnce();
  await w.tickOnce();
  assert.deepEqual(seen, ['tt-dead', 'tt-dead', 'tt-dead']);
  const r = await w.tickOnce();
  assert.equal(r.acted, true);
  assert.equal(seen[3], 'tt-live');
  assert.equal(r.added, 1);
});
