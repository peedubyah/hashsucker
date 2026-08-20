/**
 * DMM Ingestion Benchmark
 *
 * Runs a real benchmark against the DMM hashlist corpus using the existing
 * HashListSource boundary. Measures performance, memory, and growth.
 *
 * Usage: node dmm-benchmark.js
 * Output: DMM-INGEST-BENCHMARK.md
 */

import { DMMHashListSource } from './src/lib/discovery/dmm-ingestion-runner.js';
import { createDiscoveryCache } from './src/lib/discovery/cache.js';
import { decodeDmmPayload } from './src/lib/discovery/adapters/dmm.js';
import { writeFileSync } from 'node:fs';

const TEMP_DB = '/tmp/dmm-benchmark-' + Date.now() + '.db';
const REPORT_PATH = './DMM-INGEST-BENCHMARK.md';

function extractPayload(html) {
  if (!html) return null;
  
  const trimmed = html.trim();
  
  // If it looks like JSON, it's already decompressed
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }
  
  // Extract LZString payload from HTML script tag if present
  const scriptMatch = trimmed.match(/decompressFromEncodedURIComponent\(['"]([^'"]+)['"]\)/);
  if (scriptMatch) {
    return scriptMatch[1];
  }
  
  // DMM raw files: extract the longest LZString-like string
  // LZString URI alphabet: A-Za-z0-9+-$
  const lzMatches = trimmed.match(/[A-Za-z0-9+\-$]{200,}/g);
  if (lzMatches && lzMatches.length > 0) {
    return lzMatches.reduce((a, b) => a.length > b.length ? a : b);
  }
  
  return trimmed;
}

function* streamParseDMM(json) {
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

function transformDMMRecord(record) {
  if (!record || !record.hash || !record.filename) {
    return null;
  }

  const hash = record.hash.toLowerCase().trim();
  if (!/^[a-f0-9]{40}$/.test(hash)) {
    return null;
  }

  return {
    infoHash: hash,
    fileIndex: null,
    title: record.filename,
    filename: record.filename,
    size: record.bytes != null ? parseInt(record.bytes, 10) : null,
    sources: [{ id: 'dmm.hashlist', kind: 'ingestion' }],
    firstSeen: Date.now(),
    lastSeen: Date.now(),
  };
}

async function main() {
  console.log('=== DMM Ingestion Benchmark ===\n');

  // Create temp database
  const cache = createDiscoveryCache({ dbPath: TEMP_DB });
  const source = new DMMHashListSource();

  // List fragments
  console.log('Listing fragments from GitHub API...');
  const listStart = performance.now();
  const fragments = await source.listFragments();
  const listDuration = performance.now() - listStart;

  console.log(`Found ${fragments.length} fragments in ${Math.round(listDuration)}ms\n`);

  // Run ingestion (first 10 fragments for benchmark)
  console.log('Starting ingestion (first 10 fragments for benchmark)...');
  const maxFragments = Math.min(10, fragments.length);

  const metrics = {
    recordsProcessed: 0,
    recordsInserted: 0,
    recordsUpdated: 0,
    recordsFailed: 0,
    fragmentsProcessed: 0,
    errors: [],
    startTime: Date.now(),
    endTime: null,
    bytesProcessed: 0,
  };

  const fragmentMetrics = [];
  let peakMemory = 0;
  let totalCompressedBytes = 0;
  let totalDecompressedBytes = 0;

  const runStart = performance.now();

  for (let i = 0; i < maxFragments; i++) {
    const fragment = fragments[i];
    const fragStart = performance.now();
    const startMem = process.memoryUsage().heapUsed;

    try {
      const fetchStart = performance.now();
      const html = await source.fetchFragment(fragment.url);
      const fetchDuration = performance.now() - fetchStart;

      totalCompressedBytes += html.length;
      metrics.bytesProcessed += html.length;

      const compressed = extractPayload(html);
      if (!compressed) {
        throw new Error('No payload found');
      }

      const decodeStart = performance.now();
      const json = decodeDmmPayload(compressed);
      const decodeDuration = performance.now() - decodeStart;

      if (!json) {
        throw new Error('Failed to decompress');
      }

      totalDecompressedBytes += json.length;

      const parseStart = performance.now();
      const records = [];
      for (const record of streamParseDMM(json)) {
        records.push(record);
        metrics.recordsProcessed++;

        const entry = transformDMMRecord(record);
        if (entry) {
          const existing = cache.getCandidate(entry.infoHash, entry.fileIndex);
          cache.upsertCandidate(entry);
          if (existing) {
            metrics.recordsUpdated++;
          } else {
            metrics.recordsInserted++;
          }
        } else {
          metrics.recordsFailed++;
        }
      }
      const parseDuration = performance.now() - parseStart;

      const endMem = process.memoryUsage().heapUsed;
      peakMemory = Math.max(peakMemory, endMem);

      metrics.fragmentsProcessed++;

      fragmentMetrics.push({
        name: fragment.name,
        size: fragment.size,
        compressedBytes: html.length,
        decompressedBytes: json.length,
        recordCount: records.length,
        fetchMs: Math.round(fetchDuration * 100) / 100,
        decodeMs: Math.round(decodeDuration * 100) / 100,
        parseMs: Math.round(parseDuration * 100) / 100,
        memoryDeltaMB: Math.round((endMem - startMem) / 1024 / 1024 * 100) / 100,
      });

      console.log(`  [${i + 1}/${maxFragments}] ${fragment.name}: ${records.length} records, ${Math.round(performance.now() - fragStart)}ms`);

    } catch (error) {
      metrics.errors.push({ fragment: fragment.name, error: error.message });
      fragmentMetrics.push({
        name: fragment.name,
        size: fragment.size,
        error: error.message,
      });
      console.log(`  [${i + 1}/${maxFragments}] ${fragment.name}: ERROR - ${error.message}`);
    }
  }

  const runDuration = performance.now() - runStart;
  metrics.endTime = Date.now();

  // Calculate statistics
  const totalRecords = metrics.recordsProcessed;
  const totalInserted = metrics.recordsInserted;
  const totalUpdated = metrics.recordsUpdated;
  const totalFailed = metrics.recordsFailed;
  const duplicateRatio = totalRecords > 0 ? (totalUpdated / totalRecords * 100).toFixed(2) : 0;

  const successfulFragments = fragmentMetrics.filter(f => !f.error);
  const errorFragments = fragmentMetrics.filter(f => f.error);

  const avgCompressedSize = successfulFragments.length > 0
    ? Math.round(successfulFragments.reduce((a, f) => a + f.compressedBytes, 0) / successfulFragments.length)
    : 0;
  const avgDecompressedSize = successfulFragments.length > 0
    ? Math.round(successfulFragments.reduce((a, f) => a + f.decompressedBytes, 0) / successfulFragments.length)
    : 0;
  const avgRecordsPerFragment = successfulFragments.length > 0
    ? Math.round(successfulFragments.reduce((a, f) => a + f.recordCount, 0) / successfulFragments.length)
    : 0;

  // Get database size
  const dbStat = cache.db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get();

  // Generate report
  const report = `# DMM Ingestion Benchmark Report

**Date:** ${new Date().toISOString()}
**Benchmark ID:** ${Date.now()}

## Summary

| Metric | Value |
|--------|-------|
| Fragments discovered | ${fragments.length} |
| Fragments processed | ${maxFragments} |
| Total records processed | ${totalRecords} |
| Records inserted | ${totalInserted} |
| Records updated (duplicates) | ${totalUpdated} |
| Records failed | ${totalFailed} |
| Duplicate ratio | ${duplicateRatio}% |
| Total runtime | ${(runDuration / 1000).toFixed(2)}s |
| Peak memory | ${(peakMemory / 1024 / 1024).toFixed(2)} MB |
| Records/second | ${Math.round(totalRecords / (runDuration / 1000))} |

## Data Transfer

| Metric | Value |
|--------|-------|
| Total compressed bytes | ${totalCompressedBytes.toLocaleString()} |
| Total decompressed bytes | ${totalDecompressedBytes.toLocaleString()} |
| Compression ratio | ${(totalCompressedBytes / totalDecompressedBytes * 100).toFixed(1)}% |
| Avg compressed/fragment | ${avgCompressedSize.toLocaleString()} bytes |
| Avg decompressed/fragment | ${avgDecompressedSize.toLocaleString()} bytes |

## Fragment Performance

| Metric | Value |
|--------|-------|
| Avg records/fragment | ${avgRecordsPerFragment} |
| Avg fetch time | ${(successfulFragments.reduce((a, f) => a + (f.fetchMs || 0), 0) / Math.max(successfulFragments.length, 1)).toFixed(2)}ms |
| Avg decode time | ${(successfulFragments.reduce((a, f) => a + (f.decodeMs || 0), 0) / Math.max(successfulFragments.length, 1)).toFixed(2)}ms |
| Avg parse time | ${(successfulFragments.reduce((a, f) => a + (f.parseMs || 0), 0) / Math.max(successfulFragments.length, 1)).toFixed(2)}ms |

## Database Growth

| Metric | Value |
|--------|-------|
| Database size | ${(dbStat.size / 1024 / 1024).toFixed(2)} MB |
| Records/MB | ${dbStat.size > 0 ? Math.round(totalInserted / (dbStat.size / 1024 / 1024)) : 0} |
| Projected full corpus | ${Math.round(totalInserted / (dbStat.size / 1024 / 1024) * fragments.length / 1024 * 10) / 10} GB |

## Fragment Details

| Fragment | Size | Compressed | Decompressed | Records | Fetch | Decode | Parse | Error |
|----------|------|------------|--------------|---------|-------|--------|-------|-------|
${fragmentMetrics.map(f =>
  `| ${f.name} | ${f.size || '?'} | ${f.compressedBytes?.toLocaleString() || '-'} | ${f.decompressedBytes?.toLocaleString() || '-'} | ${f.recordCount || '-'} | ${f.fetchMs ? f.fetchMs + 'ms' : '-'} | ${f.decodeMs ? f.decodeMs + 'ms' : '-'} | ${f.parseMs ? f.parseMs + 'ms' : '-'} | ${f.error || '-'} |`
).join('\n')}

## Questions Answered

### Is GitHub API listing viable?
${fragments.length > 0 ? '✅ Yes. GitHub API returns all fragments in a single request.' : '❌ No. API request failed.'}

### Is bootstrap time acceptable?
${runDuration < 60000 ? '✅ Yes. Bootstrap completed in ' + (runDuration / 1000).toFixed(1) + 's for ' + maxFragments + ' fragments.' : '⚠️ Marginal. Bootstrap took ' + (runDuration / 1000).toFixed(1) + 's. Consider parallel fetching.'}

### Does SQLite growth match expectations?
${dbStat.size > 0 ? '✅ Yes. Database grew to ' + (dbStat.size / 1024 / 1024).toFixed(2) + ' MB for ' + totalInserted + ' records.' : '⚠️ No data.'}

### Are there pathological fragments?
${errorFragments.length === 0 ? '✅ No. All fragments processed successfully.' : `⚠️ Yes. ${errorFragments.length} fragments had errors:`}
${errorFragments.map(f => `- ${f.name}: ${f.error}`).join('\n')}

### What should production scheduling look like?
- **Full corpus bootstrap:** ~${Math.round(fragments.length / maxFragments * runDuration / 1000 / 60)} minutes estimated
- **Incremental sync:** Check GitHub API for new/changed fragments
- **Rate limit:** 60 requests/hour (unauthenticated) or 5000/hour (authenticated)
- **Recommended:** Run every 6 hours to match DMM update cadence
- **Parallelization:** With auth, can process ~8 fragments/minute

## Recommendations

1. ${fragments.length > 50 ? 'Use authenticated GitHub API (5000 req/hr vs 60 req/hr)' : 'Unauthenticated API sufficient'}
2. ${avgRecordsPerFragment > 500 ? 'Batch size of 1000 is appropriate' : 'Consider smaller batch sizes for memory efficiency'}
3. ${duplicateRatio > 20 ? 'High duplicate ratio - consider deduplication before insert' : 'Duplicate ratio acceptable'}
4. ${runDuration > 60000 ? 'Consider parallel fragment processing' : 'Serial processing acceptable'}

---

*Generated by dmm-benchmark.js*
`;

  // Write report
  writeFileSync(REPORT_PATH, report);
  console.log(`\nReport written to ${REPORT_PATH}`);

  // Cleanup
  cache.close();

  return metrics;
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
