import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPlexSessions, mapSessionEntry } from '../src/lib/consumers/plex-sessions.js';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('empty PMS session container without Metadata is a valid zero-session response', async () => {
  const result = await fetchPlexSessions({
    plexUrl: 'http://plex',
    plexToken: 'token',
    fetchFn: async () => response({ MediaContainer: { size: 0 } }),
  });
  assert.deepEqual(result, { ok: true, sessions: [], total: 0 });
});

test('malformed PMS session response remains bad-shape', async () => {
  const result = await fetchPlexSessions({
    plexUrl: 'http://plex',
    plexToken: 'token',
    fetchFn: async () => response({ MediaContainer: { size: 1 } }),
  });
  assert.deepEqual(result, { ok: false, reason: 'bad-shape', sessions: [] });
});

test('Plex session mapper prefers the Guid IMDb identity array', () => {
  const mapped = mapSessionEntry({
    Guid: [{ id: 'imdb://tt26545992' }],
    type: 'episode',
    parentIndex: 1,
    index: 1,
    viewOffset: 41,
    duration: 1000,
    ratingKey: '497',
    Media: [{ Part: [{ id: '1042', file: '/mnt/hashsucker-vfs/e01.mkv' }] }],
  });
  assert.equal(mapped.mediaId, 'tt26545992');
  assert.equal(mapped.partId, '1042');
  assert.equal(mapped.progress, 0.041);
});

test('session fetch enriches a real status session missing Guid from library metadata', async () => {
  const statusEntry = {
    ratingKey: '497', type: 'episode', parentIndex: 1, index: 1, viewOffset: 41, duration: 1000,
    guid: 'plex://episode/example',
    Media: [{ Part: [{ id: '1042', file: '/mnt/hashsucker-vfs/e01.mkv' }] }],
    Player: { state: 'playing' }, Session: { id: 'session-1' }, User: { title: 'user' },
  };
  const metadata = { MediaContainer: { Metadata: [{ Guid: [{ id: 'imdb://tt26546824' }] }] } };
  const series = { MediaContainer: { Metadata: [{ Guid: [{ id: 'imdb://tt26545992' }] }] } };
  const calls = [];
  const result = await fetchPlexSessions({
    plexUrl: 'http://plex', plexToken: 'token',
    fetchFn: async (url) => {
      calls.push(url);
      if (url.endsWith('/status/sessions')) return response({ MediaContainer: { size: 1, Metadata: [{ ...statusEntry, grandparentRatingKey: '495' }] } });
      if (url.endsWith('/library/metadata/497')) return response(metadata);
      return response(series);
    },
  });
  assert.deepEqual(calls, ['http://plex/status/sessions', 'http://plex/library/metadata/497', 'http://plex/library/metadata/495']);
  assert.equal(result.ok, true);
  assert.equal(result.total, 1);
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.sessions[0], {
    mediaId: 'tt26545992', mediaType: 'episode', season: 1, episode: 1,
    viewOffset: 41, duration: 1000, progress: 0.041,
    partFile: '/mnt/hashsucker-vfs/e01.mkv', partId: '1042',
    playerState: 'playing', sessionId: 'session-1', ratingKey: '497',
  });
});
