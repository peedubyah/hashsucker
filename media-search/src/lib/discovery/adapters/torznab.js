/**
 * Torznab Discovery Adapter
 *
 * Adapts Torznab/Newznab protocol to the canonical discovery candidate format.
 * Preserves: explicit infoHash, magnet fallback, size, seeders, leechers, publish date.
 */

import { normalizeInfoHash } from '../../stremio/normalize.js';

export async function discoverViaTorznab(request, source) {
  const { mediaType, searchTitles } = request;
  const searchTitle = searchTitles[0] || request.title || request.mediaId;

  const url = new URL(source.endpoint);
  url.searchParams.set('t', 'search');
  url.searchParams.set('q', searchTitle);
  url.searchParams.set('cat', mediaType === 'movie' ? '2000' : '5000');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), source.timeoutMs || 5000);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'user-agent': 'media-search/0.0.1',
        accept: 'application/json, application/xml',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Torznab ${source.id}: HTTP ${response.status}`);
    }

    const data = await response.json();
    const items = data.rss?.channel?.item || [];
    const rawItems = Array.isArray(items) ? items : [items];

    return rawItems
      .map((item) => normalizeTorznabItem(item, source))
      .filter(Boolean);
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

function normalizeTorznabItem(item, source) {
  if (!item || typeof item !== 'object') return null;

  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (!title) return null;

  // infoHash priority: direct → magnet link → GUID
  const infoHash =
    normalizeInfoHash(item.infoHash) ||
    extractHashFromLink(item.link) ||
    extractHashFromGuid(item.guid);

  if (!infoHash) return null;

  const magnet = typeof item.link === 'string' &&
    item.link.trim().toLowerCase().startsWith('magnet:')
    ? item.link.trim()
    : null;

  const downloadUrl = typeof item.link === 'string' &&
    !item.link.trim().toLowerCase().startsWith('magnet:')
    ? item.link.trim()
    : null;

  const size = parseNumber(item.size) || parseNumber(item.length);
  const seeders = parseNumber(item.seeders);
  const leechers = parseNumber(item.leechers);
  const publishDate = parseTorznabDate(item.pubDate);

  return {
    infoHash,
    fileIndex: null,
    title,
    size: size || null,
    seeders,
    leechers,
    publishDate,
    magnet,
    downloadUrl,
    trackers: [],
    sources: [
      {
        id: source.id,
        kind: 'torznab',
        instance: source.id,
        indexer: source.id,
        capability: null,
      },
    ],
    providers: {
      torbox: { cached: null, evidence: null },
      realdebrid: { cached: null, evidence: null },
    },
  };
}

function extractHashFromLink(link) {
  if (typeof link !== 'string') return null;
  const magnetMatch = link.match(/urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  if (magnetMatch) return normalizeInfoHash(magnetMatch[1]);
  return null;
}

function extractHashFromGuid(guid) {
  if (typeof guid !== 'string') return null;
  // Only accept GUIDs that are themselves a valid infoHash (40 hex chars)
  // Do NOT extract arbitrary 40-hex substrings from unrelated GUIDs
  const cleaned = guid.trim().toLowerCase();
  if (/^[a-f0-9]{40}$/.test(cleaned)) {
    return normalizeInfoHash(cleaned);
  }
  return null;
}

function parseTorznabDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseNumber(value) {
  if (value == null) return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}
