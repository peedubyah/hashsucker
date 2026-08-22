import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { createTorBoxProvider } from '../src/lib/providers/torbox.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = '1234567890abcdef1234567890abcdef12345678';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test('TorBox cache capability returns authoritative torrent observations without leaking file identity', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'test-token',
    now: () => 10_000,
    cacheObservationTtlMs: 2_000,
    fetchFn: async () => response({
      success: true,
      data: { [HASH]: { name: 'hit' } },
    }),
  });

  const observations = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([
      { infoHash: HASH, fileIndex: 0 },
      { infoHash: OTHER_HASH, fileIndex: 7 },
    ]);

  assert.deepEqual(observations.map((item) => item.state), ['cached', 'uncached']);
  assert.ok(observations.every((item) => item.kind === 'authoritative'));
  assert.ok(observations.every((item) => item.scope === 'torrent'));
  assert.ok(observations.every((item) => item.fileIndex === null));
  assert.ok(observations.every((item) => item.expiresAt === 12_000));
  assert.equal(observations[0].evidence.name, 'hit');
});

test('TorBox partial batch failure is unknown, never uncached', async () => {
  const hashes = Array.from({ length: 11 }, (_, index) => index.toString(16).padStart(40, '0'));
  let calls = 0;
  const adapter = createTorBoxProvider({
    apiKey: 'test-token',
    now: () => 10_000,
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) return response({ success: true, data: { [hashes[0]]: { hit: true } } });
      return response({}, 503);
    },
  });

  const observations = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache(hashes.map((infoHash) => ({ infoHash })));

  assert.equal(observations[0].state, 'cached');
  assert.ok(observations.slice(1, 10).every((item) => item.state === 'uncached'));
  assert.equal(observations[10].state, 'unknown');
  assert.equal(observations[10].retryable, true);
});

test('TorBox global authentication failure becomes typed authoritative error observations', async () => {
  const adapter = createTorBoxProvider({
    apiKey: 'bad-token',
    now: () => 10_000,
    fetchFn: async () => response({}, 401),
  });

  const [observation] = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);

  assert.equal(observation.state, 'error');
  assert.equal(observation.errorCategory, 'authentication');
  assert.equal(observation.retryable, false);
});
