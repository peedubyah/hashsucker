/**
 * Torrentio Discovery Adapter
 *
 * Adapts the Torrentio Stremio addon to the canonical discovery candidate format.
 * Torrentio is a live discovery source — NOT a provider observation source.
 *
 * Key rules:
 * - infoHash is the torrent identity
 * - fileIndex is always null (Torrentio does not expose file indexes)
 * - behaviorHints.filename is the release filename (authoritative)
 * - display name (raw.name) is NOT the release filename
 * - Cache hints ([TB], [RD], [PM]) in the display name are LOW-TRUST only.
 *   They must NOT create authoritative provider_observations.
 */

import { buildStreamUrl } from '../../stremio/manifest.js';
import { normalizeInfoHash } from '../../stremio/normalize.js';

// Cache hint patterns in Torrentio display names
const CACHE_HINTS = [
  { pattern: /^\s*\[TB\]/, provider: 'torbox', label: '[TB]' },
  { pattern: /^\s*\[RD\]/, provider: 'realdebrid', label: '[RD]' },
  { pattern: /^\s*\[PM\]/, provider: 'premiumize', label: '[PM]' },
  { pattern: /^\s*\[AD\]/, provider: 'alldebrid', label: '[AD]' },
  { pattern: /^\s*\[OFF\]/, label: '[OFF]' },
];

/**
 * Discover candidates from Torrentio's stream endpoint.
 *
 * @param {Object} request - Discovery request with mediaType, mediaId, searchTitles
 * @param {Object} source - Source config with endpoint, timeoutMs, id, provider
 * @returns {Promise<Array>} Normalized candidates
 */
export async function discoverViaTorrentio(request, source) {
  const { mediaType, mediaId } = request;

  const streamUrl = buildStreamUrl(source.endpoint, mediaType, mediaId);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), source.timeoutMs || 5000);

  try {
    const response = await fetch(streamUrl, {
      headers: {
        'user-agent': 'media-search/0.0.1',
        accept: 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Torrentio ${source.id}: HTTP ${response.status}`);
    }

    const data = await response.json();
    const streams = Array.isArray(data.streams) ? data.streams : [];

    return streams
      .map((raw) => normalizeTorrentioStream(raw, source))
      .filter(Boolean);
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * Normalize a single Torrentio stream object into a canonical candidate.
 *
 * @param {Object} raw - Raw Stremio stream object from Torrentio
 * @param {Object} source - Source config
 * @returns {Object|null} Normalized candidate or null if invalid
 */
function normalizeTorrentioStream(raw, source) {
  if (!raw || typeof raw !== 'object') return null;

  const title = raw.name || raw.title || '';
  const description = raw.description || raw.title || '';

  // Extract infoHash with priority: explicit → magnet
  // NOTE: No Comet corroboration — Torrentio does not expose bingeGroup
  const infoHash =
    normalizeInfoHash(raw.infoHash) ||
    extractInfoHashFromMagnet(raw.url);

  if (!infoHash) return null;

  const behaviorHints =
    raw.behaviorHints && typeof raw.behaviorHints === 'object'
      ? raw.behaviorHints
      : {};

  // Filename: behaviorHints.filename is authoritative scene release name
  // raw.name is a display label (e.g., "[TB] 2160p") — NOT the release name
  const filename =
    (typeof behaviorHints.filename === 'string' && behaviorHints.filename.trim()
      ? behaviorHints.filename.trim()
      : null) ||
    (typeof raw.filename === 'string' && raw.filename.trim()
      ? raw.filename.trim()
      : null);

  const magnetUri = extractMagnetUri(raw.url);
  const downloadUrl = !magnetUri && typeof raw.url === 'string' &&
    /^https?:\/\//i.test(raw.url.trim())
    ? raw.url.trim()
    : null;

  const size = extractSize(raw, filename, title, description);

  // Extract cache hints from display name — LOW TRUST ONLY
  // These are hints, NOT provider API assertions
  const cacheHints = extractCacheHints(raw.name || '');

  // Providers: always null from Torrentio — cache hints are NOT observations
  // Provider hydration happens separately via TorBox/RD cache checks
  const providers = {
    torbox: { cached: null, evidence: null },
    realdebrid: { cached: null, evidence: null },
  };

  return {
    infoHash,
    fileIndex: null,
    title: title || description || 'Stream',
    filename,
    size: size || null,
    seeders: null,
    leechers: null,
    publishDate: null,
    magnet: magnetUri,
    downloadUrl,
    trackers: [],
    sources: [
      {
        id: source.id,
        kind: 'torrentio',
        instance: source.id,
        indexer: null,
        capability: 'live-search',
      },
    ],
    providers,
    // Cache hints stored as low-trust evidence only
    cacheHints,
    // Preserve raw for debugging (bounded)
    raw: {
      infoHash: raw.infoHash,
      name: raw.name,
      title: raw.title,
      behaviorHints: raw.behaviorHints,
    },
  };
}

/**
 * Extract cache hints from Torrentio display name.
 * Returns array of { provider, label } — all low-trust.
 *
 * @param {string} name - Display name from Torrentio (e.g., "[TB] 2160p")
 * @returns {Array<{provider: string|null, label: string}>}
 */
function extractCacheHints(name) {
  const hints = [];
  for (const hint of CACHE_HINTS) {
    if (hint.pattern.test(name)) {
      hints.push({ provider: hint.provider || null, label: hint.label });
    }
  }
  return hints;
}

function extractInfoHashFromMagnet(url) {
  if (typeof url !== 'string' || !url.trim().toLowerCase().startsWith('magnet:')) {
    return null;
  }
  return normalizeInfoHash(url);
}

function extractMagnetUri(url) {
  if (typeof url !== 'string' || !url.trim().toLowerCase().startsWith('magnet:')) {
    return null;
  }
  return url.trim();
}

function extractSize(raw, filename, title, description) {
  // Prefer explicit videoSize from behaviorHints
  if (typeof raw.behaviorHints?.videoSize === 'number' &&
      Number.isFinite(raw.behaviorHints.videoSize)) {
    return raw.behaviorHints.videoSize;
  }
  // Fall back to parsing from text
  return parseSizeFromText(filename) ||
         parseSizeFromText(title) ||
         parseSizeFromText(description);
}

function parseSizeFromText(text) {
  const match = String(text || '').match(/(\d+(?:\.\d+)?)\s*(GiB|GB|MiB|MB|KiB|KB)/i);
  if (!match) return null;
  const n = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'GIB' || unit === 'GB') return Math.round(n * 1024 * 1024 * 1024);
  if (unit === 'MIB' || unit === 'MB') return Math.round(n * 1024 * 1024);
  if (unit === 'KIB' || unit === 'KB') return Math.round(n * 1024);
  return null;
}
