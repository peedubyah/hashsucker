/**
 * Media Intent Provider Contract
 *
 * A MediaIntent represents a request for media content from an external source.
 * Providers convert external formats (CLI, Plex watchlist, Overseerr, etc.)
 * into normalized MediaIntent objects that can be persisted and processed.
 *
 * Provider Contract:
 * - `name`: Unique provider identifier (e.g., 'cli', 'plex_watchlist')
 * - `type`: Provider category (e.g., 'watchlist', 'manual', 'api')
 * - `fetchIntents(options)`: Returns Promise<MediaIntent[]>
 * - `validateIntent(intent)`: Validates and normalizes a MediaIntent
 * - `supports(source)`: Checks if this provider handles a given source string
 */

/**
 * @typedef {Object} MediaIntent
 * @property {string} mediaId - Media ID (IMDB, TMDB, etc.)
 * @property {string} mediaType - 'movie' or 'series'
 * @property {number|null} season - Season number (series only)
 * @property {number|null} episode - Episode number (series only)
 * @property {string} source - Source identifier (e.g., 'cli', 'plex_watchlist')
 * @property {string|null} sourceType - Source type/category
 * @property {string|null} sourceId - External source ID
 * @property {string|null} sourceLabel - Human-readable label
 * @property {string} status - 'active', 'completed', 'cancelled'
 * @property {number} priority - Priority level (higher = more important)
 * @property {string|null} requestedBy - Who requested it
 * @property {number} [requestCount] - Number of times requested
 * @property {number} [lastRequestedAt] - Timestamp of last request
 * @property {number} [createdAt] - Timestamp of creation
 */

/**
 * @typedef {Object} ProviderContext
 * @property {Object} cache - Discovery cache instance
 * @property {Object} options - Provider-specific options
 * @property {Function} log - Logging function
 */

/**
 * Media Intent Provider Interface
 * All providers must implement these methods.
 */
export class MediaIntentProvider {
  /**
   * @param {string} name - Unique provider name
   * @param {string} type - Provider type
   * @param {Object} [config] - Provider configuration
   */
  constructor(name, type, config = {}) {
    if (!name || typeof name !== 'string') {
      throw new Error('Provider name is required');
    }
    if (!type || typeof type !== 'string') {
      throw new Error('Provider type is required');
    }
    this.name = name;
    this.type = type;
    this.config = config;
    this.enabled = config.enabled !== false;
  }

  /**
   * Check if this provider supports a given source identifier.
   * @param {string} source - Source identifier
   * @returns {boolean}
   */
  supports(source) {
    return source === this.name;
  }

  /**
   * Fetch intents from the external source.
   * @param {ProviderContext} context - Provider context
   * @returns {Promise<MediaIntent[]>}
   */
  async fetchIntents(context) {
    throw new Error('fetchIntents must be implemented by subclass');
  }

  /**
   * Validate and normalize a MediaIntent.
   * @param {MediaIntent} intent - Raw intent
   * @returns {MediaIntent} - Normalized intent
   * @throws {Error} If intent is invalid
   */
  validateIntent(intent) {
    if (!intent || typeof intent !== 'object') {
      throw new Error('Intent must be an object');
    }
    if (!intent.mediaId || typeof intent.mediaId !== 'string') {
      throw new Error('Intent must have a mediaId string');
    }
    if (!intent.mediaType || !['movie', 'series'].includes(intent.mediaType)) {
      throw new Error('Intent must have mediaType "movie" or "series"');
    }
    if (intent.season != null && (!Number.isInteger(intent.season) || intent.season < 0)) {
      throw new Error('Intent season must be a non-negative integer or null');
    }
    if (intent.episode != null && (!Number.isInteger(intent.episode) || intent.episode < 0)) {
      throw new Error('Intent episode must be a non-negative integer or null');
    }
    if (intent.mediaType === 'movie' && (intent.season != null || intent.episode != null)) {
      throw new Error('Movie intents must not have season/episode');
    }
    if (intent.mediaType === 'series' && intent.season == null && intent.episode != null) {
      throw new Error('Series intents with episode must have season');
    }

    return {
      mediaId: intent.mediaId,
      mediaType: intent.mediaType,
      season: intent.season ?? null,
      episode: intent.episode ?? null,
      source: intent.source || this.name,
      sourceType: intent.sourceType || this.type,
      sourceId: intent.sourceId || null,
      sourceLabel: intent.sourceLabel || null,
      status: intent.status || 'active',
      priority: intent.priority ?? 0,
      requestedBy: intent.requestedBy || null,
    };
  }

  /**
   * Called when provider is registered.
   * @param {ProviderContext} context - Provider context
   */
  async onRegister(context) {
    // Override in subclass if needed
  }

  /**
   * Called when provider is unregistered.
   * @param {ProviderContext} context - Provider context
   */
  async onUnregister(context) {
    // Override in subclass if needed
  }
}

export const INTENT_STATUS = Object.freeze({
  ACTIVE: 'active',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

export const INTENT_PRIORITY = Object.freeze({
  LOW: 0,
  NORMAL: 5,
  HIGH: 10,
  CRITICAL: 20,
});
