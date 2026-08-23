import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { createTorBoxProvider } from '../src/lib/providers/torbox.js';
import {
  HASH,
  OTHER_HASH,
  checkcachedHit,
  checkcachedMiss,
  checkcachedMixed,
  checkcachedAuthError,
  checkcachedServiceError,
} from './fixtures/torbox-response-fixtures.js';

const NOW = 20_000;

/**
 * Wrap a raw API payload in a Response-like object.
 */
function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

// ---------------------------------------------------------------------------
// Slice 2A — TorBox cache observation capability hardening
//
// Verifies: bounded batching, partial failure isolation, typed errors,
// provider/account scope preservation, torrent-scoped observations.
// ---------------------------------------------------------------------------

test('single hash cached → authoritative torrent-scoped cached observation', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    cacheObservationTtlMs: 2_000,
    fetchFn: async () => response(checkcachedHit(HASH)),
  });

  const [obs] = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);

  assert.equal(obs.provider, 'torbox');
  assert.equal(obs.accountScope, 'primary');
  assert.equal(obs.scope, 'torrent');
  assert.equal(obs.infoHash, HASH);
  assert.equal(obs.fileIndex, null);
  assert.equal(obs.kind, 'authoritative');
  assert.equal(obs.state, 'cached');
  assert.equal(obs.observedAt, NOW);
  assert.equal(obs.expiresAt, NOW + 2_000);
  assert.equal(obs.source, 'torbox-checkcached');
  assert.ok(Object.isFrozen(obs));
});

test('single hash uncached → authoritative torrent-scoped uncached observation', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedMiss()),
  });

  const [obs] = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);

  assert.equal(obs.state, 'uncached');
  assert.equal(obs.scope, 'torrent');
  assert.equal(obs.fileIndex, null);
  assert.equal(obs.errorCategory, null);
  assert.equal(obs.retryable, null);
});

test('batch of 20 hashes → batched into 2 requests of BATCH_SIZE', async () => {
  const hashes = Array.from({ length: 20 }, (_, i) =>
    `abcdef0123456789abcdef0123456789abcdef${i.toString().padStart(2, '0')}`
  );

  let fetchCount = 0;
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => {
      fetchCount += 1;
      return response({
        success: true,
        data: Object.fromEntries(hashes.map((h) => [h, { name: 'release' }])),
      });
    },
  });

  const obs = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache(hashes.map((infoHash) => ({ infoHash })));

  assert.equal(fetchCount, 2);
  assert.equal(obs.length, 20);
  assert.ok(obs.every((o) => o.state === 'cached'));
  assert.ok(obs.every((o) => o.scope === 'torrent'));
  assert.ok(obs.every((o) => o.fileIndex === null));
});

test('mixed cached/uncached → per-hash state preserved', async () => {
  const adapter = createTorBoxProvider({
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedMixed(HASH, OTHER_HASH)),
  });

  const obs = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }, { infoHash: OTHER_HASH }]);

  assert.deepEqual(obs.map((o) => o.state), ['cached', 'uncached']);
  assert.ok(obs.every((o) => o.scope === 'torrent'));
  assert.ok(obs.every((o) => o.fileIndex === null));
});

test('partial batch failure with large batch → only affected hashes become unknown', async () => {
  // Create 12 hashes so they split into 2 batches of 10 and 2
  const hashes = Array.from({ length: 12 }, (_, i) =>
    `abcdef0123456789abcdef0123456789abcdef${i.toString(16).padStart(2, '0')}`
  );

  let callCount = 0;
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => {
      callCount += 1;
      if (callCount === 1) {
        // First batch (10 hashes) succeeds
        return response({
          success: true,
          data: Object.fromEntries(hashes.slice(0, 10).map((h) => [h, { name: 'release' }])),
        });
      }
      // Second batch (2 hashes) fails
      return response(checkcachedServiceError(), 503);
    },
  });

  const result = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache(hashes.map((infoHash) => ({ infoHash })));

  // First 10 hashes should be cached
  assert.ok(result.slice(0, 10).every((o) => o.state === 'cached'));
  // Last 2 hashes should be unknown + retryable
  assert.ok(result.slice(10).every((o) => o.state === 'unknown'));
  assert.ok(result.slice(10).every((o) => o.retryable === true));
});

test('authentication failure → error observation with category, all hashes error', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'bad-token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedAuthError(), 401),
  });

  const obs = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }, { infoHash: OTHER_HASH }]);

  assert.ok(obs.every((o) => o.state === 'error'));
  assert.ok(obs.every((o) => o.errorCategory === 'authentication'));
  assert.ok(obs.every((o) => o.retryable === false));
});

test('service error (503) → unknown with retryable=true', async () => {
  const adapter = createTorBoxProvider({
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedServiceError(), 503),
  });

  const [obs] = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);

  assert.equal(obs.state, 'unknown');
  assert.equal(obs.retryable, true);
  assert.equal(obs.errorCategory, null);
});

test('provider and account scope preserved across all output observations', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'test-account-scope',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedHit(HASH)),
  });

  const obs = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);

  for (const o of obs) {
    assert.equal(o.provider, 'torbox');
    assert.equal(o.accountScope, 'test-account-scope');
  }
});

test('observation output is always torrent-scoped, never file-candidate', async () => {
  const adapter = createTorBoxProvider({
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedHit(HASH)),
  });

  const obs = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);

  for (const o of obs) {
    assert.equal(o.scope, 'torrent');
    assert.equal(o.fileIndex, null);
    assert.equal(o.subjectType, 'torrent');
    assert.equal(o.subjectKey, HASH);
  }
});

test('latency is measured and attached to observations', async () => {
  const adapter = createTorBoxProvider({
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => {
      // simulate latency by awaiting a microtask
      await Promise.resolve();
      return response(checkcachedHit(HASH));
    },
  });

  const [obs] = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([{ infoHash: HASH }]);

  assert.ok(obs.latencyMs != null, 'latencyMs should be measured');
  assert.ok(obs.latencyMs >= 0, 'latencyMs should be non-negative');
});

test('missing API key → error observation with authentication category', async () => {
  const savedKey = process.env.TORBOX_API_KEY;
  delete process.env.TORBOX_API_KEY;

  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: undefined,
    now: () => NOW,
    fetchFn: async () => response(checkcachedHit(HASH)),
  });

  try {
    // Adapter converts provider errors to error-state observations (does not throw)
    const [obs] = await adapter
      .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
      .observeCache([{ infoHash: HASH }]);

    assert.equal(obs.state, 'error');
    assert.equal(obs.errorCategory, 'authentication');
    assert.equal(obs.scope, 'torrent');
  } finally {
    if (savedKey !== undefined) process.env.TORBOX_API_KEY = savedKey;
  }
});

test('malformed infoHash → throws TypeError (programmer error)', async () => {
  const adapter = createTorBoxProvider({
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedHit(HASH)),
  });

  await assert.rejects(
    () => adapter
      .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
      .observeCache([{ infoHash: 'not-a-valid-hash' }]),
    (error) => error instanceof TypeError
  );
});

test('deduplication: duplicate hashes in input yield one observation each (no dupes)', async () => {
  const adapter = createTorBoxProvider({
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(checkcachedHit(HASH)),
  });

  const obs = await adapter
    .require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION)
    .observeCache([
      { infoHash: HASH },
      { infoHash: HASH },
      { infoHash: HASH },
    ]);

  assert.equal(obs.length, 3);
  assert.ok(obs.every((o) => o.state === 'cached'));
});
