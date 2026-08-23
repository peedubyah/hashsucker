/**
 * Corpus Topology Evidence Projection Tests
 *
 * Proves:
 *   - Identity: same hash different file indexes remain separate
 *   - Identity: null file index remains distinct from index 0
 *   - Topology: single movie file
 *   - Topology: movie with subtitles
 *   - Topology: movie with extras
 *   - Topology: sample files detected
 *   - Topology: season pack structure
 *   - Topology: mixed non-media files
 *   - Math: largestFileRatio calculation
 *   - Math: empty/zero byte handling
 *   - Math: deterministic output
 *   - Isolation: provider observation data does not affect topology features
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createCorpusTopologyFeatures } from '../src/lib/discovery/corpus-topology-features.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccccccccccc';

function setup() {
  const cache = createDiscoveryCache({ dbPath: ':memory:' });
  const topology = createCorpusTopologyFeatures(cache);
  return { cache, topology };
}

function insertCandidate(cache, { infoHash, fileIndex = null, filename, size = null }) {
  const fileIndexKey = fileIndex == null ? -1 : fileIndex;
  const now = Date.now();
  cache.db.prepare(`
    INSERT INTO candidates (info_hash, file_index, file_index_key, filename, size, first_seen, last_seen, metadata, sources)
    VALUES (@info_hash, @file_index, @file_index_key, @filename, @size, @first_seen, @last_seen, '{}', '[]')
  `).run({
    info_hash: infoHash,
    file_index: fileIndex,
    file_index_key: fileIndexKey,
    filename,
    size,
    first_seen: now,
    last_seen: now,
  });
}

function insertReleaseAttribute(cache, { infoHash, fileIndex = null, mediaType = null, season = null }) {
  const fileIndexKey = fileIndex == null ? -1 : fileIndex;
  cache.db.prepare(`
    INSERT INTO release_attributes (info_hash, file_index_key, source, filename, media_type, season, parsed_at)
    VALUES (@info_hash, @file_index_key, 'test', @filename, @media_type, @season, @parsed_at)
  `).run({
    info_hash: infoHash,
    file_index_key: fileIndexKey,
    filename: 'test-release',
    media_type: mediaType,
    season,
    parsed_at: Date.now(),
  });
}

// =============================================================================
// Identity Tests
// =============================================================================

test('same hash different file indexes remain separate', () => {
  const { cache, topology } = setup();

  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 0,
    filename: 'movie.mkv',
    size: 1000000,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 1,
    filename: 'movie2.mkv',
    size: 500000,
  });

  const result0 = topology.getTopologyFeatures(HASH_A, 0);
  const result1 = topology.getTopologyFeatures(HASH_A, 1);

  // Both see the full torrent structure
  assert.equal(result0.files.totalFiles, 2);
  assert.equal(result1.files.totalFiles, 2);
  // But identity differs
  assert.equal(result0.identity.fileIndex, 0);
  assert.equal(result1.identity.fileIndex, 1);
});

test('null file index remains distinct from index 0', () => {
  const { cache, topology } = setup();

  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: null,
    filename: 'torrent-level.nfo',
    size: 100,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 0,
    filename: 'movie.mkv',
    size: 1000000,
  });

  const resultNull = topology.getTopologyFeatures(HASH_A, null);
  const result0 = topology.getTopologyFeatures(HASH_A, 0);

  assert.equal(resultNull.identity.fileIndex, null);
  assert.equal(result0.identity.fileIndex, 0);
  assert.equal(resultNull.files.totalFiles, 2);
  assert.equal(result0.files.totalFiles, 2);
});

// =============================================================================
// Topology Tests
// =============================================================================

test('single movie file', () => {
  const { cache, topology } = setup();

  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv',
    size: 8 * 1024 * 1024 * 1024, // 8GB
  });

  const result = topology.getTopologyFeatures(HASH_A, null);

  assert.equal(result.files.totalFiles, 1);
  assert.equal(result.files.videoFiles, 1);
  assert.equal(result.files.subtitleFiles, 0);
  assert.equal(result.files.archiveFiles, 0);
  assert.equal(result.structure.singleFileMedia, true);
  assert.equal(result.structure.hasExtras, false);
  assert.equal(result.structure.hasSamples, false);
  assert.equal(result.structure.largestFileRatio, 1.0);
  assert.equal(result.quality.likelyPlayableTarget, true);
  assert.deepEqual(result.quality.warnings, []);
});

test('movie with subtitles', () => {
  const { cache, topology } = setup();

  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv',
    size: 8 * 1024 * 1024 * 1024,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 1,
    filename: 'Movie.2024.1080p.BluRay.x264-Group.srt',
    size: 50 * 1024,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 2,
    filename: 'Movie.2024.1080p.BluRay.x264-Group.forced.srt',
    size: 30 * 1024,
  });

  const result = topology.getTopologyFeatures(HASH_A, null);

  assert.equal(result.files.totalFiles, 3);
  assert.equal(result.files.videoFiles, 1);
  assert.equal(result.files.subtitleFiles, 2);
  assert.equal(result.files.mediaFiles, 3);
  assert.equal(result.structure.singleFileMedia, false);
  assert.equal(result.quality.likelyPlayableTarget, true);
  assert.deepEqual(result.quality.warnings, []);
});

test('movie with extras', () => {
  const { cache, topology } = setup();

  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv',
    size: 8 * 1024 * 1024 * 1024,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 1,
    filename: 'Extras/Behind.The.Scenes.mkv',
    size: 500 * 1024 * 1024,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 2,
    filename: 'Extras/Featurette.mkv',
    size: 300 * 1024 * 1024,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 3,
    filename: 'Extras/Trailer.mkv',
    size: 100 * 1024 * 1024,
  });

  const result = topology.getTopologyFeatures(HASH_A, null);

  assert.equal(result.files.totalFiles, 4);
  assert.equal(result.structure.hasExtras, true);
  assert.equal(result.structure.singleFileMedia, false);
  assert.equal(result.quality.likelyPlayableTarget, true);
});

test('sample files detected', () => {
  const { cache, topology } = setup();

  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv',
    size: 8 * 1024 * 1024 * 1024,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 1,
    filename: 'Sample/Movie.Sample.mkv',
    size: 25 * 1024 * 1024,
  });

  const result = topology.getTopologyFeatures(HASH_A, null);

  assert.equal(result.files.totalFiles, 2);
  assert.equal(result.structure.hasSamples, true);
  assert.ok(result.quality.warnings.includes('has_samples'));
  assert.ok(result.quality.warnings.includes('small_video_files'));
});

test('season pack structure', () => {
  const { cache, topology } = setup();

  for (let i = 0; i < 10; i++) {
    insertCandidate(cache, {
      infoHash: HASH_A,
      fileIndex: i,
      filename: `Season.1/Movie.S01E${String(i).padStart(2, '0')}.720p.mkv`,
      size: 1 * 1024 * 1024 * 1024,
    });
  }

  insertReleaseAttribute(cache, {
    infoHash: HASH_A,
    fileIndex: 0,
    mediaType: 'season',
    season: 1,
  });

  const result = topology.getTopologyFeatures(HASH_A, null);

  assert.equal(result.files.totalFiles, 10);
  assert.equal(result.files.videoFiles, 10);
  assert.equal(result.structure.hasSeasonStructure, true);
  assert.equal(result.structure.singleFileMedia, false);
});

test('mixed non-media files', () => {
  const { cache, topology } = setup();

  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv',
    size: 8 * 1024 * 1024 * 1024,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 1,
    filename: 'readme.txt',
    size: 2 * 1024,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 2,
    filename: 'cover.jpg',
    size: 100 * 1024,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 3,
    filename: 'info.nfo',
    size: 5 * 1024,
  });

  const result = topology.getTopologyFeatures(HASH_A, null);

  assert.equal(result.files.totalFiles, 4);
  assert.equal(result.files.videoFiles, 1);
  assert.equal(result.files.mediaFiles, 1);
  assert.equal(result.files.nonMediaFiles, 3);
  assert.equal(result.quality.likelyPlayableTarget, true);
});

test('missing topology data returns safe defaults', () => {
  const { topology } = setup();

  const result = topology.getTopologyFeatures('0000000000000000000000000000000000000000', null);

  assert.equal(result.files.totalFiles, 0);
  assert.equal(result.files.mediaFiles, 0);
  assert.equal(result.files.nonMediaFiles, 0);
  assert.equal(result.structure.singleFileMedia, false);
  assert.equal(result.structure.hasExtras, false);
  assert.equal(result.structure.hasSamples, false);
  assert.equal(result.structure.hasSeasonStructure, false);
  assert.equal(result.structure.largestFileRatio, null);
  assert.equal(result.quality.likelyPlayableTarget, false);
  assert.equal(result.quality.topologyConfidence, null);
  assert.ok(result.quality.warnings.includes('no_files'));
});

// =============================================================================
// Math Tests
// =============================================================================

test('largestFileRatio calculation', () => {
  const { cache, topology } = setup();

  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv',
    size: 8000,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 1,
    filename: 'Movie.subs.rar',
    size: 2000,
  });

  const result = topology.getTopologyFeatures(HASH_A, null);

  // Largest is 8000, total is 10000, ratio = 0.8
  assert.equal(result.structure.largestFileRatio, 0.8);
});

test('empty/zero byte handling', () => {
  const { cache, topology } = setup();

  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv',
    size: 0,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 1,
    filename: 'Movie.subs.rar',
    size: 0,
  });

  const result = topology.getTopologyFeatures(HASH_A, null);

  assert.equal(result.structure.largestFileRatio, null);
  assert.ok(result.quality.warnings.includes('no_size_data'));
});

test('deterministic output', () => {
  const { cache, topology } = setup();

  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv',
    size: 8 * 1024 * 1024 * 1024,
  });
  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: 1,
    filename: 'Movie.srt',
    size: 50 * 1024,
  });

  const result1 = topology.getTopologyFeatures(HASH_A, null);
  const result2 = topology.getTopologyFeatures(HASH_A, null);

  assert.deepEqual(result1, result2);
});

// =============================================================================
// Isolation Tests
// =============================================================================

test('provider observation data does not affect topology features', () => {
  const { cache, topology } = setup();

  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv',
    size: 8 * 1024 * 1024 * 1024,
  });

  // Insert provider observation (should not affect topology)
  cache.db.prepare(`
    INSERT INTO provider_observations (info_hash, file_index_key, provider, cached, checked_at)
    VALUES (@info_hash, @file_index_key, 'test-provider', 1, @checked_at)
  `).run({
    info_hash: HASH_A,
    file_index_key: -1,
    checked_at: Date.now(),
  });

  const result = topology.getTopologyFeatures(HASH_A, null);

  assert.equal(result.files.totalFiles, 1);
  assert.equal(result.files.videoFiles, 1);
  assert.equal(result.structure.singleFileMedia, true);
  assert.equal(result.quality.likelyPlayableTarget, true);
});

test('no acquisition/ranking changes', () => {
  const { cache, topology } = setup();

  insertCandidate(cache, {
    infoHash: HASH_A,
    fileIndex: null,
    filename: 'Movie.2024.1080p.BluRay.x264-Group.mkv',
    size: 8 * 1024 * 1024 * 1024,
  });

  // Capture state before
  const candidatesBefore = cache.db.prepare('SELECT COUNT(*) as count FROM candidates').get();
  const releaseAttrsBefore = cache.db.prepare('SELECT COUNT(*) as count FROM release_attributes').get();

  topology.getTopologyFeatures(HASH_A, null);

  // Capture state after
  const candidatesAfter = cache.db.prepare('SELECT COUNT(*) as count FROM candidates').get();
  const releaseAttrsAfter = cache.db.prepare('SELECT COUNT(*) as count FROM release_attributes').get();

  assert.equal(candidatesAfter.count, candidatesBefore.count);
  assert.equal(releaseAttrsAfter.count, releaseAttrsBefore.count);
});
