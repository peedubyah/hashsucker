import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import { createTorBoxProvider } from '../src/lib/providers/torbox.js';
import {
  HASH,
  OTHER_HASH,
  MAGNET,
  createTorrentSuccess,
  createTorrentNotCached,
  createTorrentMalformed,
  createTorrentAuthError,
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
// Slice 2B — TorBox placement creation capability
//
// Verifies: magnet/cached-only creation, auth errors, provider rejection,
// malformed responses, provider/account scope preservation, torrent identity.
// ---------------------------------------------------------------------------

test('successful magnet creation → placement result with provider, scope, identity', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(createTorrentSuccess(12345, HASH)),
  });

  const result = await adapter
    .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
    .createPlacement({ magnet: MAGNET });

  assert.equal(result.provider, 'torbox');
  assert.equal(result.accountScope, 'primary');
  assert.equal(result.providerResourceId, '12345');
  assert.equal(result.infoHash, HASH);
  assert.ok(Object.isFrozen(result));
});

test('cached-only creation (add_only_if_cached=true) → success', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(createTorrentSuccess(12345, HASH)),
  });

  const result = await adapter
    .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
    .createPlacement({ magnet: MAGNET, addOnlyIfCached: true });

  assert.equal(result.provider, 'torbox');
  assert.equal(result.providerResourceId, '12345');
  assert.equal(result.infoHash, HASH);
});

test('successful creation preserves provider/account scope', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'test-account',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(createTorrentSuccess(999, OTHER_HASH)),
  });

  const result = await adapter
    .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
    .createPlacement({ magnet: MAGNET });

  assert.equal(result.provider, 'torbox');
  assert.equal(result.accountScope, 'test-account');
  assert.equal(result.providerResourceId, '999');
  assert.equal(result.infoHash, OTHER_HASH);
});

test('returned torrent identity (providerResourceId) preserved as opaque string', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(createTorrentSuccess(55555, HASH)),
  });

  const result = await adapter
    .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
    .createPlacement({ magnet: MAGNET });

  assert.equal(result.providerResourceId, '55555');
  assert.equal(typeof result.providerResourceId, 'string');
});

test('authentication failure → ProviderOperationError with authentication category', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'bad-token',
    now: () => NOW,
    fetchFn: async () => response(createTorrentAuthError(), 401),
  });

  await assert.rejects(
    () => adapter
      .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
      .createPlacement({ magnet: MAGNET }),
    (error) => error.category === 'authentication'
  );
});

test('provider rejection (not_cached) → ProviderOperationError with not-found category', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(createTorrentNotCached(), 200),
  });

  await assert.rejects(
    () => adapter
      .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
      .createPlacement({ magnet: MAGNET, addOnlyIfCached: true }),
    (error) => error.category === 'not-found' && error.retryable === false
  );
});

test('malformed response (no torrent_id) → throws error', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(createTorrentMalformed(), 200),
  });

  await assert.rejects(
    () => adapter
      .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
      .createPlacement({ magnet: MAGNET }),
    (error) => error instanceof TypeError || error.category === 'invalid-response'
  );
});

test('network failure → ProviderOperationError', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => { throw new Error('Connection reset'); },
  });

  await assert.rejects(
    () => adapter
      .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
      .createPlacement({ magnet: MAGNET }),
    (error) => error.category === 'unknown' || error.category === 'network'
  );
});

test('missing input → throws TypeError (programmer error)', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(createTorrentSuccess()),
  });

  await assert.rejects(
    () => adapter
      .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
      .createPlacement({}),
    (error) => error instanceof TypeError
  );
});

test('both magnet and torrentFileBase64 → throws TypeError (programmer error)', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(createTorrentSuccess()),
  });

  await assert.rejects(
    () => adapter
      .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
      .createPlacement({ magnet: MAGNET, torrentFileBase64: 'abc==' }),
    (error) => error instanceof TypeError
  );
});

test('rate limit → ProviderOperationError with rate-limit category', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => {
      const err = new Error('Rate limited');
      err.status = 429;
      throw err;
    },
  });

  await assert.rejects(
    () => adapter
      .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
      .createPlacement({ magnet: MAGNET }),
    (error) => error.category === 'rate-limit' && error.retryable === true
  );
});

test('creation result is frozen and does not expose cache observation fields', async () => {
  const adapter = createTorBoxProvider({
    accountScope: 'primary',
    apiKey: 'token',
    now: () => NOW,
    fetchFn: async () => response(createTorrentSuccess(12345, HASH)),
  });

  const result = await adapter
    .require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE)
    .createPlacement({ magnet: MAGNET });

  // Placement result is NOT a cache observation — no scope/state fields
  assert.equal(result.scope, undefined);
  assert.equal(result.state, undefined);
  assert.equal(result.kind, undefined);
  assert.equal(result.subjectType, undefined);
});
