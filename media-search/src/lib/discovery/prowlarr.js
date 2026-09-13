/**
 * Prowlarr candidate source (Prowlarr/Torznab tranche).
 *
 * Read-only search against Prowlarr's normalized API. Prowlarr is
 * candidate intelligence ONLY: it never ranks, fulfills, publishes, or
 * touches providers. Rows flow into the standard live-discovery merge
 * (dedupe by infoHash, same ranker, same weights).
 *
 * Secret hygiene: Prowlarr embeds the API key in http(s) magnetUrl/
 * download fields. Those fields are NEVER logged, stored, or returned —
 * only the bare 40-hex infoHash (explicit field or magnet: xt hash).
 */
import { discoveryAccounting } from './discovery-accounting.js';
import { parseFilename } from './parser-adapter.js';
import { createReleaseIdentity } from '../../api/release-contract.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const ADDON_ID = 'prowlarr';

const lastSearch = { at: null, error: null, seen: 0, unique: 0 };

export function prowlarrStats() {
  return { ...lastSearch };
}

function redactError(message) {
  // Strip anything URL/key shaped before logging.
  return String(message || '').replace(/apikey=[^&\s]+/gi, 'apikey=…').slice(0, 160);
}

export function createProwlarrClient({
  baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = fetch,
} = {}) {
  const base = baseUrl ? String(baseUrl).replace(/\/+$/, '') : null;

  async function api(path, params = {}) {
    if (!base || !apiKey) {
      const err = new Error('Prowlarr not configured');
      err.code = 'PROWLARR_DISABLED';
      throw err;
    }
    const url = new URL(`${base}/api/v1/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    discoveryAccounting.recordRequest(ADDON_ID);
    let response;
    try {
      response = await fetchFn(url.toString(), {
        headers: { 'X-Api-Key': apiKey, Accept: 'application/json', 'User-Agent': 'media-search/0.0.1' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      discoveryAccounting.recordError(ADDON_ID);
      throw new Error(`Prowlarr request failed: ${redactError(err?.message)}`);
    }
    if (!response.ok) {
      discoveryAccounting.recordError(ADDON_ID);
      throw new Error(`Prowlarr HTTP ${response.status}`);
    }
    return response.json();
  }

  return {
    addonId: ADDON_ID,
    isConfigured: () => !!(base && apiKey),
    async status() {
      return api('/system/status');
    },
    async indexers() {
      const rows = await api('/indexer');
      return Array.isArray(rows) ? rows : [];
    },
    async health() {
      try {
        const rows = await api('/health');
        return Array.isArray(rows) ? rows : [];
      } catch {
        return [];
      }
    },
    /**
     * Search indexers. type: 'movie' | 'tv'. TPB honors q (+season/ep
     * hints for TV, unenforced server-side — HashSucker filters).
     */
    async search({ query, type, season = null, episode = null, limit = 100, categories = null } = {}) {
      if (!query || !String(query).trim()) return [];
      const params = { query: String(query).trim(), type, limit };
      if (type === 'tv') {
        // Prowlarr search honors Torznab-style season/ep hints (unenforced
        // server-side for TPB — HashSucker filters exact S/E itself).
        if (season != null) params.season = season;
        if (episode != null) params.ep = episode;
        if (categories) params.categories = categories;
      } else if (categories) {
        params.categories = categories;
      }
      const t0 = Date.now();
      try {
        const rows = await api('/search', params);
        const list = Array.isArray(rows) ? rows : [];
        lastSearch.at = Date.now();
        lastSearch.error = null;
        lastSearch.seen += list.length;
        return list;
      } catch (err) {
        lastSearch.at = Date.now();
        lastSearch.error = redactError(err?.message);
        throw err;
      } finally {
        void t0;
      }
    },
  };
}

/**
 * High-level Prowlarr live search → live-candidate shaped rows.
 * Query strategy: exact title (+year for movies) since TPB lacks
 * strong-ID query params; HashSucker-side parsing + identity checks
 * reject mismatches (same as every live source).
 *
 * Relevance 0.7 (below live 0.8 / corpus 1.0): new tracker data must
 * never outrank an equivalent evidenced candidate on newness alone.
 * Whole-torrent sizes are NOT presented as per-file sizes.
 */
export async function searchProwlarr({
  type, title, year = null, season = null, episode = null, wantedImdbId = null, client,
} = {}) {
  if (!['movie', 'series'].includes(type)) throw new Error('Invalid Prowlarr type');
  if (!client || typeof client.search !== 'function') return [];
  const q = [title, type === 'movie' && year ? String(year) : null].filter(Boolean).join(' ').trim();
  if (!q) return [];
  let rows;
  try {
    rows = await client.search({
      query: q, type, season, episode,
      categories: type === 'movie' ? '2000' : '5000',
    });
  } catch {
    discoveryAccounting.recordError(ADDON_ID);
    return [];
  }
  const { rows: normalized } = normalizeProwlarrRows(rows);
  const out = [];
  for (const row of normalized) {    let parsed = null;
    try {
      parsed = parseFilename(row.filename)?.parsed ?? null;
    } catch {
      parsed = null;
    }
    const imdbMatch = wantedImdbId && row.imdbId
      ? row.imdbId.toLowerCase() === String(wantedImdbId).toLowerCase()
      : false;
    // Dual provenance: the row was returned scoped to the requested media
    // by live discovery (same tier mechanics as every live row) AND it came
    // from tracker TPB via Prowlarr (diagnostics + future filtering).
    out.push({
      ...createReleaseIdentity(row.infoHash, null),
      filename: row.filename,
      title: row.filename,
      year: parsed?.year ?? null,
      season: parsed?.season ?? null,
      episode: parsed?.episode ?? null,
      episodeRange: parsed?.episodeRange ?? null,
      seasonOnly: parsed?.seasonOnly ?? false,
      mediaType: parsed?.mediaType ?? type,
      resolution: parsed?.resolution ?? null,
      source: parsed?.source ?? null,
      codec: parsed?.codec ?? null,
      hdr: parsed?.hdr === true,
      audio: parsed?.audio ?? null,
      releaseGroup: parsed?.releaseGroup ?? null,
      relevance: 0.7,
      parserConfidence: 0.6,
      mediaAssociations: [],
      providerObservations: [],
      providerEvidence: [],
      sources: [
        { origin: 'live', evidence: ['prowlarr-tracker-source'], confidence: 0.7 },
        {
          origin: 'prowlarr',
          evidence: imdbMatch ? ['prowlarr-imdb-corroborated'] : ['prowlarr-tracker'],
          confidence: 0.7,
          indexer: row.indexer,
        },
      ],
      selectedMediaId: wantedImdbId ?? null,
      hasLiveDiscovery: true,
      selectedFileSize: null,
      seeders: row.seeders,
      publishDate: row.publishDate,
    });
  }
  discoveryAccounting.recordCandidates(ADDON_ID, out.length);
  return out;
}
/** Extract a bare 40-hex infoHash from a Prowlarr row (never the raw URL). */
export function extractRowHash(row) {
  if (!row || typeof row !== 'object') return null;
  const direct = String(row.infoHash || '').trim().toLowerCase();
  if (/^[0-9a-f]{40}$/.test(direct)) return direct;
  const magnet = String(row.magnetUrl || '');
  if (magnet.startsWith('magnet:')) {
    const m = magnet.match(/xt=urn:btih:([0-9a-fA-F]{40})/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function toImdbId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? `tt${String(n).padStart(7, '0')}` : null;
}

/**
 * Normalize Prowlarr rows into live-candidate shaped rows. Rows without a
 * usable hash are dropped (counted). Sizes are whole-torrent bytes and are
 * NOT presented as per-file sizes (exact-size binding must not trust them).
 */
export function normalizeProwlarrRows(rows, { indexerDefault = 'prowlarr' } = {}) {
  const out = [];
  let invalid = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const infoHash = extractRowHash(row);
    if (!infoHash) {
      invalid++;
      continue;
    }
    const size = Number(row.size);
    const seeders = Number(row.seeders);
    out.push({
      infoHash,
      fileIndex: null,
      filename: String(row.fileName || row.title || '').slice(0, 512),
      title: String(row.title || row.fileName || '').slice(0, 512),
      size: Number.isSafeInteger(size) && size > 0 ? size : null,
      seeders: Number.isSafeInteger(seeders) && seeders >= 0 ? seeders : null,
      leechers: null,
      publishDate: row.publishDate ?? null,
      year: null,
      season: null,
      episode: null,
      imdbId: toImdbId(row.imdbId),
      indexer: String(row.indexer || indexerDefault).slice(0, 80),
      categories: Array.isArray(row.categories) ? row.categories.slice(0, 8).map((c) => c?.name ?? c).filter(Boolean) : [],
    });
  }
  return { rows: out, invalid };
}
