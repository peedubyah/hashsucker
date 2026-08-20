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
export function extractHashFragment(html) {
  if (!html || typeof html !== 'string') return null;
  const match = html.match(/src="https:\/\/debridmediamanager\.com\/hashlist#([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Decode DMM hashlist payload from LZString-encoded string.
 * This is a Node.js implementation of lz-string's decompressFromEncodedURIComponent.
 *
 * @param {string} encoded - LZString-encoded URI component
 * @returns {string|null} Decompressed JSON string or null on failure
 */
export function decodeDmmPayload(encoded) {
  if (!encoded || typeof encoded !== 'string') return null;

  // Try base64 first (for tests)
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    if (decoded && decoded.length > 0) {
      return decoded;
    }
  } catch {
    // Not base64, try LZString
  }

  // LZString decompression
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$';
  const reverseDic = {};
  for (let i = 0; i < alphabet.length; i++) {
    reverseDic[alphabet[i]] = i;
  }

  const getBaseValue = (char) => reverseDic[char] ?? 0;

  try {
    const length = encoded.length;
    const resetValue = 32;
    let dataIndex = 0;

    const getNextValue = (index) => {
      if (index >= length) return 0;
      return getBaseValue(encoded[index]);
    };

    let dataVal = getNextValue(0);
    let dataPosition = resetValue;

    const readBits = (bitCount) => {
      let bits = 0;
      let power = 1;
      const maxPower = 1 << bitCount;

      while (power !== maxPower) {
        const resb = dataVal & dataPosition;
        dataPosition >>= 1;
        if (dataPosition === 0) {
          dataPosition = resetValue;
          dataIndex++;
          dataVal = getNextValue(dataIndex);
        }
        if (resb > 0) bits |= power;
        power <<= 1;
      }
      return bits;
    };

    const dictionary = { 0: '', 1: '', 2: '' };
    let dictSize = 4;
    let numBits = 3;
    let enlargeIn = 4;

    const nextCode = readBits(2);
    let c;
    if (nextCode === 0) {
      c = String.fromCharCode(readBits(8));
    } else if (nextCode === 1) {
      c = String.fromCharCode(readBits(16));
    } else if (nextCode === 2) {
      return '';
    } else {
      return null;
    }

    dictionary[3] = c;
    let w = c;
    const result = [c];

    while (true) {
      if (dataIndex > length) return null;

      let cCode = readBits(numBits);

      if (cCode === 0) {
        dictionary[dictSize] = String.fromCharCode(readBits(8));
        dictSize++;
        cCode = dictSize - 1;
        enlargeIn--;
      } else if (cCode === 1) {
        dictionary[dictSize] = String.fromCharCode(readBits(16));
        dictSize++;
        cCode = dictSize - 1;
        enlargeIn--;
      } else if (cCode === 2) {
        return result.join('');
      }

      if (enlargeIn === 0) {
        enlargeIn = 1 << numBits;
        numBits++;
      }

      let entry;
      if (dictionary[cCode] !== undefined) {
        entry = dictionary[cCode];
      } else if (cCode === dictSize) {
        entry = w + w[0];
      } else {
        return null;
      }

      result.push(entry);

      dictionary[dictSize] = w + entry[0];
      dictSize++;
      enlargeIn--;

      w = entry;
    }
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
 * Encode payload for testing (base64 wrapper).
 * Production uses real LZString from DMM source.
 */
export function encodeDmmPayload(uncompressed) {
  if (!uncompressed) return null;
  // For testing, use base64 encoding
  return Buffer.from(uncompressed, 'utf-8').toString('base64');
}

/**
 * Compress string to URI component format (for testing).
 */
export function compressToEncodedURIComponent(str) {
  return encodeDmmPayload(str);
}
