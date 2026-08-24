/**
 * Search Trace Formatter Tests
 *
 * Tests formatSearchTrace — renders search trace as terminal text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSearchTrace } from '../src/lib/discovery/search-trace-formatter.js';

const SAMPLE_TRACE = {
  query: 'movie',
  sources: {
    corpus: { queried: true, count: 120 },
    live: {
      torrentio: 40,
      torznab: 30,
      errors: { torrentio: null, torznab: null },
    },
  },
  pipeline: {
    discovered: 190,
    deduped: 150,
    ranked: 150,
    returned: 25,
  },
  rejections: [
    {
      hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      reason: 'DUPLICATED',
      description: 'duplicate',
    },
  ],
  candidates: [
    {
      rank: 1,
      hash: 'abcdef0123456789abcdef0123456789abcdef01',
      fileIndex: null,
      releaseKey: 'abcdef0123456789abcdef0123456789abcdef01:torrent',
      filename: 'Movie.2160p.mkv',
      score: 0.875,
      source: 'corpus',
      provenance: {
        source: 'dmm-corpus',
        sourceType: 'stored',
        releaseKey: 'abcdef0123456789abcdef0123456789abcdef01:torrent',
        hash: 'abcdef0123456789abcdef0123456789abcdef01',
        discoveredAt: '2026-08-24T03:31:13.625Z',
        metadataConfidence: 0.9,
        cacheState: 'cached',
      },
      justification: {
        candidate: {
          hash: 'abcdef0123456789abcdef0123456789abcdef01',
          fileIndex: null,
          releaseKey: 'abcdef0123456789abcdef0123456789abcdef01:torrent',
          filename: 'Movie.2160p.mkv',
        },
        finalScore: 0.875,
        scoreBreakdown: {
          cacheScore: 0.9,
          qualityScore: 0.85,
          sourceScore: 0.9,
          metadataScore: 0.3,
          popularityScore: 0.95,
        },
        weights: {
          relevance: 0.25,
          quality: 0.2,
          releaseConfidence: 0.2,
          identityConfidence: 0.15,
          providerAvailability: 0.1,
          episodeMatch: 0.1,
        },
      },
    },
  ],
};

test('formatSearchTrace renders header', () => {
  const text = formatSearchTrace(SAMPLE_TRACE);
  assert.match(text, /SEARCH TRACE/);
});

test('formatSearchTrace renders sources section', () => {
  const text = formatSearchTrace(SAMPLE_TRACE);
  assert.match(text, /Sources:/);
  assert.match(text, /DMM corpus: 120 candidates/);
  assert.match(text, /Torrentio: 40 candidates/);
  assert.match(text, /Comet: 30 candidates/);
});

test('formatSearchTrace renders pipeline summary', () => {
  const text = formatSearchTrace(SAMPLE_TRACE);
  assert.match(text, /Pipeline: 190 discovered → 150 deduped → 150 ranked → 25 returned/);
});

test('formatSearchTrace renders winner', () => {
  const text = formatSearchTrace(SAMPLE_TRACE);
  assert.match(text, /Winner:/);
  assert.match(text, /abcdef0123456789abcdef0123456789abcdef01/);
});

test('formatSearchTrace renders Why section with score breakdown', () => {
  const text = formatSearchTrace(SAMPLE_TRACE);
  assert.match(text, /Why:/);
  // High cache score should show "+N cached"
  assert.match(text, /\+.*cached/);
  // High quality score should show "+N 2160p"
  assert.match(text, /\+.*2160p/);
  // Low metadata should show "-N metadata unknown"
  assert.match(text, /-.*metadata unknown/);
});

test('formatSearchTrace renders source provenance', () => {
  const text = formatSearchTrace(SAMPLE_TRACE);
  assert.match(text, /Source:/);
  assert.match(text, /dmm-corpus \(stored\)/);
  assert.match(text, /discovered: 2026-08-24T03:31:13\.625Z/);
});

test('formatSearchTrace renders rejected section', () => {
  const text = formatSearchTrace(SAMPLE_TRACE);
  assert.match(text, /Rejected \(1\):/);
  assert.match(text, /deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/);
  assert.match(text, /Reason: DUPLICATED — duplicate/);
});

test('formatSearchTrace handles empty candidates', () => {
  const trace = {
    ...SAMPLE_TRACE,
    candidates: [],
    rejections: [],
  };
  const text = formatSearchTrace(trace);
  assert.match(text, /SEARCH TRACE/);
  assert.doesNotMatch(text, /Winner:/);
  assert.doesNotMatch(text, /Rejected/);
});

test('formatSearchTrace handles live source errors', () => {
  const trace = {
    ...SAMPLE_TRACE,
    sources: {
      corpus: { queried: true, count: 10 },
      live: {
        torrentio: 0,
        torznab: 5,
        errors: { torrentio: 'timeout', torznab: null },
      },
    },
  };
  const text = formatSearchTrace(trace);
  assert.match(text, /✗ Torrentio: 0 candidates \(timeout\)/);
  assert.match(text, /✓ Comet: 5 candidates/);
});

test('formatSearchTrace handles empty live sources', () => {
  const trace = {
    ...SAMPLE_TRACE,
    sources: {
      corpus: { queried: true, count: 50 },
      live: { queried: false },
    },
  };
  const text = formatSearchTrace(trace);
  assert.doesNotMatch(text, /Torrentio:/);
  assert.doesNotMatch(text, /Comet:/);
});
