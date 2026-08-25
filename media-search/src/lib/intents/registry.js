/**
 * Media Intent Provider Registry
 *
 * Manages registration, discovery, and execution of intent providers.
 */

import { MediaIntentProvider } from './types.js';

export class MediaIntentProviderRegistry {
  constructor() {
    /** @type {Map<string, MediaIntentProvider>} */
    this.providers = new Map();
  }

  /**
   * Register a provider.
   * @param {MediaIntentProvider} provider - Provider instance
   * @param {Object} [context] - Provider context for onRegister hook
   * @returns {Promise<void>}
   */
  async register(provider, context = {}) {
    if (!(provider instanceof MediaIntentProvider)) {
      throw new Error('Provider must be an instance of MediaIntentProvider');
    }
    if (this.providers.has(provider.name)) {
      throw new Error(`Provider "${provider.name}" is already registered`);
    }

    this.providers.set(provider.name, provider);
    await provider.onRegister(context);
  }

  /**
   * Unregister a provider.
   * @param {string} name - Provider name
   * @param {Object} [context] - Provider context for onUnregister hook
   * @returns {Promise<void>}
   */
  async unregister(name, context = {}) {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider "${name}" is not registered`);
    }

    await provider.onUnregister(context);
    this.providers.delete(name);
  }

  /**
   * Get a provider by name.
   * @param {string} name - Provider name
   * @returns {MediaIntentProvider|undefined}
   */
  get(name) {
    return this.providers.get(name);
  }

  /**
   * Check if a provider is registered.
   * @param {string} name - Provider name
   * @returns {boolean}
   */
  has(name) {
    return this.providers.has(name);
  }

  /**
   * Find a provider that supports a given source.
   * @param {string} source - Source identifier
   * @returns {MediaIntentProvider|undefined}
   */
  findBySource(source) {
    for (const provider of this.providers.values()) {
      if (provider.supports(source)) {
        return provider;
      }
    }
    return undefined;
  }

  /**
   * List all registered providers.
   * @returns {Array<{name: string, type: string, enabled: boolean}>}
   */
  list() {
    return Array.from(this.providers.values()).map(p => ({
      name: p.name,
      type: p.type,
      enabled: p.enabled,
    }));
  }

  /**
   * Fetch intents from all enabled providers.
   * @param {Object} options - Options passed to fetchIntents
   * @returns {Promise<Array<{provider: string, intents: MediaIntent[], error?: string}>>}
   */
  async fetchAllIntents(options = {}) {
    const results = [];

    for (const provider of this.providers.values()) {
      if (!provider.enabled) continue;

      try {
        const intents = await provider.fetchIntents(options);
        results.push({ provider: provider.name, intents });
      } catch (error) {
        results.push({ provider: provider.name, intents: [], error: error.message });
      }
    }

    return results;
  }

  /**
   * Fetch intents from a specific provider.
   * @param {string} providerName - Provider name
   * @param {Object} options - Options passed to fetchIntents
   * @returns {Promise<MediaIntent[]>}
   */
  async fetchFromProvider(providerName, options = {}) {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider "${providerName}" is not registered`);
    }
    if (!provider.enabled) {
      throw new Error(`Provider "${providerName}" is disabled`);
    }

    return provider.fetchIntents(options);
  }

  /**
   * Clear all registered providers.
   * @returns {Promise<void>}
   */
  async clear() {
    this.providers.clear();
  }

  /**
   * Get registry statistics.
   * @returns {Object}
   */
  getStats() {
    const all = Array.from(this.providers.values());
    return {
      total: all.length,
      enabled: all.filter(p => p.enabled).length,
      disabled: all.filter(p => !p.enabled).length,
      byType: all.reduce((acc, p) => {
        acc[p.type] = (acc[p.type] || 0) + 1;
        return acc;
      }, {}),
    };
  }
}

export const INTENT_PROVIDER_TYPE = Object.freeze({
  WATCHLIST: 'watchlist',
  MANUAL: 'manual',
  API: 'api',
  CLI: 'cli',
  SCHEDULED: 'scheduled',
});
