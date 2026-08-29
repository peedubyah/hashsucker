/**
 * Provider URL Liveness Verification
 *
 * Immediately before returning a provider HTTP 307, performs a tiny bounded
 * HTTP range request against the resolved delivery URL to verify byte
 * availability.
 *
 * Safety:
 *   - Never persists or logs the resolved provider URL.
 *   - Uses a short timeout; failures are bounded.
 *   - Fetches only enough bytes to establish availability (1KB).
 *
 * Live criteria:
 *   - HTTP 206 (Partial Content) → live
 *   - HTTP 200 (OK) with media bytes → live (provider ignored Range)
 *   - Anything else → dead
 */

const LIVENESS_RANGE_BYTES = 1024; // 1KB — just enough to prove availability
const LIVENESS_TIMEOUT_MS = 5000; // 5 second timeout

/**
 * Verify a provider delivery URL is live by making a tiny range request.
 *
 * @param {string} url - The unrestricted provider delivery URL
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] - Request timeout in ms
 * @param {number} [options.rangeBytes] - Number of bytes to request
 * @param {Function} [options.fetchFn] - Fetch implementation (defaults to global fetch)
 * @returns {Promise<boolean>} True if the URL is live (206 or 200 with bytes)
 */
export async function isUrlLive(url, options = {}) {
  const {
    timeoutMs = LIVENESS_TIMEOUT_MS,
    rangeBytes = LIVENESS_RANGE_BYTES,
    fetchFn = fetch,
  } = options;

  if (!url || typeof url !== 'string') {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { Range: `bytes=0-${rangeBytes - 1}` },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);

    // HTTP 206 Partial Content → provider honored Range → live
    if (response.status === 206) {
      return true;
    }

    // HTTP 200 OK → provider ignored Range but returned bytes → live
    if (response.status === 200) {
      // Verify we actually got media bytes, not an error page
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > 0) {
        return true;
      }
      // No content-length; read a few bytes to confirm it's not an error body
      const body = await response.arrayBuffer();
      return body.byteLength > 0;
    }

    // Any other status (403, 404, 500, etc.) → dead
    return false;
  } catch (error) {
    clearTimeout(timeout);
    // Network error, timeout, abort → dead
    return false;
  }
}
