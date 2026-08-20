/**
 * Stremio Discovery Adapter
 *
 * Adapts the Stremio addon protocol to the canonical discovery candidate format.
 * Preserves all existing behavior: explicit infoHash, magnet extraction, Comet corroboration.
 */

import { buildStreamUrl } from '../../stremio/manifest.js';
import { normalizeInfoHash } from '../../stremio/normalize.js';

export async function discoverViaStremio(request, source) {
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
      throw new Error(`Stremio ${source.id}: HTTP ${response.status}`);
    }

    const data = await response.json();
    const streams = Array.isArray(data.streams) ? data.streams : [];

    return streams
      .map((raw) => normalizeStremioStream(raw, source))
      .filter(Boolean);
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

function normalizeStremioStream(raw, source) {
  if (!raw || typeof raw !== 'object') return null;

  const title = raw.name || raw.title || '';
  const description = raw.description || raw.title || '';

  // Extract infoHash with priority: explicit → magnet → Comet corroborated
  const infoHash =
    normalizeInfoHash(raw.infoHash) ||
    extractInfoHashFromMagnet(raw.url) ||
    extractCometCorroboratedHash(raw);

  if (!infoHash) return null;

  const behaviorHints =
    raw.behaviorHints && typeof raw.behaviorHints === 'object'
      ? raw.behaviorHints
      : {};

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

  return {
    infoHash,
    fileIndex: null,
    title: title || description || 'Stream',
    size,
    seeders: null,
    leechers: null,
    publishDate: null,
    magnet: magnetUri,
    downloadUrl,
    trackers: [],
    sources: [
      {
        id: source.id,
        kind: 'stremio',
        instance: source.id,
        indexer: null,
        capability: null,
      },
    ],
    providers: {
      torbox: { cached: null, evidence: null },
      realdebrid: { cached: null, evidence: null },
    },
  };
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

function extractCometCorroboratedHash(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const bingeGroup =
    raw.behaviorHints &&
    typeof raw.behaviorHints.bingeGroup === 'string'
      ? raw.behaviorHints.bingeGroup.trim()
      : '';

  const bingeMatch = bingeGroup.match(/^comet\|torbox\|([a-f0-9]{40})$/i);
  if (!bingeMatch || typeof raw.url !== 'string') return null;

  let url;
  try {
    url = new URL(raw.url);
  } catch {
    return null;
  }

  if (!/^https?:$/.test(url.protocol)) return null;

  const pathMatch = url.pathname.match(/\/playback\/([a-f0-9]{40})(?:\/|$)/i);
  if (!pathMatch) return null;

  const bingeHash = normalizeInfoHash(bingeMatch[1]);
  const pathHash = normalizeInfoHash(pathMatch[1]);

  return bingeHash && bingeHash === pathHash ? bingeHash : null;
}

function extractSize(raw, filename, title, description) {
  if (typeof raw.behaviorHints?.videoSize === 'number' &&
      Number.isFinite(raw.behaviorHints.videoSize)) {
    return raw.behaviorHints.videoSize;
  }

  const sizeMatch = (filename || `${title} ${description}`).match(
    /(\d+(?:\.\d+)?)\s*(GiB|GB|MiB|MB|KiB|KB)/i
  );
  if (!sizeMatch) return null;

  const n = parseFloat(sizeMatch[1]);
  const unit = sizeMatch[2].toUpperCase();

  if (unit === 'GIB' || unit === 'GB') return Math.round(n * 1024 * 1024 * 1024);
  if (unit === 'MIB' || unit === 'MB') return Math.round(n * 1024 * 1024);
  if (unit === 'KIB' || unit === 'KB') return Math.round(n * 1024);

  return null;
}
