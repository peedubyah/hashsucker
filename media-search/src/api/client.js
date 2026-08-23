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

/** Get read-only control-plane item summaries for one exact media ID. */
export async function getControlPlaneItems(mediaId, { limit = 100 } = {}) {
  const params = new URLSearchParams({ mediaId, limit: String(limit) });
  const response = await fetch(`${BASE}/api/control-plane/items?${params}`);
  if (!response.ok) throw new Error(`Control-plane item lookup failed: ${response.status}`);
  return response.json();
}

/** Get one control-plane item's read-only detail, optionally scoped to a release. */
export async function getControlPlaneItem(itemId, release = null) {
  const params = new URLSearchParams();
  if (release) {
    const identity = validateReleaseIdentity(release);
    params.set('infoHash', identity.infoHash);
    params.set('fileIndex', identity.fileIndex == null ? 'torrent' : String(identity.fileIndex));
  }
  const query = params.size > 0 ? `?${params}` : '';
  const response = await fetch(`${BASE}/api/control-plane/items/${encodeURIComponent(itemId)}${query}`);
  if (!response.ok) throw new Error(`Control-plane item detail failed: ${response.status}`);
  return response.json();
}

/** Get detailed read-only control-plane configuration and mount health. */
export async function getControlPlaneHealth() {
  const response = await fetch(`${BASE}/api/control-plane/health`);
  if (!response.ok) throw new Error(`Control-plane health check failed: ${response.status}`);
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

/**
 * Operator dashboard — list all requests with optional status filter.
 * @param {string} [filter='all'] - Filter: 'all' | 'queued' | 'processing' | 'done' | 'failed'
 * @returns {Promise<OperatorRequestList>}
 */
export async function listOperatorRequests(filter = 'all') {
  const params = new URLSearchParams({ filter });
  const response = await fetch(`${BASE}/api/operator/requests?${params}`);
  if (!response.ok) throw new Error(`Operator request list failed: ${response.status}`);
  return response.json();
}

/**
 * Operator dashboard — get request detail with timeline trace.
 * @param {string} requestId - UUID of the request
 * @returns {Promise<OperatorRequestDetail>}
 */
export async function getOperatorRequest(requestId) {
  const response = await fetch(`${BASE}/api/operator/requests/${requestId}`);
  if (!response.ok) throw new Error(`Operator request detail failed: ${response.status}`);
  return response.json();
}

/**
 * Operator dashboard — retry a failed request.
 * @param {string} requestId - UUID of the request
 * @returns {Promise<{ requestId: string, status: string, action: string }>}
 */
export async function retryOperatorRequest(requestId) {
  const response = await fetch(`${BASE}/api/operator/requests/${requestId}/retry`, { method: 'POST' });
  if (!response.ok) throw new Error(`Retry failed: ${response.status}`);
  return response.json();
}

/**
 * Operator dashboard — reset request to queued state.
 * @param {string} requestId - UUID of the request
 * @returns {Promise<{ requestId: string, status: string, action: string }>}
 */
export async function resetOperatorRequest(requestId) {
  const response = await fetch(`${BASE}/api/operator/requests/${requestId}/reset`, { method: 'POST' });
  if (!response.ok) throw new Error(`Reset failed: ${response.status}`);
  return response.json();
}

/**
 * Operator dashboard — delete a request from all queues.
 * @param {string} requestId - UUID of the request
 * @returns {Promise<{ requestId: string, action: string }>}
 */
export async function deleteOperatorRequest(requestId) {
  const response = await fetch(`${BASE}/api/operator/requests/${requestId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Delete failed: ${response.status}`);
  return response.json();
}

/**
 * Operator dashboard — search debug with candidate pipeline info.
 * @param {string} query - Search query (min 2 chars)
 * @returns {Promise<OperatorSearchDebug>}
 */
export async function operatorSearchDebug(query) {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`${BASE}/api/operator/search-debug?${params}`);
  if (!response.ok) throw new Error(`Search debug failed: ${response.status}`);
  return response.json();
}

/**
 * Operator dashboard — get recent worker logs.
 * @param {number} [limit=50] - Max log entries
 * @returns {Promise<OperatorLogs>}
 */
export async function operatorLogs(limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) });
  const response = await fetch(`${BASE}/api/operator/logs?${params}`);
  if (!response.ok) throw new Error(`Logs failed: ${response.status}`);
  return response.json();
}

/**
 * Operator dashboard — list available diagnostics.
 * @returns {Promise<{ available: OperatorDiagnostic[] }>}
 */
export async function listOperatorDiagnostics() {
  const response = await fetch(`${BASE}/api/operator/diagnostics`);
  if (!response.ok) throw new Error(`Diagnostics list failed: ${response.status}`);
  return response.json();
}

/**
 * Operator dashboard — run a diagnostic.
 * @param {string} diagId - Diagnostic ID
 * @returns {Promise<OperatorDiagnosticResult>}
 */
export async function runOperatorDiagnostic(diagId) {
  const response = await fetch(`${BASE}/api/operator/diagnostics/run/${diagId}`, { method: 'POST' });
  if (!response.ok) throw new Error(`Diagnostic run failed: ${response.status}`);
  return response.json();
}

/**
 * Operator dashboard — system health summary.
 * @returns {Promise<OperatorHealth>}
 */
export async function operatorHealth() {
  const response = await fetch(`${BASE}/api/operator/health`);
  return response.json();
}

/**
 * Operator dashboard — universal search across requests.
 * @param {string} query - request ID, infohash, media ID, or title
 * @returns {Promise<OperatorSearchResult>}
 */
export async function operatorUniversalSearch(query) {
  // Try request ID first
  if (/^[0-9a-f-]{36}$/i.test(query)) {
    try {
      const detail = await getOperatorRequest(query);
      return { type: 'request', result: detail };
    } catch { /* not found */ }
  }
  // Fall back to listing and searching
  const all = await listOperatorRequests('all');
  const matches = all.requests.filter(r =>
    r.mediaId?.includes(query) ||
    r.mediaTitle?.toLowerCase().includes(query.toLowerCase()) ||
    r.releaseTitle?.toLowerCase().includes(query.toLowerCase())
  );
  return { type: 'search', matches };
}
