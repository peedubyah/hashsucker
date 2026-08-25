/**
 * Media Intent Provider Tests
 *
 * Tests for the provider interface, registry, and CLI reference implementation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import {
  MediaIntentProvider,
  INTENT_STATUS,
  INTENT_PRIORITY,
} from '../src/lib/intents/types.js';
import {
  MediaIntentProviderRegistry,
  INTENT_PROVIDER_TYPE,
} from '../src/lib/intents/registry.js';
import { CliIntentProvider } from '../src/lib/intents/cli-provider.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// =============================================================================
// Test: MediaIntentProvider base class validates required fields
// =============================================================================

test('provider: base class requires name and type', () => {
  assert.throws(() => new MediaIntentProvider(), /name/);
  assert.throws(() => new MediaIntentProvider('', 'type'), /name/);
  assert.throws(() => new MediaIntentProvider('test', ''), /type/);
});

test('provider: base class accepts valid config', () => {
  const provider = new MediaIntentProvider('test', 'manual');
  assert.equal(provider.name, 'test');
  assert.equal(provider.type, 'manual');
  assert.equal(provider.enabled, true);
});

test('provider: base class respects disabled config', () => {
  const provider = new MediaIntentProvider('test', 'manual', { enabled: false });
  assert.equal(provider.enabled, false);
});

// =============================================================================
// Test: validateIntent rejects invalid intents
// =============================================================================

test('provider: validateIntent rejects missing mediaId', () => {
  const provider = new MediaIntentProvider('test', 'manual');
  assert.throws(
    () => provider.validateIntent({ mediaType: 'movie' }),
    /mediaId/
  );
});

test('provider: validateIntent rejects invalid mediaType', () => {
  const provider = new MediaIntentProvider('test', 'manual');
  assert.throws(
    () => provider.validateIntent({ mediaId: 'tt123', mediaType: 'invalid' }),
    /mediaType/
  );
});

test('provider: validateIntent rejects negative season', () => {
  const provider = new MediaIntentProvider('test', 'manual');
  assert.throws(
    () => provider.validateIntent({ mediaId: 'tt123', mediaType: 'series', season: -1 }),
    /season/
  );
});

test('provider: validateIntent rejects negative episode', () => {
  const provider = new MediaIntentProvider('test', 'manual');
  assert.throws(
    () => provider.validateIntent({ mediaId: 'tt123', mediaType: 'series', season: 1, episode: -1 }),
    /episode/
  );
});

test('provider: validateIntent rejects movie with season', () => {
  const provider = new MediaIntentProvider('test', 'manual');
  assert.throws(
    () => provider.validateIntent({ mediaId: 'tt123', mediaType: 'movie', season: 1 }),
    /Movie intents must not have season/
  );
});

test('provider: validateIntent rejects series episode without season', () => {
  const provider = new MediaIntentProvider('test', 'manual');
  assert.throws(
    () => provider.validateIntent({ mediaId: 'tt123', mediaType: 'series', episode: 5 }),
    /episode/
  );
});

test('provider: validateIntent accepts valid movie', () => {
  const provider = new MediaIntentProvider('test', 'manual');
  const intent = provider.validateIntent({ mediaId: 'tt123', mediaType: 'movie' });
  assert.equal(intent.mediaId, 'tt123');
  assert.equal(intent.mediaType, 'movie');
  assert.equal(intent.season, null);
  assert.equal(intent.episode, null);
});

test('provider: validateIntent accepts valid series', () => {
  const provider = new MediaIntentProvider('test', 'manual');
  const intent = provider.validateIntent({ mediaId: 'tt123', mediaType: 'series', season: 5, episode: 12 });
  assert.equal(intent.mediaId, 'tt123');
  assert.equal(intent.mediaType, 'series');
  assert.equal(intent.season, 5);
  assert.equal(intent.episode, 12);
});

test('provider: validateIntent accepts season-only series', () => {
  const provider = new MediaIntentProvider('test', 'manual');
  const intent = provider.validateIntent({ mediaId: 'tt123', mediaType: 'series', season: 5 });
  assert.equal(intent.season, 5);
  assert.equal(intent.episode, null);
});

// =============================================================================
// Test: validateIntent normalizes fields
// =============================================================================

test('provider: validateIntent sets defaults', () => {
  const provider = new MediaIntentProvider('myprovider', 'manual');
  const intent = provider.validateIntent({ mediaId: 'tt123', mediaType: 'movie' });
  assert.equal(intent.source, 'myprovider');
  assert.equal(intent.status, INTENT_STATUS.ACTIVE);
  assert.equal(intent.priority, 0);
});

test('provider: validateIntent preserves provided values', () => {
  const provider = new MediaIntentProvider('myprovider', 'manual');
  const intent = provider.validateIntent({
    mediaId: 'tt123',
    mediaType: 'series',
    season: 1,
    episode: 1,
    source: 'custom',
    status: 'completed',
    priority: 10,
  });
  assert.equal(intent.source, 'custom');
  assert.equal(intent.status, 'completed');
  assert.equal(intent.priority, 10);
});

// =============================================================================
// Test: Registry register and discover providers
// =============================================================================

test('registry: register adds provider', async () => {
  const registry = new MediaIntentProviderRegistry();
  const provider = new CliIntentProvider();

  await registry.register(provider);
  assert.equal(registry.has('cli'), true);
  assert.equal(registry.get('cli'), provider);
});

test('registry: register throws on duplicate', async () => {
  const registry = new MediaIntentProviderRegistry();
  const provider1 = new CliIntentProvider();
  const provider2 = new MediaIntentProvider('cli', 'manual');

  await registry.register(provider1);
  await assert.rejects(
    () => registry.register(provider2),
    /already registered/
  );
});

test('registry: register calls onRegister hook', async () => {
  let called = false;
  class TestProvider extends MediaIntentProvider {
    async onRegister() { called = true; }
  }

  const registry = new MediaIntentProviderRegistry();
  await registry.register(new TestProvider('test', 'manual'));
  assert.equal(called, true);
});

test('registry: unregister removes provider', async () => {
  const registry = new MediaIntentProviderRegistry();
  const provider = new CliIntentProvider();

  await registry.register(provider);
  assert.equal(registry.has('cli'), true);

  await registry.unregister('cli');
  assert.equal(registry.has('cli'), false);
});

test('registry: unregister throws if not found', async () => {
  const registry = new MediaIntentProviderRegistry();
  await assert.rejects(
    () => registry.unregister('nonexistent'),
    /not registered/
  );
});

test('registry: unregister calls onUnregister hook', async () => {
  let called = false;
  class TestProvider extends MediaIntentProvider {
    async onUnregister() { called = true; }
  }

  const registry = new MediaIntentProviderRegistry();
  const provider = new TestProvider('test', 'manual');
  await registry.register(provider);
  await registry.unregister('test');
  assert.equal(called, true);
});

// =============================================================================
// Test: Registry list and stats
// =============================================================================

test('registry: list returns all providers', async () => {
  const registry = new MediaIntentProviderRegistry();
  await registry.register(new CliIntentProvider());
  await registry.register(new MediaIntentProvider('test', 'manual'));

  const list = registry.list();
  assert.equal(list.length, 2);
  assert.ok(list.some(p => p.name === 'cli'));
  assert.ok(list.some(p => p.name === 'test'));
});

test('registry: getStats returns counts', async () => {
  const registry = new MediaIntentProviderRegistry();
  await registry.register(new CliIntentProvider());
  await registry.register(new MediaIntentProvider('test1', 'manual'));
  await registry.register(new MediaIntentProvider('test2', 'watchlist'));

  const stats = registry.getStats();
  assert.equal(stats.total, 3);
  assert.equal(stats.enabled, 3);
  assert.equal(stats.disabled, 0);
  assert.equal(stats.byType.manual, 2);
  assert.equal(stats.byType.watchlist, 1);
});

// =============================================================================
// Test: Registry findBySource
// =============================================================================

test('registry: findBySource matches provider', async () => {
  const registry = new MediaIntentProviderRegistry();
  await registry.register(new CliIntentProvider());

  const provider = registry.findBySource('cli');
  assert.ok(provider, 'Should find provider');
  assert.equal(provider.name, 'cli');
});

test('registry: findBySource returns undefined for unknown', async () => {
  const registry = new MediaIntentProviderRegistry();
  await registry.register(new CliIntentProvider());

  const provider = registry.findBySource('unknown');
  assert.equal(provider, undefined);
});

test('registry: findBySource respects supports() method', async () => {
  class PlexProvider extends MediaIntentProvider {
    supports(source) { return source === 'plex' || source === 'plex_watchlist'; }
  }

  const registry = new MediaIntentProviderRegistry();
  await registry.register(new PlexProvider('plex', 'watchlist'));

  assert.ok(registry.findBySource('plex'), 'Should match plex');
  assert.ok(registry.findBySource('plex_watchlist'), 'Should match plex_watchlist');
  assert.equal(registry.findBySource('cli'), undefined, 'Should not match cli');
});

// =============================================================================
// Test: Registry fetchAllIntents
// =============================================================================

test('registry: fetchAllIntents calls all enabled providers', async () => {
  class Provider1 extends MediaIntentProvider {
    async fetchIntents() { return [{ mediaId: 'tt1', mediaType: 'movie' }]; }
  }
  class Provider2 extends MediaIntentProvider {
    async fetchIntents() { return [{ mediaId: 'tt2', mediaType: 'series', season: 1, episode: 1 }]; }
  }

  const registry = new MediaIntentProviderRegistry();
  await registry.register(new Provider1('p1', 'manual'));
  await registry.register(new Provider2('p2', 'watchlist'));

  const results = await registry.fetchAllIntents();
  assert.equal(results.length, 2);
  assert.equal(results[0].intents.length, 1);
  assert.equal(results[1].intents.length, 1);
  assert.equal(results[0].intents[0].mediaId, 'tt1');
  assert.equal(results[1].intents[0].mediaId, 'tt2');
});

test('registry: fetchAllIntents skips disabled providers', async () => {
  class Provider1 extends MediaIntentProvider {
    async fetchIntents() { return [{ mediaId: 'tt1', mediaType: 'movie' }]; }
  }
  class Provider2 extends MediaIntentProvider {
    constructor() { super('p2', 'manual', { enabled: false }); }
    async fetchIntents() { return [{ mediaId: 'tt2', mediaType: 'movie' }]; }
  }

  const registry = new MediaIntentProviderRegistry();
  await registry.register(new Provider1('p1', 'manual'));
  await registry.register(new Provider2());

  const results = await registry.fetchAllIntents();
  assert.equal(results.length, 1, 'Only enabled provider should be called');
  assert.equal(results[0].provider, 'p1');
});

test('registry: fetchAllIntents handles provider errors', async () => {
  class BadProvider extends MediaIntentProvider {
    async fetchIntents() { throw new Error('Provider failure'); }
  }

  const registry = new MediaIntentProviderRegistry();
  await registry.register(new BadProvider('bad', 'manual'));

  const results = await registry.fetchAllIntents();
  assert.equal(results.length, 1);
  assert.equal(results[0].intents.length, 0);
  assert.ok(results[0].error, 'Should have error field');
});

// =============================================================================
// Test: Registry fetchFromProvider
// =============================================================================

test('registry: fetchFromProvider calls specific provider', async () => {
  class Provider1 extends MediaIntentProvider {
    async fetchIntents() { return [{ mediaId: 'tt1', mediaType: 'movie' }]; }
  }

  const registry = new MediaIntentProviderRegistry();
  await registry.register(new Provider1('p1', 'manual'));

  const intents = await registry.fetchFromProvider('p1');
  assert.equal(intents.length, 1);
  assert.equal(intents[0].mediaId, 'tt1');
});

test('registry: fetchFromProvider throws for unknown provider', async () => {
  const registry = new MediaIntentProviderRegistry();
  await assert.rejects(
    () => registry.fetchFromProvider('nonexistent'),
    /not registered/
  );
});

test('registry: fetchFromProvider throws for disabled provider', async () => {
  class DisabledProvider extends MediaIntentProvider {
    constructor() { super('disabled', 'manual', { enabled: false }); }
    async fetchIntents() { return []; }
  }

  const registry = new MediaIntentProviderRegistry();
  await registry.register(new DisabledProvider());

  await assert.rejects(
    () => registry.fetchFromProvider('disabled'),
    /disabled/
  );
});

// =============================================================================
// Test: CLI provider normalizes raw input
// =============================================================================

test('cli-provider: normalizeRawIntent handles mediaId', () => {
  const provider = new CliIntentProvider();
  const intent = provider.normalizeRawIntent({ mediaId: 'tt123', mediaType: 'movie' });
  assert.equal(intent.mediaId, 'tt123');
  assert.equal(intent.mediaType, 'movie');
});

test('cli-provider: normalizeRawIntent handles id alias', () => {
  const provider = new CliIntentProvider();
  const intent = provider.normalizeRawIntent({ id: 'tt123', type: 'series', season: 1, episode: 1 });
  assert.equal(intent.mediaId, 'tt123');
  assert.equal(intent.mediaType, 'series');
});

test('cli-provider: normalizeRawIntent defaults source to cli', () => {
  const provider = new CliIntentProvider();
  const intent = provider.normalizeRawIntent({ mediaId: 'tt123', mediaType: 'movie' });
  assert.equal(intent.source, 'cli');
});

test('cli-provider: normalizeRawIntent preserves custom source', () => {
  const provider = new CliIntentProvider();
  const intent = provider.normalizeRawIntent({ mediaId: 'tt123', mediaType: 'movie', source: 'custom' });
  assert.equal(intent.source, 'custom');
});

test('cli-provider: normalizeRawIntent handles label alias', () => {
  const provider = new CliIntentProvider();
  const intent = provider.normalizeRawIntent({ mediaId: 'tt123', mediaType: 'movie', label: 'My Movie' });
  assert.equal(intent.sourceLabel, 'My Movie');
});

// =============================================================================
// Test: CLI provider fetchIntents
// =============================================================================

test('cli-provider: fetchIntents returns validated intents', async () => {
  const provider = new CliIntentProvider({
    intents: [
      { mediaId: 'tt123', mediaType: 'movie' },
      { mediaId: 'tt456', mediaType: 'series', season: 1, episode: 1 },
    ],
  });

  const intents = await provider.fetchIntents();
  assert.equal(intents.length, 2);
  assert.equal(intents[0].mediaId, 'tt123');
  assert.equal(intents[1].mediaId, 'tt456');
});

test('cli-provider: fetchIntents skips invalid intents', async () => {
  const provider = new CliIntentProvider({
    intents: [
      { mediaId: 'tt123', mediaType: 'movie' },
      { mediaType: 'movie' }, // missing mediaId
      { mediaId: 'tt456', mediaType: 'series', season: 1, episode: 1 },
    ],
  });

  const intents = await provider.fetchIntents();
  assert.equal(intents.length, 2);
  assert.equal(intents[0].mediaId, 'tt123');
  assert.equal(intents[1].mediaId, 'tt456');
});

test('cli-provider: fetchIntents accepts options.intents', async () => {
  const provider = new CliIntentProvider();
  const intents = await provider.fetchIntents({
    intents: [{ mediaId: 'tt789', mediaType: 'movie' }],
  });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].mediaId, 'tt789');
});

test('cli-provider: fetchIntents with logs warnings', async () => {
  const logs = [];
  const provider = new CliIntentProvider({
    intents: [{ mediaType: 'movie' }], // invalid
  });

  const intents = await provider.fetchIntents({ log: (msg) => logs.push(msg) });
  assert.equal(intents.length, 0);
  assert.ok(logs.length > 0, 'Should have logged warning');
});

// =============================================================================
// Test: CLI provider addIntent and clearIntents
// =============================================================================

test('cli-provider: addIntent appends to stored intents', () => {
  const provider = new CliIntentProvider();
  assert.equal(provider.size(), 0);

  provider.addIntent({ mediaId: 'tt123', mediaType: 'movie' });
  assert.equal(provider.size(), 1);
});

test('cli-provider: clearIntents empties stored intents', () => {
  const provider = new CliIntentProvider();
  provider.addIntent({ mediaId: 'tt123', mediaType: 'movie' });
  provider.clearIntents();
  assert.equal(provider.size(), 0);
});

// =============================================================================
// Test: CLI provider supports() method
// =============================================================================

test('cli-provider: supports returns true for cli', () => {
  const provider = new CliIntentProvider();
  assert.equal(provider.supports('cli'), true);
  assert.equal(provider.supports('manual'), true);
  assert.equal(provider.supports('plex'), false);
});

// =============================================================================
// Test: CLI provider end-to-end with cache
// =============================================================================

test('cli-provider: end-to-end fetch and persist', async () => {
  const cache = createDiscoveryCache();
  const provider = new CliIntentProvider({
    intents: [
      { mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, label: 'Family Guy' },
      { mediaId: 'tt0133093', mediaType: 'movie', label: 'The Matrix' },
    ],
  });

  const intents = await provider.fetchIntents({ cache });
  assert.equal(intents.length, 2);

  for (const intent of intents) {
    cache.upsertMediaIntent({
      mediaId: intent.mediaId,
      mediaType: intent.mediaType,
      season: intent.season,
      episode: intent.episode,
      source: intent.source,
      sourceType: intent.sourceType,
      sourceLabel: intent.sourceLabel,
    });
  }

  const stats = cache.getMediaIntentStats();
  assert.equal(stats.total_intents, 2);
  assert.equal(stats.total_requests, 2);

  cache.close();
});
