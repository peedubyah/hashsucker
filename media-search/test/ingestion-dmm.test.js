/**
 * DMM Ingestion Tests
 *
 * Tests the DMM ingestion pipeline:
 * - decode real payload fixture
 * - normalize records
 * - idempotent import
 * - malformed record handling
 * - import statistics
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { importDmmString, importDmmHtml } from '../src/lib/ingestion/dmm.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { encodeDmmPayload } from '../src/lib/discovery/adapters/dmm.js';

const HASH1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';

// =============================================================================
// Test: Import from LZString payload
// =============================================================================

test('importDmmString: ingests records from LZString payload', () => {
  const cache = createDiscoveryCache();
  const json = JSON.stringify({
    torrents: [
      { hash: HASH1, filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv', bytes: 8000000000 },
      { hash: HASH2, filename: 'Show.S01E01.720p.WEB-DL.mkv', bytes: 2000000000 },
    ],
  });
  const payload = encodeDmmPayload(json);

  const stats = importDmmString(cache, payload);

  assert.equal(stats.imported, 2);
  assert.equal(stats.inserted, 2);
  assert.equal(stats.updated, 0);
  assert.equal(stats.failed, 0);
  assert.ok(stats.durationMs >= 0);

  // Verify candidates stored
  const c1 = cache.getCandidate(HASH1, null);
  assert.ok(c1);
  assert.equal(c1.filename, 'Movie.2024.1080p.BluRay.x264-Group.mkv');
  assert.equal(c1.size, 8000000000);

  const c2 = cache.getCandidate(HASH2, null);
  assert.ok(c2);
  assert.equal(c2.filename, 'Show.S01E01.720p.WEB-DL.mkv');

  cache.close();
});

// =============================================================================
// Test: Import from HTML
// =============================================================================

test('importDmmHtml: extracts and ingests from HTML', () => {
  const cache = createDiscoveryCache();
  const json = JSON.stringify({
    torrents: [
      { hash: HASH1, filename: 'Test.Movie.2024.1080p.mkv', bytes: 5000000000 },
    ],
  });
  const payload = encodeDmmPayload(json);
  const html = `<html><body><iframe src="https://debridmediamanager.com/hashlist#${payload}"></iframe></body></html>`;

  const stats = importDmmHtml(cache, html);

  assert.equal(stats.imported, 1);
  assert.equal(stats.inserted, 1);
  assert.equal(stats.failed, 0);

  const c1 = cache.getCandidate(HASH1, null);
  assert.ok(c1);
  assert.equal(c1.filename, 'Test.Movie.2024.1080p.mkv');

  cache.close();
});

// =============================================================================
// Test: Idempotent import
// =============================================================================

test('importDmmString: idempotent re-import updates rather than duplicates', () => {
  const cache = createDiscoveryCache();
  const json = JSON.stringify({
    torrents: [
      { hash: HASH1, filename: 'Movie.2024.1080p.mkv', bytes: 5000000000 },
    ],
  });
  const payload = encodeDmmPayload(json);

  // First import
  const stats1 = importDmmString(cache, payload);
  assert.equal(stats1.inserted, 1);
  assert.equal(stats1.updated, 0);

  // Second import (same data)
  const stats2 = importDmmString(cache, payload);
  assert.equal(stats2.imported, 1);
  assert.equal(stats2.inserted, 0);
  assert.equal(stats2.updated, 1);

  // Still only one candidate
  const c1 = cache.getCandidate(HASH1, null);
  assert.ok(c1);
  assert.equal(c1.filename, 'Movie.2024.1080p.mkv');

  cache.close();
});

// =============================================================================
// Test: Malformed record handling
// =============================================================================

test('importDmmString: handles malformed records gracefully', () => {
  const cache = createDiscoveryCache();
  const json = JSON.stringify({
    torrents: [
      { hash: HASH1, filename: 'Valid.mkv', bytes: 1000 },
      { hash: 'invalid_hash', filename: 'BadHash.mkv', bytes: 1000 }, // Invalid
      { hash: HASH2, filename: '', bytes: 1000 }, // Missing filename
      { hash: HASH3, filename: 'Good.mkv', bytes: 2000 },
    ],
  });
  const payload = encodeDmmPayload(json);

  const stats = importDmmString(cache, payload);

  assert.equal(stats.imported, 4);
  assert.equal(stats.inserted, 2); // HASH1 and HASH3
  assert.equal(stats.failed, 2); // invalid hash + empty filename

  const c1 = cache.getCandidate(HASH1, null);
  assert.ok(c1);

  const c3 = cache.getCandidate(HASH3, null);
  assert.ok(c3);

  cache.close();
});

// =============================================================================
// Test: Release attribute parsing
// =============================================================================

test('importDmmString: parses release attributes from filename', () => {
  const cache = createDiscoveryCache();
  const json = JSON.stringify({
    torrents: [
      { hash: HASH1, filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv', bytes: 8000000000 },
    ],
  });
  const payload = encodeDmmPayload(json);

  const stats = importDmmString(cache, payload);

  assert.equal(stats.attributesParsed, 1);

  // Verify attributes stored
  const attrs = cache.getReleaseAttributes(HASH1, null, 'dmm');
  assert.ok(attrs);
  assert.ok(attrs.length > 0);
  assert.equal(attrs[0].title, 'Movie');
  assert.equal(attrs[0].year, 2024);
  assert.equal(attrs[0].resolution, '1080p');

  cache.close();
});

// =============================================================================
// Test: Empty payload
// =============================================================================

test('importDmmString: handles empty payload', () => {
  const cache = createDiscoveryCache();
  const json = JSON.stringify({ torrents: [] });
  const payload = encodeDmmPayload(json);

  const stats = importDmmString(cache, payload);

  assert.equal(stats.imported, 0);
  assert.equal(stats.inserted, 0);
  assert.equal(stats.failed, 0);

  cache.close();
});

// =============================================================================
// Test: Invalid payload
// =============================================================================

test('importDmmString: handles invalid LZString payload', () => {
  const cache = createDiscoveryCache();

  const stats = importDmmString(cache, 'not-valid-lz-string!!!');

  assert.equal(stats.imported, 0);
  assert.equal(stats.failed, 1);

  cache.close();
});

// =============================================================================
// Test: HTML without iframe
// =============================================================================

test('importDmmHtml: handles HTML without iframe', () => {
  const cache = createDiscoveryCache();
  const html = '<html><body>No iframe here</body></html>';

  const stats = importDmmHtml(cache, html);

  assert.equal(stats.imported, 0);
  assert.equal(stats.failed, 1);

  cache.close();
});

// =============================================================================
// Test: Import statistics shape
// =============================================================================

test('importDmmString: returns correct statistics shape', () => {
  const cache = createDiscoveryCache();
  const json = JSON.stringify({
    torrents: [
      { hash: HASH1, filename: 'A.mkv', bytes: 1000 },
      { hash: HASH2, filename: 'B.mkv', bytes: 2000 },
    ],
  });
  const payload = encodeDmmPayload(json);

  const stats = importDmmString(cache, payload);

  assert.equal(typeof stats.imported, 'number');
  assert.equal(typeof stats.inserted, 'number');
  assert.equal(typeof stats.updated, 'number');
  assert.equal(typeof stats.failed, 'number');
  assert.equal(typeof stats.attributesParsed, 'number');
  assert.equal(typeof stats.durationMs, 'number');
  assert.ok(stats.startedAt > 0);
  assert.ok(stats.endedAt > 0);
  assert.ok(stats.endedAt >= stats.startedAt);

  cache.close();
});

// =============================================================================
// Test: Skip attributes option
// =============================================================================

test('importDmmString: skipAttributes option disables attribute parsing', () => {
  const cache = createDiscoveryCache();
  const json = JSON.stringify({
    torrents: [
      { hash: HASH1, filename: 'Movie.2024.1080p.mkv', bytes: 1000 },
    ],
  });
  const payload = encodeDmmPayload(json);

  const stats = importDmmString(cache, payload, { skipAttributes: true });

  assert.equal(stats.imported, 1);
  assert.equal(stats.attributesParsed, 0);

  cache.close();
});

// =============================================================================
// Test: Beta URL support
// =============================================================================

test('importDmmHtml: supports beta.debridmediamanager.com URLs', () => {
  const cache = createDiscoveryCache();
  const json = JSON.stringify({
    torrents: [
      { hash: HASH1, filename: 'Test.mkv', bytes: 1000 },
    ],
  });
  const payload = encodeDmmPayload(json);
  const html = `<html><body><iframe src="https://beta.debridmediamanager.com/hashlist#${payload}"></iframe></body></html>`;

  const stats = importDmmHtml(cache, html);

  assert.equal(stats.imported, 1);
  assert.equal(stats.inserted, 1);

  cache.close();
});
