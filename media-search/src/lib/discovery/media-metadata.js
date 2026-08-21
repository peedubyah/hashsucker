/**
 * Media Metadata Store
 *
 * Stores normalized media metadata from enrichment providers.
 * Separated from candidate identity and release attributes.
 *
 * Schema:
 *   media_id (PK) - External identifier (e.g., "tt1234567")
 *   provider - Source provider ("cinemeta", "tmdb", etc.)
 *   type - "movie" or "series"
 *   title - Normalized title
 *   year - Release year
 *   poster - Poster image URL
 *   background - Background image URL
 *   description - Short description
 *   metadata - JSON blob for provider-specific fields
 *   fetched_at - Timestamp of last fetch
 *   expires_at - Cache expiration timestamp
 *
 * Cache behavior:
 *   - Metadata is cached with TTL (default: 7 days)
 *   - Expired entries are refreshed on next access
 *   - Multiple providers can contribute to same media_id
 */

import { DatabaseSync } from 'node:sqlite';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media_metadata (
  media_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  year TEXT,
  poster TEXT,
  background TEXT,
  description TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (media_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_media_metadata_expires_at ON media_metadata(expires_at);
CREATE INDEX IF NOT EXISTS idx_media_metadata_type ON media_metadata(type);
`;

/**
 * Initialize media metadata table on existing database.
 * @param {DatabaseSync} db - Database instance
 */
export function initMediaMetadataTable(db) {
  db.exec(SCHEMA);
}

/**
 * Store media metadata from a provider.
 * @param {Object} db - Database instance
 * @param {Object} metadata - Media metadata
 * @param {string} metadata.mediaId - External media identifier
 * @param {string} metadata.provider - Provider name
 * @param {string} metadata.type - "movie" or "series"
 * @param {string} metadata.title - Media title
 * @param {string} [metadata.year] - Release year
 * @param {string} [metadata.poster] - Poster URL
 * @param {string} [metadata.background] - Background URL
 * @param {string} [metadata.description] - Description
 * @param {Object} [metadata.videos] - Episode list (series only)
 * @param {Object} [metadata.extra] - Provider-specific fields
 * @param {number} [ttlMs] - Cache TTL in ms (default: 7 days)
 * @returns {boolean} True if stored
 */
export function storeMediaMetadata(db, metadata, ttlMs = DEFAULT_TTL_MS) {
  if (!db || !metadata?.mediaId || !metadata?.provider) return false;

  const now = Date.now();
  const expiresAt = now + ttlMs;

  db.prepare(`
    INSERT INTO media_metadata (
      media_id, provider, type, title, year, poster, background,
      description, metadata, fetched_at, expires_at
    ) VALUES (
      @media_id, @provider, @type, @title, @year, @poster, @background,
      @description, @metadata, @fetched_at, @expires_at
    )
    ON CONFLICT(media_id, provider) DO UPDATE SET
      type = EXCLUDED.type,
      title = EXCLUDED.title,
      year = EXCLUDED.year,
      poster = EXCLUDED.poster,
      background = EXCLUDED.background,
      description = EXCLUDED.description,
      metadata = EXCLUDED.metadata,
      fetched_at = EXCLUDED.fetched_at,
      expires_at = EXCLUDED.expires_at
  `).run({
    media_id: metadata.mediaId,
    provider: metadata.provider,
    type: metadata.type,
    title: metadata.title || null,
    year: metadata.year || null,
    poster: metadata.poster || null,
    background: metadata.background || null,
    description: metadata.description || null,
    metadata: JSON.stringify(metadata.extra || {}),
    fetched_at: now,
    expires_at: expiresAt,
  });

  return true;
}

/**
 * Get media metadata by ID.
 * Returns null if not found or expired.
 * @param {Object} db - Database instance
 * @param {string} mediaId - External media identifier
 * @param {string} [provider] - Specific provider (optional)
 * @returns {Object|null} Media metadata or null
 */
export function getMediaMetadata(db, mediaId, provider = null) {
  if (!db || !mediaId) return null;

  const now = Date.now();
  let row;

  if (provider) {
    row = db.prepare(`
      SELECT * FROM media_metadata
      WHERE media_id = @media_id AND provider = @provider
      AND expires_at > @now
    `).get({ media_id: mediaId, provider, now });
  } else {
    // Get most recent non-expired entry from any provider
    row = db.prepare(`
      SELECT * FROM media_metadata
      WHERE media_id = @media_id AND expires_at > @now
      ORDER BY fetched_at DESC
      LIMIT 1
    `).get({ media_id: mediaId, now });
  }

  if (!row) return null;

  return {
    mediaId: row.media_id,
    provider: row.provider,
    type: row.type,
    title: row.title,
    year: row.year,
    poster: row.poster,
    background: row.background,
    description: row.description,
    metadata: JSON.parse(row.metadata || '{}'),
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Check if metadata is cached and not expired.
 * @param {Object} db - Database instance
 * @param {string} mediaId - External media identifier
 * @param {string} [provider] - Specific provider (optional)
 * @returns {boolean} True if cached and valid
 */
export function isMetadataCached(db, mediaId, provider = null) {
  if (!db || !mediaId) return false;

  const now = Date.now();
  let row;

  if (provider) {
    row = db.prepare(`
      SELECT 1 FROM media_metadata
      WHERE media_id = @media_id AND provider = @provider
      AND expires_at > @now
    `).get({ media_id: mediaId, provider, now });
  } else {
    row = db.prepare(`
      SELECT 1 FROM media_metadata
      WHERE media_id = @media_id AND expires_at > @now
      LIMIT 1
    `).get({ media_id: mediaId, now });
  }

  return !!row;
}

/**
 * Delete expired metadata entries.
 * @param {Object} db - Database instance
 * @returns {number} Number of deleted entries
 */
export function purgeExpiredMetadata(db) {
  if (!db) return 0;

  const now = Date.now();
  const result = db.prepare(`
    DELETE FROM media_metadata WHERE expires_at <= @now
  `).run({ now });

  return result.changes || 0;
}

/**
 * Get metadata cache statistics.
 * @param {Object} db - Database instance
 * @returns {Object} Stats
 */
export function getMetadataStats(db) {
  if (!db) return { total: 0, expired: 0, valid: 0 };

  const now = Date.now();
  const total = db.prepare('SELECT COUNT(*) as c FROM media_metadata').get();
  const expired = db.prepare('SELECT COUNT(*) as c FROM media_metadata WHERE expires_at <= @now').get({ now });
  const valid = db.prepare('SELECT COUNT(*) as c FROM media_metadata WHERE expires_at > @now').get({ now });

  return {
    total: total?.c || 0,
    expired: expired?.c || 0,
    valid: valid?.c || 0,
  };
}
