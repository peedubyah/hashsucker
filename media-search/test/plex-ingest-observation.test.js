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

test('sectionIdFor maps media types from the environment contract', () => {
  assert.equal(sectionIdFor('movie', { PLEX_MOVIES_SECTION_ID: '2', PLEX_TV_SECTION_ID: '3' }), '2');
  assert.equal(sectionIdFor('series', { PLEX_TV_SECTION_ID: '3' }), '3');
  assert.equal(sectionIdFor('episode', { PLEX_TV_SECTION_ID: '3' }), '3');
  assert.equal(sectionIdFor('tv', { PLEX_TV_SECTION_ID: '3' }), '3');
  assert.equal(sectionIdFor('unknown', { PLEX_TV_SECTION_ID: '3' }), null);
  assert.equal(sectionIdFor('movie', {}), null);
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
