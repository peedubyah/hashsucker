/**
 * Opportunistic deterministic Plex ingest confirmation — additive semantics.
 *
 * The rule under test: a busy Plex section, a scan that never starts, a scan
 * that never completes, and an item that never appears are all *skips*, never
 * publication failures. Only a locally-invalid path is a hard defect. A
 * verified item (ratingKey + Part id + exact file + exact size) is positive
 * confirmation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { INGEST_OUTCOMES, opportunisticIngestConfirm } from '../src/lib/requests/plex-ingest.js';

const ENV = {
  PLEX_URL: 'http://pms.test:32400',
  PLEX_TOKEN: 'tok',
  PLEX_TV_SECTION_ID: '3',
  PLEX_MOVIES_SECTION_ID: '2',
  PLEX_TV_ROOT: '/mnt/hashsucker-vfs/TV',
  PLEX_MOVIES_ROOT: '/mnt/hashsucker-vfs/Movies',
  HASHSUCKER_BASE_URL: 'http://media-search.test:3000',
};

const CANON = 'TV/tt1234567/Season 01/tt1234567 - S01E01.mkv';
const EXPECT_FILE = '/mnt/hashsucker-vfs/TV/tt1234567/Season 01/tt1234567 - S01E01.mkv';

function seams({
  quiet = true,
  vfsStatus = 207,
  findResult = async () => ({ partId: '900', file: EXPECT_FILE, size: 1234, ratingKey: '77' }),
  expectPartFile = EXPECT_FILE,
  expectSize = 1234,
} = {}) {
  return {
    fetchFn: async (url, options = {}) => {
      if (options.method === 'PROPFIND') return { status: vfsStatus };
      if (String(url).endsWith('/activities')) {
        return quiet ? { MediaContainer: { Activity: [] } } : { MediaContainer: { Activity: [{ type: 'library.update.section', uuid: 'busy' }] } };
      }
      return { MediaContainer: { Activity: [] } };
    },
    vfsExistsFn: async () => vfsStatus === 207,
    quietFn: async () => quiet,
    observeFn: async () => (quiet
      ? { started: true, completed: true, uuid: 'scan-uuid-1', elapsedMs: 250 }
      : (() => { throw new Error('should not scan when busy'); })()),
    findResult,
  };
}

/** Builds the argument object AND runs the helper, so call sites read simply. */
const base = (extra = {}) => opportunisticIngestConfirm({
  mediaType: 'series',
  canonicalPath: CANON,
  mediaId: 'tt1234567',
  season: 1,
  episode: 1,
  expectedPartFile: EXPECT_FILE,
  expectedSize: 1234,
  ...seams(),
  env: ENV,
  ...extra,
});

test('a busy Plex section is a skip, never a publication failure', async () => {
  const out = await base({ ...seams({ quiet: false }) });
  assert.equal(out.outcome, INGEST_OUTCOMES.BUSY);
  assert.equal(out.fallbackReason, 'section-scanning');
  assert.equal(out.scanUuid, null);
});

test('a verified item positively confirms and reports identity', async () => {
  const out = await base();
  assert.equal(out.outcome, INGEST_OUTCOMES.VERIFIED, `was ${out.outcome}/${out.fallbackReason}`);
  assert.equal(out.partId, '900');
  assert.equal(out.scanUuid, 'scan-uuid-1');
  assert.equal(out.fileMatch, true);
  assert.equal(out.sizeMatch, true);
});

test('a mismatch on the exact Part path is classed, not collapsed', async () => {
  const out = await base({
    findResult: async () => ({ partId: '900', file: '/wrong/path.mkv', size: 1234, ratingKey: '77' }),
  });
  assert.equal(out.outcome, INGEST_OUTCOMES.UNCONFIRMED);
  assert.equal(out.fallbackReason, 'wrong-part-path');
  assert.equal(out.fileMatch ?? null, false);
});

test('a mismatch on the exact size is classed, not collapsed', async () => {
  const out = await base({
    findResult: async () => ({ partId: '900', file: EXPECT_FILE, size: 999, ratingKey: '77' }),
  });
  assert.equal(out.outcome, INGEST_OUTCOMES.UNCONFIRMED);
  assert.equal(out.fallbackReason, 'wrong-part-size');
});

test('a Part with no size is not-playback-ready, not a mismatch', async () => {
  const out = await base({
    findResult: async () => ({ partId: '900', file: EXPECT_FILE, size: null, ratingKey: '77' }),
  });
  assert.equal(out.outcome, INGEST_OUTCOMES.UNCONFIRMED);
  assert.equal(out.fallbackReason, 'not-playback-ready');
});

test('an item that never appears is unconfirmed, not a failure', async () => {
  const out = await base({ findResult: async () => null });
  assert.equal(out.outcome, INGEST_OUTCOMES.UNCONFIRMED);
  assert.equal(out.fallbackReason, 'item-not-visible');
});

test('a scan that never starts is unconfirmed', async () => {
  const out = await base({
    observeFn: async () => { const e = new Error('never started'); e.code = 'INGEST_SCAN_NOT_STARTED'; throw e; },
  });
  assert.equal(out.outcome, INGEST_OUTCOMES.UNCONFIRMED);
  assert.equal(out.fallbackReason, 'scan-not-started');
});

test('a scan that never completes is unconfirmed', async () => {
  const out = await base({
    observeFn: async () => { const e = new Error('still running'); e.code = 'INGEST_SCAN_NOT_COMPLETED'; throw e; },
  });
  assert.equal(out.outcome, INGEST_OUTCOMES.UNCONFIRMED);
  assert.equal(out.fallbackReason, 'scan-not-completed');
});

test('a second concurrent ingest in the same section refuses as busy', async () => {
  const out = await base({
    observeFn: async () => { const e = new Error('busy'); e.code = 'INGEST_SCAN_BUSY'; throw e; },
  });
  assert.equal(out.outcome, INGEST_OUTCOMES.UNCONFIRMED);
  assert.equal(out.fallbackReason, 'section-scanning');
});

test('an invalid path is a hard defect and is never sent to PMS', async () => {
  let refreshSent = false;
  const out = await base({
    canonicalPath: 'TV/../../etc/Season 01/x.mkv',
    observeFn: async () => { refreshSent = true; return { started: true, completed: true, uuid: 'u' }; },
  });
  assert.equal(out.outcome, INGEST_OUTCOMES.INVALID);
  assert.equal(out.code, 'INGEST_INVALID_PATH');
  assert.equal(refreshSent, false, 'an invalid local path must never reach PMS');
});

test('a VFS directory that does not exist is a hard defect, not sent to PMS', async () => {
  let refreshSent = false;
  const out = await base({
    ...seams({ vfsStatus: 404 }),
    observeFn: async () => { refreshSent = true; return { started: true, completed: true, uuid: 'u' }; },
  });
  assert.equal(out.outcome, INGEST_OUTCOMES.INVALID);
  assert.equal(out.code, 'INGEST_PATH_NOT_FOUND');
  assert.equal(refreshSent, false);
});

test('without Plex configured the helper skips quietly', async () => {
  const out = await base({ env: { ...ENV, PLEX_URL: '', PLEX_TOKEN: '' } });
  assert.equal(out.outcome, INGEST_OUTCOMES.UNCONFIRMED);
  assert.equal(out.fallbackReason, 'plex-unavailable');
});

test('an unreachable VFS is ambiguous, so it skips rather than defects', async () => {
  const out = await base({
    // the outer helper calls vfsDirectoryExists directly; make the transport
    // itself fail so the ambiguity is what is classified
    fetchFn: async () => { throw new Error('connection refused'); },
    vfsExistsFn: async () => { throw new Error('connection refused'); },
    quietFn: async () => { throw new Error('connection refused'); },
  });
  assert.equal(out.outcome, INGEST_OUTCOMES.UNCONFIRMED);
  assert.match(out.fallbackReason, /vfs-check-unavailable/);
});

test('metrics record the section, path, scan timing and verification', async () => {
  const seen = [];
  const out = await base({ onMetric: (m) => seen.push(m) });
  assert.equal(out.outcome, INGEST_OUTCOMES.VERIFIED);
  assert.equal(seen.length, 1);
  const m = seen[0];
  assert.equal(m.sectionId, '3');
  assert.equal(m.seasonPath, '/mnt/hashsucker-vfs/TV/tt1234567/Season 01');
  assert.equal(m.scanUuid, 'scan-uuid-1');
  assert.equal(m.scanMs, 250);
  assert.equal(m.partId, '900');
  assert.equal(m.fileMatch, true);
  assert.equal(m.sizeMatch, true);
  assert.equal(m.mediaId, 'tt1234567');
  assert.equal(m.season, 1);
  assert.equal(m.episode, 1);
  assert.ok(typeof m.elapsedMs === 'number');
});

test('metrics record the busy skip with its reason', async () => {
  const seen = [];
  await base({ ...seams({ quiet: false }), onMetric: (m) => seen.push(m) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outcome, INGEST_OUTCOMES.BUSY);
  assert.equal(seen[0].fallbackReason, 'section-scanning');
});

test('a metric sink that throws cannot break publication', async () => {
  const out = await base({ onMetric: () => { throw new Error('sink broke'); } });
  assert.equal(out.outcome, INGEST_OUTCOMES.VERIFIED);
});

test('different sections are independent, so movies are not blocked by TV', async () => {
  const movieSeams = {
    fetchFn: async () => ({ status: 207, MediaContainer: { Activity: [] } }),
    vfsExistsFn: async () => true,
    quietFn: async () => true,
    observeFn: async () => ({ started: true, completed: true, uuid: 'movie-scan', elapsedMs: 100 }),
  };
  const out = await opportunisticIngestConfirm({
    mediaType: 'movie',
    canonicalPath: 'Movies/Some Film (2020)/Some Film (2020).mkv',
    mediaId: 'tt9999999',
    env: ENV,
    findResult: async () => ({ partId: '1', file: '/mnt/hashsucker-vfs/Movies/x.mkv', size: 5, ratingKey: '9' }),
    ...movieSeams,
  });
  assert.equal(out.outcome, INGEST_OUTCOMES.VERIFIED);
  assert.equal(out.scanUuid, 'movie-scan');
});

test('opportunistic confirms share the process-wide per-section flight', async () => {
  // Two concurrent confirms in the same section must not both observe a scan:
  // path attribution is inferential, so the second must refuse.
  let release;
  const slow = () => new Promise((r) => { release = r; });
  const common = {
    mediaType: 'series', canonicalPath: CANON, mediaId: 'tt1234567', season: 1, episode: 1,
    expectedPartFile: EXPECT_FILE, expectedSize: 1234, env: ENV,
    vfsExistsFn: async () => true, quietFn: async () => true,
    fetchFn: async (url, options = {}) => (options.method === 'PROPFIND' ? { status: 207 } : { MediaContainer: { Activity: [] } }),
  };
  const first = opportunisticIngestConfirm({
    ...common,
    observeFn: slow,
    findResult: async () => ({ partId: '1', file: EXPECT_FILE, size: 1234, ratingKey: '2' }),
  });
  await new Promise((r) => setTimeout(r, 20));
  const second = await opportunisticIngestConfirm({
    ...common,
    observeFn: async () => ({ started: true, completed: true, uuid: 'other', elapsedMs: 1 }),
    findResult: async () => ({ partId: '9', file: EXPECT_FILE, size: 1234, ratingKey: '9' }),
  });
  assert.equal(second.outcome, INGEST_OUTCOMES.UNCONFIRMED);
  assert.equal(second.fallbackReason, 'section-scanning');
  const scan = { started: true, completed: true, uuid: 'shared-1', elapsedMs: 10 };
  release(scan);
  const one = await first;
  assert.equal(one.outcome, INGEST_OUTCOMES.VERIFIED);
  assert.equal(one.partId, '1');
});
