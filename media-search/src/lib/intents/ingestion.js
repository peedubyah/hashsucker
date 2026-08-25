/**
 * Media Intent Ingestion Service
 *
 * Layer between providers and the media_intents database.
 * Providers emit normalized MediaIntent objects; this service handles
 * validation, deduplication, upsert, and reporting.
 *
 * Responsibilities:
 * - Validate each intent (delegates to provider.validateIntent)
 * - Deduplicate against existing intents (NULL-safe matching)
 * - Upsert to database via cache.upsertMediaIntent
 * - Report created/updated/skipped counts with reasons
 */

import { MediaIntentProvider } from './types.js';

/**
 * @typedef {Object} IngestionResult
 * @property {number} created - Number of new intents created
 * @property {number} updated - Number of existing intents incremented
 * @property {number} skipped - Number of intents skipped (invalid/duplicate)
 * @property {number} total - Total intents processed
 * @property {Array<{intent: MediaIntent, status: string, reason?: string, intentId?: number}>} details - Per-intent results
 * @property {number} elapsedMs - Time taken for ingestion
 */

/**
 * @typedef {Object} IngestionOptions
 * @property {Function} [log] - Optional logging function
 * @property {boolean} [dryRun] - If true, don't persist to database
 * @property {boolean} [skipValidation] - If true, skip provider validation
 */

export class MediaIntentIngestionService {
  /**
   * @param {Object} cache - Discovery cache instance
   * @param {MediaIntentProvider} [provider] - Optional provider for validation
   */
  constructor(cache, provider = null) {
    if (!cache) {
      throw new Error('Cache instance is required');
    }
    if (provider && !(provider instanceof MediaIntentProvider)) {
      throw new Error('Provider must be an instance of MediaIntentProvider');
    }
    this.cache = cache;
    this.provider = provider;
  }

  /**
   * Ingest a batch of intents.
   * @param {MediaIntent[]} intents - Array of normalized intents
   * @param {IngestionOptions} [options] - Ingestion options
   * @returns {IngestionResult}
   */
  ingest(intents, options = {}) {
    const { log, dryRun = false, skipValidation = false } = options;
    const startedAt = Date.now();

    const result = {
      created: 0,
      updated: 0,
      skipped: 0,
      total: intents.length,
      details: [],
      elapsedMs: 0,
    };

    for (const rawIntent of intents) {
      const detail = { intent: rawIntent, status: 'pending' };

      try {
        // Step 1: Validate
        let validatedIntent = rawIntent;
        if (!skipValidation && this.provider) {
          validatedIntent = this.provider.validateIntent(rawIntent);
        }

        // Step 2: Deduplicate and upsert
        if (dryRun) {
          // In dry-run mode, check if intent exists without persisting
          const exists = this._checkExists(validatedIntent);
          if (exists) {
            detail.status = 'updated';
            detail.reason = 'Would increment existing intent';
            result.updated++;
          } else {
            detail.status = 'created';
            detail.reason = 'Would create new intent';
            result.created++;
          }
        } else {
          const intentId = this._upsertIntent(validatedIntent);
          detail.intentId = intentId;

          // Determine if created or updated by checking request_count
          const stored = this.cache.getMediaIntent(intentId);
          if (stored && stored.requestCount > 1) {
            detail.status = 'updated';
            result.updated++;
          } else {
            detail.status = 'created';
            result.created++;
          }
        }

        if (log) {
          const scope = this._formatScope(validatedIntent);
          log(`  ${detail.status}: ${validatedIntent.mediaId}${scope} (source=${validatedIntent.source})`);
        }
      } catch (error) {
        detail.status = 'skipped';
        detail.reason = error.message;
        result.skipped++;

        if (log) {
          log(`  skipped: ${rawIntent.mediaId || 'unknown'} — ${error.message}`);
        }
      }

      result.details.push(detail);
    }

    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  /**
   * Ingest intents from a provider.
   * Fetches intents from the provider, then ingests them.
   * @param {MediaIntentProvider} provider - Provider to fetch from
   * @param {Object} [fetchOptions] - Options passed to provider.fetchIntents
   * @param {IngestionOptions} [options] - Ingestion options
   * @returns {Promise<{fetch: Object, ingestion: IngestionResult}>}
   */
  async ingestFromProvider(provider, fetchOptions = {}, options = {}) {
    const { log } = options;

    if (log) {
      log(`Fetching intents from "${provider.name}"...`);
    }

    const fetchStartedAt = Date.now();
    const intents = await provider.fetchIntents({
      cache: this.cache,
      ...fetchOptions,
    });
    const fetchElapsedMs = Date.now() - fetchStartedAt;

    if (log) {
      log(`Fetched ${intents.length} intents in ${fetchElapsedMs}ms`);
    }

    // Use this provider for validation if not already set
    const originalProvider = this.provider;
    if (!this.provider) {
      this.provider = provider;
    }

    const ingestion = this.ingest(intents, options);

    // Restore original provider
    this.provider = originalProvider;

    return {
      fetch: {
        provider: provider.name,
        intentCount: intents.length,
        elapsedMs: fetchElapsedMs,
      },
      ingestion,
    };
  }

  /**
   * Ingest intents from multiple providers.
   * @param {MediaIntentProvider[]} providers - Providers to fetch from
   * @param {Object} [fetchOptions] - Options passed to each provider.fetchIntents
   * @param {IngestionOptions} [options] - Ingestion options
   * @returns {Promise<Array<{provider: string, fetch: Object, ingestion: IngestionResult}>>}
   */
  async ingestFromProviders(providers, fetchOptions = {}, options = {}) {
    const results = [];

    for (const provider of providers) {
      if (!provider.enabled) {
        continue;
      }

      try {
        const result = await this.ingestFromProvider(provider, fetchOptions, options);
        results.push({ provider: provider.name, ...result });
      } catch (error) {
        results.push({
          provider: provider.name,
          fetch: { provider: provider.name, intentCount: 0, elapsedMs: 0, error: error.message },
          ingestion: { created: 0, updated: 0, skipped: 0, total: 0, details: [], elapsedMs: 0 },
        });
      }
    }

    return results;
  }

  /**
   * Check if an intent already exists in the database.
   * Uses NULL-safe matching for season/episode.
   * @param {MediaIntent} intent - Intent to check
   * @returns {boolean}
   */
  _checkExists(intent) {
    const existing = this.cache.db.prepare(
      'SELECT id FROM media_intents WHERE media_id = ? AND media_type = ? AND source = ? AND season IS ? AND episode IS ?'
    ).get(
      intent.mediaId,
      intent.mediaType,
      intent.source || 'api',
      intent.season ?? null,
      intent.episode ?? null
    );
    return !!existing;
  }

  /**
   * Upsert an intent to the database.
   * @param {MediaIntent} intent - Validated intent
   * @returns {number} - Intent ID
   */
  _upsertIntent(intent) {
    return this.cache.upsertMediaIntent({
      mediaId: intent.mediaId,
      mediaType: intent.mediaType,
      season: intent.season,
      episode: intent.episode,
      source: intent.source,
      sourceType: intent.sourceType,
      sourceId: intent.sourceId,
      sourceLabel: intent.sourceLabel,
      status: intent.status,
      priority: intent.priority,
      requestedBy: intent.requestedBy,
    });
  }

  /**
   * Format scope string for logging.
   * @param {MediaIntent} intent
   * @returns {string}
   */
  _formatScope(intent) {
    if (intent.season != null) {
      const ep = intent.episode != null ? `E${String(intent.episode).padStart(2, '0')}` : '';
      return ` S${String(intent.season).padStart(2, '0')}${ep}`;
    }
    return '';
  }
}

/**
 * Format ingestion result as a human-readable summary.
 * @param {IngestionResult} result
 * @returns {string}
 */
export function formatIngestionSummary(result) {
  const lines = [
    `Ingestion complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped (${result.total} total) in ${result.elapsedMs}ms`,
  ];

  if (result.skipped > 0) {
    lines.push('Skipped intents:');
    for (const detail of result.details.filter(d => d.status === 'skipped')) {
      lines.push(`  ${detail.intent.mediaId || '?'}: ${detail.reason}`);
    }
  }

  return lines.join('\n');
}
