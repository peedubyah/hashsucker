import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPlexSessions } from '../src/lib/consumers/plex-sessions.js';

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
