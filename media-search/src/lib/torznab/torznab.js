import { createReleaseIdentity } from '../../api/release-contract.js';
import { normalizeInfoHash } from '../stremio/normalize.js';
import { discoveryAccounting } from '../discovery/discovery-accounting.js';

const TORZNAB_CAPS = '/api?t=capabilities';
const TORZNAB_SEARCH = '/api?t=search';

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

function extractHashFromLink(link) {
  if (typeof link !== 'string') return null;
  const magnetMatch = link.match(/urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  if (magnetMatch) return normalizeInfoHash(magnetMatch[1]);
  return null;
}

function extractHashFromGuid(guid) {
  if (typeof guid !== 'string') return null;
  // Only accept GUIDs that are themselves a valid infoHash (40 hex chars).
  // Do NOT extract arbitrary 40-hex substrings from unrelated GUIDs.
  const cleaned = guid.trim().toLowerCase();
  if (/^[a-f0-9]{40}$/.test(cleaned)) {
    return normalizeInfoHash(cleaned);
  }
  return null;
}

export function normalizeTorznabItem(item, indexerMeta = {}) {
  if (!item || typeof item !== 'object') return null;

  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (!title) return null;

  // infoHash priority: direct field → magnet link → GUID
  const infoHash = normalizeInfoHash(item.infoHash) ||
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
  const identity = createReleaseIdentity(infoHash, null);

  return {
    key: identity.releaseKey,
    addonId: indexerMeta.addonId || null,
    addonName: indexerMeta.name || null,
    addonSortOrder: indexerMeta.sortOrder ?? 0,
    streamType: null,
    role: indexerMeta.role || 'discovery',
    title,
    description: '',
    quality: null,
    resolution: null,
    codec: null,
    hdr: null,
    audio: null,
    language: null,
    size: size || null,
    cached: false,
    filename: title,
    ...identity,
    nzbUrl: null,
    url: downloadUrl,
    behaviorHints: {},
    raw: item,
    sources: [
      {
        addonId: indexerMeta.addonId || null,
        addonName: indexerMeta.name || null,
        role: indexerMeta.role || 'discovery',
        provider: indexerMeta.provider || null,
        kind: 'torznab',
        indexer: indexerMeta.name || null,
      },
    ],
    torznab: {
      seeders,
      leechers,
      publishDate,
      magnet,
      downloadUrl,
    },
  };
}

export async function loadTorznabIndexers() {
  const urlsRaw = process.env.TORZNAB_URLS;
  if (!urlsRaw) return [];

  let configs;
  try {
    configs = JSON.parse(urlsRaw);
  } catch {
    return [];
  }

  if (!Array.isArray(configs)) return [];

  return configs
    .map((config, index) => {
      if (typeof config === 'string') {
        return {
          addonId: `torznab.${index}`,
          name: `Torznab ${index + 1}`,
          url: config,
          role: 'discovery',
          enabled: true,
          sort_order: 100 + index,
        };
      }
      if (!config || typeof config !== 'object') return null;
      return {
        addonId: config.id || `torznab.${index}`,
        name: config.name || `Torznab ${index + 1}`,
        url: config.url,
        role: config.role || 'discovery',
        enabled: config.enabled !== false,
        sort_order: config.sortOrder ?? 100 + index,
      };
    })
    .filter((c) => c && c.url);
}

export async function searchTorznab({ type, mediaId, indexers, concurrency = 3 }) {
  if (!['movie', 'series'].includes(type)) {
    throw new Error(`Invalid search type: ${type}`);
  }

  const enabledIndexers = (indexers || await loadTorznabIndexers())
    .filter((idx) => idx.enabled);

  const results = await Promise.allSettled(
    enabledIndexers.map(async (indexer) => {
      try {
        const url = new URL(indexer.url);
        url.searchParams.set('t', 'search');
        url.searchParams.set('q', mediaId);
        url.searchParams.set('cat', type === 'movie' ? '2000' : '5000');

        // Account the outbound HTTP call by the operator-assigned
        // addonId (e.g. "torznab.0"). Never the URL.
        discoveryAccounting.recordRequest(indexer.addonId);

        let response;
        try {
          response = await fetch(url.toString(), {
            headers: {
              'user-agent': 'media-search/0.0.1',
              accept: 'application/json, application/xml',
            },
            signal: AbortSignal.timeout(5000),
          });
        } catch (err) {
          discoveryAccounting.recordError(indexer.addonId);
          console.error(`Torznab search failed for ${indexer.name}: ${err.message}`);
          return [];
        }

        if (!response.ok) {
          discoveryAccounting.recordError(indexer.addonId);
          return [];
        }

        const data = await response.json();
        const items = data.rss?.channel?.item || [];
        const rawItems = Array.isArray(items) ? items : [items];

        const normalized = rawItems
          .map((item) => normalizeTorznabItem(item, {
            addonId: indexer.addonId,
            name: indexer.name,
            sortOrder: indexer.sort_order,
            role: indexer.role,
          }))
          .filter(Boolean);
        discoveryAccounting.recordCandidates(indexer.addonId, normalized.length);
        return normalized;
      } catch (error) {
        discoveryAccounting.recordError(indexer.addonId);
        console.error(`Torznab search failed for ${indexer.name}: ${error.message}`);
        return [];
      }
    })
  );

  let merged = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      for (const item of result.value) {
        merged.push(item);
      }
    }
  }
  return merged;
}
