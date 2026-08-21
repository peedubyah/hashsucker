/**
 * DMM Hashlist Ingestion Adapter
 *
 * Parses DMM hashlist records into HashSucker ingestCandidates() input.
 * This adapter is a pure parser — it does not fetch, call Stremio/Torznab,
 * perform provider checks, or write directly to SQLite.
 *
 * === Real DMM Format (verified from MediaFusion source) ===
 *
 * Repository: github.com/debridmediamanager/hashlists
 *
 * 1. HTML wrapper file containing an <iframe>:
 *    <iframe src="https://debridmediamanager.com/hashlist#PAYLOAD"></iframe>
 *
 * 2. PAYLOAD is LZString-compressed JSON (URI-component alphabet).
 *    Decompresses to either:
 *    { "torrents": [ { "filename": "...", "hash": "...", "bytes": N }, ... ] }
 *    or just: [ { "filename": "...", "hash": "...", "bytes": N }, ... ]
 *
 * 3. Per-record fields:
 *    - filename (required) — release title/filename
 *    - hash (required) — 40-char hex infoHash
 *    - bytes (optional) — file size in bytes
 *
 * === What DMM does NOT provide ===
 * - Media identity (no mediaId, imdb, tmdb)
 * - Confidence score
 * - Source/provenance beyond the filename
 * - Seeders/leechers
 * - Magnet URI
 *
 * Uses the lz-string npm package for decompression.
 * - fileIndex (single-file torrents only)
 *
 * Media identity MUST be inferred post-ingestion from filename via enrichment.
 *
 * Reference:
 * - github.com/mhdzumair/MediaFusion/blob/main/python-deprecated/workers/scrapers/dmm_hashlist.py
 *
 * Update cadence: DMM syncs every 6 hours (DMM_HASHLIST_SYNC_INTERVAL_HOUR=6)
 * Commit processing: 100 commits per run (incremental), 100 backfill commits
 */

/**
 * Parse a single DMM hashlist torrent record into an ingest entry.
 * Returns null if the record is malformed.
 *
 * @param {Object} record - Raw DMM record (filename, hash, bytes)
 * @param {Object} [options] - Parser options
 * @param {string} [options.filename] - Fallback filename if record.filename missing
 * @returns {Object|null} Ingest entry or null if invalid
 */
export function parseDmmRecord(record, options = {}) {
  if (!record || typeof record !== 'object') return null;

  // Required field: hash (infoHash)
  const infoHash = normalizeInfoHash(record.hash);
  if (!infoHash) return null;

  // Required field: filename (or title)
  const title = record.filename || record.title || options.filename;
  if (!title || typeof title !== 'string') return null;

  const entry = {
    infoHash,
    fileIndex: null,
    title: title.trim(),
    filename: title.trim(),
    size: parseSize(record.bytes),
    seeders: null,
    leechers: null,
    publishDate: null,
    magnet: null,
    downloadUrl: null,
    metadata: {},
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
    mediaAssociations: [],
  };

  return entry;
}

/**
 * Parse DMM hashlist payload (decompressed JSON).
 *
 * @param {Object|string} payload - Decompressed JSON (object or JSON string)
 * @returns {Array<Object>} Array of valid ingest entries
 */
export function parseDmmPayload(payload) {
  let data = payload;
  if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload);
    } catch {
      return [];
    }
  }
  if (!data || typeof data !== 'object') return [];

  let torrentRows;
  if (Array.isArray(data)) {
    torrentRows = data;
  } else if (data.torrents && Array.isArray(data.torrents)) {
    torrentRows = data.torrents;
  } else {
    return [];
  }

  const entries = [];
  for (const row of torrentRows) {
    const entry = parseDmmRecord(row);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Extract hash fragment from DMM HTML wrapper.
 *
 * @param {string} html - HTML string containing iframe with hash fragment
 * @returns {string|null} The hash fragment or null
 */
import LZString from 'lz-string';

export function extractHashFragment(html) {
  if (!html || typeof html !== 'string') return null;
  // Match both debridmediamanager.com and beta.debridmediamanager.com
  const match = html.match(/src="https:\/\/(?:beta\.)?debridmediamanager\.com\/hashlist#([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Decode DMM hashlist payload from LZString-encoded string.
 * Uses the lz-string npm package.
 *
 * @param {string} encoded - LZString-encoded URI component
 * @returns {string|null} Decompressed JSON string or null on failure
 */
export function decodeDmmPayload(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;
  try {
    const decompressed = LZString.decompressFromEncodedURIComponent(encoded);
    return decompressed;
  } catch {
    return null;
  }
}

function normalizeInfoHash(hash) {
  if (!hash || typeof hash !== 'string') return null;
  const cleaned = hash.trim().toLowerCase();
  if (/^[a-f0-9]{40}$/.test(cleaned)) return cleaned;
  return null;
}

function parseSize(size) {
  if (size == null) return null;
  const n = parseInt(size, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Encode payload for testing.
 * Uses the same lz-string library as production decoding.
 */
export function encodeDmmPayload(uncompressed) {
  if (!uncompressed) return null;
  return LZString.compressToEncodedURIComponent(uncompressed);
}

/**
 * Compress string to URI component format (for testing).
 * Uses the same lz-string library as production decoding.
 */
export function compressToEncodedURIComponent(str) {
  return LZString.compressToEncodedURIComponent(str);
}
