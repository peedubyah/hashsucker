/**
 * Metadata Provider Adapter Interface
 *
 * Defines the contract that all upstream metadata providers must implement.
 * This abstraction allows swapping Cinemeta for TMDB (or adding new providers)
 * without changing the search or caching layers.
 *
 * Future providers: TMDB, IMDb, TVDB, etc.
 */

/**
 * @typedef {Object} ProviderAdapter
 * @property {string} name - Unique provider identifier (e.g., "cinemeta", "tmdb")
 * @property {number} priority - Lower = higher priority for result merging
 * @property {function(string): Promise<NormalizedMedia[]>} search - Search titles by query
 * @property {function(string, string): Promise<NormalizedMedia|null>} getMedia - Get media by type and ID
 * @property {function(): Promise<boolean>} [healthCheck] - Optional liveness check
 */

/**
 * Create a provider adapter with validation.
 *
 * @param {Object} config - Provider configuration
 * @param {string} config.name - Provider name
 * @param {number} [config.priority=100] - Provider priority (lower = preferred)
 * @param {function(string): Promise<NormalizedMedia[]>} config.search - Search function
 * @param {function(string, string): Promise<NormalizedMedia|null>} [config.getMedia] - Media lookup
 * @param {function(): Promise<boolean>} [config.healthCheck] - Health check
 * @returns {ProviderAdapter} Validated provider adapter
 */
export function createProviderAdapter(config = {}) {
  if (!config.name || typeof config.name !== 'string') {
    throw new Error('Provider adapter requires a name');
  }
  if (typeof config.search !== 'function') {
    throw new Error(`Provider "${config.name}" requires a search function`);
  }
  return {
    name: config.name,
    priority: config.priority ?? 100,
    search: config.search,
    getMedia: config.getMedia || null,
    healthCheck: config.healthCheck || null,
  };
}

/**
 * Merge results from multiple providers, deduplicating by media ID.
 * When the same ID appears from multiple providers, the higher-priority
 * provider's version wins.
 *
 * @param {Array<{provider: string, priority: number, results: NormalizedMedia[]>}} providerResults
 * @returns {NormalizedMedia[]} Deduplicated, merged results
 */
export function mergeProviderResults(providerResults) {
  const byId = new Map();

  // Sort by priority so higher-priority providers overwrite lower ones
  const sorted = [...providerResults].sort((a, b) => a.priority - b.priority);

  for (const { results } of sorted) {
    for (const media of results) {
      if (!media || !media.id) continue;
      const existing = byId.get(media.id);
      if (!existing) {
        byId.set(media.id, media);
      }
      // Higher priority (lower number) already processed first, so skip duplicates
    }
  }

  return [...byId.values()];
}
