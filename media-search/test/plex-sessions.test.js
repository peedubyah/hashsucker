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
