import { PROVIDER_CAPABILITIES, createProviderAdapter } from './capabilities.js';
import { classifyProviderError } from './errors.js';
import { createCacheObservation } from './observations.js';

const API_BASE = 'https://api.torbox.app/v1/api';
const BATCH_SIZE = 10;
const REQUEST_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_OBSERVATION_TTL_MS = 5 * 60 * 1000;

function chunk(array, size) {
  const chunks = [];

  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }

  return chunks;
}

export async function checkTorBoxCached(hashes, options = {}) {
  const apiKey = options.apiKey ?? process.env.TORBOX_API_KEY;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  if (!apiKey) {
    const error = new Error('TORBOX_API_KEY is missing');
    error.code = 'AUTH_ERROR';
    throw error;
  }

  const normalizedHashes = [
    ...new Set(
      hashes
        .filter(Boolean)
        .map((hash) => String(hash).trim().toLowerCase())
    ),
  ];

  const cached = new Set();
  const details = new Map();
  const failed = new Set();

  for (const batch of chunk(normalizedHashes, BATCH_SIZE)) {
    try {
      const params = new URLSearchParams({
        format: 'object',
        list_files: 'false',
      });

      for (const hash of batch) {
        params.append('hash', hash);
      }

      const response = await fetchFn(
        `${API_BASE}/torrents/checkcached?${params}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'User-Agent': 'media-search/0.0.1',
          },
          signal: AbortSignal.timeout(timeoutMs),
        }
      );

      if (!response.ok) {
        const error = new Error(
          `TorBox cache check failed: HTTP ${response.status}`
        );
        error.status = response.status;
        throw error;
      }

      const payload = await response.json();

      if (!payload?.success) {
        const error = new Error(
          payload?.detail ||
          payload?.error ||
          'TorBox cache check failed'
        );
        error.code = payload?.error || null;
        throw error;
      }

      const data = payload.data || {};

      for (const [hash, value] of Object.entries(data)) {
        if (!value) continue;

        const normalized = hash.toLowerCase();
        cached.add(normalized);
        details.set(normalized, value);
      }
    } catch (error) {
      // Authentication is global, not a per-batch cache miss.
      if (
        error?.status === 401 ||
        error?.status === 403 ||
        error?.code === 'BAD_TOKEN' ||
        error?.code === 'AUTH_ERROR'
      ) {
        throw error;
      }

      for (const hash of batch) {
        failed.add(hash);
      }

      console.error(
        `TorBox cache batch unavailable (${batch.length} hashes): ${error.message}`
      );
    }
  }

  return {
    cached,
    details,
    failed,
  };
}

export function createTorBoxProvider(options = {}) {
  const {
    accountScope = 'default',
    apiKey,
    fetchFn = fetch,
    timeoutMs = REQUEST_TIMEOUT_MS,
    cacheObservationTtlMs = DEFAULT_CACHE_OBSERVATION_TTL_MS,
    now = () => Date.now(),
  } = options;

  return createProviderAdapter({
    provider: 'torbox',
    accountScope,
    capabilities: {
      [PROVIDER_CAPABILITIES.CACHE_OBSERVATION]: {
        async observeCache(subjects) {
          const normalized = normalizeCacheSubjects(subjects);
          const observedAt = now();
          const hashes = [...new Set(normalized.map((subject) => subject.infoHash))];

          try {
            const result = await checkTorBoxCached(hashes, { apiKey, fetchFn, timeoutMs });
            return normalized.map((subject) => {
              const failed = result.failed.has(subject.infoHash);
              return createCacheObservation({
                provider: 'torbox',
                accountScope,
                scope: 'torrent',
                infoHash: subject.infoHash,
                fileIndex: null,
                kind: 'authoritative',
                state: failed ? 'unknown' : result.cached.has(subject.infoHash) ? 'cached' : 'uncached',
                observedAt,
                ttlMs: cacheObservationTtlMs,
                source: 'torbox-checkcached',
                evidence: result.details.get(subject.infoHash) ?? null,
                errorCategory: null,
                retryable: failed ? true : null,
              });
            });
          } catch (error) {
            const providerError = classifyProviderError(error, {
              provider: 'torbox',
              operation: 'observe-cache',
            });
            return normalized.map((subject) => createCacheObservation({
              provider: 'torbox',
              accountScope,
              scope: 'torrent',
              infoHash: subject.infoHash,
              fileIndex: null,
              kind: 'authoritative',
              state: 'error',
              observedAt,
              ttlMs: cacheObservationTtlMs,
              source: 'torbox-checkcached',
              errorCategory: providerError.category,
              retryable: providerError.retryable,
              retryAfterMs: providerError.retryAfterMs,
            }));
          }
        },
      },
    },
  });
}

function normalizeCacheSubjects(subjects) {
  if (!Array.isArray(subjects)) throw new TypeError('Cache observation subjects must be an array');
  return subjects.map((subject) => {
    if (!subject || typeof subject !== 'object') throw new TypeError('Cache observation subject must be an object');
    const infoHash = String(subject.infoHash || '').trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(infoHash)) throw new TypeError('Cache observation requires a valid infoHash');
    return { infoHash };
  });
}
