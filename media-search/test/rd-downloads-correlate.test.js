/**
 * RD /downloads correlation layer tests.
 *
 * These tests prove the WEAK-class contract on real-corpus-shaped
 * data: when observations match candidates by title tokens but do
 * NOT match by exact filename or exact bytes, the result is WEAK
 * (not UNMATCHED, not UNIQUE_STRONG).
 *
 * This is the "do not promote correlation to identity truth" guard.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  correlateRdDownloads,
  groupCorrelationsByFileBytes,
  CORRELATION_CLASSES,
} from '../src/lib/acquisition/rd-downloads-correlate.js';

test('correlation emits WEAK (not UNMATCHED) when only title tokens overlap', () => {
  const observations = [
    {
      provider: 'realdebrid',
      source_id: 'downloads',
      source_event_id: 'rd-1',
      normalized_filename: 'Oppenheimer.2023.1080p.BluRay.x264.mkv',
      exact_bytes: 12_345_678,
      filename: 'Oppenheimer.2023.1080p.BluRay.x264.mkv',
    },
  ];
  // Candidate with similar title tokens but different filename
  // normalization and different bytes
  const candidates = [
    {
      info_hash: 'aaaa',
      file_index_key: 1,
      filename: 'oppenheimer_2023_bluray_1080p.mkv', // different
      title: 'Oppenheimer 2023',                     // title matches
      size: 9_999_999,                               // different bytes
    },
  ];
  const { correlations, stats } = correlateRdDownloads({
    observations,
    candidates,
    strongFloor: 0.7,
  });
  assert.equal(correlations.length, 1);
  assert.equal(correlations[0].correlation_class, CORRELATION_CLASSES.WEAK);
  assert.equal(stats.eventsByClass.WEAK, 1);
  assert.equal(stats.eventsByClass.UNIQUE_STRONG, 0);
  assert.equal(stats.eventsByClass.UNMATCHED, 0);
});

test('correlation emits UNMATCHED when no candidate passes hard gate', () => {
  const observations = [
    {
      provider: 'realdebrid',
      source_id: 'downloads',
      source_event_id: 'rd-1',
      normalized_filename: 'Oppenheimer.S01E05.1080p.mkv',
      exact_bytes: 100,
      filename: 'Oppenheimer.S01E05.1080p.mkv',
      season: 1,
      episode: 5,
    },
  ];
  // Candidate fails hard gate: different season/episode
  const candidates = [
    {
      info_hash: 'aaaa',
      file_index_key: 1,
      filename: 'Oppenheimer.S02E10.1080p.mkv', // S/E conflict
      title: 'Oppenheimer 2023',
      size: 500,
      search_key: 'oppenheimer.s02e10.1080p',
    },
  ];
  const { correlations, stats } = correlateRdDownloads({
    observations,
    candidates,
    strongFloor: 0.7,
  });
  assert.equal(correlations.length, 1,
    'one synthetic row emitted for unmatched, recording the null match');
  assert.equal(correlations[0].correlation_class, CORRELATION_CLASSES.UNMATCHED);
  assert.equal(correlations[0].candidate_info_hash, '');
  assert.equal(stats.eventsByClass.UNMATCHED, 1);
  assert.equal(stats.eventsByClass.WEAK, 0);
});

test('correlation preserves multiple distinct events for the same file-bytes', () => {
  // The "Oppenheimer 52 rows" case: many distinct RD download events
  // for the same exact file (same bytes) should ALL be preserved,
  // not collapsed into one.
  const observations = [];
  for (let i = 0; i < 52; i += 1) {
    observations.push({
      provider: 'realdebrid',
      source_id: 'downloads',
      source_event_id: `rd-Oppenheimer-${i}`,
      normalized_filename: 'Oppenheimer.2023.1080p.BluRay.x264.mkv',
      exact_bytes: 12_345_678,
      filename: 'Oppenheimer.2023.1080p.BluRay.x264.mkv',
    });
  }
  const candidates = [
    {
      info_hash: 'aaaa',
      file_index_key: 1,
      filename: 'Oppenheimer.2023.1080p.BluRay.x264.mkv',
      title: 'Oppenheimer 2023',
      size: 12_345_678,
    },
  ];
  const { correlations, stats } = correlateRdDownloads({
    observations,
    candidates,
    strongFloor: 0.7,
  });
  assert.equal(correlations.length, 52, 'all 52 events preserved, not collapsed');
  const distinctEventIds = new Set(correlations.map((c) => c.source_event_id));
  assert.equal(distinctEventIds.size, 52);
  // Grouping should produce a single group with 52 events
  const groups = groupCorrelationsByFileBytes(correlations, observations);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].events, 52);
  // totalBytes = 52 * 12_345_678
  assert.equal(groups[0].totalBytes, 52 * 12_345_678);
});

test('correlation does NOT emit UNIQUE_STRONG without exact filename/bytes match', () => {
  // Even with high token overlap, the gate requires exact features
  // for STRONG. Otherwise, we over-commit to identity.
  const observations = [
    {
      provider: 'realdebrid',
      source_id: 'downloads',
      source_event_id: 'rd-1',
      normalized_filename: 'Oppenheimer.2023.1080p.BluRay.x264.mkv',
      exact_bytes: 12_345_678,
      filename: 'Oppenheimer.2023.1080p.BluRay.x264.mkv',
    },
  ];
  const candidates = [
    {
      info_hash: 'aaaa',
      file_index_key: 1,
      filename: 'Oppenheimer.2023.1080p.BluRay.x264-DIFFERENT-GROUP.mkv',
      title: 'Oppenheimer 2023',
      size: 12_345_679, // 1 byte off
    },
  ];
  const { correlations } = correlateRdDownloads({
    observations,
    candidates,
    strongFloor: 0.7,
  });
  assert.equal(correlations.length, 1);
  assert.equal(correlations[0].correlation_class, CORRELATION_CLASSES.WEAK,
    '1-byte-off size should NOT qualify as UNIQUE_STRONG');
});
