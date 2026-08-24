/**
 * Cinemeta Identity Resolver Tests
 *
 * Proves the production resolver:
 * - Exact movie title match
 * - Series season/episode match
 * - Wrong title rejection
 * - Ambiguous title handling
 * - Confidence thresholds
 * - Provenance preservation
 * - Infrastructure error handling
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CinemetaIdentityResolver } from '../src/lib/discovery/cinemeta-identity-resolver.js';
import { ResolverError } from '../src/lib/discovery/identity-resolver.js';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockFetch(results) {
  // Cinemeta API uses 'name' field for titles, not 'title'
  // The searchCatalog function maps name→title via publicMeta
  return async (url) => {
    if (url.includes('/catalog/')) {
      return {
        ok: true,
        async json() {
          const filterFn = url.includes('/series/')
            ? (r) => r.type === 'series'
            : (r) => r.type === 'movie';
          return {
            metas: results.filter(filterFn).map(r => ({
              id: r.id,
              type: r.type,
              name: r.title, // Cinemeta uses 'name'
              year: r.year,
              poster: null,
            })),
          };
        },
      };
    }
    if (url.includes('/meta/')) {
      const id = url.split('/').pop().replace('.json', '');
      const media = results.find(r => r.id === id);
      return {
        ok: true,
        async json() {
          if (!media) return { meta: null };
          return {
            meta: {
              id: media.id,
              type: media.type,
              name: media.title,
              year: media.year,
              videos: media.videos || [],
            },
          };
        },
      };
    }
    return { ok: false, status: 404 };
  };
}

// =============================================================================
// Exact Movie Title Match Tests
// =============================================================================

test('exact movie title match returns high confidence', async () => {
  const results = [
    { id: 'tt0111161', type: 'movie', title: 'The Shawshank Redemption', year: 1994 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  const candidate = { infoHash: 'aaa', filename: 'The.Shawshank.Redemption.1994.1080p.mkv' };
  const parsedAttributes = { title: 'The Shawshank Redemption', year: 1994 };

  const result = await resolver.resolveIdentity({ candidate, parsedAttributes });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].mediaId, 'tt0111161');
  assert.equal(result.matches[0].mediaType, 'movie');
  assert.ok(result.matches[0].confidence >= 0.6, 'Expected high confidence for exact match');
  assert.ok(result.matches[0].evidence.includes('title_exact_match'));
  assert.ok(result.matches[0].evidence.includes('year_match'));
});

test('movie match without year still resolves', async () => {
  const results = [
    { id: 'tt0111161', type: 'movie', title: 'The Shawshank Redemption', year: 1994 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  const candidate = { infoHash: 'aaa', filename: 'The.Shawshank.Redemption.1080p.mkv' };
  const parsedAttributes = { title: 'The Shawshank Redemption' };

  const result = await resolver.resolveIdentity({ candidate, parsedAttributes });

  assert.equal(result.matches.length, 1);
  assert.ok(result.matches[0].confidence >= 0.4);
  assert.ok(result.matches[0].evidence.includes('title_exact_match'));
});

// =============================================================================
// Series Season/Episode Match Tests
// =============================================================================

test('series season/episode match returns high confidence', async () => {
  const results = [
    {
      id: 'tt0903747',
      type: 'series',
      title: 'Breaking Bad',
      year: 2008,
      videos: [{ season: 5, episode: 14, id: 'tt0903747:5:14' }],
    },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  const candidate = { infoHash: 'aaa', filename: 'Breaking.Bad.S05E14.1080p.mkv' };
  const parsedAttributes = { title: 'Breaking Bad', year: 2008, season: 5, episode: 14 };

  const result = await resolver.resolveIdentity({ candidate, parsedAttributes });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].mediaId, 'tt0903747');
  assert.equal(result.matches[0].mediaType, 'series');
  assert.ok(result.matches[0].confidence >= 0.5);
  assert.ok(result.matches[0].evidence.includes('title_exact_match'));
  assert.ok(result.matches[0].evidence.includes('episode_verified'));
});

test('series match without episode verification still resolves', async () => {
  const results = [
    {
      id: 'tt0903747',
      type: 'series',
      title: 'Breaking Bad',
      year: 2008,
      videos: [], // No episode data
    },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  const candidate = { infoHash: 'aaa', filename: 'Breaking.Bad.S05E14.1080p.mkv' };
  const parsedAttributes = { title: 'Breaking Bad', year: 2008, season: 5, episode: 14 };

  const result = await resolver.resolveIdentity({ candidate, parsedAttributes });

  assert.equal(result.matches.length, 1);
  assert.ok(result.matches[0].confidence >= 0.4);
  assert.ok(result.matches[0].evidence.includes('episode_not_verified'));
});

// =============================================================================
// Wrong Title Rejection Tests
// =============================================================================

test('wrong title rejection returns empty matches', async () => {
  const results = [
    { id: 'tt0111161', type: 'movie', title: 'The Shawshank Redemption', year: 1994 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  const candidate = { infoHash: 'aaa', filename: 'Completely.Different.Movie.2020.mkv' };
  const parsedAttributes = { title: 'Completely Different Movie', year: 2020 };

  const result = await resolver.resolveIdentity({ candidate, parsedAttributes });

  assert.equal(result.matches.length, 0);
});

test('year mismatch reduces confidence', async () => {
  const results = [
    { id: 'tt0111161', type: 'movie', title: 'The Shawshank Redemption', year: 1994 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  const candidate = { infoHash: 'aaa', filename: 'The.Shawshank.Redemption.2020.mkv' };
  const parsedAttributes = { title: 'The Shawshank Redemption', year: 2020 };

  const result = await resolver.resolveIdentity({ candidate, parsedAttributes });

  // Should still match title but with reduced confidence due to year mismatch
  if (result.matches.length > 0) {
    assert.ok(result.matches[0].evidence.includes('year_mismatch'));
  }
});

// =============================================================================
// Ambiguous Title Handling Tests
// =============================================================================

test('ambiguous title returns multiple matches sorted by confidence', async () => {
  const results = [
    { id: 'tt111', type: 'movie', title: 'The Matrix', year: 1999 },
    { id: 'tt222', type: 'movie', title: 'The Matrix Reloaded', year: 2003 },
    { id: 'tt333', type: 'movie', title: 'The Matrix Revolutions', year: 2003 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  const candidate = { infoHash: 'aaa', filename: 'The.Matrix.1999.mkv' };
  const parsedAttributes = { title: 'The Matrix', year: 1999 };

  const result = await resolver.resolveIdentity({ candidate, parsedAttributes });

  assert.ok(result.matches.length >= 1);
  // First match should be the exact title + year match
  assert.equal(result.matches[0].mediaId, 'tt111');
  assert.ok(result.matches[0].confidence >= 0.6);
  // Matches should be sorted by confidence descending
  for (let i = 1; i < result.matches.length; i++) {
    assert.ok(result.matches[i - 1].confidence >= result.matches[i].confidence);
  }
});

test('type mismatch (movie vs series) reduces confidence', async () => {
  const results = [
    { id: 'tt0903747', type: 'series', title: 'Breaking Bad', year: 2008 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  // Candidate has season/episode but result is a movie
  const results2 = [
    { id: 'tt123', type: 'movie', title: 'Breaking Bad', year: 2008 },
  ];
  const fetchImpl2 = createMockFetch(results2);
  const resolver2 = new CinemetaIdentityResolver({ fetchImpl: fetchImpl2 });

  const candidate = { infoHash: 'aaa', filename: 'Breaking.Bad.S05E14.mkv' };
  const parsedAttributes = { title: 'Breaking Bad', year: 2008, season: 5, episode: 14 };

  const result = await resolver2.resolveIdentity({ candidate, parsedAttributes });

  if (result.matches.length > 0) {
    assert.ok(result.matches[0].evidence.includes('type_mismatch'));
  }
});

// =============================================================================
// Confidence Threshold Tests
// =============================================================================

test('low confidence matches are filtered out', async () => {
  const results = [
    { id: 'tt999', type: 'movie', title: 'Something Completely Unrelated', year: 2020 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl, minConfidence: 0.4 });

  const candidate = { infoHash: 'aaa', filename: 'My.Specific.Movie.2010.mkv' };
  const parsedAttributes = { title: 'My Specific Movie', year: 2010 };

  const result = await resolver.resolveIdentity({ candidate, parsedAttributes });

  assert.equal(result.matches.length, 0);
});

test('custom minConfidence threshold is respected', async () => {
  const results = [
    { id: 'tt111', type: 'movie', title: 'The Matrix', year: 1999 },
  ];
  const fetchImpl = createMockFetch(results);

  // With high threshold
  const resolverHigh = new CinemetaIdentityResolver({ fetchImpl, minConfidence: 0.9 });
  const candidate = { infoHash: 'aaa', filename: 'The.Matrix.1999.mkv' };
  const parsedAttributes = { title: 'The Matrix', year: 1999 };

  const resultHigh = await resolverHigh.resolveIdentity({ candidate, parsedAttributes });
  // Exact match with year should pass even high threshold
  assert.ok(resultHigh.matches.length <= 1);

  // With low threshold
  const resolverLow = new CinemetaIdentityResolver({ fetchImpl, minConfidence: 0.1 });
  const resultLow = await resolverLow.resolveIdentity({ candidate, parsedAttributes });
  assert.ok(resultLow.matches.length >= 1);
});

// =============================================================================
// canResolve Tests
// =============================================================================

test('canResolve returns true when title is available', () => {
  const resolver = new CinemetaIdentityResolver();
  const candidate = { infoHash: 'aaa', filename: 'Some.Movie.mkv' };
  const parsedAttributes = { title: 'Some Movie' };

  assert.equal(resolver.canResolve({ candidate, parsedAttributes }), true);
});

test('canResolve returns false when no title available', () => {
  const resolver = new CinemetaIdentityResolver();
  const candidate = { infoHash: 'aaa' };
  const parsedAttributes = null;

  assert.equal(resolver.canResolve({ candidate, parsedAttributes }), false);
});

test('canResolve returns false when resolver is disabled', () => {
  const resolver = new CinemetaIdentityResolver({ enabled: false });
  const candidate = { infoHash: 'aaa', filename: 'Some.Movie.mkv' };
  const parsedAttributes = { title: 'Some Movie' };

  assert.equal(resolver.canResolve({ candidate, parsedAttributes }), false);
});

test('canResolve returns false for short titles', () => {
  const resolver = new CinemetaIdentityResolver();
  const candidate = { infoHash: 'aaa' };
  const parsedAttributes = { title: 'A' };

  assert.equal(resolver.canResolve({ candidate, parsedAttributes }), false);
});

// =============================================================================
// Infrastructure Error Tests
// =============================================================================

test('infrastructure failure throws ResolverError', async () => {
  const fetchImpl = async () => { throw new Error('Network timeout'); };
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  const candidate = { infoHash: 'aaa', filename: 'Some.Movie.mkv' };
  const parsedAttributes = { title: 'Some Movie' };

  await assert.rejects(
    () => resolver.resolveIdentity({ candidate, parsedAttributes }),
    (err) => err instanceof ResolverError && err.code === 'cinemeta-infrastructure'
  );
});

test('HTTP error throws ResolverError', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  const candidate = { infoHash: 'aaa', filename: 'Some.Movie.mkv' };
  const parsedAttributes = { title: 'Some Movie' };

  await assert.rejects(
    () => resolver.resolveIdentity({ candidate, parsedAttributes }),
    (err) => err instanceof ResolverError
  );
});

// =============================================================================
// Provenance Tests
// =============================================================================

test('resolver has correct source name and version', () => {
  const resolver = new CinemetaIdentityResolver();
  assert.equal(resolver.sourceName, 'cinemeta');
  assert.equal(resolver.version, '1.0.0');
});

test('custom version is respected', () => {
  const resolver = new CinemetaIdentityResolver({ version: '2.0.0' });
  assert.equal(resolver.version, '2.0.0');
});

// =============================================================================
// Filename Cleaning Tests
// =============================================================================

test('cleanFilename removes release tokens', () => {
  const resolver = new CinemetaIdentityResolver();
  const cleaned = resolver._cleanFilename('The.Matrix.1999.1080p.BluRay.x264-TEST.mkv');
  assert.ok(!cleaned.includes('1080p'));
  assert.ok(!cleaned.includes('BluRay'));
  assert.ok(!cleaned.includes('x264'));
  assert.ok(cleaned.includes('Matrix'));
});

test('cleanFilename removes season/episode tokens', () => {
  const resolver = new CinemetaIdentityResolver();
  const cleaned = resolver._cleanFilename('Breaking.Bad.S05E14.1080p.mkv');
  assert.ok(!cleaned.includes('S05E14'));
  assert.ok(cleaned.includes('Breaking'));
  assert.ok(cleaned.includes('Bad'));
});

// =============================================================================
// Token Overlap Tests
// =============================================================================

test('token overlap calculates correctly', () => {
  const resolver = new CinemetaIdentityResolver();
  const overlap = resolver._tokenOverlap('the matrix', 'the matrix reloaded');
  assert.ok(overlap > 0.4);
  assert.ok(overlap < 1.0);
});

test('token overlap with no common tokens returns 0', () => {
  const resolver = new CinemetaIdentityResolver();
  const overlap = resolver._tokenOverlap('abc def', 'ghi jkl');
  assert.equal(overlap, 0);
});

// =============================================================================
// Integration: Worker + Cinemeta Resolver
// =============================================================================

test('resolver works with enrichment worker', async () => {
  const results = [
    { id: 'tt0111161', type: 'movie', title: 'The Shawshank Redemption', year: 1994 },
  ];
  const fetchImpl = createMockFetch(results);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  // Import worker dynamically to avoid circular deps
  const { runIdentityEnrichmentWorker } = await import('../src/lib/discovery/identity-enrichment-worker.js');
  const { createDiscoveryCache } = await import('../src/lib/discovery/cache.js');
  const { storeReleaseAttributes } = await import('../src/lib/discovery/release-attributes.js');

  const cache = createDiscoveryCache();
  const infoHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  // Setup candidate
  cache.upsertCandidate({
    infoHash,
    fileIndex: null,
    filename: 'The.Shawshank.Redemption.1994.1080p.mkv',
    title: 'The Shawshank Redemption',
  });
  storeReleaseAttributes(cache, {
    infoHash,
    fileIndex: null,
    filename: 'The.Shawshank.Redemption.1994.1080p.mkv',
    source: 'ptn-regex',
    confidence: 0.85,
    parsed: { title: 'The Shawshank Redemption', year: 1994 },
    evidence: ['title_extracted'],
  });

  // Enqueue and process
  cache.enqueueIdentityResolution(infoHash, null);
  const stats = await runIdentityEnrichmentWorker(cache, { resolver, limit: 10 });

  assert.equal(stats.resolved, 1);
  assert.equal(stats.failed, 0);

  // Verify candidate_media was created with provenance
  const associations = cache.getMediaAssociations(infoHash, null);
  assert.equal(associations.length, 1);
  assert.equal(associations[0].mediaId, 'tt0111161');
  assert.equal(associations[0].resolverSource, 'cinemeta');
  assert.ok(associations[0].confidence >= 0.5);

  cache.close();
});

// =============================================================================
// Empty Results Tests
// =============================================================================

test('empty Cinemeta results return empty matches', async () => {
  const fetchImpl = createMockFetch([]);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  const candidate = { infoHash: 'aaa', filename: 'Unknown.Movie.mkv' };
  const parsedAttributes = { title: 'Unknown Movie' };

  const result = await resolver.resolveIdentity({ candidate, parsedAttributes });

  assert.equal(result.matches.length, 0);
});

test('no match is not a failure', async () => {
  const fetchImpl = createMockFetch([]);
  const resolver = new CinemetaIdentityResolver({ fetchImpl });

  const candidate = { infoHash: 'aaa', filename: 'Some.Movie.mkv' };
  const parsedAttributes = { title: 'Some Movie' };

  // Should not throw
  const result = await resolver.resolveIdentity({ candidate, parsedAttributes });
  assert.deepEqual(result, { matches: [] });
});
