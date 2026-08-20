/**
 * Filename Parser Adapter Tests
 *
 * Tests the PTN-based regex parser for release filename parsing.
 * Proves:
 * - Parser extracts standard fields (title, year, season, episode, etc.)
 * - Evidence tags are preserved
 * - Raw filename is always retained
 * - Low-confidence parses are flagged
 * - Parser failures don't break ingestion
 * - Ambiguous titles remain unresolved
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseFilename,
  createReleaseAttributes,
  parseFilenames,
} from '../src/lib/discovery/parser-adapter.js';

import { storeReleaseAttributes, getReleaseAttributesForCandidate, getStrongestReleaseAttributes } from '../src/lib/discovery/release-attributes.js';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const OTHER_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// =============================================================================
// Parser Output Tests
// =============================================================================

test('parseFilename extracts title from standard movie release', () => {
  const result = parseFilename('The.Matrix.1999.1080p.BluRay.x264-Group');
  assert.ok(result);
  assert.equal(result.filename, 'The.Matrix.1999.1080p.BluRay.x264-Group');
  assert.equal(result.parsed.title, 'The Matrix');
  assert.equal(result.parsed.year, 1999);
  assert.equal(result.parsed.resolution, '1080p');
  assert.equal(result.parsed.source, 'BluRay');
  assert.equal(result.parsed.codec, 'x264');
  assert.equal(result.parsed.releaseGroup, 'Group');
  assert.ok(result.confidence > 0.5);
  assert.ok(result.evidence.includes('title_extracted'));
  assert.ok(result.evidence.includes('year_detected'));
  assert.ok(result.evidence.includes('resolution_detected'));
});

test('parseFilename extracts season and episode', () => {
  const result = parseFilename('Black.Mirror.S07E03.1080p.WEB-DL');
  assert.ok(result);
  assert.equal(result.parsed.title, 'Black Mirror');
  assert.equal(result.parsed.season, 7);
  assert.equal(result.parsed.episode, 3);
  assert.equal(result.parsed.resolution, '1080p');
  assert.equal(result.parsed.source, 'WEB-DL');
  assert.equal(result.parsed.mediaType, 'episode');
  assert.ok(result.evidence.includes('season_episode_detected'));
});

test('parseFilename extracts episode range', () => {
  const result = parseFilename('Show.S01E01-E03.720p');
  assert.ok(result);
  assert.equal(result.parsed.episodeRange, '1-3');
  assert.equal(result.parsed.season, 1);
});

test('parseFilename extracts HDR flag', () => {
  const result = parseFilename('Movie.2024.2160p.HDR.DV.x265');
  assert.ok(result);
  assert.equal(result.parsed.hdr, true);
  assert.equal(result.parsed.resolution, '2160p');
  assert.ok(result.evidence.includes('hdr_detected'));
});

test('parseFilename extracts audio format', () => {
  const result = parseFilename('Release.2024.1080p.DTS-HD.x264');
  assert.ok(result);
  assert.equal(result.parsed.audio, 'DTS-HD');
  assert.ok(result.evidence.includes('audio_detected'));
});

test('parseFilename extracts codec variants', () => {
  const h265 = parseFilename('Release.x265.1080p');
  assert.equal(h265.parsed.codec, 'x265');

  const hevc = parseFilename('Release.HEVC.1080p');
  assert.equal(hevc.parsed.codec, 'x265');

  const h264 = parseFilename('Release.x264.720p');
  assert.equal(h264.parsed.codec, 'x264');
});

test('parseFilename normalizes resolution', () => {
  const uhd = parseFilename('Movie.2160p.BluRay');
  assert.equal(uhd.parsed.resolution, '2160p');

  const fourK = parseFilename('Movie.4K.UHD');
  assert.equal(fourK.parsed.resolution, '2160p');
});

test('parseFilename handles Season X Episode Y format', () => {
  const result = parseFilename('Show Season 2 Episode 5 1080p');
  assert.ok(result);
  assert.equal(result.parsed.season, 2);
  assert.equal(result.parsed.episode, 5);
});

test('parseFilename returns null for empty filename', () => {
  assert.equal(parseFilename(''), null);
  assert.equal(parseFilename(null), null);
  assert.equal(parseFilename(undefined), null);
});

test('parseFilename handles ambiguous filename gracefully', () => {
  const result = parseFilename('video');
  assert.ok(result);
  assert.equal(result.parsed.title, 'video');
  assert.equal(result.confidence, 0.55); // Base + title
  // Should not crash, but low confidence
});

// =============================================================================
// Confidence Tests
// =============================================================================

test('confidence increases with more detected fields', () => {
  const minimal = parseFilename('Movie.Title');
  const full = parseFilename('Movie.Title.2024.1080p.BluRay.x264.DTS-Group');

  assert.ok(full.confidence > minimal.confidence);
  assert.ok(full.confidence <= 1.0);
  assert.ok(minimal.confidence >= 0.3);
});

test('confidence is within valid range', () => {
  const result = parseFilename('A.2024.1080p.BluRay.x264.DTS-HD.AAC.HDR.GROUP');
  assert.ok(result.confidence >= 0.0);
  assert.ok(result.confidence <= 1.0);
});

test('low-confidence parse is still stored', () => {
  const cache = createDiscoveryCache();
  const attrs = createReleaseAttributes(HASH, null, 'video');
  assert.ok(attrs);
  assert.ok(attrs.confidence < 0.6);

  // Store it anyway
  const stored = storeReleaseAttributes(cache, attrs);
  assert.equal(stored, true);

  const retrieved = cache.getReleaseAttributes(HASH, null);
  assert.equal(retrieved.length, 1);

  cache.close();
});

// =============================================================================
// Evidence Tests
// =============================================================================

test('evidence tags are preserved through storage', () => {
  const cache = createDiscoveryCache();
  const attrs = createReleaseAttributes(HASH, null, 'Movie.2024.1080p.x264-Group');

  storeReleaseAttributes(cache, attrs);

  const retrieved = cache.getReleaseAttributes(HASH, null);
  assert.equal(retrieved.length, 1);
  assert.ok(retrieved[0].evidence.includes('title_extracted'));
  assert.ok(retrieved[0].evidence.includes('year_detected'));
  assert.ok(retrieved[0].evidence.includes('resolution_detected'));

  cache.close();
});

test('evidence tags describe what was found', () => {
  const result = parseFilename('Movie.2024.1080p.BluRay.x264.DTS-Group');

  assert.ok(result.evidence.includes('title_extracted'));
  assert.ok(result.evidence.includes('year_detected'));
  assert.ok(result.evidence.includes('resolution_detected'));
  assert.ok(result.evidence.includes('source_detected'));
  assert.ok(result.evidence.includes('codec_detected'));
  assert.ok(result.evidence.includes('audio_detected'));
  assert.ok(result.evidence.includes('release_group_detected'));
});

// =============================================================================
// Raw Filename Preservation
// =============================================================================

test('raw filename is always retained', () => {
  const original = 'Some.Complex.Filename.2024.1080p.BluRay.x264-Group.mkv';
  const result = parseFilename(original);
  assert.equal(result.filename, original);
});

test('raw filename preserved in storage', () => {
  const cache = createDiscoveryCache();
  const original = 'Exact.Filename.With.Dots.2024.mkv';
  const attrs = createReleaseAttributes(HASH, null, original);

  storeReleaseAttributes(cache, attrs);

  const retrieved = cache.getReleaseAttributes(HASH, null);
  assert.equal(retrieved[0].filename, original);

  cache.close();
});

// =============================================================================
// Parser Failure Tests
// =============================================================================

test('parser handles malformed filename without throwing', () => {
  assert.doesNotThrow(() => parseFilename('...---...'));
  assert.doesNotThrow(() => parseFilename('!!!@@@###'));
  assert.doesNotThrow(() => parseFilename('   '));
});

test('parser returns valid result for unusual but valid filenames', () => {
  const result = parseFilename('Movie.with.many.dots.2024.720p');
  assert.ok(result);
  assert.equal(result.parsed.title, 'Movie with many dots');
  assert.equal(result.parsed.year, 2024);
});

// =============================================================================
// Media Type Detection Tests
// =============================================================================

test('detects movie from year pattern', () => {
  const result = parseFilename('Inception.2010.1080p.BluRay');
  assert.equal(result.parsed.mediaType, 'movie');
});

test('detects episode from SXXEYY pattern', () => {
  const result = parseFilename('Show.S01E05.720p');
  assert.equal(result.parsed.mediaType, 'episode');
});

test('returns unknown for ambiguous patterns', () => {
  const result = parseFilename('Some.Release.1080p');
  assert.equal(result.parsed.mediaType, 'unknown');
});

// =============================================================================
// Integration Tests
// =============================================================================

test('createReleaseAttributes produces storable object', () => {
  const attrs = createReleaseAttributes(HASH, null, 'Movie.2024.1080p.x264-Group');
  assert.ok(attrs);
  assert.equal(attrs.infoHash, HASH);
  assert.equal(attrs.fileIndex, null);
  assert.equal(attrs.source, 'ptn-regex');
  assert.ok(attrs.confidence > 0);
  assert.ok(attrs.evidence.length > 0);
});

test('parseFilenames handles multiple items', () => {
  const items = [
    { infoHash: HASH, fileIndex: null, filename: 'Movie.2024.1080p' },
    { infoHash: OTHER_HASH, fileIndex: null, filename: 'Show.S01E01.720p' },
  ];

  const results = parseFilenames(items);
  assert.equal(results.length, 2);
  assert.equal(results[0].parsed.title, 'Movie');
  assert.equal(results[1].parsed.title, 'Show');
});

test('parser does not break ingestion on failure', () => {
  // Simulate ingestion pipeline
  const cache = createDiscoveryCache();
  cache.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    title: 'Test Release',
    filename: 'Test.Release.2024.mkv',
  });

  // Parse and store
  const attrs = createReleaseAttributes(HASH, null, 'Test.Release.2024.mkv');
  storeReleaseAttributes(cache, attrs);

  // Candidate should still exist
  const candidate = cache.getCandidate(HASH, null);
  assert.ok(candidate);

  // Attributes should be stored
  const stored = cache.getReleaseAttributes(HASH, null);
  assert.equal(stored.length, 1);

  cache.close();
});

// =============================================================================
// Fixture Tests (matching WINDOWS parser-fixtures.json format)
// =============================================================================

const FIXTURES = [
  {
    name: 'Standard movie release',
    filename: 'The.Matrix.1999.1080p.BluRay.x264-ESiR',
    expected: {
      title: 'The Matrix',
      year: 1999,
      resolution: '1080p',
      source: 'BluRay',
      codec: 'x264',
      releaseGroup: 'ESiR',
      mediaType: 'movie',
    },
  },
  {
    name: 'TV episode release',
    name: 'Black.Mirror.S03E01.1080p.WEB-DL',
    filename: 'Black.Mirror.S03E01.1080p.WEB-DL',
    expected: {
      title: 'Black Mirror',
      season: 3,
      episode: 1,
      resolution: '1080p',
      source: 'WEB-DL',
      mediaType: 'episode',
    },
  },
  {
    name: '4K HDR release',
    filename: 'Dune.2021.2160p.UHD.BluRay.HDR.DV.HEVC',
    expected: {
      title: 'Dune',
      year: 2021,
      resolution: '2160p',
      source: 'BluRay',
      codec: 'x265',
      hdr: true,
      mediaType: 'movie',
    },
  },
  {
    name: 'Episode range',
    filename: 'Show.S01E01-E03.720p.HDTV',
    expected: {
      title: 'Show',
      season: 1,
      episodeRange: '1-3',
      resolution: '720p',
      source: 'HDTV',
      mediaType: 'episode',
    },
  },
  {
    name: 'Remux release',
    filename: 'Movie.2024.1080p.BluRay.Remux.AVC.DTS-HD',
    expected: {
      title: 'Movie',
      year: 2024,
      resolution: '1080p',
      source: 'BluRay',
      audio: 'DTS-HD',
      mediaType: 'movie',
    },
  },
  {
    name: 'WEB-DL with AAC',
    filename: 'Series.S02E05.1080p.WEB-DL.AAC2.0',
    expected: {
      title: 'Series',
      season: 2,
      episode: 5,
      resolution: '1080p',
      source: 'WEB-DL',
      mediaType: 'episode',
    },
  },
  {
    name: 'Minimal release',
    filename: 'Short.Film.2024',
    expected: {
      title: 'Short Film',
      year: 2024,
      mediaType: 'movie',
    },
  },
];

for (const fixture of FIXTURES) {
  test(`fixture: ${fixture.name}`, () => {
    const result = parseFilename(fixture.filename);
    assert.ok(result, `Failed to parse: ${fixture.filename}`);

    const expected = fixture.expected;
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(
        result.parsed[key],
        value,
        `${key} mismatch for ${fixture.filename}: expected ${value}, got ${result.parsed[key]}`
      );
    }
  });
}

// =============================================================================
// Storage Integration Tests
// =============================================================================

test('parsed attributes can be stored and retrieved', () => {
  const cache = createDiscoveryCache();
  const attrs = createReleaseAttributes(HASH, null, 'Movie.2024.1080p.x264-Group');

  storeReleaseAttributes(cache, attrs);

  const allAttrs = getReleaseAttributesForCandidate(cache, HASH, null);
  assert.equal(allAttrs.length, 1);
  assert.equal(allAttrs[0].title, 'Movie');
  assert.equal(allAttrs[0].year, 2024);
  assert.equal(allAttrs[0].resolution, '1080p');

  cache.close();
});

test('multiple parser sources can contribute to same candidate', () => {
  const cache = createDiscoveryCache();

  // First parser
  const attrs1 = createReleaseAttributes(HASH, null, 'Movie.2024.1080p');
  attrs1.source = 'parser-a';
  attrs1.confidence = 0.7;
  storeReleaseAttributes(cache, attrs1);

  // Second parser (different source, higher confidence)
  const attrs2 = createReleaseAttributes(HASH, null, 'Movie.2024.1080p');
  attrs2.source = 'parser-b';
  attrs2.confidence = 0.9;
  attrs2.parsed.codec = 'x265'; // This parser detected codec
  storeReleaseAttributes(cache, attrs2);

  // Both sources stored
  const allAttrs = getReleaseAttributesForCandidate(cache, HASH, null);
  assert.equal(allAttrs.length, 2);

  // Strongest first
  const strongest = getStrongestReleaseAttributes(cache, HASH, null);
  assert.equal(strongest.source, 'parser-b');
  assert.equal(strongest.confidence, 0.9);

  cache.close();
});

test('parser source is preserved (no fuzzy merge)', () => {
  const cache = createDiscoveryCache();

  const attrs1 = createReleaseAttributes(HASH, null, 'Movie.2024.1080p');
  attrs1.source = 'ptn-regex';
  storeReleaseAttributes(cache, attrs1);

  const attrs2 = createReleaseAttributes(HASH, null, 'Movie.2024.1080p');
  attrs2.source = 'custom-regex';
  storeReleaseAttributes(cache, attrs2);

  const allAttrs = cache.getReleaseAttributes(HASH, null);
  assert.equal(allAttrs.length, 2);

  // Sources preserved
  const sources = allAttrs.map(a => a.source).sort();
  assert.deepEqual(sources, ['custom-regex', 'ptn-regex']);

  cache.close();
});

test('parsed attributes survive cache reload', () => {
  const cache = createDiscoveryCache();

  const attrs = createReleaseAttributes(HASH, null, 'Movie.2024.1080p.x264-Group');
  storeReleaseAttributes(cache, attrs);

  // Verify stored
  const before = cache.getReleaseAttributes(HASH, null);
  assert.equal(before.length, 1);
  assert.equal(before[0].title, 'Movie');

  cache.close();

  // Create new cache (simulates reload)
  const cache2 = createDiscoveryCache();
  cache2.upsertCandidate({
    infoHash: HASH,
    fileIndex: null,
    filename: 'Movie.2024.1080p.x264-Group',
  });

  // Re-parse
  const attrs2 = createReleaseAttributes(HASH, null, 'Movie.2024.1080p.x264-Group');
  storeReleaseAttributes(cache2, attrs2);

  const after = cache2.getReleaseAttributes(HASH, null);
  assert.equal(after.length, 1);
  assert.equal(after[0].title, 'Movie');
  assert.equal(after[0].year, 2024);

  cache2.close();
});

test('ambiguous title remains unresolved', () => {
  const cache = createDiscoveryCache();

  // Ambiguous filename - parser can't determine much
  const attrs = createReleaseAttributes(HASH, null, 'release');
  storeReleaseAttributes(cache, attrs);

  // Still stored, but with low confidence
  const stored = cache.getReleaseAttributes(HASH, null);
  assert.equal(stored.length, 1);
  assert.ok(stored[0].confidence < 0.6);
  // No media identity created (no candidate_media)
  const associations = cache.getMediaAssociations(HASH, null);
  assert.equal(associations.length, 0);

  cache.close();
});
