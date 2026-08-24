/**
 * Identity Resolver Interface
 *
 * Provider-agnostic abstraction for resolving media identity from
 * candidate metadata. Implementations can use external APIs, local
 * databases, or any other metadata source.
 *
 * Contract:
 * - Input: { candidate, parsedAttributes }
 * - Output: { matches: [{ mediaId, mediaType, confidence, evidence: [] }] }
 * - No side effects (read-only)
 * - Returns empty matches array on no match (never throws for "not found")
 * - Throws ResolverError on infrastructure failures
 */

export class ResolverError extends Error {
  constructor(message, code = 'resolver-error', cause = null) {
    super(message);
    this.name = 'ResolverError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Base class for identity resolvers.
 * Subclasses must implement resolveIdentity().
 */
export class BaseIdentityResolver {
  constructor(options = {}) {
    this.sourceName = options.sourceName || 'base';
    this.version = options.version || '1.0.0';
    this.enabled = options.enabled !== false;
  }

  /**
   * Resolve media identity for a candidate.
   *
   * @param {Object} params
   * @param {Object} params.candidate - Candidate object { infoHash, fileIndex, filename, title, ... }
   * @param {Object|null} params.parsedAttributes - Strongest release attributes or null
   * @returns {Promise<Object>} { matches: [{ mediaId, mediaType, confidence, evidence: [] }] }
   */
  async resolveIdentity({ candidate, parsedAttributes }) {
    throw new Error('Subclasses must implement resolveIdentity()');
  }

  /**
   * Check if this resolver can handle the given candidate.
   * Override to add capability detection.
   *
   * @param {Object} params
   * @param {Object} params.candidate
   * @param {Object|null} params.parsedAttributes
   * @returns {boolean}
   */
  canResolve({ candidate, parsedAttributes }) {
    return this.enabled;
  }
}

/**
 * Composite resolver that tries multiple resolvers in order.
 * Returns the first successful non-empty result.
 */
export class CompositeIdentityResolver extends BaseIdentityResolver {
  constructor(options = {}) {
    super(options);
    this.resolvers = options.resolvers || [];
  }

  addResolver(resolver) {
    this.resolvers.push(resolver);
  }

  async resolveIdentity({ candidate, parsedAttributes }) {
    const errors = [];

    for (const resolver of this.resolvers) {
      if (!resolver.canResolve({ candidate, parsedAttributes })) {
        continue;
      }

      try {
        const result = await resolver.resolveIdentity({ candidate, parsedAttributes });
        if (result && result.matches && result.matches.length > 0) {
          return {
            ...result,
            resolverSource: resolver.sourceName,
            resolverVersion: resolver.version,
          };
        }
      } catch (error) {
        errors.push({ resolver: resolver.sourceName, error: error.message });
        // Continue to next resolver
      }
    }

    return {
      matches: [],
      resolverSource: this.sourceName,
      resolverVersion: this.version,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

/**
 * No-op resolver that always returns empty matches.
 * Useful as a placeholder or for testing.
 */
export class NoopIdentityResolver extends BaseIdentityResolver {
  constructor(options = {}) {
    super({ ...options, sourceName: 'noop' });
  }

  async resolveIdentity() {
    return {
      matches: [],
      resolverSource: this.sourceName,
      resolverVersion: this.version,
    };
  }
}
