/**
 * Media Metadata Store Tests
 *
 * Tests the media metadata cache layer:
 * - Store and retrieve metadata
 * - Cache expiration
 * - Multiple providers
 * - Purge expired entries
 * - Statistics
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  initMediaMetadataTable,
  storeMediaMetadata,
  getMediaMetadata,
  isMetadataCached,
  purgeExpiredMetadata,
  getMetadataStats,
} from '../src/lib/discovery/media-metadata.js';

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  initMediaMetadataTable(db);
  return db;
}

// =============================================================================
// Store and Retrieve Tests
// =============================================================================

test('storeMediaMetadata: stores movie metadata', () => {
  const db = createTestDb();

  const stored = storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'cinemeta',
    type: 'movie',
    title: 'The Matrix',
    year: '1999',
    poster: 'https://example.com/poster.jpg',
    description: 'A computer hacker learns about the true nature of reality.',
  });

  assert.equal(stored, true);

  const retrieved = getMediaMetadata(db, 'tt0133093');
  assert.ok(retrieved);
  assert.equal(retrieved.mediaId, 'tt0133093');
  assert.equal(retrieved.provider, 'cinemeta');
  assert.equal(retrieved.type, 'movie');
  assert.equal(retrieved.title, 'The Matrix');
  assert.equal(retrieved.year, '1999');
  assert.equal(retrieved.poster, 'https://example.com/poster.jpg');
  assert.equal(retrieved.description, 'A computer hacker learns about the true nature of reality.');

  db.close();
});

test('storeMediaMetadata: stores series metadata', () => {
  const db = createTestDb();

  storeMediaMetadata(db, {
    mediaId: 'tt0903747',
    provider: 'cinemeta',
    type: 'series',
    title: 'Breaking Bad',
    year: '2008–2013',
    poster: 'https://example.com/bb-poster.jpg',
    description: 'A chemistry teacher diagnosed with cancer turns to making meth.',
  });

  const retrieved = getMediaMetadata(db, 'tt0903747');
  assert.ok(retrieved);
  assert.equal(retrieved.type, 'series');
  assert.equal(retrieved.title, 'Breaking Bad');

  db.close();
});

test('storeMediaMetadata: updates existing entry', () => {
  const db = createTestDb();

  // First store
  storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'cinemeta',
    type: 'movie',
    title: 'The Matrix',
    year: '1999',
    poster: 'https://example.com/poster-v1.jpg',
  });

  // Update with new poster
  storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'cinemeta',
    type: 'movie',
    title: 'The Matrix',
    year: '1999',
    poster: 'https://example.com/poster-v2.jpg',
  });

  const retrieved = getMediaMetadata(db, 'tt0133093');
  assert.equal(retrieved.poster, 'https://example.com/poster-v2.jpg');

  db.close();
});

test('storeMediaMetadata: returns false for invalid input', () => {
  const db = createTestDb();

  assert.equal(storeMediaMetadata(db, null), false);
  assert.equal(storeMediaMetadata(db, {}), false);
  assert.equal(storeMediaMetadata(db, { mediaId: 'tt123' }), false); // missing provider
  assert.equal(storeMediaMetadata(db, { provider: 'cinemeta' }), false); // missing mediaId

  db.close();
});

// =============================================================================
// Cache Expiration Tests
// =============================================================================

test('getMediaMetadata: returns null for expired entry', () => {
  const db = createTestDb();

  // Store with very short TTL (already expired)
  storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'cinemeta',
    type: 'movie',
    title: 'The Matrix',
  }, -1); // Negative TTL = already expired

  const retrieved = getMediaMetadata(db, 'tt0133093');
  assert.equal(retrieved, null);

  db.close();
});

test('isMetadataCached: returns false for expired entry', () => {
  const db = createTestDb();

  storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'cinemeta',
    type: 'movie',
    title: 'The Matrix',
  }, -1); // Already expired

  assert.equal(isMetadataCached(db, 'tt0133093'), false);

  db.close();
});

test('isMetadataCached: returns true for valid entry', () => {
  const db = createTestDb();

  storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'cinemeta',
    type: 'movie',
    title: 'The Matrix',
  });

  assert.equal(isMetadataCached(db, 'tt0133093'), true);

  db.close();
});

// =============================================================================
// Multiple Providers Tests
// =============================================================================

test('getMediaMetadata: returns most recent provider when no provider specified', async () => {
  const db = createTestDb();

  // Store from Cinemeta first
  storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'cinemeta',
    type: 'movie',
    title: 'The Matrix',
    year: '1999',
  });

  // Small delay to ensure different fetched_at timestamps
  await new Promise(resolve => setTimeout(resolve, 10));

  // Store from TMDB later (more recent)
  storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'tmdb',
    type: 'movie',
    title: 'The Matrix',
    year: '1999',
    poster: 'https://tmdb.com/poster.jpg',
  });

  // Should return TMDB (most recent)
  const retrieved = getMediaMetadata(db, 'tt0133093');
  assert.equal(retrieved.provider, 'tmdb');
  assert.equal(retrieved.poster, 'https://tmdb.com/poster.jpg');

  db.close();
});

test('getMediaMetadata: returns specific provider when specified', () => {
  const db = createTestDb();

  storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'cinemeta',
    type: 'movie',
    title: 'The Matrix',
    year: '1999',
  });

  storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'tmdb',
    type: 'movie',
    title: 'The Matrix',
    year: '1999',
  });

  // Get specific provider
  const cinemeta = getMediaMetadata(db, 'tt0133093', 'cinemeta');
  assert.equal(cinemeta.provider, 'cinemeta');

  const tmdb = getMediaMetadata(db, 'tt0133093', 'tmdb');
  assert.equal(tmdb.provider, 'tmdb');

  db.close();
});

// =============================================================================
// Purge Tests
// =============================================================================

test('purgeExpiredMetadata: removes expired entries', () => {
  const db = createTestDb();

  // Store valid entry
  storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'cinemeta',
    type: 'movie',
    title: 'The Matrix',
  });

  // Store expired entry
  storeMediaMetadata(db, {
    mediaId: 'tt0903747',
    provider: 'cinemeta',
    type: 'series',
    title: 'Breaking Bad',
  }, -1); // Already expired

  const purged = purgeExpiredMetadata(db);
  assert.equal(purged, 1);

  // Valid entry should still exist
  assert.ok(getMediaMetadata(db, 'tt0133093'));

  // Expired entry should be gone
  assert.equal(getMediaMetadata(db, 'tt0903747'), null);

  db.close();
});

// =============================================================================
// Statistics Tests
// =============================================================================

test('getMetadataStats: returns correct counts', () => {
  const db = createTestDb();

  // Store valid entries
  storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'cinemeta',
    type: 'movie',
    title: 'The Matrix',
  });

  storeMediaMetadata(db, {
    mediaId: 'tt0903747',
    provider: 'cinemeta',
    type: 'series',
    title: 'Breaking Bad',
  });

  // Store expired entry
  storeMediaMetadata(db, {
    mediaId: 'tt0000000',
    provider: 'cinemeta',
    type: 'movie',
    title: 'Expired',
  }, -1);

  const stats = getMetadataStats(db);
  assert.equal(stats.total, 3);
  assert.equal(stats.valid, 2);
  assert.equal(stats.expired, 1);

  db.close();
});

// =============================================================================
// Edge Cases
// =============================================================================

test('getMediaMetadata: returns null for non-existent media', () => {
  const db = createTestDb();

  const retrieved = getMediaMetadata(db, 'tt9999999');
  assert.equal(retrieved, null);

  db.close();
});

test('getMediaMetadata: handles null/undefined mediaId', () => {
  const db = createTestDb();

  assert.equal(getMediaMetadata(db, null), null);
  assert.equal(getMediaMetadata(db, undefined), null);

  db.close();
});

test('storeMediaMetadata: stores extra metadata as JSON', () => {
  const db = createTestDb();

  storeMediaMetadata(db, {
    mediaId: 'tt0133093',
    provider: 'cinemeta',
    type: 'movie',
    title: 'The Matrix',
    extra: {
      genres: ['Action', 'Sci-Fi'],
      rating: 8.7,
      runtime: 136,
    },
  });

  const retrieved = getMediaMetadata(db, 'tt0133093');
  assert.ok(retrieved.metadata);
  assert.equal(retrieved.metadata.genres.length, 2);
  assert.equal(retrieved.metadata.rating, 8.7);

  db.close();
});
