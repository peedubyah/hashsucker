/**
 * Plex Media Intent Provider
 *
 * Read-only provider that fetches Plex watchlist items and normalizes
 * them into MediaIntent objects for the ingestion service.
 *
 * Configuration:
 * - PLEX_URL: Plex server URL (e.g., http://localhost:32400)
 * - PLEX_TOKEN: Plex authentication token
 *
 * Plex API endpoints used:
 * - GET /watchlist - Fetch user's watchlist
 * - GET /library/metadata/{ratingKey} - Fetch metadata for items
 *
 * Provider emits intents with:
 * - source: 'plex'
 * - sourceType: 'watchlist'
 * - sourceId: Plex ratingKey
 * - sourceLabel: Plex title
 * - requestedBy: Plex username (if available)
 */

import { MediaIntentProvider } from '../types.js';

/**
 * @typedef {Object} PlexConfig
 * @property {string} [url] - Plex server URL (default: PLEX_URL env)
 * @property {string} [token] - Plex token (default: PLEX_TOKEN env)
 * @property {string} [username] - Plex username for requestedBy
 * @property {boolean} [enabled] - Whether provider is enabled
 */

export class PlexIntentProvider extends MediaIntentProvider {
  /**
   * @param {PlexConfig} [config] - Provider configuration
   */
  constructor(config = {}) {
    super('plex', 'watchlist', config);
    this.url = config.url || process.env.PLEX_URL || '';
    this.token = config.token || process.env.PLEX_TOKEN || '';
    this.username = config.username || process.env.PLEX_USERNAME || null;
  }

  /**
   * Check if this provider supports a given source.
   * @param {string} source - Source identifier
   * @returns {boolean}
   */
  supports(source) {
    return source === 'plex' || source === 'watchlist';
  }

  /**
   * Fetch intents from Plex watchlist.
   * @param {Object} context - Provider context
   * @param {Function} [context.log] - Logging function
   * @returns {Promise<MediaIntent[]>}
   */
  async fetchIntents(context = {}) {
    const { log } = context;

    if (!this.url || !this.token) {
      throw new Error('Plex provider requires PLEX_URL and PLEX_TOKEN');
    }

    if (log) {
      log(`Fetching Plex watchlist from ${this.url}...`);
    }

    const watchlist = await this._fetchWatchlist();
    const intents = [];

    for (const item of watchlist) {
      try {
        const intent = this._normalizePlexItem(item);
        if (intent) {
          intents.push(intent);
        }
      } catch (error) {
        if (log) {
          log(`Skipping Plex item ${item.ratingKey}: ${error.message}`);
        }
      }
    }

    if (log) {
      log(`Fetched ${intents.length} intents from Plex watchlist (${watchlist.length} items)`);
    }

    return intents;
  }

  /**
   * Validate and normalize a MediaIntent.
   * Overrides base class to add Plex-specific validation.
   * @param {MediaIntent} intent - Raw intent
   * @returns {MediaIntent} - Normalized intent
   */
  validateIntent(intent) {
    const validated = super.validateIntent(intent);

    // Ensure Plex source metadata is preserved
    validated.source = 'plex';
    validated.sourceType = 'watchlist';

    return validated;
  }

  /**
   * Fetch watchlist items from Plex API.
   * @returns {Promise<Array<Object>>}
   */
  async _fetchWatchlist() {
    const url = `${this.url.replace(/\/$/, '')}/watchlist`;

    const response = await fetch(url, {
      headers: {
        'X-Plex-Token': this.token,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Plex authentication failed: invalid token');
      }
      throw new Error(`Plex API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const items = data.MediaContainer?.Metadata || [];
    return items;
  }

  /**
   * Normalize a Plex watchlist item into a MediaIntent.
   * @param {Object} item - Plex metadata item
   * @returns {MediaIntent|null}
   */
  _normalizePlexItem(item) {
    if (!item || !item.ratingKey) {
      return null;
    }

    const mediaType = this._mapPlexType(item.type);
    if (!mediaType) {
      return null;
    }

    const mediaId = this._extractMediaId(item);
    if (!mediaId) {
      return null;
    }

    const season = item.parentIndex || null;
    const episode = item.index || null;

    return {
      mediaId,
      mediaType,
      season,
      episode,
      source: 'plex',
      sourceType: 'watchlist',
      sourceId: String(item.ratingKey),
      sourceLabel: item.title || null,
      status: 'active',
      priority: 0,
      requestedBy: this.username,
    };
  }

  /**
   * Map Plex media type to internal media type.
   * @param {string} plexType - Plex type (movie, show, season, episode)
   * @returns {'movie'|'series'|null}
   */
  _mapPlexType(plexType) {
    switch (plexType) {
      case 'movie':
        return 'movie';
      case 'show':
      case 'season':
      case 'episode':
        return 'series';
      default:
        return null;
    }
  }

  /**
   * Extract media ID from Plex item GUID.
   * Plex GUIDs are formatted as: imdb://tt1234567, tmdb://12345, etc.
   * @param {Object} item - Plex metadata item
   * @returns {string|null}
   */
  _extractMediaId(item) {
    // Try GUID first (format: "imdb://tt1234567" or "tmdb://12345")
    if (item.guid) {
      const match = item.guid.match(/\/\/([^/?]+)/);
      if (match) {
        return match[1];
      }
    }

    // Fallback: use ratingKey as sourceId, but we need a proper mediaId
    // Try to extract from Guid array (newer Plex API)
    if (item.Guid && Array.isArray(item.Guid) && item.Guid.length > 0) {
      const guid = item.Guid[0].id;
      const match = guid.match(/\/\/([^/?]+)/);
      if (match) {
        return match[1];
      }
    }

    return null;
  }
}

/**
 * Create a PlexIntentProvider from environment variables.
 * @param {Object} [overrides] - Configuration overrides
 * @returns {PlexIntentProvider}
 */
export function createPlexProvider(overrides = {}) {
  return new PlexIntentProvider({
    url: overrides.url || process.env.PLEX_URL,
    token: overrides.token || process.env.PLEX_TOKEN,
    username: overrides.username || process.env.PLEX_USERNAME,
    enabled: overrides.enabled,
  });
}
