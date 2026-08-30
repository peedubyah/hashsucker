/**
 * Jellyfin Notifier
 *
 * Notifies Jellyfin of newly created media after atomic `.strm` creation.
 *
 * Configuration (all optional — integration disabled if not set):
 *   - JELLYFIN_URL - Jellyfin server URL (e.g., http://host:8096)
 *   - JELLYFIN_API_KEY - Jellyfin API key
 *
 * Behavior:
 *   - No configuration → disabled without affecting Hashsucker
 *   - Uses host-gateway route from container (not localhost)
 *   - Tries targeted media-update API first
 *   - Falls back to library refresh if targeted update unavailable
 *   - Notification failure does NOT roll back request/handoff/STRM
 *   - Records/reports failure; allows later scan to discover
 */

const JELLYFIN_URL = process.env.JELLYFIN_URL;
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;
const JELLYFIN_MEDIA_ROOT = process.env.JELLYFIN_MEDIA_ROOT || '';
const STRM_OUTPUT_PATH = process.env.STRM_OUTPUT_PATH || '/strm';
const NOTIFICATION_TIMEOUT_MS = 5000;

/**
 * Translate container path to Jellyfin-native path.
 * @param {string} strmPath - Path inside container (e.g., /strm/Movies/Foo.strm)
 * @returns {string} Path as Jellyfin sees it (e.g., /home/patrick/.../strm/Movies/Foo.strm)
 */
function translatePath(strmPath) {
  if (!JELLYFIN_MEDIA_ROOT || !strmPath) return strmPath;
  if (strmPath.startsWith(STRM_OUTPUT_PATH)) {
    return strmPath.replace(STRM_OUTPUT_PATH, JELLYFIN_MEDIA_ROOT);
  }
  return strmPath;
}

/**
 * Check if Jellyfin notification is enabled.
 * @returns {boolean}
 */
export function isJellyfinEnabled() {
  return Boolean(JELLYFIN_URL && JELLYFIN_API_KEY);
}

/**
 * Notify Jellyfin of a newly created media path.
 *
 * @param {Object} params
 * @param {string} params.strmPath - Absolute path to the created `.strm` file
 * @param {string} params.mediaId - Media identifier
 * @param {string} params.mediaType - 'movie' or 'series'
 * @returns {Promise<{ notified: boolean, method: string|null, error: string|null }>}
 */
export async function notifyJellyfin({ strmPath, mediaId, mediaType }) {
  if (!isJellyfinEnabled()) {
    return { notified: false, method: null, error: null };
  }

  const baseUrl = JELLYFIN_URL.replace(/\/$/, '');

  // Try targeted media update first
  try {
    const updateResult = await tryMediaUpdate(baseUrl, strmPath, mediaId, mediaType);
    if (updateResult) {
      return { notified: true, method: 'media-update', error: null };
    }
  } catch (error) {
    // Targeted update failed — fall through to library refresh
  }

  // Fall back to library refresh
  try {
    await refreshLibrary(baseUrl);
    return { notified: true, method: 'library-refresh', error: null };
  } catch (error) {
    // Both methods failed — record and report
    const errorMsg = error.message || 'Unknown Jellyfin error';
    console.error(`[Jellyfin] Notification failed for ${mediaId}: ${errorMsg}`);
    return { notified: false, method: null, error: errorMsg };
  }
}

/**
 * Try Jellyfin's media update API for a specific path.
 *
 * Uses the /Library/Media/Updated endpoint if available.
 *
 * @param {string} baseUrl - Jellyfin base URL
 * @param {string} strmPath - Path to the created `.strm`
 * @param {string} mediaId - Media identifier
 * @param {string} mediaType - 'movie' or 'series'
 * @returns {Promise<boolean>} True if the update was accepted
 */
async function tryMediaUpdate(baseUrl, strmPath, mediaId, mediaType) {
  // Jellyfin API: POST /Library/Media/Updated
  // https://api.jellyfin.org/#tag/Library/operation/UpdateItem
  const url = `${baseUrl}/Library/Media/Updated`;

  const jellyfinPath = translatePath(strmPath);
  console.log(`[Jellyfin] Sending path: ${jellyfinPath}`);
  const body = JSON.stringify({
    Item: {
      Path: jellyfinPath,
      ProviderIds: {
        Imdb: mediaId.startsWith('tt') ? mediaId : '',
      },
    },
    UpdateType: 'Created',
  });

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Emby-Authorization': `MediaBrowser Client="hashsucker", Device="media-search", Version="0.0.1", Token="${JELLYFIN_API_KEY}"`,
    },
    body,
  }, NOTIFICATION_TIMEOUT_MS);

  // 204 No Content or 200 OK means accepted
  if (response.status === 204 || response.status === 200) {
    return true;
  }

  // 404 or 405 means endpoint not available — fall back
  if (response.status === 404 || response.status === 405) {
    return false;
  }

  // Other status — treat as failure
  throw new Error(`Media update returned HTTP ${response.status}`);
}

/**
 * Refresh Jellyfin library to pick up new media.
 *
 * @param {string} baseUrl - Jellyfin base URL
 * @returns {Promise<void>}
 */
async function refreshLibrary(baseUrl) {
  // Jellyfin API: POST /Library/Refresh
  const url = `${baseUrl}/Library/Refresh`;

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Emby-Authorization': `MediaBrowser Client="hashsucker", Device="media-search", Version="0.0.1", Token="${JELLYFIN_API_KEY}"`,
    },
  }, NOTIFICATION_TIMEOUT_MS);

  if (response.status === 204 || response.status === 200) {
    return;
  }

  throw new Error(`Library refresh returned HTTP ${response.status}`);
}

/**
 * Fetch with timeout.
 *
 * @param {string} url
 * @param {Object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
