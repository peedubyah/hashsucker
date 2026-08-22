/**
 * Frontend API Client
 *
 * Isolates all backend assumptions in src/api/.
 * The rest of the frontend uses these functions, never fetch() directly.
 */

import { validateReleaseIdentity } from './release-contract.js';

const BASE = '';

/**
 * Search for titles by query string (Cinemeta catalog).
 * @param {string} query - Search query (2-120 characters)
 * @returns {Promise<TitleSearchResult>}
 * @throws {Error} On network failure or 400/502 response
 */
export async function searchTitles(query) {
  const response = await fetch(`${BASE}/api/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(`Search failed: ${response.status}`);
  return response.json();
}

/**
 * Search for releases by media identity.
 * Merges DMM corpus + live discovery, ranked by composite score.
 * @param {string} type - 'movie' or 'series'
 * @param {string} mediaId - Media identifier (e.g., "tt0944947:7:3")
 * @returns {Promise<ReleaseSearchResult>}
 * @throws {Error} On network failure or 400/502 response
 */
export async function searchReleases(type, mediaId) {
  const response = await fetch(`${BASE}/api/search?type=${encodeURIComponent(type)}&mediaId=${encodeURIComponent(mediaId)}`);
  if (!response.ok) throw new Error(`Release search failed: ${response.status}`);
  return response.json();
}

/**
 * Get media details by type and ID (Cinemeta).
 * @param {string} type - 'movie' or 'series'
 * @param {string} id - Media identifier (e.g., "tt2085059")
 * @returns {Promise<MediaLookupResult>}
 * @throws {Error} On network failure, 404, or 502 response
 */
export async function getMedia(type, id) {
  const response = await fetch(`${BASE}/api/media?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Media lookup failed: ${response.status}`);
  return response.json();
}

/**
 * Submit a media request for import.
 * @param {Object} request - Request payload
 * @param {string} request.type - 'movie' or 'series'
 * @param {string} request.mediaId - Media identifier
 * @param {Object} request.release - Selected release
 * @param {string} request.release.infoHash - 40-char hex infoHash
 * @param {number|null} request.release.fileIndex - Exact browser/corpus file evidence
 * @param {string} request.release.releaseKey - Canonical exact release identity
 * @returns {Promise<RequestSubmissionResult>}
 * @throws {Error} On network failure or 400 response
 */
export async function submitRequest(request) {
  const identity = validateReleaseIdentity(request?.release);
  const response = await fetch(`${BASE}/api/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...request,
      release: { ...request.release, ...identity },
    }),
  });
  if (!response.ok) throw new Error(`Request submission failed: ${response.status}`);
  return response.json();
}

/**
 * Get request status.
 * @param {string} requestId - UUID of the request
 * @returns {Promise<RequestStatusResult>}
 * @throws {Error} On network failure, 404, or 502 response
 */
export async function getRequestStatus(requestId) {
  const response = await fetch(`${BASE}/api/requests/${requestId}`);
  if (!response.ok) throw new Error(`Status check failed: ${response.status}`);
  return response.json();
}

/**
 * Get search index statistics.
 * @returns {Promise<SearchStats>}
 * @throws {Error} On network failure
 */
export async function getSearchStats() {
  const response = await fetch(`${BASE}/api/search/stats`);
  if (!response.ok) throw new Error(`Stats failed: ${response.status}`);
  return response.json();
}

/**
 * Search the DMM corpus directly via FTS5 (no live discovery).
 * @param {string} query - Search query
 * @param {Object} [filters] - Structured filters
 * @param {number} [filters.year] - Filter by year
 * @param {number} [filters.season] - Filter by season
 * @param {number} [filters.episode] - Filter by episode
 * @param {string} [filters.resolution] - Filter by resolution
 * @param {string} [filters.source] - Filter by source type
 * @param {string} [filters.codec] - Filter by codec
 * @param {boolean} [filters.hdr] - Filter by HDR
 * @param {string} [filters.audio] - Filter by audio format
 * @param {number} [limit=50] - Max results
 * @param {number} [offset=0] - Pagination offset
 * @param {boolean} [includeProviders=false] - Include provider observations
 * @param {boolean} [includeMedia=false] - Include media associations
 * @returns {Promise<InternalSearchResult>}
 * @throws {Error} On network failure or 400 response
 */
export async function searchInternal(query, filters = {}, { limit = 50, offset = 0, includeProviders = false, includeMedia = false } = {}) {
  const params = new URLSearchParams({ q: query });
  for (const [key, value] of Object.entries(filters)) {
    if (value != null) params.set(key, String(value));
  }
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (includeProviders) params.set('providers', 'true');
  if (includeMedia) params.set('media', 'true');
  const response = await fetch(`${BASE}/api/search/internal?${params}`);
  if (!response.ok) throw new Error(`Internal search failed: ${response.status}`);
  return response.json();
}

/**
 * Trigger DMM hashlist ingestion (admin/background operation).
 * @param {Object} [options]
 * @param {number} [options.maxFragments=1] - Max fragments to ingest
 * @param {number} [options.batchSize=1000] - Batch size for commits
 * @returns {Promise<IngestResult>}
 * @throws {Error} On network failure
 */
export async function triggerIngestion({ maxFragments = 1, batchSize = 1000 } = {}) {
  const response = await fetch(`${BASE}/api/ingest/dmm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxFragments, batchSize }),
  });
  if (!response.ok) throw new Error(`Ingestion failed: ${response.status}`);
  return response.json();
}

/**
 * Trigger release attribute parsing for unparsed candidates.
 * @param {Object} [options]
 * @param {number} [options.limit] - Max candidates to process
 * @returns {Promise<AttributeRunResult>}
 * @throws {Error} On network failure
 */
export async function triggerAttributeRun({ limit } = {}) {
  const response = await fetch(`${BASE}/api/attributes/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit }),
  });
  if (!response.ok) throw new Error(`Attribute run failed: ${response.status}`);
  return response.json();
}

/**
 * Check backend health.
 * @returns {Promise<HealthStatus>}
 * @throws {Error} On network failure
 */
export async function checkHealth() {
  const response = await fetch(`${BASE}/health`);
  if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
  return response.json();
}
