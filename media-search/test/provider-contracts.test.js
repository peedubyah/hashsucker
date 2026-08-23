import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVIDER_CAPABILITIES,
  UnsupportedProviderCapabilityError,
  createProviderAdapter,
} from '../src/lib/providers/capabilities.js';
import {
  ProviderOperationError,
  classifyProviderError,
} from '../src/lib/providers/errors.js';
import {
  createCacheObservation,
  evaluateObservationFreshness,
  toLegacyCachedState,
} from '../src/lib/providers/observations.js';
import {
  createExposureObservation,
  createPlacementObservation,
  createProviderFileInventory,
} from '../src/lib/providers/resources.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

function fakeCacheCapability() {
  return {
    async observeCache(subjects) {
      return subjects.map((subject) => createCacheObservation({
        provider: 'fake',
        accountScope: 'test-account',
        scope: subject.fileIndex == null ? 'torrent' : 'candidate',
        infoHash: subject.infoHash,
        fileIndex: subject.fileIndex,
        state: 'cached',
        observedAt: 1_000,
        ttlMs: 5_000,
        source: 'fake-contract',
      }));
    },
  };
}

test('provider adapter exposes only independently implemented capabilities', () => {
  const adapter = createProviderAdapter({
    provider: 'Fake',
    accountScope: 'Test-Account',
    capabilities: {
      [PROVIDER_CAPABILITIES.CACHE_OBSERVATION]: fakeCacheCapability(),
    },
  });

  assert.equal(adapter.provider, 'fake');
  assert.equal(adapter.accountScope, 'test-account');
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.CACHE_OBSERVATION), true);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.PLACEMENT_CREATE), false);
  assert.equal(
    typeof adapter.require(PROVIDER_CAPABILITIES.CACHE_OBSERVATION).observeCache,
    'function',
  );
  assert.throws(
    () => adapter.require(PROVIDER_CAPABILITIES.PLACEMENT_CREATE),
    UnsupportedProviderCapabilityError,
  );
});

test('provider adapter rejects malformed or invented capability contracts', () => {
  assert.throws(() => createProviderAdapter({
    provider: 'fake',
    capabilities: { imaginary: {} },
  }), /Unknown provider capability/);

  assert.throws(() => createProviderAdapter({
    provider: 'fake',
    capabilities: { [PROVIDER_CAPABILITIES.FILE_INVENTORY]: {} },
  }), /requires getFileInventory/);
});

test('cache observations preserve exact candidate identity including null versus zero', () => {
  const torrent = createCacheObservation({
    provider: 'torbox',
    accountScope: 'primary',
    scope: 'torrent',
    infoHash: HASH.toUpperCase(),
    fileIndex: null,
    state: 'cached',
    kind: 'authoritative',
    observedAt: 10_000,
    ttlMs: 1_000,
    source: 'torbox-checkcached',
  });
  const fileZero = createCacheObservation({
    provider: 'torbox',
    accountScope: 'primary',
    scope: 'candidate',
    infoHash: HASH,
    fileIndex: 0,
    state: 'cached',
    kind: 'authoritative',
    observedAt: 10_000,
    expiresAt: 11_000,
    source: 'torbox-checkcached',
  });

  assert.equal(torrent.subjectKey, HASH);
  assert.equal(torrent.fileIndex, null);
  assert.equal(fileZero.subjectKey, `${HASH}:0`);
  assert.equal(fileZero.fileIndex, 0);
  assert.notEqual(torrent.subjectKey, fileZero.subjectKey);
});

test('freshness is explicit and an expired authoritative result remains stale history', () => {
  const observation = createCacheObservation({
    provider: 'realdebrid',
    infoHash: HASH,
    fileIndex: null,
    state: 'uncached',
    kind: 'authoritative',
    observedAt: 10_000,
    expiresAt: 12_000,
    source: 'rd-instant-availability',
  });

  assert.deepEqual(evaluateObservationFreshness(observation, { now: 11_000 }), {
    freshness: 'fresh',
    fresh: true,
    ageMs: 1_000,
    expiresInMs: 1_000,
  });
  assert.deepEqual(evaluateObservationFreshness(observation, { now: 12_001 }), {
    freshness: 'stale',
    fresh: false,
    ageMs: 2_001,
    expiresInMs: -1,
  });
  assert.equal(observation.state, 'uncached');
});

test('predicted, inferred, and authoritative observations remain distinct', () => {
  const base = {
    provider: 'torbox',
    infoHash: HASH,
    fileIndex: null,
    state: 'cached',
    observedAt: 10_000,
  };
  const predicted = createCacheObservation({ ...base, kind: 'predicted', source: 'cache-prior-v1' });
  const inferred = createCacheObservation({ ...base, kind: 'inferred', source: 'torrentio-hint' });
  const authoritative = createCacheObservation({ ...base, kind: 'authoritative', source: 'torbox-api' });

  assert.equal(predicted.kind, 'predicted');
  assert.equal(inferred.kind, 'inferred');
  assert.equal(authoritative.kind, 'authoritative');
  assert.equal(toLegacyCachedState(predicted.state), true);
});

test('unknown and typed error observations never masquerade as uncached', () => {
  const unknown = createCacheObservation({
    provider: 'torbox', infoHash: HASH, fileIndex: null,
    state: 'unknown', observedAt: 10_000, source: 'batch-failure',
  });
  const error = createCacheObservation({
    provider: 'torbox', infoHash: HASH, fileIndex: null,
    state: 'error', errorCategory: 'rate-limit', retryable: true,
    retryAfterMs: 30_000, observedAt: 10_000, source: 'torbox-api',
  });

  assert.equal(toLegacyCachedState(unknown.state), null);
  assert.equal(toLegacyCachedState(error.state), null);
  assert.equal(error.errorCategory, 'rate-limit');
  assert.equal(error.retryable, true);
  assert.throws(() => createCacheObservation({
    provider: 'torbox', infoHash: HASH, fileIndex: null,
    state: 'error', observedAt: 10_000,
  }), /require errorCategory/);
});

test('provider errors carry retry and rate-limit metadata without provider-specific branching', () => {
  const classified = classifyProviderError(Object.assign(new Error('slow down'), {
    status: 429,
    retryAfterMs: 3_000,
    rateLimit: { limit: 100, remaining: 0, resetAt: 20_000 },
  }), { provider: 'torbox', operation: 'observe-cache' });

  assert.ok(classified instanceof ProviderOperationError);
  assert.equal(classified.category, 'rate-limit');
  assert.equal(classified.retryable, true);
  assert.equal(classified.retryAfterMs, 3_000);
  assert.deepEqual(classified.rateLimit, { limit: 100, remaining: 0, resetAt: 20_000 });

  const auth = classifyProviderError(Object.assign(new Error('bad token'), { status: 401 }), {
    provider: 'realdebrid', operation: 'observe-cache',
  });
  assert.equal(auth.category, 'authentication');
  assert.equal(auth.retryable, false);
});

test('resource observations keep placement, file inventory, and exposure authority separate', () => {
  const placement = createPlacementObservation({
    provider: 'TorBox', accountScope: 'Primary', infoHash: HASH,
    providerResourceId: 'torrent-7', state: 'ready', ownership: 'external',
    provenance: 'fixture:mylist-v1', observedAt: 10_000, ttlMs: 2_000,
  });
  const inventory = createProviderFileInventory({
    provider: 'torbox', accountScope: 'primary', providerResourceId: 'torrent-7',
    authoritative: true, complete: true, observedAt: 10_000, expiresAt: 12_000,
    files: [{
      providerFileId: 'file-900', path: '/Release/movie.mkv', name: 'movie.mkv',
      size: 1_000, selected: true, corpusFileIndex: 0,
    }],
  });
  const exposure = createExposureObservation({
    provider: 'torbox', accountScope: 'primary', mountScope: 'living-room',
    providerResourceId: 'torrent-7', providerFileId: 'file-900',
    transport: 'torbox-webdav-rclone', exposureKey: 'torrent-7:file-900',
    relativePath: '/Release/movie.mkv', state: 'visible', readOnly: true,
    observedAt: 10_000, ttlMs: 500,
  });

  assert.equal(placement.infoHash, HASH);
  assert.equal(placement.fileIndex, null);
  assert.equal(inventory.files[0].corpusFileIndex, 0);
  assert.equal(inventory.files[0].providerFileId, 'file-900');
  assert.equal(exposure.readOnly, true);
  assert.equal(exposure.mountScope, 'living-room');
  assert.equal(Object.hasOwn(placement, 'files'), false);
  assert.equal(Object.hasOwn(inventory, 'state'), false);
  assert.equal(Object.hasOwn(exposure, 'ownership'), false);
});

test('resource observations reject unsafe ownership and ambiguous inventory evidence', () => {
  assert.throws(() => createPlacementObservation({
    provider: 'torbox', infoHash: HASH, providerResourceId: 'torrent-7',
    state: 'ready', ownership: 'owned', provenance: 'fixture', observedAt: 10_000,
  }), /requires ownerKey/);

  assert.throws(() => createProviderFileInventory({
    provider: 'torbox', providerResourceId: 'torrent-7', observedAt: 10_000,
    files: [
      { providerFileId: 'same', path: '/a', name: 'a' },
      { providerFileId: 'same', path: '/b', name: 'b' },
    ],
  }), /Duplicate providerFileId/);

  assert.throws(() => createProviderFileInventory({
    provider: 'torbox', providerResourceId: 'torrent-7', observedAt: 10_000,
    files: [{ providerFileId: 'file', path: '/a', name: 'a', corpusFileIndex: 1.5 }],
  }), /corpusFileIndex/);
});
