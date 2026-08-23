/**
 * TorBox cache observation capability.
 *
 * Transport evaluation — GET vs POST batch semantics:
 *
 * TorBox documents `checkcached` as GET with repeated `hash` query params.
 * We use GET rather than POST because:
 *
 *   1. The endpoint is documented as GET; POST batch semantics are
 *      undocumented and would add complexity without contract.
 *   2. GET is idempotent, cacheable, and proxy-friendly.
 *   3. BATCH_SIZE = 10 keeps each URL under ~600 chars — well within the
 *      ~2000 char proxy/server limit. Each hash is 40 chars; 10 hashes
 *      plus URL encoding and other params is roughly 600 chars total.
 *
 * Batching:
 *   - Hashes are chunked into bounded batches. Each batch is an
 *     independent HTTP request.
 *   - A batch-level failure marks only that batch's hashes as failed
 *     (→ unknown, retryable) rather than failing the entire observation.
 *   - Authentication failures (401/403/BAD_TOKEN) are global: they abort
 *     the entire observation since retrying without new credentials is
 *     futile.
 *
 * The adapter owns request formatting, authentication, and response
 * normalization. It does NOT own scheduling, polling cadence, retry
 * orchestration, or candidate prioritization.
 */

import { PROVIDER_CAPABILITIES, createProviderAdapter } from './capabilities.js';
import { classifyProviderError, ProviderOperationError } from './errors.js';
import { createCacheObservation } from './observations.js';
import { createPlacementResult } from './resources.js';

const PLACEMENT_CREATE_TIMEOUT_MS = 5_000;

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
  const latencyMs = new Map();

  for (const batch of chunk(normalizedHashes, BATCH_SIZE)) {
    const batchStart = Date.now();
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

      const elapsed = Date.now() - batchStart;
      for (const hash of batch) {
        latencyMs.set(hash, elapsed);
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

      const elapsed = Date.now() - batchStart;
      for (const hash of batch) {
        failed.add(hash);
        latencyMs.set(hash, elapsed);
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
    latencyMs,
  };
}

export function createTorBoxProvider(options = {}) {
  const {
    accountScope = 'default',
    apiKey,
    fetchFn = fetch,
    timeoutMs = REQUEST_TIMEOUT_MS,
    placementCreateTimeoutMs = PLACEMENT_CREATE_TIMEOUT_MS,
    cacheObservationTtlMs = DEFAULT_CACHE_OBSERVATION_TTL_MS,
    now = () => Date.now(),
  } = options;

  async function createPlacement(input) {
    if (!input || typeof input !== 'object') {
      throw new TypeError('createPlacement input must be an object');
    }

    const magnet = input.magnet ? String(input.magnet).trim() : null;
    const torrentFileBase64 = input.torrentFileBase64 ? String(input.torrentFileBase64).trim() : null;

    if (!magnet && !torrentFileBase64) {
      throw new TypeError('createPlacement requires magnet or torrentFileBase64');
    }
    if (magnet && torrentFileBase64) {
      throw new TypeError('createPlacement accepts only one of magnet or torrentFileBase64');
    }

    const body = new URLSearchParams();
    if (magnet) {
      body.append('magnet', magnet);
    } else {
      body.append('torrent_file', torrentFileBase64);
    }
    body.append('add_only_if_cached', input.addOnlyIfCached ? 'true' : 'false');

    try {
      const response = await fetchFn(`${API_BASE}/torrents/createtorrent`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'media-search/0.0.1',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(placementCreateTimeoutMs),
      });

      if (!response.ok) {
        const error = new Error(`TorBox create torrent failed: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }

      const payload = await response.json();

      if (!payload?.success) {
        const error = new Error(
          payload?.detail || payload?.error || 'TorBox create torrent failed'
        );
        error.code = payload?.error || null;
        throw error;
      }

      const data = payload.data || {};

      if (data.torrent_id == null || String(data.torrent_id).trim() === '') {
        throw Object.assign(
          new Error('TorBox create torrent response missing torrent_id'),
          { code: 'MALFORMED_RESPONSE' }
        );
      }

      return createPlacementResult({
        provider: 'torbox',
        accountScope,
        providerResourceId: String(data.torrent_id),
        infoHash: data.hash ?? null,
        evidence: { torrentId: data.torrent_id, filename: data.filename ?? null },
      });
    } catch (error) {
      if (error instanceof ProviderOperationError) throw error;
      throw classifyProviderError(error, {
        provider: 'torbox',
        operation: 'create-placement',
      });
    }
  }

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
                latencyMs: result.latencyMs.get(subject.infoHash) ?? null,
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
      [PROVIDER_CAPABILITIES.PLACEMENT_CREATE]: {
        createPlacement,
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
