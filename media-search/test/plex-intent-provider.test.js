/**
 * Plex Intent Provider Tests
 *
 * Tests for the Plex watchlist provider implementation.
 * Mocks Plex HTTP responses to avoid requiring a real Plex server.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { PlexIntentProvider, createPlexProvider } from '../src/lib/intents/providers/plex.js';
import { MediaIntentIngestionService } from '../src/lib/intents/ingestion.js';
import { MediaIntentProviderRegistry } from '../src/lib/intents/registry.js';

// =============================================================================
// Mock fetch for Plex API
// =============================================================================

let mockFetch = null;
let originalFetch = globalThis.fetch;

function setupMockFetch(handler) {
  mockFetch = handler;
  globalThis.fetch = mockFetch;
}

function teardownMockFetch() {
  globalThis.fetch = originalFetch;
  mockFetch = null;
}

// =============================================================================
// Test: PlexIntentProvider requires URL and token
// =============================================================================

test('plex: requires PLEX_URL and PLEX_TOKEN', async () => {
  const provider = new PlexIntentProvider({ url: '', token: '' });

  await assert.rejects(
    () => provider.fetchIntents({}),
    /PLEX_URL and PLEX_TOKEN/
  );
});

test('plex: accepts config', () => {
  const provider = new PlexIntentProvider({
    url: 'http://localhost:32400',
    token: 'test-token',
  });

  assert.equal(provider.url, 'http://localhost:32400');
  assert.equal(provider.token, 'test-token');
  assert.equal(provider.name, 'plex');
  assert.equal(provider.type, 'watchlist');
});

test('plex: supports returns true for plex', () => {
  const provider = new PlexIntentProvider({
    url: 'http://localhost:32400',
    token: 'test-token',
  });

  assert.equal(provider.supports('plex'), true);
  assert.equal(provider.supports('watchlist'), true);
  assert.equal(provider.supports('cli'), false);
});

// =============================================================================
// Test: Plex response normalization
// =============================================================================

test('plex: normalizes movie watchlist item', async () => {
  setupMockFetch(async (url, options) => {
    assert.ok(url.includes('/watchlist'));
    assert.equal(options.headers['X-Plex-Token'], 'test-token');

    return {
      ok: true,
      status: 200,
      json: async () => ({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '12345',
              type: 'movie',
              title: 'The Matrix',
              guid: 'imdb://tt0133093',
              year: 1999,
            },
          ],
        },
      }),
    };
  });

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const intents = await provider.fetchIntents({});

    assert.equal(intents.length, 1);
    assert.equal(intents[0].mediaId, 'tt0133093');
    assert.equal(intents[0].mediaType, 'movie');
    assert.equal(intents[0].source, 'plex');
    assert.equal(intents[0].sourceType, 'watchlist');
    assert.equal(intents[0].sourceId, '12345');
    assert.equal(intents[0].sourceLabel, 'The Matrix');
    assert.equal(intents[0].season, null);
    assert.equal(intents[0].episode, null);
  } finally {
    teardownMockFetch();
  }
});

test('plex: normalizes series watchlist item', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '67890',
            type: 'show',
            title: 'Family Guy',
            guid: 'imdb://tt0182576',
            parentIndex: 5,
            index: 12,
          },
        ],
      },
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const intents = await provider.fetchIntents({});

    assert.equal(intents.length, 1);
    assert.equal(intents[0].mediaId, 'tt0182576');
    assert.equal(intents[0].mediaType, 'series');
    assert.equal(intents[0].season, 5);
    assert.equal(intents[0].episode, 12);
  } finally {
    teardownMockFetch();
  }
});

test('plex: normalizes season watchlist item', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '11111',
            type: 'season',
            title: 'Breaking Bad Season 3',
            guid: 'imdb://tt0903747',
            parentIndex: 3,
          },
        ],
      },
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const intents = await provider.fetchIntents({});

    assert.equal(intents.length, 1);
    assert.equal(intents[0].mediaType, 'series');
    assert.equal(intents[0].season, 3);
    assert.equal(intents[0].episode, null);
  } finally {
    teardownMockFetch();
  }
});

test('plex: normalizes episode watchlist item', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '22222',
            type: 'episode',
            title: 'The Office - Pilot',
            guid: 'imdb://tt0386676',
            parentIndex: 1,
            index: 1,
          },
        ],
      },
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const intents = await provider.fetchIntents({});

    assert.equal(intents.length, 1);
    assert.equal(intents[0].mediaType, 'series');
    assert.equal(intents[0].season, 1);
    assert.equal(intents[0].episode, 1);
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: Missing metadata handling
// =============================================================================

test('plex: skips items without ratingKey', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [
          { type: 'movie', title: 'No Rating Key', guid: 'imdb://tt1111111' },
        ],
      },
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const intents = await provider.fetchIntents({});
    assert.equal(intents.length, 0);
  } finally {
    teardownMockFetch();
  }
});

test('plex: skips items without media ID', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [
          { ratingKey: '33333', type: 'movie', title: 'No GUID' },
        ],
      },
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const intents = await provider.fetchIntents({});
    assert.equal(intents.length, 0);
  } finally {
    teardownMockFetch();
  }
});

test('plex: skips items with unknown type', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [
          { ratingKey: '44444', type: 'clip', title: 'Trailer', guid: 'imdb://tt2222222' },
        ],
      },
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const intents = await provider.fetchIntents({});
    assert.equal(intents.length, 0);
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: Invalid Plex responses
// =============================================================================

test('plex: handles empty watchlist', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [],
      },
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const intents = await provider.fetchIntents({});
    assert.equal(intents.length, 0);
  } finally {
    teardownMockFetch();
  }
});

test('plex: handles missing Metadata array', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {},
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const intents = await provider.fetchIntents({});
    assert.equal(intents.length, 0);
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: Authentication/config failures
// =============================================================================

test('plex: throws on 401 authentication failure', async () => {
  setupMockFetch(async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'bad-token',
    });

    await assert.rejects(
      () => provider.fetchIntents({}),
      /authentication failed/
    );
  } finally {
    teardownMockFetch();
  }
});

test('plex: throws on 500 server error', async () => {
  setupMockFetch(async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    await assert.rejects(
      () => provider.fetchIntents({}),
      /Plex API error: 500/
    );
  } finally {
    teardownMockFetch();
  }
});

test('plex: throws on network error', async () => {
  setupMockFetch(async () => {
    throw new Error('ECONNREFUSED');
  });

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    await assert.rejects(
      () => provider.fetchIntents({}),
      /ECONNREFUSED/
    );
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: Provider registration
// =============================================================================

test('plex: registers with registry', async () => {
  const registry = new MediaIntentProviderRegistry();
  const provider = new PlexIntentProvider({
    url: 'http://localhost:32400',
    token: 'test-token',
  });

  await registry.register(provider);

  assert.equal(registry.has('plex'), true);
  assert.equal(registry.findBySource('plex'), provider);
});

test('plex: registry list includes plex', async () => {
  const registry = new MediaIntentProviderRegistry();
  const provider = new PlexIntentProvider({
    url: 'http://localhost:32400',
    token: 'test-token',
  });

  await registry.register(provider);

  const list = registry.list();
  const plex = list.find(p => p.name === 'plex');

  assert.ok(plex);
  assert.equal(plex.type, 'watchlist');
  assert.equal(plex.enabled, true);
});

// =============================================================================
// Test: Integration with ingestion service
// =============================================================================

test('plex: integrates with ingestion service', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '12345',
            type: 'movie',
            title: 'The Matrix',
            guid: 'imdb://tt0133093',
          },
          {
            ratingKey: '67890',
            type: 'show',
            title: 'Family Guy',
            guid: 'imdb://tt0182576',
            parentIndex: 5,
            index: 12,
          },
        ],
      },
    }),
  }));

  try {
    const cache = createDiscoveryCache();
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const ingestion = new MediaIntentIngestionService(cache, provider);
    const result = await ingestion.ingestFromProvider(provider);

    assert.equal(result.fetch.intentCount, 2);
    assert.equal(result.ingestion.created, 2);
    assert.equal(result.ingestion.skipped, 0);

    // Verify intents were persisted
    const stats = cache.getMediaIntentStats();
    assert.equal(stats.total_intents, 2);
    assert.equal(stats.unique_media, 2);

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

test('plex: ingestion handles provider errors gracefully', async () => {
  setupMockFetch(async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
  }));

  try {
    const cache = createDiscoveryCache();
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'bad-token',
    });

    const ingestion = new MediaIntentIngestionService(cache);

    // ingestFromProvider should throw on provider error
    await assert.rejects(
      () => ingestion.ingestFromProvider(provider),
      /authentication failed/
    );

    cache.close();
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: createPlexProvider factory
// =============================================================================

test('plex: createPlexProvider uses env vars', () => {
  process.env.PLEX_URL = 'http://plex:32400';
  process.env.PLEX_TOKEN = 'env-token';
  process.env.PLEX_USERNAME = 'testuser';

  try {
    const provider = createPlexProvider();

    assert.equal(provider.url, 'http://plex:32400');
    assert.equal(provider.token, 'env-token');
    assert.equal(provider.username, 'testuser');
  } finally {
    delete process.env.PLEX_URL;
    delete process.env.PLEX_TOKEN;
    delete process.env.PLEX_USERNAME;
  }
});

test('plex: createPlexProvider allows overrides', () => {
  process.env.PLEX_URL = 'http://plex:32400';
  process.env.PLEX_TOKEN = 'env-token';

  try {
    const provider = createPlexProvider({
      url: 'http://override:32400',
      token: 'override-token',
    });

    assert.equal(provider.url, 'http://override:32400');
    assert.equal(provider.token, 'override-token');
  } finally {
    delete process.env.PLEX_URL;
    delete process.env.PLEX_TOKEN;
  }
});

// =============================================================================
// Test: validateIntent preserves Plex source
// =============================================================================

test('plex: validateIntent preserves Plex source metadata', () => {
  const provider = new PlexIntentProvider({
    url: 'http://localhost:32400',
    token: 'test-token',
  });

  const validated = provider.validateIntent({
    mediaId: 'tt0133093',
    mediaType: 'movie',
    source: 'plex',
    sourceType: 'watchlist',
    sourceId: '12345',
    sourceLabel: 'The Matrix',
  });

  assert.equal(validated.source, 'plex');
  assert.equal(validated.sourceType, 'watchlist');
});

// =============================================================================
// Test: requestedBy from config
// =============================================================================

test('plex: requestedBy from config', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '12345',
            type: 'movie',
            title: 'The Matrix',
            guid: 'imdb://tt0133093',
          },
        ],
      },
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
      username: 'john.doe',
    });

    const intents = await provider.fetchIntents({});
    assert.equal(intents[0].requestedBy, 'john.doe');
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: TMDB GUID extraction
// =============================================================================

test('plex: extracts TMDB ID from GUID', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '12345',
            type: 'movie',
            title: 'TMDB Movie',
            guid: 'tmdb://12345',
          },
        ],
      },
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const intents = await provider.fetchIntents({});
    assert.equal(intents[0].mediaId, '12345');
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: Guid array format (newer Plex API)
// =============================================================================

test('plex: extracts ID from Guid array', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '12345',
            type: 'movie',
            title: 'Array Guid Movie',
            Guid: [{ id: 'imdb://tt9999999' }],
          },
        ],
      },
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const intents = await provider.fetchIntents({});
    assert.equal(intents[0].mediaId, 'tt9999999');
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: Logging
// =============================================================================

test('plex: logs when log function provided', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '12345',
            type: 'movie',
            title: 'The Matrix',
            guid: 'imdb://tt0133093',
          },
        ],
      },
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const logs = [];
    await provider.fetchIntents({ log: (msg) => logs.push(msg) });

    assert.ok(logs.length >= 2);
    assert.ok(logs.some(l => l.includes('Fetching Plex watchlist')));
    assert.ok(logs.some(l => l.includes('Fetched 1 intents')));
  } finally {
    teardownMockFetch();
  }
});

// =============================================================================
// Test: Multiple items with mixed validity
// =============================================================================

test('plex: handles mixed valid/invalid items', async () => {
  setupMockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '12345',
            type: 'movie',
            title: 'Valid Movie',
            guid: 'imdb://tt0133093',
          },
          {
            ratingKey: '67890',
            type: 'clip',
            title: 'Invalid Type',
            guid: 'imdb://tt0000000',
          },
          {
            ratingKey: '11111',
            type: 'movie',
            title: 'No GUID',
          },
          {
            ratingKey: '22222',
            type: 'show',
            title: 'Valid Show',
            guid: 'imdb://tt0182576',
            parentIndex: 1,
            index: 1,
          },
        ],
      },
    }),
  }));

  try {
    const provider = new PlexIntentProvider({
      url: 'http://localhost:32400',
      token: 'test-token',
    });

    const intents = await provider.fetchIntents({});
    assert.equal(intents.length, 2);
    assert.equal(intents[0].sourceLabel, 'Valid Movie');
    assert.equal(intents[1].sourceLabel, 'Valid Show');
  } finally {
    teardownMockFetch();
  }
});
