/**
 * DMM Ingestion Module
 *
 * Fetches, decodes, and ingests DMM hashlist data into the candidate corpus.
 *
 * Pipeline:
 *   fetch payload → decode LZString → parse records → normalize →
 *   upsert candidates → parse release attributes → FTS5 auto-index
 *
 * This module is separable from the API runtime. Call it from:
 *   - A CLI script: `node importer.js`
 *   - A future worker/container
 *   - Tests
 *
 * Responsibilities:
 *   - Fetch DMM payload (or accept raw payload)
 *   - Decode LZString
 *   - Parse records
 *   - Normalize candidates
 *   - Upsert into cache (idempotent)
 *   - Parse release attributes
 *   - Return import statistics
 */

import {
  parseDmmPayload,
  parseDmmRecord,
  decodeDmmPayload,
  extractHashFragment,
} from '../discovery/adapters/dmm.js';

import { parseFilename } from '../discovery/parser-adapter.js';
import { storeReleaseAttributes } from '../discovery/release-attributes.js';

/**
 * Import DMM payload into the candidate corpus.
 *
 * @param {Object} cache - Discovery cache instance (createDiscoveryCache)
 * @param {Object} options
 * @param {string} [options.payload] - Raw LZString-encoded payload
 * @param {string} [options.html] - Raw HTML containing iframe with payload
 * @param {string} [options.source='dmm'] - Source identifier for release_attributes
 * @param {boolean} [options.skipAttributes] - Skip release attribute parsing
 * @returns {Object} Import statistics
 */
export function importDmmPayload(cache, options = {}) {
  const {
    payload: rawPayload,
    html,
    source = 'dmm',
    skipAttributes = false,
  } = options;

  const stats = {
    imported: 0,
    inserted: 0,
    updated: 0,
    failed: 0,
    attributesParsed: 0,
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
  };

  if (!cache) {
    throw new Error('importDmmPayload requires a cache instance');
  }

  let payload = rawPayload;

  // Extract from HTML if no payload provided
  if (!payload && html) {
    const fragment = extractHashFragment(html);
    if (!fragment) {
      stats.failed++;
      stats.endedAt = Date.now();
      stats.durationMs = stats.endedAt - stats.startedAt;
      return stats;
    }
    payload = fragment;
  }

  if (!payload) {
    stats.endedAt = Date.now();
    stats.durationMs = stats.endedAt - stats.startedAt;
    return stats;
  }

  // Decode LZString payload
  const decoded = decodeDmmPayload(payload);
  if (!decoded) {
    stats.failed++;
    stats.endedAt = Date.now();
    stats.durationMs = stats.endedAt - stats.startedAt;
    return stats;
  }

  // Parse JSON and count ALL raw records (before filtering)
  let data;
  try {
    data = typeof decoded === 'string' ? JSON.parse(decoded) : decoded;
  } catch {
    stats.failed++;
    stats.endedAt = Date.now();
    stats.durationMs = stats.endedAt - stats.startedAt;
    return stats;
  }

  let rawRecords = [];
  if (Array.isArray(data)) {
    rawRecords = data;
  } else if (data && data.torrents && Array.isArray(data.torrents)) {
    rawRecords = data.torrents;
  }
  stats.imported = rawRecords.length;

  // Ingest each record (filtering happens per-record)
  for (const rawRecord of rawRecords) {
    try {
      // Normalize the record
      const entry = parseDmmRecord(rawRecord);
      if (!entry) {
        stats.failed++;
        continue;
      }

      // Check if candidate already exists (for stats)
      const existing = cache.getCandidate(entry.infoHash, entry.fileIndex ?? null);
      const wasExisting = !!existing;

      // Upsert candidate (idempotent)
      // The cache handles ON CONFLICT for candidates with merge semantics
      cache.upsertCandidate({
        infoHash: entry.infoHash,
        fileIndex: entry.fileIndex ?? null,
        searchKey: entry.searchKey ?? null,
        title: entry.title ?? null,
        filename: entry.filename ?? null,
        size: entry.size ?? null,
        seeders: entry.seeders ?? null,
        leechers: entry.leechers ?? null,
        publishDate: entry.publishDate ?? null,
        magnet: entry.magnet ?? null,
        downloadUrl: entry.downloadUrl ?? null,
        metadata: entry.metadata ?? {},
        sources: entry.sources ?? [{ id: 'dmm.hashlist', kind: 'ingestion' }],
        firstSeen: entry.firstSeen ?? Date.now(),
        lastSeen: entry.lastSeen ?? Date.now(),
      });

      if (wasExisting) {
        stats.updated++;
      } else {
        stats.inserted++;
      }

      // Parse release attributes (filename → structured data)
      if (!skipAttributes && entry.filename) {
        const parseResult = parseFilename(entry.filename);
        if (parseResult && parseResult.confidence > 0) {
          const stored = storeReleaseAttributes(cache, {
            infoHash: entry.infoHash,
            fileIndex: entry.fileIndex ?? null,
            filename: entry.filename,
            source,
            confidence: parseResult.confidence,
            parsed: parseResult.parsed,
            evidence: parseResult.evidence,
          });
          if (stored) {
            stats.attributesParsed++;
          }
        }
      }
    } catch (error) {
      stats.failed++;
      // Ingestion failures are isolated per-record
      // Do not throw — continue processing
    }
  }

  stats.endedAt = Date.now();
  stats.durationMs = stats.endedAt - stats.startedAt;
  return stats;
}

/**
 * Import DMM payload from a raw LZString string.
 * Convenience wrapper for importDmmPayload.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {string} payload - LZString-encoded payload
 * @param {Object} options - Additional options
 * @returns {Object} Import statistics
 */
export function importDmmString(cache, payload, options = {}) {
  return importDmmPayload(cache, { ...options, payload });
}

/**
 * Import DMM payload from raw HTML.
 * Convenience wrapper for importDmmPayload.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {string} html - Raw HTML containing iframe
 * @param {Object} options - Additional options
 * @returns {Object} Import statistics
 */
export function importDmmHtml(cache, html, options = {}) {
  return importDmmPayload(cache, { ...options, html });
}

/**
 * Import DMM payload from a URL.
 * Fetches HTML, extracts fragment, decodes, and ingests.
 *
 * @param {Object} cache - Discovery cache instance
 * @param {string} url - URL to fetch HTML from
 * @param {Object} options - Additional options
 * @param {Function} [options.fetchFn] - Custom fetch function (defaults to global fetch)
 * @returns {Object} Import statistics
 */
export async function importDmmUrl(cache, url, options = {}) {
  const { fetchFn = fetch, ...rest } = options;
  const html = await fetchFn(url).then(r => r.text());
  return importDmmPayload(cache, { ...rest, html });
}
