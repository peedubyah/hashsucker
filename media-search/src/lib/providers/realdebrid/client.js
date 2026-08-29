/**
 * Real-Debrid REST API client.
 *
 * Direct client for the Real-Debrid REST API. Does not implement the gateway
 * abstraction — this is a purpose-built client for operator diagnostics and
 * the RD provider boundary.
 *
 * Supported endpoints:
 *   GET /user
 *   POST /torrents/addMagnet
 *   GET /torrents/info/{id}
 *   POST /torrents/selectFiles/{id}
 *   DELETE /torrents/delete/{id}
 *   POST /unrestrict/link
 *
 * The client never logs or exposes the API token.
 *
 * Rate limiting:
 *   - Global scheduler: concurrency 1, min interval 500ms (~120 req/min)
 *   - On HTTP 429, RD code 34, or RD code 5: pause queue, honor Retry-After or
 *     60s cooldown
 *   - A single logical request gets at most one retry total after a rate-limit
 *     response. Retry bookkeeping is cleared only when that logical request has
 *     succeeded or terminated permanently.
 *   - Code 7 (resource not found) is NOT rate limiting
 *   - Code 35 (infringing) is NOT rate limiting
 *
 * Resolver-safe mode (internal):
 *   - When `resolverSafe: true` is passed, an active long RD cooldown causes
 *     the attempt to fail fast instead of waiting.
 *   - HTTP 429 / RD code 5 / RD code 34 does not perform the 60-second retry.
 *   - Normal global scheduling (min interval) still applies.
 *   - Used by the playback resolver so RD throttling never blocks TorBox
 *     fallback.
 */

import { classifyProviderError, ProviderOperationError } from '../errors.js';

export const REALDEBRID_API_BASE = 'https://api.real-debrid.com/rest/1.0';

/**
 * Real-Debrid error codes — preserved for diagnostics.
 * https://api.real-debrid.com/#errors
 */
export const REALDEBRID_ERROR_CODES = Object.freeze({
  INVALID_TOKEN: 1,
  BAD_FILE: 2,
  MISSING_PARAMETER: 3,
  ACCOUNT_LOCKED: 4,
  MISSING_PERMISSIONS: 5,
  FILE_UNAVAILABLE: 6,
  UNKNOWN_RESOURCE: 7,
  INFRINGING_FILE: 35,
  UNALLOWED_FILE_TYPE: 36,
  SERVICE_UNAVAILABLE: 37,
  TOO_MANY_REQUESTS: 34,
});

const RD_ERROR_CATEGORY_MAP = Object.freeze({
  [REALDEBRID_ERROR_CODES.INVALID_TOKEN]: 'authentication',
  [REALDEBRID_ERROR_CODES.BAD_FILE]: 'invalid-request',
  [REALDEBRID_ERROR_CODES.MISSING_PARAMETER]: 'invalid-request',
  [REALDEBRID_ERROR_CODES.ACCOUNT_LOCKED]: 'authorization',
  [REALDEBRID_ERROR_CODES.MISSING_PERMISSIONS]: 'rate-limit',
  [REALDEBRID_ERROR_CODES.FILE_UNAVAILABLE]: 'unavailable',
  [REALDEBRID_ERROR_CODES.UNKNOWN_RESOURCE]: 'not-found',
  [REALDEBRID_ERROR_CODES.INFRINGING_FILE]: 'infringing',
  [REALDEBRID_ERROR_CODES.UNALLOWED_FILE_TYPE]: 'unsupported',
  [REALDEBRID_ERROR_CODES.SERVICE_UNAVAILABLE]: 'temporarily-unavailable',
  [REALDEBRID_ERROR_CODES.TOO_MANY_REQUESTS]: 'rate-limit',
});

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_INTERVAL_MS = 500;
const GLOBAL_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 1;

/**
 * Error thrown when resolver-safe mode detects an active cooldown.
 * The resolver catches this to fail fast and fall back to TorBox.
 */
export class RdCooldownError extends Error {
  constructor(remainingMs, operation) {
    super(`Real-Debrid cooldown active (${remainingMs}ms remaining, operation: ${operation})`);
    this.name = 'RdCooldownError';
    this.provider = 'realdebrid';
    this.category = 'rate-limit';
    this.retryable = true;
    this.retryAfterMs = remainingMs;
    this.operation = operation;
  }
}

/**
 * Create a Real-Debrid client.
 *
 * @param {Object} options
 * @param {string} options.apiKey - Real-Debrid API key (server-side only).
 * @param {Function} [options.fetchFn] - Fetch implementation (defaults to global fetch).
 * @param {number} [options.timeoutMs] - Request timeout in milliseconds.
 * @param {number} [options.minIntervalMs] - Minimum interval between requests (default 500).
 *   Use lower values (e.g., 100) for interactive resolver-safe calls where
 *   serialized 429/cooldown compliance matters more than conservative pacing.
 *   Background probing should keep the default 500ms.
 * @param {Function} [options.now] - Clock function (defaults to Date.now).
 * @param {Function} [options.log] - Logging function (defaults to console.error).
 * @returns {Object} Real-Debrid client.
 */
export function createRealDebridClient({
  apiKey,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  minIntervalMs = MIN_INTERVAL_MS,
  now = () => Date.now(),
  log = console.error,
} = {}) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('apiKey is required');
  }

  const token = apiKey.trim();

  // ---------------------------------------------------------------------------
  // Global rate limiter
  // ---------------------------------------------------------------------------
  let lastRequestTime = 0;
  let queue = [];
  let activeCount = 0;
  let cooldownUntil = 0;
  let rateLimitRetries = new Map(); // operation key -> retry count

  function isRateLimited() {
    return now() < cooldownUntil;
  }

  function getCooldownRemaining() {
    return Math.max(0, cooldownUntil - now());
  }

  async function acquireSlot(operation, { resolverSafe = false } = {}) {
    while (true) {
      // Check global cooldown
      if (isRateLimited()) {
        const waitMs = getCooldownRemaining();
        if (resolverSafe) {
          // Resolver-safe: fail fast instead of waiting through cooldown
          throw new RdCooldownError(waitMs, operation);
        }
        log(`[RD rate-limit] waiting ${waitMs}ms due to active cooldown (operation: ${operation})`);
        await sleep(waitMs);
        continue;
      }

      // Check concurrency
      if (activeCount >= 1) {
        // Wait for current request to complete
        await new Promise(resolve => queue.push(resolve));
        continue;
      }

      // Check min interval
      const elapsed = now() - lastRequestTime;
      if (elapsed < minIntervalMs) {
        const waitMs = minIntervalMs - elapsed;
        log(`[RD rate-limit] waiting ${waitMs}ms to maintain min interval (operation: ${operation})`);
        await sleep(waitMs);
        continue;
      }

      // Acquire slot
      activeCount++;
      lastRequestTime = now();
      return;
    }
  }

  function releaseSlot() {
    activeCount--;
    // Wake up next waiter
    const next = queue.shift();
    if (next) next();
  }

  function enterCooldown(durationMs, reason) {
    cooldownUntil = now() + durationMs;
    log(`[RD rate-limit] entering global cooldown for ${durationMs}ms (reason: ${reason})`);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getRetryKey(operation, path) {
    return `${operation}:${path}`;
  }

  function shouldRetry(operation, path) {
    const key = getRetryKey(operation, path);
    const count = rateLimitRetries.get(key) || 0;
    if (count < MAX_RATE_LIMIT_RETRIES) {
      rateLimitRetries.set(key, count + 1);
      return true;
    }
    return false;
  }

  function clearRetry(operation, path) {
    rateLimitRetries.delete(getRetryKey(operation, path));
  }

  /**
   * Make an authenticated request to the Real-Debrid API.
   * All requests go through the global rate limiter.
   *
   * @param {string} method - HTTP method.
   * @param {string} path - API path (e.g., '/user').
   * @param {Object} [options]
   * @param {URLSearchParams|string} [options.body] - Request body.
   * @param {string} [options.operation] - Operation name for error classification.
   * @param {boolean} [options.resolverSafe] - If true, fail fast on active cooldown.
   * @returns {Promise<Object>} Parsed JSON response.
   */
  async function request(method, path, { body, operation = path, resolverSafe = false } = {}) {
    const schedulerStart = now();
    await acquireSlot(operation, { resolverSafe });
    const schedulerWaitMs = now() - schedulerStart;

    try {
      const networkStart = now();
      const result = await requestWithRetry(method, path, { body, operation, resolverSafe });
      const networkMs = now() - networkStart;
      if (process.env.RESOLVER_PROFILE === '1') {
        console.log(`[RD-profile] ${operation}: scheduler=${schedulerWaitMs}ms network=${networkMs}ms`);
      }
      return result;
    } finally {
      releaseSlot();
    }
  }

  async function requestWithRetry(method, path, { body, operation, resolverSafe = false }) {
    const url = `${REALDEBRID_API_BASE}${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'media-search/0.0.1',
    };

    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    let response;
    try {
      response = await fetchFn(url, {
        method,
        headers,
        body: body ? body.toString() : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Network/timeout error — clear retry bookkeeping for this logical request
      clearRetry(operation, path);
      throw classifyProviderError(error, {
        provider: 'realdebrid',
        operation,
      });
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        // Malformed response — terminal failure, clear retry bookkeeping
        clearRetry(operation, path);
        throw classifyProviderError(new Error('Malformed JSON response'), {
          provider: 'realdebrid',
          operation,
        });
      }
    }

    if (!response.ok) {
      const rdCode = payload?.error_code ?? null;
      const rdMessage = payload?.error || `HTTP ${response.status}`;
      const category = rdCode != null
        ? (RD_ERROR_CATEGORY_MAP[rdCode] || mapHttpStatus(response.status))
        : mapHttpStatus(response.status);

      // Check for rate limiting conditions
      const isRateLimit = (
        response.status === 429 ||
        rdCode === REALDEBRID_ERROR_CODES.TOO_MANY_REQUESTS ||
        rdCode === REALDEBRID_ERROR_CODES.SLOW_DOWN
      );

      if (isRateLimit && !resolverSafe && shouldRetry(operation, path)) {
        // Determine cooldown duration
        let cooldownMs = GLOBAL_COOLDOWN_MS;
        const retryAfter = response.headers?.get?.('Retry-After');
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed) && parsed > 0) {
            cooldownMs = parsed * 1000;
          }
        }

        log(`[RD rate-limit] 429/slow-down detected (code: ${rdCode}, http: ${response.status}), cooldown: ${cooldownMs}ms`);
        enterCooldown(cooldownMs, `HTTP ${response.status}, RD code ${rdCode}`);

        // Retry after cooldown — explicitly wait through the cooldown first.
        // The retry itself counts as an RD request for global spacing purposes:
        // we wait the cooldown, then re-enter acquireSlot which enforces the
        // 500ms min interval.
        await sleep(cooldownMs);
        return request(method, path, { body, operation, resolverSafe });
      }

      // Terminal failure (no retry, or resolver-safe, or retry exhausted):
      // clear retry bookkeeping for this logical request.
      clearRetry(operation, path);

      const error = new ProviderOperationError(rdMessage, {
        provider: 'realdebrid',
        operation,
        category,
        retryable: isRetryable(category),
      });
      error.rdErrorCode = rdCode;
      error.rdError = payload?.error || null;
      throw error;
    }

    // Success - clear retry count
    clearRetry(operation, path);
    return payload;
  }

  return Object.freeze({
    provider: 'realdebrid',

    /**
     * Validate credentials and get account info.
     * GET /user
     * @returns {Promise<Object>} Account info (id, username, email, type, points, expiration).
     */
    async validateAccount() {
      return request('GET', '/user', { operation: 'validate-account' });
    },

    /**
     * Add a magnet link to Real-Debrid.
     * POST /torrents/addMagnet
     * @param {string} magnetUri - Magnet URI.
     * @param {Object} [options]
     * @param {boolean} [options.resolverSafe] - Fail fast on active cooldown.
     * @returns {Promise<Object>} { id, uri } — the RD torrent ID.
     */
    async addMagnet(magnetUri, options = {}) {
      const body = new URLSearchParams();
      body.append('magnet', magnetUri);
      return request('POST', '/torrents/addMagnet', {
        body,
        operation: 'add-magnet',
        resolverSafe: options.resolverSafe ?? false,
      });
    },

    /**
     * Get torrent info and file metadata.
     * GET /torrents/info/{id}
     * @param {string} torrentId - RD torrent ID.
     * @param {Object} [options]
     * @param {boolean} [options.resolverSafe] - Fail fast on active cooldown.
     * @returns {Promise<Object>} Torrent info with files array.
     */
    async getTorrentInfo(torrentId, options = {}) {
      return request('GET', `/torrents/info/${encodeURIComponent(torrentId)}`, {
        operation: 'torrents-info',
        resolverSafe: options.resolverSafe ?? false,
      });
    },

    /**
     * Select files for download.
     * POST /torrents/selectFiles/{id}
     * @param {string} torrentId - RD torrent ID.
     * @param {string|string[]} fileIds - File ID(s) to select ('all' for all files).
     * @param {Object} [options]
     * @param {boolean} [options.resolverSafe] - Fail fast on active cooldown.
     * @returns {Promise<Object>} Empty object on success.
     */
    async selectFiles(torrentId, fileIds, options = {}) {
      const ids = Array.isArray(fileIds) ? fileIds.join(',') : String(fileIds);
      const body = new URLSearchParams();
      body.append('files', ids);
      return request('POST', `/torrents/selectFiles/${encodeURIComponent(torrentId)}`, {
        body,
        operation: 'select-files',
        resolverSafe: options.resolverSafe ?? false,
      });
    },

    /**
     * Delete a torrent from Real-Debrid.
     * DELETE /torrents/delete/{id}
     * @param {string} torrentId - RD torrent ID.
     * @param {Object} [options]
     * @param {boolean} [options.resolverSafe] - Fail fast on active cooldown.
     * @returns {Promise<Object>} Empty object on success.
     */
    async deleteTorrent(torrentId, options = {}) {
      return request('DELETE', `/torrents/delete/${encodeURIComponent(torrentId)}`, {
        operation: 'delete-torrent',
        resolverSafe: options.resolverSafe ?? false,
      });
    },

    /**
     * Unrestrict a link to get a direct download URL.
     * POST /unrestrict/link
     * @param {string} link - The hoster link to unrestrict.
     * @param {string} [password] - Optional password for the link.
     * @param {Object} [options]
     * @param {boolean} [options.resolverSafe] - Fail fast on active cooldown.
     * @returns {Promise<Object>} { id, filename, mimeType, filesize, link, host, chunks, crc, download, type }.
     */
    async unrestrictLink(link, password, options = {}) {
      const body = new URLSearchParams();
      body.append('link', link);
      if (password) body.append('password', password);
      return request('POST', '/unrestrict/link', {
        body,
        operation: 'unrestrict-link',
        resolverSafe: options.resolverSafe ?? false,
      });
    },

    /**
     * Check if RD is currently in cooldown.
     * Used by the resolver to determine if a bounded attempt is worth making.
     * @returns {boolean}
     */
    isRdCooldownActive() {
      return isRateLimited();
    },

    /**
     * Get remaining cooldown in ms.
     * @returns {number}
     */
    getRdCooldownRemainingMs() {
      return getCooldownRemaining();
    },
  });
}

function mapHttpStatus(status) {
  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 429) return 'rate-limit';
  if (status === 404) return 'not-found';
  if (status >= 400 && status < 500) return 'invalid-request';
  if (status >= 500) return 'temporarily-unavailable';
  return 'unknown';
}

function isRetryable(category) {
  return ['rate-limit', 'timeout', 'network', 'temporarily-unavailable'].includes(category);
}
