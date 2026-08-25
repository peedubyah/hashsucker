/**
 * CLI Media Intent Provider
 *
 * Reference implementation of the MediaIntentProvider interface.
 * Accepts intents from CLI arguments or JSON files.
 */

import { MediaIntentProvider } from './types.js';

export class CliIntentProvider extends MediaIntentProvider {
  constructor(config = {}) {
    super('cli', 'manual', config);
    this.intents = config.intents || [];
  }

  /**
   * Check if this provider supports a given source.
   * @param {string} source - Source identifier
   * @returns {boolean}
   */
  supports(source) {
    return source === 'cli' || source === 'manual';
  }

  /**
   * Fetch intents from CLI input.
   * @param {Object} options - Options
   * @param {Array<Object>} [options.intents] - Array of raw intent objects
   * @returns {Promise<MediaIntent[]>}
   */
  async fetchIntents(options = {}) {
    const rawIntents = options.intents || this.intents || [];
    const validated = [];

    for (const raw of rawIntents) {
      try {
        const normalized = this.normalizeRawIntent(raw);
        const validated_intent = this.validateIntent(normalized);
        validated.push(validated_intent);
      } catch (error) {
        // Skip invalid intents but log warning
        if (options.log) {
          options.log(`Skipping invalid intent: ${error.message}`);
        }
      }
    }

    return validated;
  }

  /**
   * Normalize a raw CLI intent to MediaIntent format.
   * @param {Object} raw - Raw intent from CLI
   * @returns {MediaIntent}
   */
  normalizeRawIntent(raw) {
    // Support various input formats
    // Format 1: { mediaId, mediaType, season, episode }
    // Format 2: { id, type, season, episode } (aliases)
    // Format 3: { mediaId, mediaType, season, episode, label, priority }

    const mediaId = raw.mediaId || raw.id;
    const mediaType = raw.mediaType || raw.type || 'movie';
    const season = raw.season ?? null;
    const episode = raw.episode ?? null;

    return {
      mediaId,
      mediaType,
      season,
      episode,
      source: raw.source || 'cli',
      sourceType: raw.sourceType || 'manual',
      sourceId: raw.sourceId || null,
      sourceLabel: raw.label || raw.sourceLabel || null,
      status: raw.status || 'active',
      priority: raw.priority ?? 0,
      requestedBy: raw.requestedBy || raw.user || null,
    };
  }

  /**
   * Add an intent programmatically.
   * @param {Object} intent - Raw intent
   */
  addIntent(intent) {
    this.intents.push(intent);
  }

  /**
   * Clear all stored intents.
   */
  clearIntents() {
    this.intents = [];
  }

  /**
   * Get the number of stored intents.
   * @returns {number}
   */
  size() {
    return this.intents.length;
  }
}
