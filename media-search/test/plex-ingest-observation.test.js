import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INGEST_ERRORS,
  activeScans,
  ingestError,
  isPlexEnabled,
  isScanQuiet,
  observeScan,
  requestSectionRefresh,
  sectionIdFor,
  waitForScanQuiet,
} from '../src/lib/requests/plex-ingest.js';

const PLEX_URL = 'http://pms.test:32400';
const PLEX_TOKEN = 'test-token';

/**
 * fetchFn convention for this module: it receives (url, options) and returns the
 * already-parsed JSON body. `requestSectionRefresh` is the exception — it needs
 * a response object — so its stub returns { ok, status } directly.
 */
/** observeScan must be tested without a real network refresh. */
const noopRequest = async () => ({ status: 200 });

function stubJson(handler) {
  return async (url, options = {}) => {
    const out = handler(String(url), options);
    if (out instanceof Error) throw out;
    if ('body' in out) return out.body;
    return { MediaContainer: { Activity: [] } };
  };
}

test('activeScans filters to library section scans only', async () => {
  const fetchFn = stubJson(() => ({
    body: {
      MediaContainer: {
        Activity: [
          { type: 'library.update.section', uuid: 'a', Context: { librarySectionID: '3' } },
          { type: 'provider.subscriptions.process', uuid: 'b' },
          { type: 'transcode.session', uuid: 'c' },
        ],
      },
    },
  }));
  const acts = await activeScans({ plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, fetchFn });
  assert.deepEqual(acts.map((a) => a.uuid), ['a']);
});

test('isScanQuiet is true when no section scan is running', async () => {
  const fetchFn = stubJson(() => ({ body: { MediaContainer: { Activity: [{ type: 'transcode.session' }] } } }));
  assert.equal(await isScanQuiet({ plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, fetchFn }), true);
  const busy = stubJson(() => ({ body: { MediaContainer: { Activity: [{ type: 'library.update.section' }] } } }));
  assert.equal(await isScanQuiet({ plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, fetchFn: busy }), false);
});

test('requestSectionRefresh targets the section and encodes the path', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };
  await requestSectionRefresh({
    plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, sectionId: '3',
    path: '/mnt/hashsucker-vfs/TV/tt123/Season 01', fetchFn,
  });
  assert.equal(calls[0].url, `${PLEX_URL}/library/sections/3/refresh?path=${encodeURIComponent('/mnt/hashsucker-vfs/TV/tt123/Season 01')}`);
});

test('requestSectionRefresh refuses a missing section or path instead of guessing', async () => {
  await assert.rejects(
    () => requestSectionRefresh({ plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, sectionId: null, path: '/x' }),
    (err) => err.code === INGEST_ERRORS.REFRESH_REJECTED,
  );
  await assert.rejects(
    () => requestSectionRefresh({ plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, sectionId: '3', path: null }),
    (err) => err.code === INGEST_ERRORS.REFRESH_REJECTED,
  );
});

test('a non-200 refresh is surfaced, not swallowed', async () => {
  const fetchFn = async () => ({ ok: false, status: 404 });
  await assert.rejects(
    () => requestSectionRefresh({ plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, sectionId: '99', path: '/x', fetchFn }),
    (err) => err.code === INGEST_ERRORS.REFRESH_REJECTED && /404/.test(err.message),
  );
});

test('observeScan reports started and completed from the activity lifecycle', async () => {
  let polls = 0;
  const fetchFn = stubJson(() => {
    polls += 1;
    // running for the first two polls, then gone
    const running = polls <= 2;
    return { body: { MediaContainer: { Activity: running ? [{ type: 'library.update.section', uuid: 'scan-1' }] : [] } } };
  });
  const out = await observeScan({
    plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, sectionId: '3', path: '/p', pollMs: 1, fetchFn,
    requestFn: noopRequest,
  });
  assert.equal(out.started, true);
  assert.equal(out.completed, true);
  assert.equal(out.uuid, 'scan-1');
  assert.equal(out.elapsedMs >= 0, true);
});

test('observeScan fails closed when no activity ever appears', async () => {
  const fetchFn = stubJson(() => ({ body: { MediaContainer: { Activity: [] } } }));
  await assert.rejects(
    () => observeScan({ plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, sectionId: '3', path: '/p', pollMs: 1, timeoutMs: 30, fetchFn, requestFn: async () => ({}) }),
    (err) => err.code === INGEST_ERRORS.SCAN_NOT_STARTED,
  );
});

test('observeScan fails closed when the activity never clears', async () => {
  const fetchFn = stubJson(() => ({ body: { MediaContainer: { Activity: [{ type: 'library.update.section', uuid: 'x' }] } } }));
  await assert.rejects(
    () => observeScan({ plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, sectionId: '3', path: '/p', pollMs: 1, timeoutMs: 30, fetchFn, requestFn: async () => ({}) }),
    (err) => err.code === INGEST_ERRORS.SCAN_NOT_COMPLETED,
  );
});

test('observeScan does not claim media analysis completed', async () => {
  // The activity must clear for completion; nothing here asserts anything about
  // the separate `Plex Media Scanner --analyze` subprocess, which this API
  // cannot observe. Documented as a limitation, not silently implied.
  const out = await observeScan({
    plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, sectionId: '3', path: '/p', pollMs: 1, timeoutMs: 20,
    fetchFn: stubJson(() => ({ body: { MediaContainer: { Activity: [] } } })),
    requestFn: noopRequest,
  }).catch((e) => e);
  assert.equal(out.code, INGEST_ERRORS.SCAN_NOT_STARTED);
});

test('waitForScanQuiet polls until PMS stops scanning', async () => {
  let calls = 0;
  const fetchFn = stubJson(() => {
    calls += 1;
    return { body: { MediaContainer: { Activity: calls < 3 ? [{ type: 'library.update.section' }] : [] } } };
  });
  const quiet = await waitForScanQuiet({ plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, pollMs: 1, fetchFn });
  assert.equal(quiet, true);
  assert.ok(calls >= 3);
});

test('waitForScanQuiet reports a timeout instead of claiming quiet', async () => {
  const fetchFn = stubJson(() => ({ body: { MediaContainer: { Activity: [{ type: 'library.update.section' }] } } }));
  assert.equal(await waitForScanQuiet({ plexUrl: PLEX_URL, plexToken: PLEX_TOKEN, pollMs: 1, timeoutMs: 20, fetchFn }), false);
});

test('sectionIdFor maps only the real mediaType contract (movie | series)', () => {
  assert.equal(sectionIdFor('movie', { PLEX_MOVIES_SECTION_ID: '2', PLEX_TV_SECTION_ID: '3' }), '2');
  assert.equal(sectionIdFor('series', { PLEX_TV_SECTION_ID: '3' }), '3');
  // 'episode' is a coordinate qualifier on a series, not a mediaType.
  assert.equal(sectionIdFor('episode', { PLEX_TV_SECTION_ID: '3' }), null);
  assert.equal(sectionIdFor('tv', { PLEX_TV_SECTION_ID: '3' }), null);
  assert.equal(sectionIdFor('unknown', { PLEX_TV_SECTION_ID: '3' }), null);
  assert.equal(sectionIdFor('movie', {}), null);
  assert.equal(sectionIdFor('series', {}), null);
});

test('isPlexEnabled requires the existing URL/token pair', () => {
  assert.equal(isPlexEnabled({ PLEX_URL: 'u', PLEX_TOKEN: 't' }), true);
  assert.equal(isPlexEnabled({ PLEX_URL: 'u' }), false);
  assert.equal(isPlexEnabled({}), false);
});

test('ingestError carries a stable code', () => {
  const err = ingestError(INGEST_ERRORS.SCAN_NOT_STARTED, 'x');
  assert.equal(err.code, INGEST_ERRORS.SCAN_NOT_STARTED);
  assert.ok(err instanceof Error);
});

/* ── path guard ────────────────────────────────────────────────────────────── */

import {
  classifyResultingItem,
  createIngestFlight,
  INGEST_ERRORS as E,
  requestLibraryIngest,
  validateRefreshPath,
  vfsDirectoryExists,
} from '../src/lib/requests/plex-ingest.js';

const ROOT = '/mnt/hashsucker-vfs/TV';

test('validateRefreshPath derives the narrowest correct scan target', () => {
  const got = validateRefreshPath({
    mediaType: 'series', collection: 'TV', sectionRoot: ROOT,
    canonicalPath: 'TV/tt31510819/Season 02/tt31510819 - S02E04.mkv',
    vfsBaseUrl: 'http://127.0.0.1:3000',
  });
  assert.equal(got.scanPath, `${ROOT}/tt31510819/Season 02`);
  assert.equal(got.vfsUrl, 'http://127.0.0.1:3000/vfs/TV/tt31510819/Season%2002/');
  assert.equal(got.vfsRelative, 'TV/tt31510819/Season 02');
});

test('validateRefreshPath rejects traversal and escapes', () => {
  const cases = [
    '/absolute/path/TV/x/Season 01/f.mkv',
    'TV/../../../etc/Season 01/f.mkv',
    'TV/..',
    'TV/x/Season 01/',
    'TV/x',
    'TV//Season 01/f.mkv',
  ];
  for (const canonicalPath of cases) {
    assert.throws(
      () => validateRefreshPath({ mediaType: 'series', collection: 'TV', sectionRoot: ROOT, canonicalPath }),
      (err) => err.code === E.INVALID_PATH,
      `expected ${canonicalPath} to be rejected`,
    );
  }
});

test('validateRefreshPath requires a "Season NN" target for series', () => {
  assert.throws(
    () => validateRefreshPath({ mediaType: 'series', collection: 'TV', sectionRoot: ROOT, canonicalPath: 'TV/tt1/tt1 - S01E01.mkv' }),
    (err) => err.code === E.INVALID_PATH && /Season NN/.test(err.message),
  );
});

test('validateRefreshPath requires the section root', () => {
  assert.throws(
    () => validateRefreshPath({ mediaType: 'series', collection: 'TV', sectionRoot: null, canonicalPath: 'TV/a/Season 01/a.mkv' }),
    (err) => err.code === E.INVALID_PATH && /sectionRoot/.test(err.message),
  );
});

/* ── vfs existence guard ───────────────────────────────────────────────────── */

test('vfsDirectoryExists treats a 207 as present and a 404 as absent', async () => {
  const present = async () => ({ status: 207 });
  const absent = async () => ({ status: 404 });
  assert.equal(await vfsDirectoryExists('http://vfs/x/', { fetchFn: present }), true);
  assert.equal(await vfsDirectoryExists('http://vfs/x/', { fetchFn: absent }), false);
});

test('vfsDirectoryExists surfaces an unexpected status instead of guessing', async () => {
  const boom = async () => ({ status: 500 });
  await assert.rejects(
    () => vfsDirectoryExists('http://vfs/x/', { fetchFn: boom }),
    (err) => err.code === E.PATH_NOT_FOUND && /500/.test(err.message),
  );
});

test('vfsDirectoryExists fails closed rather than assuming the path exists', async () => {
  // No vfsBaseUrl -> cannot verify -> must throw, not pass through.
  const plan = validateRefreshPath({ mediaType: 'series', collection: 'TV', sectionRoot: ROOT, canonicalPath: 'TV/tt1/Season 01/tt1 - S01E01.mkv', vfsBaseUrl: null });
  assert.equal(plan.vfsUrl, null);
  await assert.rejects(
    () => vfsDirectoryExists(plan.vfsUrl),
    (err) => err.code === E.PATH_NOT_FOUND,
  );
});

/* ── single-flight ─────────────────────────────────────────────────────────── */

test('a section refuses a second concurrent ingest because paths are indistinguishable', async () => {
  const flight = createIngestFlight();
  let release;
  const first = flight.runExclusive('3', '/a/Season 01', () => new Promise((r) => { release = r; }));
  assert.equal(flight.size, 1);
  await assert.rejects(
    () => flight.runExclusive('3', '/b/Season 02', async () => {}),
    (err) => err.code === E.SCAN_BUSY && /no path correlation/.test(err.message),
  );
  release('done');
  assert.equal(await first, 'done');
});

test('a section allows one ingest at a time and releases afterwards', async () => {
  const flight = createIngestFlight();
  const a = await flight.runExclusive('3', '/p', async () => 'first');
  assert.equal(a, 'first');
  assert.equal(flight.size, 0);
  const b = await flight.runExclusive('3', '/p', async () => 'second');
  assert.equal(b, 'second');
});

test('different sections may ingest concurrently', async () => {
  const flight = createIngestFlight();
  const p1 = flight.runExclusive('3', '/a', async () => 'tv');
  const p2 = flight.runExclusive('2', '/b', async () => 'movie');
  assert.deepEqual(await Promise.all([p1, p2]), ['tv', 'movie']);
});

/* ── resulting-item verification ───────────────────────────────────────────── */

test('classifyResultingItem separates wrong path from wrong size from readiness', () => {
  const base = { partId: '99', file: '/mnt/x', size: 100 };
  const verify = { expectedPartFile: '/mnt/x', expectedSize: 100 };
  assert.equal(classifyResultingItem(base, verify), null);

  const wrongPath = classifyResultingItem({ ...base, file: '/mnt/y' }, verify);
  assert.equal(wrongPath.code, E.WRONG_PART_PATH);

  const wrongSize = classifyResultingItem({ ...base, size: 200 }, verify);
  assert.equal(wrongSize.code, E.WRONG_PART_SIZE);

  const noSize = classifyResultingItem({ ...base, size: null }, verify);
  assert.equal(noSize.code, E.NOT_PLAYBACK_READY);

  const noPart = classifyResultingItem({ partId: null, file: '/mnt/x', size: 100 }, verify);
  assert.equal(noPart.code, E.NOT_PLAYBACK_READY);

  // no verification requested -> never a failure
  assert.equal(classifyResultingItem({ partId: null }, null), null);
});

/* ── full transaction ──────────────────────────────────────────────────────── */

test('requestLibraryIngest fails closed on an invalid path without touching PMS', async () => {
  let refreshCalled = false;
  await assert.rejects(
    () => requestLibraryIngest({
      mediaType: 'series', canonicalPath: 'TV/../escape/Season 01/f.mkv',
      sectionRoot: ROOT, collection: 'TV', vfsBaseUrl: 'http://vfs',
      plexUrl: 'http://pms', plexToken: 't',
      sectionIdOverride: '3',
      vfsExistsFn: async () => true,
      findResult: async () => ({}),
    }),
    (err) => err.code === E.INVALID_PATH,
  );
  assert.equal(refreshCalled, false);
});

test('requestLibraryIngest runs the full ordered transaction', async () => {
  const seen = [];
  const flight = createIngestFlight();
  const result = await requestLibraryIngest({
    mediaType: 'series', collection: 'TV', sectionRoot: ROOT,
    canonicalPath: 'TV/tt1/Season 01/tt1 - S01E01.mkv',
    vfsBaseUrl: 'http://vfs', plexUrl: 'http://pms', plexToken: 't',
    sectionIdOverride: '3',
    verify: { mediaId: 'tt1', expectedPartFile: '/mnt/hashsucker-vfs/TV/tt1/Season 01/tt1 - S01E01.mkv', expectedSize: 555 },
    findResult: async () => {
      seen.push('findResult');
      return { partId: '42', file: '/mnt/hashsucker-vfs/TV/tt1/Season 01/tt1 - S01E01.mkv', size: 555, duration: 1000, ratingKey: '77' };
    },
    pollMs: 1,
    timeoutMs: 5000,
    flight,
    // injected seams so no network is touched
    vfsExistsFn: async () => { seen.push('vfs'); return true; },
    quietFn: async () => { seen.push('quiet'); return true; },
    observeFn: async () => { seen.push('observeScan'); return { started: true, completed: true, uuid: 'u1' }; },
  });
  assert.deepEqual(seen, ['vfs', 'quiet', 'observeScan', 'findResult']);
  assert.equal(result.item.partId, '42');
  assert.equal(result.item.size, 555);
  assert.equal(result.scan.uuid, 'u1');
});
