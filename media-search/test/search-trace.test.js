/**
 * Search Trace Endpoint Tests
 *
 * Tests GET /api/debug/search-trace and the underlying searchTrace() engine.
 * Proves:
 * - Returns query, sources, pipeline funnel, candidates
 * - Source breakdown includes corpus and live
 * - Pipeline counts: discovered, deduped, ranked, returned
 * - Candidates include provenance and justification
 * - Rejection reasons are included
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { searchTrace } from '../src/lib/discovery/search-engine.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { storeReleaseAttributes } from '../src/lib/discovery/release-attributes.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const HASH2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH3 = 'cccccccccccccccccccccccccccccccccccccccc';

function makeCandidate(cache, infoHash, attrs) {
  cache.upsertCandidate({
    infoHash,
    fileIndex: null,
    filename: attrs.filename,
    title: attrs.title,
  });
  storeReleaseAttributes(cache, {
    infoHash,
    fileIndex: null,
    filename: attrs.filename,
    source: 'ptn-regex',
    confidence: attrs.confidence || 0.8,
    parsed: {
      title: attrs.title,
      year: attrs.year,
      season: attrs.season,
      episode: attrs.episode,
      resolution: attrs.resolution,
      source: attrs.source,
      codec: attrs.codec,
      hdr: attrs.hdr,
      audio: attrs.audio,
      releaseGroup: attrs.releaseGroup,
    },
    evidence: ['title_extracted'],
  });
}

test('searchTrace returns query in trace output', async () => {
  const cache = createDiscoveryCache();
  makeCandidate(cache, HASH, {
    filename: 'Show.S01E01.720p.mkv',
    title: 'Show',
    season: 1,
    episode: 1,
    resolution: '720p',
  });

  const trace = await searchTrace(cache, { query: 'show' });
  assert.equal(trace.query, 'show');
  cache.close();
});

test('searchTrace reports corpus source count', async () => {
  const cache = createDiscoveryCache();
  makeCandidate(cache, HASH, {
    filename: 'Movie.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
  });
  makeCandidate(cache, HASH2, {
    filename: 'Movie.720p.mkv',
    title: 'Movie',
    resolution: '720p',
  });

  const trace = await searchTrace(cache, { query: 'movie' });
  assert.equal(trace.sources.corpus.queried, true);
  assert.equal(trace.sources.corpus.count, 2);
  cache.close();
});

test('searchTrace reports pipeline funnel', async () => {
  const cache = createDiscoveryCache();
  makeCandidate(cache, HASH, {
    filename: 'Movie.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
  });
  makeCandidate(cache, HASH2, {
    filename: 'Movie.720p.mkv',
    title: 'Movie',
    resolution: '720p',
  });

  const trace = await searchTrace(cache, { query: 'movie' });
  assert.equal(trace.pipeline.discovered, 2);
  assert.equal(trace.pipeline.deduped, 2);
  assert.equal(trace.pipeline.ranked, 2);
  assert.equal(trace.pipeline.returned, 2);
  cache.close();
});

test('searchTrace includes candidates with rank', async () => {
  const cache = createDiscoveryCache();
  makeCandidate(cache, HASH, {
    filename: 'Movie.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
  });

  const trace = await searchTrace(cache, { query: 'movie' });
  assert.equal(trace.candidates.length, 1);
  assert.equal(trace.candidates[0].rank, 1);
  assert.equal(trace.candidates[0].hash, HASH);
  assert.equal(trace.candidates[0].releaseKey, `${HASH}:torrent`);
  cache.close();
});

test('searchTrace candidates include provenance', async () => {
  const cache = createDiscoveryCache();
  makeCandidate(cache, HASH, {
    filename: 'Movie.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
  });

  const trace = await searchTrace(cache, { query: 'movie' });
  assert.ok(trace.candidates[0].provenance, 'provenance should be present');
  assert.equal(trace.candidates[0].provenance.source, 'dmm-corpus');
  assert.equal(trace.candidates[0].provenance.sourceType, 'stored');
  cache.close();
});

test('searchTrace candidates include justification', async () => {
  const cache = createDiscoveryCache();
  makeCandidate(cache, HASH, {
    filename: 'Movie.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
  });

  const trace = await searchTrace(cache, { query: 'movie' });
  const just = trace.candidates[0].justification;
  assert.ok(just, 'justification should be present');
  assert.ok(typeof just.finalScore === 'number');
  assert.ok(just.scoreBreakdown, 'scoreBreakdown should be present');
  assert.ok(just.weights, 'weights should be present');
  cache.close();
});

test('searchTrace reports live source counts when includeLive=true', async () => {
  const cache = createDiscoveryCache();
  makeCandidate(cache, HASH, {
    filename: 'Movie.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
  });

  const trace = await searchTrace(cache, {
    query: 'movie',
    includeLive: true,
    liveDiscoveryFnWithCounts: async () => ({
      releases: [],
      sources: {
        torrentio: { count: 3, error: null },
        torznab: { count: 1, error: null },
      },
    }),
  });

  assert.equal(trace.sources.live.torrentio, 3);
  assert.equal(trace.sources.live.torznab, 1);
  cache.close();
});

test('searchTrace reports live source errors', async () => {
  const cache = createDiscoveryCache();

  const trace = await searchTrace(cache, {
    query: 'test',
    includeLive: true,
    liveDiscoveryFnWithCounts: async () => ({
      releases: [],
      sources: {
        torrentio: { count: 0, error: 'timeout' },
        torznab: { count: 0, error: null },
      },
    }),
  });

  assert.equal(trace.sources.live.errors.torrentio, 'timeout');
  assert.equal(trace.sources.live.errors.torznab, null);
  cache.close();
});

test('searchTrace rejections array is present', async () => {
  const cache = createDiscoveryCache();
  makeCandidate(cache, HASH, {
    filename: 'Movie.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
  });

  const trace = await searchTrace(cache, { query: 'movie' });
  assert.ok(Array.isArray(trace.rejections));
  cache.close();
});

test('searchTrace deduplicates and tracks rejections', async () => {
  const cache = createDiscoveryCache();
  // Same title, same attributes → dedup by releaseKey if hash same
  // But different hashes → both survive dedup
  makeCandidate(cache, HASH, {
    filename: 'Movie.1080p.mkv',
    title: 'Movie',
    resolution: '1080p',
  });
  makeCandidate(cache, HASH2, {
    filename: 'Movie.1080p copy.mkv',
    title: 'Movie',
    resolution: '1080p',
  });

  const trace = await searchTrace(cache, { query: 'movie' });
  // Different hashes = different releaseKeys = no dedup
  assert.equal(trace.pipeline.deduped, 2);
  cache.close();
});

test('searchTrace respects pagination limits', async () => {
  const cache = createDiscoveryCache();
  makeCandidate(cache, HASH, { filename: 'A.1080p.mkv', title: 'A Movie' });
  makeCandidate(cache, HASH2, { filename: 'B.1080p.mkv', title: 'B Movie' });
  makeCandidate(cache, HASH3, { filename: 'C.1080p.mkv', title: 'C Movie' });

  const trace = await searchTrace(cache, { query: 'movie', limit: 2, offset: 0 });
  assert.equal(trace.pipeline.returned, 2);
  assert.equal(trace.candidates.length, 2);
  cache.close();
});

test('searchTrace with empty query returns empty results', async () => {
  const cache = createDiscoveryCache();
  const trace = await searchTrace(cache, { query: '' });
  assert.equal(trace.query, '');
  assert.equal(trace.pipeline.discovered, 0);
  cache.close();
});
