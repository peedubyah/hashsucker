/**
 * Identity Resolver Tests
 *
 * Proves the resolver interface contract:
 *   resolver.resolveIdentity() → { matches: [{ mediaId, mediaType, confidence, evidence }] }
 *
 * Tests:
 * - BaseIdentityResolver cannot be instantiated directly
 * - NoopIdentityResolver returns empty matches
 * - CompositeIdentityResolver tries resolvers in order
 * - Custom resolver implementation works
 * - canResolve() filtering works
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BaseIdentityResolver,
  CompositeIdentityResolver,
  NoopIdentityResolver,
  ResolverError,
} from '../src/lib/discovery/identity-resolver.js';

const CANDIDATE = {
  infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  fileIndex: null,
  filename: 'Breaking.Bad.S05E14.1080p.BluRay.x264-TEST.mkv',
  title: 'Breaking Bad S05E14',
};

const PARSED_ATTRIBUTES = {
  title: 'Breaking Bad',
  year: 2013,
  season: 5,
  episode: 14,
  mediaType: 'series',
  resolution: '1080p',
  sourceType: 'BluRay',
  codec: 'x264',
  confidence: 0.85,
  evidence: ['title_extracted', 'season_episode_extracted'],
};

// =============================================================================
// Base Resolver Tests
// =============================================================================

test('BaseIdentityResolver requires subclass implementation', () => {
  const resolver = new BaseIdentityResolver({ sourceName: 'test' });

  return assert.rejects(
    () => resolver.resolveIdentity({ candidate: CANDIDATE, parsedAttributes: PARSED_ATTRIBUTES }),
    { message: 'Subclasses must implement resolveIdentity()' },
  );
});

test('BaseIdentityResolver has default properties', () => {
  const resolver = new BaseIdentityResolver({ sourceName: 'test', version: '2.0.0' });

  assert.equal(resolver.sourceName, 'test');
  assert.equal(resolver.version, '2.0.0');
  assert.equal(resolver.enabled, true);
});

test('BaseIdentityResolver canResolve returns true by default', () => {
  const resolver = new BaseIdentityResolver({ sourceName: 'test' });

  assert.equal(resolver.canResolve({ candidate: CANDIDATE, parsedAttributes: PARSED_ATTRIBUTES }), true);
});

test('BaseIdentityResolver canResolve returns false when disabled', () => {
  const resolver = new BaseIdentityResolver({ sourceName: 'test', enabled: false });

  assert.equal(resolver.canResolve({ candidate: CANDIDATE, parsedAttributes: PARSED_ATTRIBUTES }), false);
});

// =============================================================================
// Noop Resolver Tests
// =============================================================================

test('NoopIdentityResolver returns empty matches', async () => {
  const resolver = new NoopIdentityResolver();

  const result = await resolver.resolveIdentity({ candidate: CANDIDATE, parsedAttributes: PARSED_ATTRIBUTES });

  assert.deepEqual(result, {
    matches: [],
    resolverSource: 'noop',
    resolverVersion: '1.0.0',
  });
});

test('NoopIdentityResolver sourceName is noop', () => {
  const resolver = new NoopIdentityResolver();
  assert.equal(resolver.sourceName, 'noop');
});

// =============================================================================
// Custom Resolver Implementation Test
// =============================================================================

test('custom resolver can return matches', async () => {
  class TestResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'test-provider', version: '1.0.0' });
    }

    async resolveIdentity({ candidate, parsedAttributes }) {
      return {
        matches: [
          {
            mediaId: 'tt0903747',
            mediaType: 'series',
            confidence: 0.95,
            evidence: ['title_exact_match', 'year_match'],
          },
        ],
      };
    }
  }

  const resolver = new TestResolver();
  const result = await resolver.resolveIdentity({ candidate: CANDIDATE, parsedAttributes: PARSED_ATTRIBUTES });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].mediaId, 'tt0903747');
  assert.equal(result.matches[0].mediaType, 'series');
  assert.equal(result.matches[0].confidence, 0.95);
  assert.deepEqual(result.matches[0].evidence, ['title_exact_match', 'year_match']);
});

// =============================================================================
// Composite Resolver Tests
// =============================================================================

test('CompositeIdentityResolver returns first non-empty result', async () => {
  class FailingResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'failing' });
    }
    async resolveIdentity() {
      return { matches: [] };
    }
  }

  class SuccessResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'success', version: '2.0.0' });
    }
    async resolveIdentity() {
      return {
        matches: [
          { mediaId: 'tt1234567', mediaType: 'movie', confidence: 0.9, evidence: ['exact'] },
        ],
      };
    }
  }

  const composite = new CompositeIdentityResolver({ sourceName: 'composite' });
  composite.addResolver(new FailingResolver());
  composite.addResolver(new SuccessResolver());

  const result = await composite.resolveIdentity({ candidate: CANDIDATE, parsedAttributes: PARSED_ATTRIBUTES });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].mediaId, 'tt1234567');
  assert.equal(result.resolverSource, 'success');
  assert.equal(result.resolverVersion, '2.0.0');
});

test('CompositeIdentityResolver returns empty when all fail', async () => {
  class EmptyResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'empty' });
    }
    async resolveIdentity() {
      return { matches: [] };
    }
  }

  const composite = new CompositeIdentityResolver({ sourceName: 'composite' });
  composite.addResolver(new EmptyResolver());
  composite.addResolver(new EmptyResolver());

  const result = await composite.resolveIdentity({ candidate: CANDIDATE, parsedAttributes: PARSED_ATTRIBUTES });

  assert.equal(result.matches.length, 0);
});

test('CompositeIdentityResolver skips disabled resolvers', async () => {
  class DisabledResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'disabled', enabled: false });
    }
    async resolveIdentity() {
      throw new Error('Should not be called');
    }
  }

  class WorkingResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'working' });
    }
    async resolveIdentity() {
      return {
        matches: [{ mediaId: 'tt999', mediaType: 'movie', confidence: 0.8, evidence: [] }],
      };
    }
  }

  const composite = new CompositeIdentityResolver({ sourceName: 'composite' });
  composite.addResolver(new DisabledResolver());
  composite.addResolver(new WorkingResolver());

  const result = await composite.resolveIdentity({ candidate: CANDIDATE, parsedAttributes: PARSED_ATTRIBUTES });

  assert.equal(result.matches.length, 1);
  assert.equal(result.resolverSource, 'working');
});

test('CompositeIdentityResolver captures errors from failed resolvers', async () => {
  class ErrorResolver extends BaseIdentityResolver {
    constructor() {
      super({ sourceName: 'error-prone' });
    }
    async resolveIdentity() {
      throw new Error('API timeout');
    }
  }

  const composite = new CompositeIdentityResolver({ sourceName: 'composite' });
  composite.addResolver(new ErrorResolver());

  const result = await composite.resolveIdentity({ candidate: CANDIDATE, parsedAttributes: PARSED_ATTRIBUTES });

  assert.equal(result.matches.length, 0);
  assert.ok(result.errors);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].resolver, 'error-prone');
  assert.equal(result.errors[0].error, 'API timeout');
});

// =============================================================================
// ResolverError Tests
// =============================================================================

test('ResolverError has correct properties', () => {
  const cause = new Error('underlying');
  const error = new ResolverError('resolver failed', 'resolver-error', cause);

  assert.equal(error.message, 'resolver failed');
  assert.equal(error.code, 'resolver-error');
  assert.equal(error.cause, cause);
  assert.equal(error.name, 'ResolverError');
});
