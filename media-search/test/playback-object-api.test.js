/**
 * The playback object API — one step from a media intent to a stable,
 * HashSucker-owned playback URL.
 *
 * The API is a thin adapter over the authority that already exists. These
 * tests pin the properties the tiny client depends on:
 *
 *   - a media id resolves deterministically;
 *   - a title resolves through the existing metadata search;
 *   - an ambiguous title NEVER silently chooses;
 *   - the warm path performs no discovery (the request pipeline is not run);
 *   - the cold path runs the existing pipeline and then mints the object;
 *   - the response carries no provider state, credential or URL;
 *   - a series intent needs real episode coordinates (there is no S00E00);
 *   - an expired token can be re-resolved.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolvePlaybackIntent,
  looksLikeMediaId,
  PlaybackObjectApiError,
} from '../src/api/playback-object.js';
import { mintPlaybackToken, verifyPlaybackToken } from '../src/lib/resolver/playback-object.js';
import { buildMpvArgs } from '../tools/hs/mpv.mjs';

const SECRET = 'playback-secret-for-tests-0123456789';
const ENV = { PLAYBACK_TOKEN_SECRET: SECRET, PLAYBACK_TOKEN_TTL_SECONDS: '86400' };

function store({ items = {}, bindings = {} }) {
  return {
    getLibraryItemByIdentityKey: (key) => items[key] ?? null,
    getActiveBindingForLibraryItem: (id) => bindings[id] ?? null,
  };
}

/** A control plane with one bound movie and one bound episode. */
function boundStore() {
  return store({
    items: {
      'movie:tt0000001:default': { id: 'lib-movie-1' },
      'episode:tt0000002:default:2:5': { id: 'lib-episode-1' },
    },
    bindings: {
      'lib-movie-1': { torrentFile: { id: 'tf-movie-1' } },
      'lib-episode-1': { torrentFile: { id: 'tf-episode-1' } },
    },
  });
}

async function expectError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof PlaybackObjectApiError, `expected a typed error, got ${error}`);
    assert.equal(error.code, code);
    if (status != null) assert.equal(error.status, status);
    return true;
  });
}

test('A1 — a media id resolves deterministically to the authoritative TorrentFile', async () => {
  const result = await resolvePlaybackIntent({
    controlPlaneStore: boundStore(),
    env: ENV,
    mediaId: 'tt0000001',
    mediaType: 'movie',
    prepareFn: async () => { throw new Error('the warm path must not run the pipeline'); },
  });
  assert.equal(result.mediaId, 'tt0000001');
  assert.equal(result.mediaType, 'movie');
  assert.equal(result.torrentFileId, 'tf-movie-1');
  assert.ok(result.playbackUrl.startsWith('/play/'));
  assert.equal(result.warm, true);
});

test('A2 — the warm path performs no discovery and no provider work', async () => {
  let pipelineCalls = 0;
  const result = await resolvePlaybackIntent({
    controlPlaneStore: boundStore(),
    env: ENV,
    mediaId: 'tt0000001',
    mediaType: 'movie',
    prepareFn: async () => { pipelineCalls += 1; return {}; },
  });
  assert.equal(pipelineCalls, 0, 'an already-authoritative item never runs the request pipeline');
  assert.equal(result.warm, true);
  assert.equal(result.alreadyPrepared, false);
});

test('A3 — the cold path runs the existing pipeline and then mints the object', async () => {
  const controlPlaneStore = store({ items: {}, bindings: {} });
  let pipelineCalls = 0;
  const result = await resolvePlaybackIntent({
    controlPlaneStore,
    env: ENV,
    mediaId: 'tt0000009',
    mediaType: 'movie',
    prepareFn: async (cache, request) => {
      pipelineCalls += 1;
      assert.equal(request.mediaId, 'tt0000009');
      // The pipeline produced the durable authority.
      controlPlaneStore.getLibraryItemByIdentityKey = () => ({ id: 'lib-new' });
      controlPlaneStore.getActiveBindingForLibraryItem = () => ({ torrentFile: { id: 'tf-new' } });
      return { published: true };
    },
  });
  assert.equal(pipelineCalls, 1);
  assert.equal(result.warm, false);
  assert.equal(result.published, true);
  assert.equal(result.torrentFileId, 'tf-new');
});

test('A4 — an ambiguous title never silently chooses', async () => {
  // Two legitimate works match the same title. The API must refuse, and hand
  // back the candidates so the client can ask — it must never pick one.
  await expectError(
    resolvePlaybackIntent({
      controlPlaneStore: boundStore(),
      env: ENV,
      query: 'Alien',
      searchFn: async () => ({
        results: [
          { id: 'tt0078748', type: 'movie', title: 'Alien', year: 1979 },
          { id: 'tt0078749', type: 'series', title: 'Alien', year: 1979 },
        ],
      }),
      prepareFn: async () => ({}),
    }),
    'AMBIGUOUS_INTENT',
    409,
  );
  // The refusal carries the candidates so the client can disambiguate.
  const error = await resolvePlaybackIntent({
    controlPlaneStore: boundStore(),
    env: ENV,
    query: 'Alien',
    searchFn: async () => ({
      results: [
        { id: 'tt0078748', type: 'movie', title: 'Alien', year: 1979 },
        { id: 'tt0078749', type: 'series', title: 'Alien', year: 1979 },
      ],
    }),
    prepareFn: async () => ({}),
  }).catch((e) => e);
  assert.equal(error.code, 'AMBIGUOUS_INTENT');
  assert.equal(error.candidates.length, 2);
  assert.deepEqual(error.candidates.map((c) => c.mediaId), ['tt0078748', 'tt0078749']);
});

test('A4b — a title that matches exactly one work resolves through it', async () => {
  const result = await resolvePlaybackIntent({
    controlPlaneStore: boundStore(),
    env: ENV,
    query: 'The Movie',
    searchFn: async () => ({
      results: [{ id: 'tt0000001', type: 'movie', title: 'The Movie', year: 1999 }],
    }),
    prepareFn: async () => ({}),
  });
  assert.equal(result.mediaId, 'tt0000001');
  assert.equal(result.mediaType, 'movie');
  assert.equal(result.title, 'The Movie');
  assert.equal(result.torrentFileId, 'tf-movie-1');
});

test('A4c — a title that matches nothing is a typed not-found', async () => {
  await expectError(
    resolvePlaybackIntent({
      controlPlaneStore: boundStore(),
      env: ENV,
      query: 'zzzznotawork',
      searchFn: async () => ({ results: [] }),
      prepareFn: async () => ({}),
    }),
    'INTENT_NOT_FOUND',
    404,
  );
});

test('A5 — the response carries no provider state, credential or URL', async () => {
  const result = await resolvePlaybackIntent({
    controlPlaneStore: boundStore(),
    env: ENV,
    mediaId: 'tt0000001',
    mediaType: 'movie',
    prepareFn: async () => ({}),
  });
  const blob = JSON.stringify(result).toLowerCase();
  for (const forbidden of ['realdebrid', 'torbox', 'premiumize', 'alldebrid', 'provider', 'placement', 'capability', 'secret', 'unrestrict', 'requestdl']) {
    assert.ok(!blob.includes(forbidden), `the response must not mention ${forbidden}`);
  }
  assert.equal(Object.keys(result).includes('playbackUrl'), true);
  assert.ok(result.playbackUrl.startsWith('/play/'));
});

test('A6 — a series intent needs real episode coordinates (there is no S00E00)', async () => {
  await expectError(
    resolvePlaybackIntent({
      controlPlaneStore: boundStore(),
      env: ENV,
      mediaId: 'tt0000002',
      mediaType: 'series',
      prepareFn: async () => ({}),
    }),
    'EPISODE_COORDINATES_REQUIRED',
    400,
  );
  await expectError(
    resolvePlaybackIntent({
      controlPlaneStore: boundStore(),
      env: ENV,
      mediaId: 'tt0000002',
      mediaType: 'series',
      season: 0,
      episode: 0,
      prepareFn: async () => ({}),
    }),
    'EPISODE_COORDINATES_REQUIRED',
    400,
  );
});

test('A7 — a TV episode resolves to its own exact TorrentFile', async () => {
  const result = await resolvePlaybackIntent({
    controlPlaneStore: boundStore(),
    env: ENV,
    mediaId: 'tt0000002',
    mediaType: 'series',
    season: 2,
    episode: 5,
    prepareFn: async () => { throw new Error('the warm path must not run the pipeline'); },
  });
  assert.equal(result.torrentFileId, 'tf-episode-1');
  assert.equal(result.season, 2);
  assert.equal(result.episode, 5);
  assert.equal(result.mediaType, 'series');
});

test('A8 — a media id is recognised as such, and a title is not', () => {
  assert.equal(looksLikeMediaId('tt0078748'), true);
  assert.equal(looksLikeMediaId('tmdb348'), true);
  assert.equal(looksLikeMediaId('Alien'), false);
  assert.equal(looksLikeMediaId('that submarine movie'), false);
});

test('A9 — an expired token can be re-resolved, and the media identity survives', async () => {
  const first = await resolvePlaybackIntent({
    controlPlaneStore: boundStore(),
    env: { ...ENV, PLAYBACK_TOKEN_TTL_SECONDS: '1' },
    mediaId: 'tt0000001',
    mediaType: 'movie',
    now: () => 1_000_000,
    prepareFn: async () => ({}),
  });
  const token = decodeURIComponent(first.playbackUrl.slice('/play/'.length));
  assert.equal(verifyPlaybackToken({ token, secret: SECRET, now: 1_000_000 }).torrentFileId, 'tf-movie-1');
  // The same token, one lifetime later, is expired — the client must ask
  // again rather than treat it as a broken release.
  assert.throws(
    () => verifyPlaybackToken({ token, secret: SECRET, now: 1_000_000 + 2_000 }),
    (error) => error.status === 410 && error.code === 'PLAYBACK_TOKEN_EXPIRED',
  );
  const second = await resolvePlaybackIntent({
    controlPlaneStore: boundStore(),
    env: { ...ENV, PLAYBACK_TOKEN_TTL_SECONDS: '1' },
    mediaId: 'tt0000001',
    mediaType: 'movie',
    now: () => 1_000_000 + 5_000,
    prepareFn: async () => ({}),
  });
  assert.equal(second.torrentFileId, first.torrentFileId, 'the media identity is unchanged by a re-resolve');
  assert.notEqual(second.playbackUrl, first.playbackUrl, 'the re-resolve issues a fresh URL');
  const secondToken = decodeURIComponent(second.playbackUrl.slice('/play/'.length));
  assert.equal(verifyPlaybackToken({ token: secondToken, secret: SECRET, now: 1_000_000 + 5_000 }).torrentFileId, 'tf-movie-1');
});

test('A10 — without a signing secret the API is unavailable, not permissive', async () => {
  await expectError(
    resolvePlaybackIntent({
      controlPlaneStore: boundStore(),
      env: {},
      mediaId: 'tt0000001',
      mediaType: 'movie',
      prepareFn: async () => ({}),
    }),
    'PLAYBACK_OBJECT_UNAVAILABLE',
    503,
  );
});

test('A11 — an intent that cannot be made authoritative is a typed failure', async () => {
  await expectError(
    resolvePlaybackIntent({
      controlPlaneStore: store({ items: {}, bindings: {} }),
      env: ENV,
      mediaId: 'tt0000003',
      mediaType: 'movie',
      prepareFn: async () => ({ published: false }),
    }),
    'NO_AUTHORITATIVE_REPRESENTATION',
    409,
  );
});

test('A12 — the mpv invocation opens the playback URL and nothing else', () => {
  const args = buildMpvArgs({ url: 'http://localhost:3000/play/TOKEN', socketPath: '/tmp/x.sock', headless: true });
  assert.equal(args.at(-1), 'http://localhost:3000/play/TOKEN', 'the URL is the last argument');
  assert.ok(args.includes('--input-ipc-server=/tmp/x.sock'), 'the JSON IPC socket is requested');
  assert.ok(args.includes('--vo=null'), 'headless means no video output');
  assert.ok(args.includes('--term-playing-msg=PLAYING ${path}'), 'the first-frame signal is the player\'s own');
  const withVideo = buildMpvArgs({ url: 'u', socketPath: 's', headless: false });
  assert.ok(!withVideo.includes('--vo=null'), 'a display means the video output is kept');
  assert.equal(withVideo.length, args.length - 2);
});

test('A13 — the minted token is bound to the TorrentFile and to nothing else', async () => {
  const result = await resolvePlaybackIntent({
    controlPlaneStore: boundStore(),
    env: ENV,
    mediaId: 'tt0000001',
    mediaType: 'movie',
    prepareFn: async () => ({}),
  });
  const token = decodeURIComponent(result.playbackUrl.slice('/play/'.length));
  const verified = verifyPlaybackToken({ token, secret: SECRET });
  assert.equal(verified.torrentFileId, 'tf-movie-1');
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload).sort(), ['exp', 'tf', 'v']);
});
