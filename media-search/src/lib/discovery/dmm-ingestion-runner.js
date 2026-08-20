/**
 * DMM Corpus Ingestion Runner
 *
 * Fetches, decompresses, and ingests DMM hashlist data into the candidate cache.
 *
 * Transport abstraction:
 * - HashListSource interface: listFragments(), fetchFragment(url)
 * - DMMHashListSource: GitHub Pages → HTML → LZString payload
 * - Future: CDN source, torrent-based, etc.
 *
 * Memory efficiency:
 * - Streaming JSON parser (yields records one at a time)
 * - Batch ingestion (commit every N records)
 * - Single fragment processed at a time
 *
 * Metrics:
 * - records processed, duplicates, failures, duration, estimated db growth
 */

// DMM source adapter (WINDOWS: canonical parser, well-tested with real DMM data)
import { decodeDmmPayload as decompressFromEncodedURIComponent, parseDmmRecord } from './adapters/dmm.js';
import { ingestCandidates } from './ingest.js';
import { runAttributeWorker } from './attribute-worker.js';
import { runEnrichmentWorker } from './worker.js';
import { enrichWithCinemeta } from './enrichment-sources/cinemeta.js';

/**
 * Abstract hashlist source interface.
 */
export class HashListSource {
  async listFragments() {
    throw new Error('not implemented');
  }
  async fetchFragment(url) {
    throw new Error('not implemented');
  }
}

/**
 * DMM Hashlist Source
 *
 * Canonical source: https://hashlists.debridmediamanager.com
 * Implementation: GitHub Pages → HTML → LZString-compressed JSON
 *
 * Each fragment is a separate HTML page containing compressed payload.
 */
export class DMMHashListSource extends HashListSource {
  constructor({ baseUrl, githubToken } = {}) {
    super();
    this.baseUrl = baseUrl || 'https://hashlists.debridmediamanager.com';
    this.apiBase = 'https://api.github.com/repos/debridmediamanager/hashlists/contents';
    this.githubToken = githubToken || null;
  }

  /**
   * List available hashlist fragments from GitHub API.
   */
  async listFragments() {
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'HashSucker/1.0',
    };
    if (this.githubToken) {
      headers['Authorization'] = `token ${this.githubToken}`;
    }

    const response = await fetch(this.apiBase, { headers });
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const contents = await response.json();
    const fragments = contents
      .filter(item => item.name.endsWith('.html'))
      .map(item => ({
        url: item.download_url,
        name: item.name,
        size: item.size,
      }));

    return fragments;
  }

  /**
   * Fetch and decompress a single fragment.
   * Returns the raw HTML with embedded LZString payload.
   */
  async fetchFragment(url) {
    const headers = {
      'User-Agent': 'HashSucker/1.0',
    };

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Fragment fetch error: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  }
}

/**
 * Parse HTML and extract LZString-compressed JSON payload.
 */
export function extractPayload(html) {
  if (!html) return null;

  // Find the LZString compressed payload
  const scriptMatch = html.match(/decompressFromEncodedURIComponent\(['"]([^'"]+)['"]\)/);
  if (!scriptMatch) return null;

  return scriptMatch[1];
}

/**
 * Streaming JSON parser for DMM payloads.
 * Yields records one at a time to avoid loading entire corpus.
 *
 * @param {string} json - JSON string (array of records or object with torrents[])
 * @yields {Object} Individual records
 */
export function* streamParseDMM(json) {
  if (!json) return;

  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const objStr = json.slice(start, i + 1);
        try {
          const obj = JSON.parse(objStr);
          // Handle DMM's {torrents: [...]} format
          if (obj.torrents && Array.isArray(obj.torrents)) {
            for (const item of obj.torrents) {
              yield item;
            }
          } else {
            yield obj;
          }
        } catch (e) {
          // Skip malformed objects
        }
        start = -1;
      }
    }
  }
}

/**
 * Transform DMM record to HashSucker ingest entry.
 * Delegates to the canonical DMM source adapter (parseDmmRecord) and adds
 * timestamps for the runner's tracking.
 */
export function transformDMMRecord(record) {
  // Delegate to the canonical DMM adapter (WINDOWS: tested with real DMM data)
  const entry = parseDmmRecord(record);
  if (!entry) return null;

  // Add timestamps for the runner's tracking
  entry.firstSeen = Date.now();
  entry.lastSeen = Date.now();

  return entry;
}

/**
 * Ingestion metrics tracker.
 */
export class IngestionMetrics {
  constructor() {
    this.recordsProcessed = 0;
    this.recordsInserted = 0;
    this.recordsUpdated = 0;
    this.recordsFailed = 0;
    this.recordsDuplicate = 0;
    this.fragmentsProcessed = 0;
    this.errors = [];
    this.startTime = null;
    this.endTime = null;
    this.bytesProcessed = 0;
  }

  start() {
    this.startTime = Date.now();
  }

  stop() {
    this.endTime = Date.now();
  }

  get duration() {
    if (!this.startTime) return 0;
    const end = this.endTime || Date.now();
    return end - this.startTime;
  }

  get recordsPerSecond() {
    const dur = this.duration / 1000;
    if (dur === 0) return 0;
    return this.recordsProcessed / dur;
  }

  /**
   * Estimate database growth based on average record size.
   * DMM records average ~200 bytes in SQLite.
   */
  estimateDatabaseGrowthMB() {
    const avgRecordSize = 200; // bytes per record in SQLite
    return (this.recordsInserted * avgRecordSize) / (1024 * 1024);
  }

  recordProcessed() {
    this.recordsProcessed++;
  }

  recordInserted() {
    this.recordsInserted++;
  }

  recordUpdated() {
    this.recordsUpdated++;
    this.recordsDuplicate++;
  }

  recordFailed() {
    this.recordsFailed++;
  }

  fragmentProcessed() {
    this.fragmentsProcessed++;
  }

  addError(error) {
    this.errors.push({
      message: error.message,
      timestamp: Date.now(),
    });
  }

  toJSON() {
    return {
      recordsProcessed: this.recordsProcessed,
      recordsInserted: this.recordsInserted,
      recordsUpdated: this.recordsUpdated,
      recordsFailed: this.recordsFailed,
      recordsDuplicate: this.recordsDuplicate,
      fragmentsProcessed: this.fragmentsProcessed,
      durationMs: this.duration,
      recordsPerSecond: Math.round(this.recordsPerSecond * 100) / 100,
      estimatedGrowthMB: Math.round(this.estimateDatabaseGrowthMB() * 100) / 100,
      errorCount: this.errors.length,
      errors: this.errors.slice(0, 10), // First 10 errors
      attributeStats: this.attributeStats || null,
    };
  }
}

/**
 * DMM Corpus Ingestion Runner
 *
 * Orchestrates fetching, parsing, and ingesting DMM hashlist data.
 */
export class DMMIngestionRunner {
  constructor({
    source = null,
    cache = null,
    batchSize = 1000,
    maxFragments = null,
    onProgress = null,
    enableAttributeParsing = true,
    enableMediaEnrichment = false,  // Disabled by default (requires external API calls)
  } = {}) {
    this.source = source || new DMMHashListSource();
    this.cache = cache;
    this.batchSize = batchSize;
    this.maxFragments = maxFragments;
    this.onProgress = onProgress || null;
    this.enableAttributeParsing = enableAttributeParsing;
    this.enableMediaEnrichment = enableMediaEnrichment;
    this.metrics = new IngestionMetrics();
  }

  /**
   * Run the full ingestion pipeline.
   */
  async run() {
    if (!this.cache) {
      throw new Error('DMMIngestionRunner requires a cache');
    }

    this.metrics.start();

    try {
      // 1. List available fragments
      const fragments = await this.source.listFragments();
      const toProcess = this.maxFragments
        ? fragments.slice(0, this.maxFragments)
        : fragments;

      // 2. Process each fragment
      for (const fragment of toProcess) {
        await this.processFragment(fragment);
      }

      // 3. Attribute parsing pass (post-ingestion enrichment)
      //    Parses filenames of newly-ingested candidates into release_attributes,
      //    which auto-populates the FTS5 search index via triggers.
      if (this.enableAttributeParsing) {
        const attrStats = await runAttributeWorker(this.cache, {
          parser: undefined, // uses default parseFilename
          limit: undefined,  // all unparsed candidates
        });
        this.metrics.attributeStats = attrStats;
      }

      // 4. Media identity enrichment pass (optional, uses external API)
      //    Resolves release_attributes → candidate_media associations via Cinemeta.
      if (this.enableMediaEnrichment) {
        const enrichStats = await runEnrichmentWorker(this.cache, {
          enrich: enrichWithCinemeta,
          limit: undefined,
        });
        this.metrics.enrichmentStats = enrichStats;
      }
    } finally {
      this.metrics.stop();
    }

    return this.metrics.toJSON();
  }

  /**
   * Process a single fragment.
   */
  async processFragment(fragment) {
    try {
      // Fetch HTML
      const html = await this.source.fetchFragment(fragment.url);
      this.metrics.bytesProcessed += html.length;

      // Extract LZString payload
      const compressed = extractPayload(html);
      if (!compressed) {
        this.metrics.addError(new Error(`No payload found in ${fragment.name}`));
        return;
      }

      // Decompress
      const json = decompressFromEncodedURIComponent(compressed);
      if (!json) {
        this.metrics.addError(new Error(`Failed to decompress ${fragment.name}`));
        return;
      }

      // Stream parse and ingest in batches
      await this.ingestFromStream(streamParseDMM(json));

      this.metrics.fragmentProcessed();
    } catch (error) {
      this.metrics.addError(error);
    }

    if (this.onProgress) {
      this.onProgress(this.metrics);
    }
  }

  /**
   * Ingest records from a streaming parser.
   */
  async ingestFromStream(recordStream) {
    let batch = [];

    for (const record of recordStream) {
      this.metrics.recordProcessed();

      const entry = transformDMMRecord(record);
      if (!entry) {
        this.metrics.recordFailed();
        continue;
      }

      batch.push(entry);

      if (batch.length >= this.batchSize) {
        await this.flushBatch(batch);
        batch = [];
      }
    }

    // Flush remaining
    if (batch.length > 0) {
      await this.flushBatch(batch);
    }
  }

  /**
   * Flush a batch of entries through the ingestion boundary.
   */
  async flushBatch(batch) {
    try {
      // Use existing ingestCandidates boundary
      const result = ingestCandidates(this.cache, {
        source: 'dmm-hashlist',
        entries: batch,
      });

      this.metrics.recordsInserted += result.inserted || 0;
      // Each updated record is a duplicate (already existed)
      for (let i = 0; i < (result.updated || 0); i++) {
        this.metrics.recordUpdated();
      }
    } catch (error) {
      this.metrics.recordsFailed += batch.length;
      this.metrics.addError(error);
    }
  }
}

/**
 * Convenience function to run DMM ingestion.
 */
export async function runDMMIngestion(options = {}) {
  const runner = new DMMIngestionRunner(options);
  return await runner.run();
}
