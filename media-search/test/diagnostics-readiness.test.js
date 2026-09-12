/**
 * Rollout readiness diagnostics tests.
 *
 * Covers status classification (fatal/degraded/warning), secret redaction,
 * Jellyfin realtime-monitor warnings, and Plex reason codes — all with
 * stubbed fetch and filesystem-light fixtures. No network, no production.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  redactUrl,
  classifyHttpError,
  buildDiagnostics,
  summarizeForStartup,
} from '../src/lib/diagnostics/readiness.js';

function stubFetch(routes) {
  return async (url, options = {}) => {
    const u = String(url);
    for (const [prefix, body, status = 200] of routes) {
      if (u.startsWith(prefix)) {
        return { ok: status >= 200 && status < 300, status, json: async () => body };
      }
    }
    const err = new Error(`unexpected fetch ${u}`);
    err.status = 0;
    throw err;
  };
}

const SECRET = 'super-secret-value-12345';

test('redactUrl strips credentials, query, and fragments', () => {
  assert.equal(
    redactUrl(`https://user:${SECRET}@host:8096/path?api_key=${SECRET}#frag`),
    'https://host:8096/path',
  );
  assert.equal(redactUrl('not a url'), '<invalid-url>');
});

test('classifyHttpError distinguishes auth, throttle, and unreachable', () => {
  assert.deepEqual(classifyHttpError({ status: 401 }, 'X'), {
    state: 'error', reason: 'X_AUTH_FAILED', detail: 'X: credential rejected',
  });
  assert.deepEqual(classifyHttpError({ status: 429 }, 'X'), {
    state: 'error', reason: 'X_RATE_LIMITED', detail: 'X: rate limited',
  });
  assert.deepEqual(classifyHttpError(new Error('boom'), 'X'), {
    state: 'error', reason: 'X_UNREACHABLE', detail: 'X: unreachable',
  });
});

function baseEnv(overrides = {}) {
  return {
    DISCOVERY_DB: ':memory:',
    CONTROL_PLANE_DB: null,
    STRM_OUTPUT_PATH: '/nonexistent-strm-root-for-test',
    DATA_PLANE_URL: 'http://dp.test:3001',
    ...overrides,
  };
}

const emptyCache = { db: { prepare: () => ({ get: () => ({ n: 0 }), all: () => [] }) } };
const emptyStore = {
  listAllLibraryItems: () => [],
  listConsumerObservations: () => [],
  listBindings: () => [],
  getTorrentFile: () => null,
  listDataPlaneCoordinates: () => [],
};
const emptyListing = () => ({ items: [], total: 0 });
const disabledPolicy = {
  enabled: false, requiredConsumers: ['jellyfin'], absenceGraceMs: 1, observationMaxAgeMs: 1,
};

test('diagnostics: unreachable everything is not_ready, secrets never leak', async () => {
  const fetchFn = stubFetch([]);
  const env = {
    ...baseEnv(),
    TORBOX_API_KEY: SECRET,
    REALDEBRID_API_KEY: SECRET,
    JELLYFIN_URL: 'http://jf.test:8096',
    JELLYFIN_API_KEY: SECRET,
    PLEX_URL: 'http://plex.test:32400',
    PLEX_TOKEN: SECRET,
  };
  const d = await buildDiagnostics({
    cache: emptyCache,
    controlPlaneStore: emptyStore,
    env,
    fetchFn,
    listLibraryFn: emptyListing,
    retirementPolicy: disabledPolicy,
    realDebridClientFactory: () => { throw Object.assign(new Error('no'), { status: 0 }); },
  });
  assert.equal(d.status, 'not_ready');
  const flat = JSON.stringify(d);
  assert.ok(!flat.includes(SECRET), 'no secret material in output');
  assert.ok(!flat.includes('api_key='), 'no credential query strings in output');
  assert.equal(d.providers.torbox.reason, 'TORBOX_UNREACHABLE');
  assert.equal(d.consumers.plex.reason, 'PLEX_UNREACHABLE');
  assert.equal(d.consumers.jellyfin.reason, 'JELLYFIN_UNREACHABLE');
});

test('diagnostics: healthy core with broken Plex is degraded, not fatal', async () => {
  const fetchFn = stubFetch([
    ['http://dp.test:3001/metrics', {}],
    ['https://api.torbox.app/v1/api/torrents/checkcached', {}],
    ['http://jf.test:8096/System/Info/Public', {}],
    ['http://jf.test:8096/Library/VirtualFolders', [
      { Name: 'Movies', Locations: ['/x/Movies'], LibraryOptions: { EnableRealtimeMonitor: true } },
    ]],
    ['http://plex.test:32400/identity', {}],
  ]);
  const env = {
    ...baseEnv(),
    TORBOX_API_KEY: SECRET,
    JELLYFIN_URL: 'http://jf.test:8096',
    JELLYFIN_API_KEY: SECRET,
    PLEX_URL: 'http://plex.test:32400',
    PLEX_TOKEN: 'bad-token',
  };
  const d = await buildDiagnostics({
    cache: emptyCache,
    controlPlaneStore: emptyStore,
    env,
    fetchFn,
    listLibraryFn: emptyListing,
    retirementPolicy: disabledPolicy,
    realDebridClientFactory: null,
  });
  // STRM root probe fails (/nonexistent) → not_ready in this fixture by design.
  assert.equal(d.status, 'not_ready');
  assert.equal(d.providers.torbox.state, 'ok');
  assert.equal(d.consumers.jellyfin.state, 'ok');
});

test('diagnostics: Jellyfin TV without realtime monitor warns explicitly', async () => {
  const fetchFn = stubFetch([
    ['http://jf.test:8096/System/Info/Public', {}],
    ['http://jf.test:8096/Library/VirtualFolders', [
      { Name: 'Movies', Locations: ['/x/Movies'], LibraryOptions: { EnableRealtimeMonitor: true } },
      { Name: 'TV Shows', Locations: ['/x/TV Shows'], LibraryOptions: { EnableRealtimeMonitor: false } },
    ]],
  ]);
  const env = {
    ...baseEnv(),
    JELLYFIN_URL: 'http://jf.test:8096',
    JELLYFIN_API_KEY: SECRET,
  };
  const d = await buildDiagnostics({
    cache: emptyCache,
    controlPlaneStore: emptyStore,
    env,
    fetchFn,
    listLibraryFn: emptyListing,
    retirementPolicy: disabledPolicy,
    realDebridClientFactory: null,
  });
  assert.equal(d.consumers.jellyfin.state, 'ok');
  assert.ok(
    d.warnings.some((w) => w.includes('TV Shows') && w.includes('realtime')),
    'expected TV realtime warning, got: ' + JSON.stringify(d.warnings),
  );
  assert.ok(!JSON.stringify(d).includes(SECRET));
});

test('diagnostics: Plex 401 classifies as auth failure, timeout as unreachable', async () => {
  const fetch401 = stubFetch([
    ['http://plex.test:32400/identity', {}],
    ['http://plex.test:32400/library/sections', {}, 401],
  ]);
  const env = {
    ...baseEnv(), PLEX_URL: 'http://plex.test:32400', PLEX_TOKEN: SECRET,
  };
  const d401 = await buildDiagnostics({
    cache: emptyCache,
    controlPlaneStore: emptyStore,
    env,
    fetchFn: fetch401,
    listLibraryFn: emptyListing,
    retirementPolicy: disabledPolicy,
    realDebridClientFactory: null,
  });
  assert.equal(d401.consumers.plex.reason, 'PLEX_AUTH_FAILED');

  const fetchTimeout = async () => { throw new Error('timeout'); };
  const dTimeout = await buildDiagnostics({
    cache: emptyCache,
    controlPlaneStore: emptyStore,
    env,
    fetchFn: fetchTimeout,
    listLibraryFn: emptyListing,
    retirementPolicy: disabledPolicy,
    realDebridClientFactory: null,
  });
  assert.equal(dTimeout.consumers.plex.reason, 'PLEX_UNREACHABLE');
});

test('summarizeForStartup renders one compact block without secrets', () => {
  const d = {
    status: 'degraded',
    warnings: ['retirement disabled'],
    storage: { discoveryDb: { state: 'ok' }, controlDb: { state: 'ok' } },
    dataPlane: { state: 'ok' },
    providers: { torbox: { state: 'ok' } },
    consumers: { plex: { state: 'error', reason: 'PLEX_AUTH_FAILED' } },
    publication: { strm: { state: 'ok' }, vfs: { state: 'ok' } },
    lifecycle: { retirement: { enabled: false } },
  };
  const text = summarizeForStartup(d);
  assert.ok(text.includes('degraded'));
  assert.ok(text.includes('PLEX_AUTH_FAILED'));
  assert.ok(!text.includes(SECRET));
  assert.ok(text.split('\n').length <= 14, 'compact, got: ' + text);
});
