/**
 * Discovery Candidate Cache
 *
 * SQLite-backed persistent storage for normalized discovery candidates.
 *
 * Architectural contract:
 * - Identity is exactly (infoHash, fileIndex). No fuzzy merging.
 * - Provider observations are stored SEPARATELY from candidates.
 *   A candidate never stores `cached=true` directly; that state lives in
 *   provider_observations and can expire/refresh independently.
 * - Cache failures must never break live discovery. Every write path is
 *   wrapped so a cache error is swallowed; live search remains authoritative.
 * - This is additive only. Live discovery is the source of truth; the cache
 *   is a substrate for later background discovery, ranking, and provider workers.
 */

import { DatabaseSync } from 'node:sqlite';

import {
  createCacheObservation,
  evaluateObservationFreshness,
  legacyObservationInput,
  toLegacyCachedState,
} from '../providers/observations.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  info_hash TEXT NOT NULL,
  file_index INTEGER,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  search_key TEXT,
  title TEXT,
  filename TEXT,
  size INTEGER,
  seeders INTEGER,
  leechers INTEGER,
  publish_date TEXT,
  magnet TEXT,
  download_url TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  sources TEXT NOT NULL DEFAULT '[]',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (info_hash, file_index_key)
);

CREATE TABLE IF NOT EXISTS provider_observations (
  info_hash TEXT NOT NULL,
  file_index INTEGER,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  provider TEXT NOT NULL,
  cached INTEGER,
  evidence TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (info_hash, file_index_key, provider)
);

CREATE INDEX IF NOT EXISTS idx_candidates_last_seen ON candidates(last_seen);
CREATE INDEX IF NOT EXISTS idx_candidates_search_key ON candidates(search_key);
CREATE INDEX IF NOT EXISTS idx_observations_checked_at ON provider_observations(checked_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_observation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  info_hash TEXT,
  file_index INTEGER,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER,
  source TEXT NOT NULL,
  evidence TEXT,
  error_category TEXT,
  retryable INTEGER,
  retry_after_ms INTEGER,
  latency_ms INTEGER,
  correlation_id TEXT,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_observation_events_subject
  ON provider_observation_events(subject_type, subject_key, provider, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_observation_events_candidate
  ON provider_observation_events(info_hash, file_index_key, provider, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_observation_events_expiry
  ON provider_observation_events(expires_at);

CREATE TABLE IF NOT EXISTS provider_observation_current (
  provider TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  info_hash TEXT,
  file_index INTEGER,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER,
  source TEXT NOT NULL,
  evidence TEXT,
  error_category TEXT,
  retryable INTEGER,
  retry_after_ms INTEGER,
  latency_ms INTEGER,
  correlation_id TEXT,
  event_id INTEGER NOT NULL,
  PRIMARY KEY (provider, account_scope, scope, subject_type, subject_key, kind),
  FOREIGN KEY (event_id) REFERENCES provider_observation_events(id)
);

CREATE INDEX IF NOT EXISTS idx_provider_observation_current_candidate
  ON provider_observation_current(info_hash, file_index_key, provider);
CREATE INDEX IF NOT EXISTS idx_provider_observation_current_expiry
  ON provider_observation_current(expires_at);

CREATE TABLE IF NOT EXISTS candidate_media (
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  media_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'search',
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence TEXT,
  associated_at INTEGER NOT NULL,
  -- Provenance: how this association was created
  resolver_source TEXT,
  resolver_version TEXT,
  match_method TEXT,
  resolution_state TEXT NOT NULL DEFAULT 'unresolved',
  PRIMARY KEY (info_hash, file_index_key, media_id)
);

CREATE INDEX IF NOT EXISTS idx_candidate_media_media_id ON candidate_media(media_id);
CREATE INDEX IF NOT EXISTS idx_candidate_media_resolution_state ON candidate_media(resolution_state);

CREATE TABLE IF NOT EXISTS cache_probe_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  info_hash TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'checking', 'complete', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cache_probe_queue_active_hash ON cache_probe_queue(info_hash) WHERE status IN ('pending', 'checking');
CREATE INDEX IF NOT EXISTS idx_cache_probe_queue_status_priority ON cache_probe_queue(status, priority DESC, created_at ASC);

CREATE TABLE IF NOT EXISTS identity_enrichment_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  resolver_source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_attempt_at INTEGER,
  error_message TEXT,
  error_category TEXT,
  UNIQUE(info_hash, file_index_key)
);

CREATE INDEX IF NOT EXISTS idx_enrichment_queue_status_priority ON identity_enrichment_queue(status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_enrichment_queue_candidate ON identity_enrichment_queue(info_hash, file_index_key);

CREATE TABLE IF NOT EXISTS media_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  season INTEGER,
  episode INTEGER,
  source TEXT NOT NULL DEFAULT 'api',
  source_type TEXT,
  source_id TEXT,
  source_label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  priority INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT,
  request_count INTEGER NOT NULL DEFAULT 1,
  last_requested_at INTEGER NOT NULL,
  last_processed_at INTEGER,
  last_result_count INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  imdb_id TEXT,
  tmdb_id TEXT,
  tvdb_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_media_intents_media_id ON media_intents(media_id, last_requested_at);
CREATE INDEX IF NOT EXISTS idx_media_intents_source ON media_intents(source, source_type, last_requested_at);
CREATE INDEX IF NOT EXISTS idx_media_intents_status ON media_intents(status, priority DESC);

CREATE TABLE IF NOT EXISTS media_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  season INTEGER,
  episode INTEGER,
  intent_id INTEGER,
  source TEXT NOT NULL DEFAULT 'api',
  source_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (intent_id) REFERENCES media_intents(id)
);

CREATE INDEX IF NOT EXISTS idx_media_requests_media_id ON media_requests(media_id, created_at);

CREATE TABLE IF NOT EXISTS media_request_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  intent_id INTEGER,
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  filename TEXT,
  score REAL NOT NULL DEFAULT 0,
  score_breakdown TEXT,
  identity_tier TEXT,
  identity_confidence REAL,
  identity_evidence TEXT,
  resolution_state TEXT,
  release_metadata TEXT,
  ranking_breakdown TEXT,
  eligible INTEGER,
  ineligible_reason TEXT,
  ineligible_code TEXT,
  expected_media_scope TEXT,
  parsed_candidate_scope TEXT,
  selected_file_size INTEGER,
  FOREIGN KEY (request_id) REFERENCES media_requests(id),
  FOREIGN KEY (intent_id) REFERENCES media_intents(id)
);

CREATE INDEX IF NOT EXISTS idx_media_request_results_request ON media_request_results(request_id, rank);

CREATE TABLE IF NOT EXISTS release_attributes (
  info_hash TEXT NOT NULL,
  file_index INTEGER,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  source TEXT NOT NULL,
  filename TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  title TEXT,
  year INTEGER,
  media_type TEXT,
  season INTEGER,
  episode INTEGER,
  episode_range TEXT,
  resolution TEXT,
  source_type TEXT,
  codec TEXT,
  hdr INTEGER,
  audio TEXT,
  language TEXT,
  release_group TEXT,
  evidence TEXT,
  parsed_at INTEGER NOT NULL,
  PRIMARY KEY (info_hash, file_index_key, source)
);

CREATE INDEX IF NOT EXISTS idx_release_attributes_source ON release_attributes(source);
CREATE INDEX IF NOT EXISTS idx_release_attributes_parsed_at ON release_attributes(parsed_at);

-- ============================================================================
-- Playback Handoffs
-- ============================================================================
-- Stable boundary object representing the exact candidate chosen for playback.
-- Retrieved by request ID for playback materialization.

CREATE TABLE IF NOT EXISTS playback_handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER,
  media_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  season INTEGER,
  episode INTEGER,
  release_key TEXT NOT NULL,
  info_hash TEXT NOT NULL,
  file_index INTEGER,
  filename TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'torbox',
  provider_state TEXT NOT NULL DEFAULT 'unknown',
  identity_tier TEXT,
  resolution_state TEXT,
  selection_reason TEXT,
  selected_at INTEGER NOT NULL,
  torrent_file_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
  FOREIGN KEY (request_id) REFERENCES media_requests(id)
);

CREATE INDEX IF NOT EXISTS idx_playback_handoffs_request ON playback_handoffs(request_id);
CREATE INDEX IF NOT EXISTS idx_playback_handoffs_media ON playback_handoffs(media_id, created_at);
-- Slice 1.75: the playback_handoffs row carries the durable TorrentFile id
-- once the pre-publication identity helper has bound the selected candidate to
-- an exact TorBox file. NULL on legacy handoffs and on candidates where the
-- raw per-file size is unknown. The id lives in control-plane.db and is
-- enforced only via application-level validation; no FK by design.
-- The index is created AFTER the column migration (see
-- migratePlaybackHandoffsTorrentFileId + ensurePlaybackHandoffsTorrentFileIndex)
-- so a legacy prod DB that already has the playback_handoffs table without
-- this column does not error at SCHEMA exec time.

-- Stable, movies-only virtual filesystem metadata. Provider playback URLs are
-- deliberately excluded: backing URLs remain short-lived process state.
CREATE TABLE IF NOT EXISTS vfs_movie_entries (
  media_id TEXT PRIMARY KEY,
  release_key TEXT NOT NULL,
  info_hash TEXT NOT NULL,
  file_index INTEGER,
  canonical_path TEXT NOT NULL UNIQUE,
  torrent_file_id TEXT,
  size INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Stable TV episode virtual filesystem metadata. Same invariants as movies:
-- provider playback URLs remain ephemeral process state.
CREATE TABLE IF NOT EXISTS vfs_tv_entries (
  media_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  release_key TEXT NOT NULL,
  info_hash TEXT NOT NULL,
  file_index INTEGER,
  canonical_path TEXT NOT NULL UNIQUE,
  torrent_file_id TEXT,
  size INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (media_id, season, episode)
);

-- FTS5 full-text search index over release_attributes
-- Stores its own copy of searchable fields (simpler than external content)
CREATE VIRTUAL TABLE IF NOT EXISTS release_search USING fts5(
  title,
  filename,
  resolution,
  source_type,
  codec,
  audio,
  release_group,
  language,
  media_type,
  tokenize='porter unicode61'
);

-- Triggers to keep FTS index in sync with release_attributes
CREATE TRIGGER IF NOT EXISTS release_attributes_ai AFTER INSERT ON release_attributes BEGIN
  INSERT INTO release_search(rowid, title, filename, resolution, source_type, codec, audio, release_group, language, media_type)
  VALUES (new.rowid, new.title, new.filename, new.resolution, new.source_type, new.codec, new.audio, new.release_group, new.language, new.media_type);
END;

CREATE TRIGGER IF NOT EXISTS release_attributes_ad AFTER DELETE ON release_attributes BEGIN
  DELETE FROM release_search WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS release_attributes_au AFTER UPDATE ON release_attributes BEGIN
  DELETE FROM release_search WHERE rowid = old.rowid;
  INSERT INTO release_search(rowid, title, filename, resolution, source_type, codec, audio, release_group, language, media_type)
  VALUES (new.rowid, new.title, new.filename, new.resolution, new.source_type, new.codec, new.audio, new.release_group, new.language, new.media_type);
END;
`;

const INSERT_CANDIDATE = `
INSERT INTO candidates (
  info_hash, file_index, file_index_key, search_key, title, filename, size, seeders, leechers,
  publish_date, magnet, download_url, metadata, sources, first_seen, last_seen
) VALUES (
  @info_hash, @file_index, @file_index_key, @search_key, @title, @filename, @size, @seeders, @leechers,
  @publish_date, @magnet, @download_url, @metadata, @sources, @first_seen, @last_seen
)
ON CONFLICT(info_hash, file_index_key) DO UPDATE SET
  search_key = COALESCE(EXCLUDED.search_key, candidates.search_key),
  title = COALESCE(EXCLUDED.title, candidates.title),
  filename = COALESCE(EXCLUDED.filename, candidates.filename),
  size = COALESCE(EXCLUDED.size, candidates.size),
  seeders = COALESCE(EXCLUDED.seeders, candidates.seeders),
  leechers = COALESCE(EXCLUDED.leechers, candidates.leechers),
  publish_date = COALESCE(EXCLUDED.publish_date, candidates.publish_date),
  magnet = COALESCE(EXCLUDED.magnet, candidates.magnet),
  download_url = COALESCE(EXCLUDED.download_url, candidates.download_url),
  metadata = EXCLUDED.metadata,
  sources = EXCLUDED.sources,
  last_seen = EXCLUDED.last_seen;
`;

const GET_CANDIDATE = `
SELECT * FROM candidates WHERE info_hash = @info_hash AND file_index_key = @file_index_key;
`;

const GET_CURRENT_OBSERVATIONS = `
SELECT *
FROM provider_observation_current
WHERE info_hash = @info_hash AND file_index_key = @file_index_key
ORDER BY provider, account_scope, kind;
`;

const GET_OBSERVATION_HISTORY = `
SELECT *
FROM provider_observation_events
WHERE info_hash = @info_hash AND file_index_key = @file_index_key
  AND (@provider IS NULL OR provider = @provider)
  AND (@account_scope IS NULL OR account_scope = @account_scope)
  AND (@kind IS NULL OR kind = @kind)
ORDER BY observed_at DESC, id DESC
LIMIT @limit;
`;

const SELECT_ALL_CANDIDATES = `
SELECT * FROM candidates ORDER BY last_seen DESC;
`;

const SELECT_CANDIDATES_BY_KEY = `
SELECT * FROM candidates WHERE search_key = @search_key ORDER BY last_seen DESC;
`;

const INSERT_OBSERVATION_EVENT = `
INSERT INTO provider_observation_events (
  provider, account_scope, scope, subject_type, subject_key,
  info_hash, file_index, file_index_key, kind, state,
  observed_at, expires_at, source, evidence, error_category,
  retryable, retry_after_ms, latency_ms, correlation_id, recorded_at
) VALUES (
  @provider, @account_scope, @scope, @subject_type, @subject_key,
  @info_hash, @file_index, @file_index_key, @kind, @state,
  @observed_at, @expires_at, @source, @evidence, @error_category,
  @retryable, @retry_after_ms, @latency_ms, @correlation_id, @recorded_at
) RETURNING id;
`;

const UPSERT_CURRENT_OBSERVATION = `
INSERT INTO provider_observation_current (
  provider, account_scope, scope, subject_type, subject_key,
  info_hash, file_index, file_index_key, kind, state,
  observed_at, expires_at, source, evidence, error_category,
  retryable, retry_after_ms, latency_ms, correlation_id, event_id
) VALUES (
  @provider, @account_scope, @scope, @subject_type, @subject_key,
  @info_hash, @file_index, @file_index_key, @kind, @state,
  @observed_at, @expires_at, @source, @evidence, @error_category,
  @retryable, @retry_after_ms, @latency_ms, @correlation_id, @event_id
)
ON CONFLICT(provider, account_scope, scope, subject_type, subject_key, kind) DO UPDATE SET
  info_hash = EXCLUDED.info_hash,
  file_index = EXCLUDED.file_index,
  file_index_key = EXCLUDED.file_index_key,
  state = EXCLUDED.state,
  observed_at = EXCLUDED.observed_at,
  expires_at = EXCLUDED.expires_at,
  source = EXCLUDED.source,
  evidence = EXCLUDED.evidence,
  error_category = EXCLUDED.error_category,
  retryable = EXCLUDED.retryable,
  retry_after_ms = EXCLUDED.retry_after_ms,
  latency_ms = EXCLUDED.latency_ms,
  correlation_id = EXCLUDED.correlation_id,
  event_id = EXCLUDED.event_id
WHERE EXCLUDED.observed_at >= provider_observation_current.observed_at;
`;

const INSERT_MEDIA_ASSOCIATION = `
INSERT INTO candidate_media (
  info_hash, file_index_key, media_id, source, confidence, evidence, associated_at,
  resolver_source, resolver_version, match_method, resolution_state
) VALUES (
  @info_hash, @file_index_key, @media_id, @source, @confidence, @evidence, @associated_at,
  @resolver_source, @resolver_version, @match_method, @resolution_state
)
ON CONFLICT(info_hash, file_index_key, media_id) DO UPDATE SET
  source = EXCLUDED.source,
  confidence = EXCLUDED.confidence,
  evidence = EXCLUDED.evidence,
  associated_at = EXCLUDED.associated_at,
  resolver_source = EXCLUDED.resolver_source,
  resolver_version = EXCLUDED.resolver_version,
  match_method = EXCLUDED.match_method,
  resolution_state = EXCLUDED.resolution_state;
`;

const UPSERT_MEDIA_ASSOCIATION = `
INSERT INTO candidate_media (
  info_hash, file_index_key, media_id, source, confidence, evidence, associated_at,
  resolver_source, resolver_version, match_method, resolution_state
) VALUES (
  @info_hash, @file_index_key, @media_id, @source, @confidence, @evidence, @associated_at,
  @resolver_source, @resolver_version, @match_method, @resolution_state
)
ON CONFLICT(info_hash, file_index_key, media_id) DO UPDATE SET
  source = EXCLUDED.source,
  confidence = EXCLUDED.confidence,
  evidence = COALESCE(EXCLUDED.evidence, candidate_media.evidence),
  associated_at = EXCLUDED.associated_at,
  resolver_source = EXCLUDED.resolver_source,
  resolver_version = EXCLUDED.resolver_version,
  match_method = EXCLUDED.match_method,
  resolution_state = EXCLUDED.resolution_state;
`;

const GET_MEDIA_ASSOCIATIONS = `
SELECT media_id, source, confidence, evidence, associated_at,
       resolver_source, resolver_version, match_method, resolution_state
FROM candidate_media
WHERE info_hash = @info_hash AND file_index_key = @file_index_key;
`;

const GET_CANDIDATES_BY_MEDIA = `
SELECT c.*
FROM candidate_media cm
JOIN candidates c ON c.info_hash = cm.info_hash AND c.file_index_key = cm.file_index_key
WHERE cm.media_id = @media_id;
`;

const INSERT_RELEASE_ATTRIBUTES = `
INSERT INTO release_attributes (
  info_hash, file_index, file_index_key, source, filename, confidence,
  title, year, media_type, season, episode, episode_range, resolution, source_type,
  codec, hdr, audio, language, release_group, evidence, parsed_at
) VALUES (
  @info_hash, @file_index, @file_index_key, @source, @filename, @confidence,
  @title, @year, @media_type, @season, @episode, @episode_range, @resolution, @source_type,
  @codec, @hdr, @audio, @language, @release_group, @evidence, @parsed_at
)
ON CONFLICT(info_hash, file_index_key, source) DO UPDATE SET
  filename = EXCLUDED.filename,
  confidence = EXCLUDED.confidence,
  title = EXCLUDED.title,
  year = EXCLUDED.year,
  media_type = EXCLUDED.media_type,
  season = EXCLUDED.season,
  episode = EXCLUDED.episode,
  episode_range = EXCLUDED.episode_range,
  resolution = EXCLUDED.resolution,
  source_type = EXCLUDED.source_type,
  codec = EXCLUDED.codec,
  hdr = EXCLUDED.hdr,
  audio = EXCLUDED.audio,
  language = EXCLUDED.language,
  release_group = EXCLUDED.release_group,
  evidence = EXCLUDED.evidence,
  parsed_at = EXCLUDED.parsed_at;
`;

const GET_RELEASE_ATTRIBUTES = `
SELECT * FROM release_attributes
WHERE info_hash = @info_hash AND file_index_key = @file_index_key
ORDER BY confidence DESC;
`;

const GET_RELEASE_ATTRIBUTES_BY_SOURCE = `
SELECT * FROM release_attributes
WHERE info_hash = @info_hash AND file_index_key = @file_index_key AND source = @source;
`;

const GET_CANDIDATES_WITHOUT_ATTRIBUTES = `
SELECT c.*
FROM candidates c
LEFT JOIN release_attributes ra ON c.info_hash = ra.info_hash AND c.file_index_key = ra.file_index_key
WHERE ra.info_hash IS NULL;
`;

const LEGACY_OBSERVATION_MIGRATION = 'provider-observations-v2';
const MEDIA_REQUEST_ELIGIBILITY_COLUMNS = 'media-request-eligibility-columns';
const MEDIA_INTENTS_SCHEMA = 'media-intents-v1';
// Slice 1.75: preserve raw selected-file size from behaviorHints.videoSize so
// downstream control-plane identity binding can match the exact TorBox file
// before a playback handoff becomes authoritative. Integer byte count; null
// when no exact size is observable (corpus-only or selected without a known
// per-file size).
const SELECTED_FILE_SIZE_COLUMN = 'media-request-results-selected-file-size';
// Slice 1.75: nullable playback_handoffs.torrent_file_id. Carried into the
// durable handoff after ensureTorBoxFileIdentity binds a candidate to an
// exact TorBox file. Lives in control-plane.db; no SQL FK.
const PLAYBACK_HANDOFF_TORRENT_FILE_COLUMN = 'playback-handoffs-torrent-file-id';
// Slice 2: nullable cross-database pointer on durable VFS rows. Legacy rows
// remain NULL. The corresponding TorrentFile is validated in application code.
const VFS_TORRENT_FILE_COLUMN = 'vfs-entries-torrent-file-id';

function migrateLegacyProviderObservations(db) {
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(LEGACY_OBSERVATION_MIGRATION);
  if (applied) return;

  const rows = db.prepare('SELECT * FROM provider_observations ORDER BY checked_at, rowid').all();
  db.exec('BEGIN IMMEDIATE');
  try {
    const insertEvent = db.prepare(INSERT_OBSERVATION_EVENT);
    const upsertCurrent = db.prepare(UPSERT_CURRENT_OBSERVATION);
    for (const row of rows) {
      const fileIndex = row.file_index ?? null;
      const state = row.cached === 1 ? 'cached' : row.cached === 0 ? 'uncached' : 'unknown';
      const params = {
        provider: String(row.provider).toLowerCase(),
        account_scope: 'default',
        scope: fileIndex == null ? 'torrent' : 'candidate',
        subject_type: fileIndex == null ? 'torrent' : 'candidate',
        subject_key: fileIndex == null ? row.info_hash : `${row.info_hash}:${fileIndex}`,
        info_hash: row.info_hash,
        file_index: fileIndex,
        file_index_key: row.file_index_key,
        kind: 'authoritative',
        state,
        observed_at: row.checked_at,
        expires_at: null,
        source: 'legacy-observation-migration',
        evidence: row.evidence,
        error_category: null,
        retryable: null,
        retry_after_ms: null,
        latency_ms: null,
        correlation_id: null,
        recorded_at: Date.now(),
      };
      const event = insertEvent.get(params);
      const { recorded_at: _recordedAt, ...currentParams } = params;
      upsertCurrent.run({ ...currentParams, event_id: event.id });
    }
    db.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    ).run(LEGACY_OBSERVATION_MIGRATION, Date.now());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateMediaRequestEligibilityColumns(db) {
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(MEDIA_REQUEST_ELIGIBILITY_COLUMNS);
  if (applied) return;

  // Check if columns already exist (from CREATE TABLE)
  const tableInfo = db.prepare('PRAGMA table_info(media_request_results)').all();
  const hasEligible = tableInfo.some(col => col.name === 'eligible');

  if (!hasEligible) {
    // Add eligibility columns to existing media_request_results tables
    db.exec('ALTER TABLE media_request_results ADD COLUMN eligible INTEGER');
    db.exec('ALTER TABLE media_request_results ADD COLUMN ineligible_reason TEXT');
    db.exec('ALTER TABLE media_request_results ADD COLUMN ineligible_code TEXT');
    db.exec('ALTER TABLE media_request_results ADD COLUMN expected_media_scope TEXT');
    db.exec('ALTER TABLE media_request_results ADD COLUMN parsed_candidate_scope TEXT');
  }

  db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  ).run(MEDIA_REQUEST_ELIGIBILITY_COLUMNS, Date.now());
}

function migrateMediaIntents(db) {
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(MEDIA_INTENTS_SCHEMA);
  if (applied) return;

  // Note: the media_intents table is created by SCHEMA. The identity bundle
  // columns (imdb_id, tmdb_id, tvdb_id) on a pre-SCHEMA database are
  // added by ensureMediaIntentIdentityColumns before SCHEMA runs.
  // SCHEMA itself does not cover the processing columns below, so
  // they are added here for legacy databases that pre-date the
  // processing-state additions.
  const intentInfo = db.prepare('PRAGMA table_info(media_intents)').all();
  const hasLastProcessedAt = intentInfo.some(col => col.name === 'last_processed_at');
  if (!hasLastProcessedAt) {
    db.exec('ALTER TABLE media_intents ADD COLUMN last_processed_at INTEGER');
  }
  const hasLastResultCount = intentInfo.some(col => col.name === 'last_result_count');
  if (!hasLastResultCount) {
    db.exec('ALTER TABLE media_intents ADD COLUMN last_result_count INTEGER');
  }
  const hasLastError = intentInfo.some(col => col.name === 'last_error');
  if (!hasLastError) {
    db.exec('ALTER TABLE media_intents ADD COLUMN last_error TEXT');
  }

  // Add intent_id column to media_requests if missing
  const reqInfo = db.prepare('PRAGMA table_info(media_requests)').all();
  const hasIntentId = reqInfo.some(col => col.name === 'intent_id');
  if (!hasIntentId) {
    db.exec('ALTER TABLE media_requests ADD COLUMN intent_id INTEGER');
  }

  // Add source column to media_requests if missing
  const hasSource = reqInfo.some(col => col.name === 'source');
  if (!hasSource) {
    db.exec("ALTER TABLE media_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'api'");
  }

  // Add source_type column to media_requests if missing
  const hasSourceType = reqInfo.some(col => col.name === 'source_type');
  if (!hasSourceType) {
    db.exec('ALTER TABLE media_requests ADD COLUMN source_type TEXT');
  }

  // Add intent_id column to media_request_results if missing
  const resInfo = db.prepare('PRAGMA table_info(media_request_results)').all();
  const hasResultIntentId = resInfo.some(col => col.name === 'intent_id');
  if (!hasResultIntentId) {
    db.exec('ALTER TABLE media_request_results ADD COLUMN intent_id INTEGER');
  }

  db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  ).run(MEDIA_INTENTS_SCHEMA, Date.now());
}

// Slice 1.75: nullable column for the RAW byte size from
// behaviorHints.videoSize on the selected candidate. Survives selection so
// the pre-publication identity helper can match provider files by exact size.
// Corpus rows that pre-date this migration keep NULL — legacy behavior.
function migrateMediaRequestResultsSelectedFileSize(db) {
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(SELECTED_FILE_SIZE_COLUMN);
  if (applied) return;
  const info = db.prepare('PRAGMA table_info(media_request_results)').all();
  if (!info.some((col) => col.name === 'selected_file_size')) {
    db.exec('ALTER TABLE media_request_results ADD COLUMN selected_file_size INTEGER');
  }
  db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  ).run(SELECTED_FILE_SIZE_COLUMN, Date.now());
}

// Slice 1.75: nullable playback_handoffs.torrent_file_id. NULL on legacy
// handoffs and on candidates without an exact selected-file size. The
// controlPlaneStore is the source of truth; this column is a soft pointer.
function migratePlaybackHandoffsTorrentFileId(db) {
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(PLAYBACK_HANDOFF_TORRENT_FILE_COLUMN);
  if (applied) return;
  const info = db.prepare('PRAGMA table_info(playback_handoffs)').all();
  if (!info.some((col) => col.name === 'torrent_file_id')) {
    db.exec('ALTER TABLE playback_handoffs ADD COLUMN torrent_file_id TEXT');
  }
  db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  ).run(PLAYBACK_HANDOFF_TORRENT_FILE_COLUMN, Date.now());
}

function migrateVfsTorrentFileId(db) {
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(VFS_TORRENT_FILE_COLUMN);
  if (!applied) {
    for (const table of ['vfs_movie_entries', 'vfs_tv_entries']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some((column) => column.name === 'torrent_file_id')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN torrent_file_id TEXT`);
      }
    }
    db.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    ).run(VFS_TORRENT_FILE_COLUMN, Date.now());
  }

  // release_key is legacy candidate metadata, not physical-file identity.
  // Its old unique indexes block season-pack episodes that legitimately share
  // a release key while pointing at different TorrentFiles.
  db.exec('DROP INDEX IF EXISTS idx_vfs_movie_entries_release');
  db.exec('DROP INDEX IF EXISTS idx_vfs_tv_entries_release');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vfs_movie_entries_torrent_file
    ON vfs_movie_entries(torrent_file_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vfs_tv_entries_torrent_file
    ON vfs_tv_entries(torrent_file_id)
  `);
}

// Demand priority constants for queue promotion
// Background corpus work: ~10, explicit request: ~100, selected release: ~200
export const DEMAND_PRIORITY = Object.freeze({
  BACKGROUND: 10,      // Normal DMM corpus seeding
  MEDIA_INTENT: 50,    // Normalized media intent (when mappable to hashes)
  EXPLICIT_REQUEST: 100, // Explicit /api/media-request
  SELECTED_RELEASE: 200, // User selected this specific release
});

// Default max age for cache probe refresh eligibility.
// When a hash's latest authoritative TorBox observation is older than this,
// it becomes eligible for re-probing. Aligned with provider observation
// freshness semantics (expiresAt-based) — not a separate TTL architecture.
export const CACHE_PROBE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const IDENTITY_ENRICHMENT_QUEUE_PRIORITY = 'identity-enrichment-queue-priority-v1';

function migrateIdentityEnrichmentQueuePriority(db) {
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(IDENTITY_ENRICHMENT_QUEUE_PRIORITY);
  if (applied) return;

  // Check if identity_enrichment_queue table exists and has priority column
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='identity_enrichment_queue'"
  ).get();

  if (tableExists) {
    const cols = db.prepare('PRAGMA table_info(identity_enrichment_queue)').all();
    const hasPriority = cols.some(col => col.name === 'priority');
    if (!hasPriority) {
      db.exec('ALTER TABLE identity_enrichment_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
    }
  }

  db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  ).run(IDENTITY_ENRICHMENT_QUEUE_PRIORITY, Date.now());
}

/**
 * Add nullable identity bundle columns (imdb_id, tmdb_id, tvdb_id) to a
 * pre-existing media_intents table BEFORE the main SCHEMA runs. The SCHEMA
 * contains `CREATE INDEX` statements that reference these columns; if the
 * table was created by an older HashSucker version without the columns,
 * those indexes would fail without this pre-migration.
 *
 * No-op on fresh databases (table does not yet exist) — the main SCHEMA
 * creates the table with the columns in that case.
 */
function ensureMediaIntentIdentityColumns(db) {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_intents'"
  ).get();
  if (!tableExists) return; // main SCHEMA will create with columns

  const cols = db.prepare('PRAGMA table_info(media_intents)').all();
  const addIfMissing = (name) => {
    if (!cols.some(col => col.name === name)) {
      db.exec(`ALTER TABLE media_intents ADD COLUMN ${name} TEXT`);
    }
  };
  addIfMissing('imdb_id');
  addIfMissing('tmdb_id');
  addIfMissing('tvdb_id');
}

const CACHE_PROBE_QUEUE_SCHEMA = 'cache-probe-queue-v1';

function migrateCacheProbeQueue(db) {
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(CACHE_PROBE_QUEUE_SCHEMA);
  if (applied) return;

  // Table is created via SCHEMA constant; migration tracks application.
  db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  ).run(CACHE_PROBE_QUEUE_SCHEMA, Date.now());
}

export function createDiscoveryCache({ dbPath = ':memory:', database = null } = {}) {
  const db = database || new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  // Ensure schema_migrations exists BEFORE any migration queries it
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  // Run migrations that need to alter tables before SCHEMA is applied
  migrateIdentityEnrichmentQueuePriority(db);
  ensureMediaIntentIdentityColumns(db);

  db.exec(SCHEMA);

  migrateLegacyProviderObservations(db);
  migrateMediaRequestEligibilityColumns(db);
  migrateMediaIntents(db);
  migrateMediaRequestResultsSelectedFileSize(db);
  migratePlaybackHandoffsTorrentFileId(db);
  migrateVfsTorrentFileId(db);
  // Slice 1.75: the torrent_file_id index can only be created once the
  // column is present. For legacy prod databases, the column is added by
  // migratePlaybackHandoffsTorrentFileId above. For fresh installs the
  // column is part of the SCHEMA CREATE TABLE.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_playback_handoffs_torrent_file '
    + 'ON playback_handoffs(torrent_file_id)'
  );
  migrateCacheProbeQueue(db);

  const insertCandidateStmt = db.prepare(INSERT_CANDIDATE);
  const getCandidateStmt = db.prepare(GET_CANDIDATE);
  const insertObservationEventStmt = db.prepare(INSERT_OBSERVATION_EVENT);
  const upsertCurrentObservationStmt = db.prepare(UPSERT_CURRENT_OBSERVATION);
  const getCurrentObservationsStmt = db.prepare(GET_CURRENT_OBSERVATIONS);
  const getObservationHistoryStmt = db.prepare(GET_OBSERVATION_HISTORY);
  const selectAllCandidatesStmt = db.prepare(SELECT_ALL_CANDIDATES);
  const selectCandidatesByKeyStmt = db.prepare(SELECT_CANDIDATES_BY_KEY);
  const insertMediaAssocStmt = db.prepare(INSERT_MEDIA_ASSOCIATION);
  const upsertMediaAssocStmt = db.prepare(UPSERT_MEDIA_ASSOCIATION);
  const getMediaAssocStmt = db.prepare(GET_MEDIA_ASSOCIATIONS);
  const getCandidatesByMediaStmt = db.prepare(GET_CANDIDATES_BY_MEDIA);
  const insertReleaseAttributesStmt = db.prepare(INSERT_RELEASE_ATTRIBUTES);
  const getReleaseAttributesStmt = db.prepare(GET_RELEASE_ATTRIBUTES);
  const getReleaseAttributesBySourceStmt = db.prepare(GET_RELEASE_ATTRIBUTES_BY_SOURCE);
  const getCandidatesWithoutAttributesStmt = db.prepare(GET_CANDIDATES_WITHOUT_ATTRIBUTES);


  function fileIndexKey(fileIndex) {
    return fileIndex == null ? -1 : fileIndex;
  }

  function normalizeCandidate(candidate) {
    const now = Date.now();
    return {
      info_hash: candidate.infoHash,
      file_index: candidate.fileIndex ?? null,
      file_index_key: fileIndexKey(candidate.fileIndex),
      search_key: candidate.searchKey ?? null,
      title: candidate.title ?? null,
      filename: candidate.filename ?? null,
      size: candidate.size ?? null,
      seeders: candidate.seeders ?? null,
      leechers: candidate.leechers ?? null,
      publish_date: candidate.publishDate ?? null,
      magnet: candidate.magnet ?? null,
      download_url: candidate.downloadUrl ?? null,
      metadata: JSON.stringify(candidate.metadata ?? {}),
      sources: JSON.stringify(candidate.sources ?? []),
      first_seen: candidate.firstSeen ?? now,
      last_seen: candidate.lastSeen ?? now,
    };
  }

  function rowToCandidate(row) {
    if (!row) return null;
    return {
      infoHash: row.info_hash,
      fileIndex: row.file_index,
      searchKey: row.search_key,
      title: row.title,
      filename: row.filename,
      size: row.size,
      seeders: row.seeders,
      leechers: row.leechers,
      publishDate: row.publish_date,
      magnet: row.magnet,
      downloadUrl: row.download_url,
      metadata: JSON.parse(row.metadata || '{}'),
      sources: JSON.parse(row.sources || '[]'),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    };
  }

  function rowToObservation(row, now = Date.now()) {
    const observation = {
      id: row.id ?? row.event_id,
      provider: row.provider,
      accountScope: row.account_scope,
      scope: row.scope,
      subjectType: row.subject_type,
      subjectKey: row.subject_key,
      infoHash: row.info_hash,
      fileIndex: row.file_index,
      kind: row.kind,
      state: row.state,
      cached: toLegacyCachedState(row.state),
      observedAt: row.observed_at,
      checkedAt: row.observed_at,
      expiresAt: row.expires_at,
      source: row.source,
      evidence: row.evidence ? JSON.parse(row.evidence) : null,
      errorCategory: row.error_category,
      retryable: row.retryable == null ? null : row.retryable === 1,
      retryAfterMs: row.retry_after_ms,
      latencyMs: row.latency_ms,
      correlationId: row.correlation_id,
    };
    return { ...observation, ...evaluateObservationFreshness(observation, { now }) };
  }

  function observationParams(observation, recordedAt = Date.now()) {
    return {
      provider: observation.provider,
      account_scope: observation.accountScope,
      scope: observation.scope,
      subject_type: observation.subjectType,
      subject_key: observation.subjectKey,
      info_hash: observation.infoHash,
      file_index: observation.fileIndex,
      file_index_key: fileIndexKey(observation.fileIndex),
      kind: observation.kind,
      state: observation.state,
      observed_at: observation.observedAt,
      expires_at: observation.expiresAt,
      source: observation.source,
      evidence: observation.evidence == null ? null : JSON.stringify(observation.evidence),
      error_category: observation.errorCategory,
      retryable: observation.retryable == null ? null : Number(observation.retryable),
      retry_after_ms: observation.retryAfterMs,
      latency_ms: observation.latencyMs,
      correlation_id: observation.correlationId,
      recorded_at: recordedAt,
    };
  }

  /**
   * Upsert a candidate. On identity conflict:
   * - Preserves earliest firstSeen, updates lastSeen
   * - Scalar fields: incoming non-null values fill existing nulls (don't overwrite)
   * - sources: set-union by source key
   * - metadata: shallow merge, incoming keys fill existing missing keys
   */
  function upsertCandidate(candidate) {
    const existing = getCandidate(candidate.infoHash, candidate.fileIndex);
    const merged = mergeCandidateIntoCache(existing, candidate);
    const params = normalizeCandidate(merged);
    insertCandidateStmt.run(params);
    return getCandidate(candidate.infoHash, candidate.fileIndex);
  }

  function getCandidate(infoHash, fileIndex) {
    const row = getCandidateStmt.get({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return rowToCandidate(row);
  }

  /**
   * Append a normalized provider observation and update its current projection.
   * Older events remain in history but cannot replace newer current truth.
   */
  function appendProviderObservation(input) {
    const observation = createCacheObservation(input);
    const params = observationParams(observation);

    db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = insertObservationEventStmt.get(params);
      const { recorded_at: _recordedAt, ...currentParams } = params;
      upsertCurrentObservationStmt.run({ ...currentParams, event_id: inserted.id });
      db.exec('COMMIT');
      return { ...observation, id: inserted.id };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Compatibility boundary for exact-candidate callers. New callers should
   * prefer appendProviderObservation() so scope/kind/freshness are explicit.
   */
  function recordProviderObservation(infoHash, fileIndex, provider, observation) {
    return appendProviderObservation(
      legacyObservationInput(infoHash, fileIndex, provider, observation),
    );
  }

  function getProviderObservations(infoHash, fileIndex, options = {}) {
    const now = options.now ?? Date.now();
    const includeStale = options.includeStale ?? true;
    const kinds = options.kinds == null ? null : new Set(options.kinds);
    const rows = getCurrentObservationsStmt.all({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return rows
      .map((row) => rowToObservation(row, now))
      .filter((observation) => includeStale || observation.freshness !== 'stale')
      .filter((observation) => kinds == null || kinds.has(observation.kind));
  }

  function getProviderObservationHistory(infoHash, fileIndex, options = {}) {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('Observation history limit must be between 1 and 1000');
    }
    const rows = getObservationHistoryStmt.all({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
      provider: options.provider ?? null,
      account_scope: options.accountScope ?? null,
      kind: options.kind ?? null,
      limit,
    });
    const now = options.now ?? Date.now();
    return rows.map((row) => rowToObservation(row, now));
  }

  /**
   * Check whether a hash has a fresh authoritative TorBox observation.
   * Uses the provider observation freshness semantics (expiresAt-based).
   *
   * @param {string} infoHash - Info hash
   * @param {number|null} fileIndex - File index or null
   * @param {number} [maxAgeMs] - Max age in ms (default: CACHE_PROBE_MAX_AGE_MS)
   * @returns {boolean} True if fresh authoritative TorBox observation exists
   */
  function hasFreshTorBoxObservation(infoHash, fileIndex, maxAgeMs = CACHE_PROBE_MAX_AGE_MS) {
    const now = Date.now();
    const observations = getProviderObservations(infoHash, fileIndex, {
      includeStale: true,
      kinds: ['authoritative'],
    });
    const torboxObs = observations.find(o => o.provider === 'torbox');
    if (!torboxObs) return false;
    // Use freshness evaluation (expiresAt-based)
    const freshness = evaluateObservationFreshness(torboxObs, { now });
    if (freshness.freshness === 'unbounded') {
      // No expiry: treat as fresh only if within maxAgeMs of observedAt
      return freshness.ageMs < maxAgeMs;
    }
    return freshness.fresh;
  }

  /**
   * Query cached candidates with optional filtering and observation attachment.
   *
   * Options:
   * - searchKey: filter candidates by search key (exact match)
   * - predicate(candidate): filter function applied to each candidate
   * - maxAgeMs: exclude candidates older than this many milliseconds
   * - withObservations: attach provider observations to each candidate
   *
   * Returns an array of candidates (never throws).
   */
  function queryCachedCandidates(options = {}) {
    const { searchKey, predicate, maxAgeMs, withObservations } = options;
    const rows = searchKey != null
      ? selectCandidatesByKeyStmt.all({ search_key: searchKey })
      : selectAllCandidatesStmt.all();
    let candidates = rows.map(rowToCandidate);

    if (maxAgeMs != null) {
      const cutoff = Date.now() - maxAgeMs;
      candidates = candidates.filter((c) => c.lastSeen >= cutoff);
    }

    if (predicate) {
      candidates = candidates.filter(predicate);
    }

    if (withObservations) {
      for (const candidate of candidates) {
        candidate.observations = getProviderObservations(candidate.infoHash, candidate.fileIndex);
      }
    }

    return candidates;
  }

  /**
   * Write-through batch ingest: upsert candidate + merge sources from a
   * discovery result. Returns the merged candidate. Never throws — cache
   * errors are caught and returned as part of the result so callers can
   * decide whether to log.
   */
  function ingestCandidate(candidate) {
    try {
      const existing = getCandidate(candidate.infoHash, candidate.fileIndex);
      const merged = mergeCandidateIntoCache(existing, candidate);
      return { candidate: upsertCandidate(merged), error: null };
    } catch (error) {
      return { candidate: null, error };
    }
  }

  function mergeCandidateIntoCache(existing, incoming) {
    if (!existing) {
      const now = Date.now();
      return { ...incoming, firstSeen: incoming.firstSeen ?? now, lastSeen: incoming.lastSeen ?? now };
    }
    return {
      ...existing,
      ...(incoming.title ? { title: incoming.title } : {}),
      ...(incoming.filename ? { filename: incoming.filename } : {}),
      ...(incoming.size != null ? { size: incoming.size } : {}),
      ...(incoming.seeders != null ? { seeders: incoming.seeders } : {}),
      ...(incoming.leechers != null ? { leechers: incoming.leechers } : {}),
      ...(incoming.publishDate ? { publishDate: incoming.publishDate } : {}),
      ...(incoming.magnet ? { magnet: incoming.magnet } : {}),
      ...(incoming.downloadUrl ? { downloadUrl: incoming.downloadUrl } : {}),
      metadata: mergeMetadata(existing.metadata, incoming.metadata),
      sources: mergeSources(existing.sources, incoming.sources),
      lastSeen: Date.now(),
    };
  }

  function mergeMetadata(existing = {}, incoming = {}) {
    if (!incoming || Object.keys(incoming).length === 0) return existing;
    if (!existing || Object.keys(existing).length === 0) return incoming;
    const merged = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      if (merged[key] == null && value != null) {
        merged[key] = value;
      }
    }
    return merged;
  }

  function mergeSources(existing = [], incoming = []) {
    const seen = new Set(existing.map((s) => sourceKey(s)));
    const merged = [...existing];
    for (const source of incoming) {
      const key = sourceKey(source);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(source);
      }
    }
    return merged;
  }

  function sourceKey(source) {
    if (!source) return '';
    return [source.id, source.kind, source.instance, source.indexer, source.capability].join('|');
  }

  /**
   * Associate a candidate with a media identifier.
   * Multiple media identifiers can be associated with the same candidate.
   * Idempotent — re-associating the same (candidate, media) pair updates metadata.
   */
  function associateMedia(infoHash, fileIndex, mediaId, options = {}) {
    const evidenceJson = options.evidence != null ? JSON.stringify(options.evidence) : null;
    insertMediaAssocStmt.run({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
      media_id: mediaId,
      source: options.source || 'search',
      confidence: options.confidence != null ? options.confidence : 1.0,
      evidence: evidenceJson,
      associated_at: options.associatedAt ?? Date.now(),
      resolver_source: options.resolverSource ?? null,
      resolver_version: options.resolverVersion ?? null,
      match_method: options.matchMethod ?? null,
      resolution_state: options.resolutionState ?? 'unresolved',
    });
  }

  function upsertMediaAssociation(infoHash, fileIndex, mediaId, options = {}) {
    const evidenceJson = options.evidence != null ? JSON.stringify(options.evidence) : null;
    upsertMediaAssocStmt.run({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
      media_id: mediaId,
      source: options.source || 'search',
      confidence: options.confidence != null ? options.confidence : 1.0,
      evidence: evidenceJson,
      associated_at: options.associatedAt ?? Date.now(),
      resolver_source: options.resolverSource ?? null,
      resolver_version: options.resolverVersion ?? null,
      match_method: options.matchMethod ?? null,
      resolution_state: options.resolutionState ?? 'unresolved',
    });
  }

  /**
   * Get all media associations for a candidate.
   * Returns empty array if candidate has no associations.
   */
  function getMediaAssociations(infoHash, fileIndex) {
    const rows = getMediaAssocStmt.all({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return rows.map((row) => ({
      mediaId: row.media_id,
      source: row.source,
      confidence: row.confidence,
      evidence: row.evidence ? JSON.parse(row.evidence) : null,
      associatedAt: row.associated_at,
      resolverSource: row.resolver_source,
      resolverVersion: row.resolver_version,
      matchMethod: row.match_method,
      resolutionState: row.resolution_state || 'unresolved',
    }));
  }

  /**
   * Query candidates by media identifier.
   * Joins candidate_media with candidates to return full candidate data.
   */
  function queryCandidatesByMedia(mediaId) {
    const rows = getCandidatesByMediaStmt.all({ media_id: mediaId });
    return rows.map(rowToCandidate);
  }

  /**
   * Store release attributes for a candidate from a specific parser source.
   * Uses UPSERT — if same (candidate, source) exists, overwrites if confidence is higher.
   * This is the internal write path used by release-attributes.js.
   *
   * @param {Object} attrs - Normalized release attributes
   */
  function _insertReleaseAttributes(attrs) {
    insertReleaseAttributesStmt.run({
      info_hash: attrs.infoHash,
      file_index: attrs.fileIndex ?? null,
      file_index_key: fileIndexKey(attrs.fileIndex),
      source: attrs.source,
      filename: attrs.filename,
      confidence: attrs.confidence,
      title: attrs.title ?? null,
      year: attrs.year ?? null,
      media_type: attrs.mediaType ?? null,
      season: attrs.season ?? null,
      episode: attrs.episode ?? null,
      episode_range: attrs.episodeRange ?? null,
      resolution: attrs.resolution ?? null,
      source_type: attrs.sourceType ?? null,
      codec: attrs.codec ?? null,
      hdr: attrs.hdr === true ? 1 : 0,
      audio: attrs.audio ?? null,
      language: attrs.language ?? null,
      release_group: attrs.releaseGroup ?? null,
      evidence: attrs.evidence != null ? JSON.stringify(attrs.evidence) : null,
      parsed_at: attrs.parsedAt,
    });
  }

  function rowToReleaseAttributes(row) {
    if (!row) return null;
    return {
      infoHash: row.info_hash,
      fileIndex: row.file_index,
      source: row.source,
      filename: row.filename,
      confidence: row.confidence,
      title: row.title,
      year: row.year,
      mediaType: row.media_type,
      season: row.season,
      episode: row.episode,
      episodeRange: row.episode_range,
      resolution: row.resolution,
      sourceType: row.source_type,
      codec: row.codec,
      hdr: row.hdr === 1,
      audio: row.audio,
      language: row.language,
      releaseGroup: row.release_group,
      evidence: row.evidence ? JSON.parse(row.evidence) : null,
      parsedAt: row.parsed_at,
    };
  }

  /**
   * Get release attributes for a candidate.
   * If source is provided, returns attributes from that source only.
   * If source is null, returns attributes from all sources (sorted by confidence desc).
   *
   * @param {string} infoHash - Candidate infoHash
   * @param {number|null} fileIndex - Candidate fileIndex
   * @param {string} [source] - Optional source filter
   * @returns {Array<Object>} Release attributes
   */
  function getReleaseAttributes(infoHash, fileIndex = null, source = null) {
    if (source != null) {
      const row = getReleaseAttributesBySourceStmt.get({
        info_hash: infoHash,
        file_index_key: fileIndexKey(fileIndex),
        source,
      });
      return row ? [rowToReleaseAttributes(row)] : [];
    }
    const rows = getReleaseAttributesStmt.all({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return rows.map(rowToReleaseAttributes);
  }

  /**
   * Get candidates that have no release attributes.
   * Useful for finding candidates that need filename parsing.
   *
   * @returns {Array<Object>} Candidates without release attributes
   */
  function getCandidatesWithoutReleaseAttributes() {
    const rows = getCandidatesWithoutAttributesStmt.all();
    return rows.map(rowToCandidate);
  }

  // ---------------------------------------------------------------------------
  // Identity enrichment queue management
  // ---------------------------------------------------------------------------

  const INSERT_ENRICHMENT_QUEUE = `
    INSERT INTO identity_enrichment_queue (info_hash, file_index_key, status, priority, attempts, max_attempts, resolver_source, created_at, updated_at, next_attempt_at)
    VALUES (@info_hash, @file_index_key, 'pending', @priority, 0, @max_attempts, @resolver_source, @now, @now, @now)
    ON CONFLICT(info_hash, file_index_key) DO UPDATE SET
      priority = MAX(priority, @priority),
      updated_at = @now,
      next_attempt_at = @now
    WHERE status IN ('pending', 'failed', 'resolved');
  `;

  const GET_PENDING_ENRICHMENT = `
    SELECT * FROM identity_enrichment_queue
    WHERE status IN ('pending', 'failed')
      AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
      AND attempts < max_attempts
    ORDER BY priority DESC, created_at ASC
    LIMIT @limit;
  `;

  const GET_ENRICHMENT_QUEUE_ITEM = `
    SELECT * FROM identity_enrichment_queue
    WHERE info_hash = @info_hash AND file_index_key = @file_index_key;
  `;

  const UPDATE_ENRICHMENT_STATUS = `
    UPDATE identity_enrichment_queue
    SET status = @status, attempts = @attempts, updated_at = @now,
        next_attempt_at = @next_attempt_at, error_message = @error_message,
        error_category = @error_category, resolver_source = @resolver_source
    WHERE info_hash = @info_hash AND file_index_key = @file_index_key;
  `;

  const GET_ENRICHMENT_STATS = `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM identity_enrichment_queue;
  `;

  // ---------------------------------------------------------------------------
  // Cache probe queue
  // ---------------------------------------------------------------------------

  const INSERT_CACHE_PROBE = `
    INSERT INTO cache_probe_queue (info_hash, priority, reason, status, attempt_count, created_at, updated_at)
    VALUES (@info_hash, @priority, @reason, 'pending', 0, @now, @now);
  `;

  const CHECK_ACTIVE_PROBE = `
    SELECT 1 FROM cache_probe_queue
    WHERE info_hash = @info_hash AND status IN ('pending', 'checking')
    LIMIT 1;
  `;

  const CLAIM_CACHE_PROBES = `
    WITH candidates AS (
      SELECT id
      FROM cache_probe_queue
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT @limit
    )
    UPDATE cache_probe_queue
    SET status = 'checking',
        attempt_count = attempt_count + 1,
        last_attempt = @now,
        updated_at = @now
    WHERE id IN (SELECT id FROM candidates)
    RETURNING *;
  `;

  const COMPLETE_CACHE_PROBE = `
    UPDATE cache_probe_queue
    SET status = 'complete',
        updated_at = @now
    WHERE id = @id AND status = 'checking';
  `;

  const FAIL_CACHE_PROBE = `
    UPDATE cache_probe_queue
    SET status = 'failed',
        updated_at = @now
    WHERE id = @id AND status = 'checking';
  `;

  const GET_CACHE_PROBE_BY_HASH = `
    SELECT * FROM cache_probe_queue
    WHERE info_hash = @info_hash
    ORDER BY created_at DESC
    LIMIT 1;
  `;

  const PROMOTE_CACHE_PROBE = `
    UPDATE cache_probe_queue
    SET priority = MAX(priority, @priority),
        updated_at = @now
    WHERE info_hash = @info_hash
      AND status IN ('pending', 'checking');
  `;

  const GET_CACHE_PROBE_STATS = `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'checking' THEN 1 ELSE 0 END) as checking,
      SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as complete,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM cache_probe_queue;
  `;

  // Aggregate metrics for corpus observability
  const GET_CANDIDATE_MEDIA_COVERAGE = `
    SELECT
      COUNT(DISTINCT c.info_hash || ':' || c.file_index_key) as total_candidates,
      COUNT(DISTINCT CASE WHEN cm.info_hash IS NOT NULL THEN c.info_hash || ':' || c.file_index_key END) as candidates_with_media,
      COUNT(DISTINCT CASE WHEN cm.info_hash IS NOT NULL AND cm.resolver_source IS NOT NULL THEN c.info_hash || ':' || c.file_index_key END) as candidates_with_resolved_media
    FROM candidates c
    LEFT JOIN candidate_media cm ON c.info_hash = cm.info_hash AND c.file_index_key = cm.file_index_key;
  `;

  const GET_RESOLVER_SUCCESS_RATES = `
    SELECT
      COALESCE(resolver_source, 'none') as resolver_source,
      COUNT(*) as total_attempts,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
    FROM identity_enrichment_queue
    GROUP BY resolver_source;
  `;

  const GET_CONFIDENCE_DISTRIBUTION = `
    SELECT
      CASE
        WHEN confidence >= 0.9 THEN 'very_high'
        WHEN confidence >= 0.7 THEN 'high'
        WHEN confidence >= 0.5 THEN 'medium'
        WHEN confidence >= 0.3 THEN 'low'
        ELSE 'very_low'
      END as confidence_bucket,
      COUNT(*) as count
    FROM candidate_media
    WHERE resolver_source IS NOT NULL
    GROUP BY confidence_bucket;
  `;

  const GET_UNRESOLVED_STATS = `
    SELECT
      COUNT(*) as total_unresolved
    FROM identity_enrichment_queue
    WHERE status IN ('pending', 'failed')
      AND attempts < max_attempts;
  `;

  const GET_MATCH_METHOD_DISTRIBUTION = `
    SELECT
      COALESCE(match_method, 'unknown') as match_method,
      COUNT(*) as count
    FROM candidate_media
    WHERE resolver_source IS NOT NULL
    GROUP BY match_method;
  `;

  const GET_RESOLUTION_STATE_DISTRIBUTION = `
    SELECT
      COALESCE(resolution_state, 'unresolved') as resolution_state,
      COUNT(*) as count
    FROM candidate_media
    WHERE resolver_source IS NOT NULL
    GROUP BY resolution_state;
  `;

  // Find candidates without candidate_media associations (unresolved)
  const GET_UNRESOLVED_CANDIDATES = `
    SELECT c.*
    FROM candidates c
    LEFT JOIN candidate_media cm ON c.info_hash = cm.info_hash AND c.file_index_key = cm.file_index_key
    WHERE cm.info_hash IS NULL
    ORDER BY c.first_seen ASC
    LIMIT @limit OFFSET @offset;
  `;

  // Count candidates without candidate_media associations
  const COUNT_UNRESOLVED_CANDIDATES = `
    SELECT COUNT(*) as total
    FROM candidates c
    LEFT JOIN candidate_media cm ON c.info_hash = cm.info_hash AND c.file_index_key = cm.file_index_key
    WHERE cm.info_hash IS NULL;
  `;

  // Check if candidate is already in queue
  const CHECK_CANDIDATE_IN_QUEUE = `
    SELECT 1 FROM identity_enrichment_queue
    WHERE info_hash = @info_hash AND file_index_key = @file_index_key
    LIMIT 1;
  `;

  // Media intents
  const UPSERT_MEDIA_INTENT = `
    INSERT INTO media_intents (media_id, media_type, season, episode, source, source_type, source_id, source_label, status, priority, requested_by, request_count, last_requested_at, created_at)
    VALUES (@media_id, @media_type, @season, @episode, @source, @source_type, @source_id, @source_label, @status, @priority, @requested_by, 1, @now, @now)
    ON CONFLICT(media_id, media_type, source) WHERE season IS @season AND episode IS @episode DO UPDATE SET
      request_count = request_count + 1,
      last_requested_at = @now,
      source_label = COALESCE(@source_label, media_intents.source_label),
      source_type = COALESCE(@source_type, media_intents.source_type),
      source_id = COALESCE(@source_id, media_intents.source_id),
      requested_by = COALESCE(@requested_by, media_intents.requested_by),
      priority = MAX(priority, COALESCE(@priority, 0))
    RETURNING id;
  `;

  const GET_MEDIA_INTENT = `
    SELECT * FROM media_intents WHERE id = @id;
  `;

  const GET_MEDIA_INTENTS_BY_MEDIA_ID = `
    SELECT * FROM media_intents WHERE media_id = @media_id ORDER BY last_requested_at DESC;
  `;

  const GET_MEDIA_INTENTS_BY_SOURCE = `
    SELECT * FROM media_intents WHERE source = @source ORDER BY last_requested_at DESC LIMIT @limit;
  `;

  const GET_RECENT_MEDIA_INTENTS = `
    SELECT * FROM media_intents ORDER BY last_requested_at DESC LIMIT @limit;
  `;

  const UPDATE_MEDIA_INTENT_STATUS = `
    UPDATE media_intents SET status = @status WHERE id = @id;
  `;

  const GET_MEDIA_INTENT_STATS = `
    SELECT
      COUNT(*) as total_intents,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_intents,
      SUM(request_count) as total_requests,
      COUNT(DISTINCT media_id) as unique_media,
      COUNT(DISTINCT source) as unique_sources
    FROM media_intents;
  `;

  // Media request persistence
  function buildInsertMediaRequestSql(intent) {
    const cols = ['media_id', 'media_type', 'season', 'episode', 'status', 'candidate_count', 'created_at'];
    const values = [
      intent.mediaId,
      intent.mediaType || 'movie',
      intent.season || null,
      intent.episode != null ? intent.episode : (intent.episodes?.length ? intent.episodes[0] : null),
      'completed',
      intent.resultsLength || 0,
      intent.now,
    ];
    if (intent.source) { cols.push('source'); values.push(intent.source); }
    if (intent.sourceType) { cols.push('source_type'); values.push(intent.sourceType); }
    if (intent.intentId) { cols.push('intent_id'); values.push(intent.intentId); }
    const placeholders = cols.map(() => '?').join(', ');
    return { sql: `INSERT INTO media_requests (${cols.join(', ')}) VALUES (${placeholders});`, values };
  }

  function buildInsertMediaRequestResultSql(intentId) {
    const cols = [
      'request_id', 'rank', 'info_hash', 'file_index_key', 'filename', 'score',
      'score_breakdown', 'identity_tier', 'identity_confidence', 'identity_evidence',
      'resolution_state', 'release_metadata', 'ranking_breakdown',
      'eligible', 'ineligible_reason', 'ineligible_code', 'expected_media_scope', 'parsed_candidate_scope',
      'selected_file_size'
    ];
    if (intentId) { cols.push('intent_id'); }
    const placeholders = cols.map(() => '?').join(', ');
    const buildValues = (r) => {
      const values = [
        r.requestId,
        r.rank,
        r.infoHash,
        r.fileIndexKey,
        r.filename,
        r.score,
        r.scoreBreakdown,
        r.identityTier,
        r.identityConfidence,
        r.identityEvidence,
        r.resolutionState,
        r.releaseMetadata,
        r.rankingBreakdown,
        r.eligible,
        r.ineligibleReason,
        r.ineligibleCode,
        r.expectedMediaScope,
        r.parsedCandidateScope,
        Number.isSafeInteger(r.selectedFileSize) && r.selectedFileSize > 0
          ? r.selectedFileSize
          : null,
      ];
      if (intentId) { values.push(intentId); }
      return values;
    };
    return { sql: `INSERT INTO media_request_results (${cols.join(', ')}) VALUES (${placeholders});`, buildValues };
  }

  const GET_MEDIA_REQUESTS = `
    SELECT * FROM media_requests ORDER BY created_at DESC;
  `;

  const GET_MEDIA_REQUEST_RESULTS = `
    SELECT * FROM media_request_results WHERE request_id = @request_id ORDER BY rank ASC;
  `;

  const insertEnrichmentQueueStmt = db.prepare(INSERT_ENRICHMENT_QUEUE);
  const getPendingEnrichmentStmt = db.prepare(GET_PENDING_ENRICHMENT);
  const getEnrichmentQueueItemStmt = db.prepare(GET_ENRICHMENT_QUEUE_ITEM);
  const updateEnrichmentStatusStmt = db.prepare(UPDATE_ENRICHMENT_STATUS);
  const getEnrichmentStatsStmt = db.prepare(GET_ENRICHMENT_STATS);
  const insertCacheProbeStmt = db.prepare(INSERT_CACHE_PROBE);
  const checkActiveProbeStmt = db.prepare(CHECK_ACTIVE_PROBE);
  const claimCacheProbesStmt = db.prepare(CLAIM_CACHE_PROBES);
  const completeCacheProbeStmt = db.prepare(COMPLETE_CACHE_PROBE);
  const failCacheProbeStmt = db.prepare(FAIL_CACHE_PROBE);
  const getCacheProbeByHashStmt = db.prepare(GET_CACHE_PROBE_BY_HASH);
  const promoteCacheProbeStmt = db.prepare(PROMOTE_CACHE_PROBE);
  const getCacheProbeStatsStmt = db.prepare(GET_CACHE_PROBE_STATS);
  const getCandidateMediaCoverageStmt = db.prepare(GET_CANDIDATE_MEDIA_COVERAGE);
  const getResolverSuccessRatesStmt = db.prepare(GET_RESOLVER_SUCCESS_RATES);
  const getConfidenceDistributionStmt = db.prepare(GET_CONFIDENCE_DISTRIBUTION);
  const getUnresolvedStatsStmt = db.prepare(GET_UNRESOLVED_STATS);
  const getMatchMethodDistributionStmt = db.prepare(GET_MATCH_METHOD_DISTRIBUTION);
  const getResolutionStateDistributionStmt = db.prepare(GET_RESOLUTION_STATE_DISTRIBUTION);
  const getUnresolvedCandidatesStmt = db.prepare(GET_UNRESOLVED_CANDIDATES);
  const countUnresolvedCandidatesStmt = db.prepare(COUNT_UNRESOLVED_CANDIDATES);
  const checkCandidateInQueueStmt = db.prepare(CHECK_CANDIDATE_IN_QUEUE);
  const getMediaIntentStmt = db.prepare(GET_MEDIA_INTENT);
  const getMediaIntentsByMediaIdStmt = db.prepare(GET_MEDIA_INTENTS_BY_MEDIA_ID);
  const getMediaIntentsBySourceStmt = db.prepare(GET_MEDIA_INTENTS_BY_SOURCE);
  const getRecentMediaIntentsStmt = db.prepare(GET_RECENT_MEDIA_INTENTS);
  const updateMediaIntentStatusStmt = db.prepare(UPDATE_MEDIA_INTENT_STATUS);
  const getMediaIntentStatsStmt = db.prepare(GET_MEDIA_INTENT_STATS);
  const getMediaRequestsStmt = db.prepare(GET_MEDIA_REQUESTS);
  const getMediaRequestResultsStmt = db.prepare(GET_MEDIA_REQUEST_RESULTS);

  // ---------------------------------------------------------------------------
  // Playback handoff persistence
  // ---------------------------------------------------------------------------

  const INSERT_PLAYBACK_HANDOFF = `
    INSERT INTO playback_handoffs (
      request_id, media_id, media_type, season, episode,
      release_key, info_hash, file_index, filename,
      provider, provider_state, identity_tier, resolution_state,
      selection_reason, selected_at, torrent_file_id
    ) VALUES (
      @request_id, @media_id, @media_type, @season, @episode,
      @release_key, @info_hash, @file_index, @filename,
      @provider, @provider_state, @identity_tier, @resolution_state,
      @selection_reason, @selected_at, @torrent_file_id
    );
  `;

  const GET_PLAYBACK_HANDOFF_BY_REQUEST = `
    SELECT * FROM playback_handoffs
    WHERE request_id = @request_id
    ORDER BY created_at DESC
    LIMIT 1;
  `;

  const GET_PLAYBACK_HANDOFF_BY_ID = `
    SELECT * FROM playback_handoffs WHERE id = @id;
  `;

  const GET_PLAYBACK_HANDOFF_BY_MEDIA = `
    SELECT * FROM playback_handoffs
    WHERE media_id = @media_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
  `;

  const insertPlaybackHandoffStmt = db.prepare(INSERT_PLAYBACK_HANDOFF);
  const getPlaybackHandoffByRequestStmt = db.prepare(GET_PLAYBACK_HANDOFF_BY_REQUEST);
  const getPlaybackHandoffByIdStmt = db.prepare(GET_PLAYBACK_HANDOFF_BY_ID);
  const getPlaybackHandoffByMediaStmt = db.prepare(GET_PLAYBACK_HANDOFF_BY_MEDIA);
  const listMoviePlaybackHandoffsStmt = db.prepare(`
    SELECT h.*
    FROM playback_handoffs h
    WHERE h.media_type = 'movie'
      AND (
        h.torrent_file_id IS NOT NULL
        OR h.selected_at < COALESCE((
          SELECT applied_at FROM schema_migrations WHERE name = '${VFS_TORRENT_FILE_COLUMN}'
        ), 0)
      )
      AND h.release_key = h.info_hash || ':' || COALESCE(CAST(h.file_index AS TEXT), 'torrent')
      AND h.id = (
        SELECT latest.id
        FROM playback_handoffs latest
        WHERE latest.media_id = h.media_id
          AND latest.media_type = 'movie'
          AND (
            latest.torrent_file_id IS NOT NULL
            OR latest.selected_at < COALESCE((
              SELECT applied_at FROM schema_migrations WHERE name = '${VFS_TORRENT_FILE_COLUMN}'
            ), 0)
          )
          AND latest.release_key = latest.info_hash || ':' || COALESCE(CAST(latest.file_index AS TEXT), 'torrent')
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      )
    ORDER BY h.media_id
  `);
  const getPlaybackHandoffByReleaseStmt = db.prepare(`
    SELECT * FROM playback_handoffs
    WHERE media_id = @media_id
      AND release_key = @release_key
      AND media_type = 'movie'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  const getVfsMovieEntryStmt = db.prepare(`
    SELECT * FROM vfs_movie_entries WHERE media_id = @media_id
  `);
  const listVfsMovieEntriesStmt = db.prepare(`
    SELECT * FROM vfs_movie_entries ORDER BY canonical_path
  `);
  const insertVfsMovieEntryStmt = db.prepare(`
    INSERT INTO vfs_movie_entries (
      media_id, release_key, info_hash, file_index, canonical_path,
      torrent_file_id, size, created_at, updated_at
    ) VALUES (
      @media_id, @release_key, @info_hash, @file_index, @canonical_path,
      @torrent_file_id, @size, @created_at, @updated_at
    )
  `);
  const updateVfsMovieEntrySizeStmt = db.prepare(`
    UPDATE vfs_movie_entries
    SET size = @size, updated_at = @updated_at
    WHERE media_id = @media_id
      AND release_key = @release_key
      AND size IS NULL
  `);

  function persistPlaybackHandoff(handoff) {
    const info = insertPlaybackHandoffStmt.run({
      request_id: handoff.requestId || null,
      media_id: handoff.mediaId,
      media_type: handoff.mediaType,
      season: handoff.season ?? null,
      episode: handoff.episode ?? null,
      release_key: handoff.releaseKey,
      info_hash: handoff.infoHash,
      file_index: handoff.fileIndex ?? null,
      filename: handoff.filename,
      provider: handoff.provider,
      provider_state: handoff.providerState,
      identity_tier: handoff.identityTier,
      resolution_state: handoff.resolutionState,
      selection_reason: handoff.selectionReason,
      selected_at: handoff.selectedAt,
      // Slice 1.75: durable pointer to the control-plane TorrentFile once
      // ensureTorBoxFileIdentity has bound the selected candidate to an
      // exact TorBox file. NULL on legacy handoffs and on candidates
      // without an observable raw per-file size.
      torrent_file_id: handoff.torrentFileId ?? null,
    });
    return info.lastInsertRowid;
  }

  function getPlaybackHandoffByRequestId(requestId) {
    return getPlaybackHandoffByRequestStmt.get({ request_id: requestId }) || null;
  }

  function getPlaybackHandoffById(id) {
    return getPlaybackHandoffByIdStmt.get({ id });
  }

  function getPlaybackHandoffByMediaId(mediaId) {
    return rowToPlaybackHandoff(getPlaybackHandoffByMediaStmt.get({ media_id: mediaId }));
  }

  function listMoviePlaybackHandoffs() {
    return listMoviePlaybackHandoffsStmt.all().map(rowToPlaybackHandoff);
  }

  function getPlaybackHandoffByReleaseKey(mediaId, releaseKey) {
    return rowToPlaybackHandoff(getPlaybackHandoffByReleaseStmt.get({
      media_id: mediaId,
      release_key: releaseKey,
    }));
  }

  function getVfsMovieEntry(mediaId) {
    return rowToVfsMovieEntry(getVfsMovieEntryStmt.get({ media_id: mediaId }));
  }

  function listVfsMovieEntries() {
    return listVfsMovieEntriesStmt.all().map(rowToVfsMovieEntry);
  }

  function createVfsMovieEntry(entry) {
    insertVfsMovieEntryStmt.run({
      media_id: entry.mediaId,
      release_key: entry.releaseKey,
      info_hash: entry.infoHash,
      file_index: entry.fileIndex ?? null,
      canonical_path: entry.canonicalPath,
      torrent_file_id: entry.torrentFileId ?? null,
      size: entry.size ?? null,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
    });
    return getVfsMovieEntry(entry.mediaId);
  }

  function setVfsMovieEntrySize(mediaId, releaseKey, size, updatedAt) {
    const info = updateVfsMovieEntrySizeStmt.run({
      media_id: mediaId,
      release_key: releaseKey,
      size,
      updated_at: updatedAt,
    });
    return info.changes === 1 ? getVfsMovieEntry(mediaId) : null;
  }

  function rowToVfsMovieEntry(row) {
    if (!row) return null;
    return {
      mediaId: row.media_id,
      releaseKey: row.release_key,
      infoHash: row.info_hash,
      fileIndex: row.file_index,
      canonicalPath: row.canonical_path,
      torrentFileId: row.torrent_file_id,
      size: row.size,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // TV episode VFS repository
  const listTvPlaybackHandoffsStmt = db.prepare(`
    SELECT h.*
    FROM playback_handoffs h
    WHERE h.media_type IN ('series', 'tv')
      AND h.season IS NOT NULL
      AND h.episode IS NOT NULL
      AND (
        h.torrent_file_id IS NOT NULL
        OR h.selected_at < COALESCE((
          SELECT applied_at FROM schema_migrations WHERE name = '${VFS_TORRENT_FILE_COLUMN}'
        ), 0)
      )
      AND h.release_key = h.info_hash || ':' || COALESCE(CAST(h.file_index AS TEXT), 'torrent')
      AND h.id = (
        SELECT latest.id
        FROM playback_handoffs latest
        WHERE latest.media_id = h.media_id
          AND latest.season = h.season
          AND latest.episode = h.episode
          AND latest.media_type IN ('series', 'tv')
          AND (
            latest.torrent_file_id IS NOT NULL
            OR latest.selected_at < COALESCE((
              SELECT applied_at FROM schema_migrations WHERE name = '${VFS_TORRENT_FILE_COLUMN}'
            ), 0)
          )
          AND latest.release_key = latest.info_hash || ':' || COALESCE(CAST(latest.file_index AS TEXT), 'torrent')
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      )
    ORDER BY h.media_id, h.season, h.episode
  `);
  const getTvPlaybackHandoffStmt = db.prepare(`
    SELECT * FROM playback_handoffs
    WHERE media_id = @media_id
      AND season = @season
      AND episode = @episode
      AND media_type IN ('series', 'tv')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  const getVfsTvEntryStmt = db.prepare(`
    SELECT * FROM vfs_tv_entries WHERE media_id = @media_id AND season = @season AND episode = @episode
  `);
  const listVfsTvEntriesStmt = db.prepare(`
    SELECT * FROM vfs_tv_entries ORDER BY canonical_path
  `);
  const insertVfsTvEntryStmt = db.prepare(`
    INSERT INTO vfs_tv_entries (
      media_id, season, episode, release_key, info_hash, file_index,
      canonical_path, torrent_file_id, size, created_at, updated_at
    ) VALUES (
      @media_id, @season, @episode, @release_key, @info_hash, @file_index,
      @canonical_path, @torrent_file_id, @size, @created_at, @updated_at
    )
  `);
  const updateVfsTvEntrySizeStmt = db.prepare(`
    UPDATE vfs_tv_entries
    SET size = @size, updated_at = @updated_at
    WHERE media_id = @media_id
      AND season = @season
      AND episode = @episode
      AND release_key = @release_key
      AND size IS NULL
  `);

  function listTvPlaybackHandoffs() {
    return listTvPlaybackHandoffsStmt.all().map(rowToPlaybackHandoff);
  }

  function getTvPlaybackHandoff(mediaId, season, episode) {
    return rowToPlaybackHandoff(getTvPlaybackHandoffStmt.get({
      media_id: mediaId,
      season,
      episode,
    }));
  }

  function getVfsTvEntry(mediaId, season, episode) {
    return rowToVfsTvEntry(getVfsTvEntryStmt.get({
      media_id: mediaId,
      season,
      episode,
    }));
  }

  function listVfsTvEntries() {
    return listVfsTvEntriesStmt.all().map(rowToVfsTvEntry);
  }

  function createVfsTvEntry(entry) {
    insertVfsTvEntryStmt.run({
      media_id: entry.mediaId,
      season: entry.season,
      episode: entry.episode,
      release_key: entry.releaseKey,
      info_hash: entry.infoHash,
      file_index: entry.fileIndex ?? null,
      canonical_path: entry.canonicalPath,
      torrent_file_id: entry.torrentFileId ?? null,
      size: entry.size ?? null,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
    });
    return getVfsTvEntry(entry.mediaId, entry.season, entry.episode);
  }

  function setVfsTvEntrySize(mediaId, season, episode, releaseKey, size, updatedAt) {
    const info = updateVfsTvEntrySizeStmt.run({
      media_id: mediaId,
      season,
      episode,
      release_key: releaseKey,
      size,
      updated_at: updatedAt,
    });
    return info.changes === 1 ? getVfsTvEntry(mediaId, season, episode) : null;
  }

  function rowToVfsTvEntry(row) {
    if (!row) return null;
    return {
      mediaId: row.media_id,
      season: row.season,
      episode: row.episode,
      releaseKey: row.release_key,
      infoHash: row.info_hash,
      fileIndex: row.file_index,
      canonicalPath: row.canonical_path,
      torrentFileId: row.torrent_file_id,
      size: row.size,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowToPlaybackHandoff(row) {
    if (!row) return null;
    return {
      id: row.id,
      requestId: row.request_id,
      mediaId: row.media_id,
      mediaType: row.media_type,
      season: row.season,
      episode: row.episode,
      releaseKey: row.release_key,
      infoHash: row.info_hash,
      fileIndex: row.file_index,
      filename: row.filename,
      provider: row.provider,
      providerState: row.provider_state,
      identityTier: row.identity_tier,
      resolutionState: row.resolution_state,
      selectionReason: row.selection_reason,
      selectedAt: row.selected_at,
      createdAt: row.created_at,
      // Slice 1.75: durable pointer to the control-plane TorrentFile once
      // ensureTorBoxFileIdentity has bound the selected candidate to an
      // exact TorBox file. NULL on legacy handoffs and on candidates
      // without an observable raw per-file size.
      torrentFileId: row.torrent_file_id ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Media intents persistence functions
  // ---------------------------------------------------------------------------

  function upsertMediaIntent(input) {
    const now = Date.now();

    // Use a transaction to handle the upsert atomically
    db.exec('BEGIN IMMEDIATE');
    try {
      // Check for existing intent with matching NULL handling
      const existing = db.prepare(
        'SELECT id, priority FROM media_intents WHERE media_id = ? AND media_type = ? AND source = ? AND season IS ? AND episode IS ?'
      ).get(
        input.mediaId,
        input.mediaType || 'movie',
        input.source || 'api',
        input.season ?? null,
        input.episode ?? null
      );

      if (existing) {
        // Update existing
        db.prepare(
          'UPDATE media_intents SET request_count = request_count + 1, last_requested_at = ?, source_label = COALESCE(?, source_label), source_type = COALESCE(?, source_type), source_id = COALESCE(?, source_id), requested_by = COALESCE(?, requested_by), priority = MAX(priority, ?), imdb_id = COALESCE(?, imdb_id), tmdb_id = COALESCE(?, tmdb_id), tvdb_id = COALESCE(?, tvdb_id) WHERE id = ?'
        ).run(
          now,
          input.sourceLabel || null,
          input.sourceType || null,
          input.sourceId || null,
          input.requestedBy || null,
          input.priority ?? 0,
          input.imdbId || null,
          input.tmdbId || null,
          input.tvdbId || null,
          existing.id
        );
        db.exec('COMMIT');
        return existing.id;
      } else {
        // Insert new
        const info = db.prepare(
          'INSERT INTO media_intents (media_id, media_type, season, episode, source, source_type, source_id, source_label, status, priority, requested_by, request_count, last_requested_at, created_at, imdb_id, tmdb_id, tvdb_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)'
        ).run(
          input.mediaId,
          input.mediaType || 'movie',
          input.season ?? null,
          input.episode ?? null,
          input.source || 'api',
          input.sourceType || null,
          input.sourceId || null,
          input.sourceLabel || null,
          input.status || 'active',
          input.priority ?? 0,
          input.requestedBy || null,
          now,
          now,
          input.imdbId || null,
          input.tmdbId || null,
          input.tvdbId || null
        );
        db.exec('COMMIT');
        return info.lastInsertRowid;
      }
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function getMediaIntent(id) {
    const row = getMediaIntentStmt.get({ id });
    return row ? rowToMediaIntent(row) : null;
  }

  function getMediaIntentsByMediaId(mediaId) {
    return getMediaIntentsByMediaIdStmt.all({ media_id: mediaId }).map(rowToMediaIntent);
  }

  function getMediaIntentsBySource(source, limit = 100) {
    return getMediaIntentsBySourceStmt.all({ source, limit }).map(rowToMediaIntent);
  }

  function getRecentMediaIntents(limit = 100) {
    return getRecentMediaIntentsStmt.all({ limit }).map(rowToMediaIntent);
  }

  function updateMediaIntentStatus(id, status) {
    updateMediaIntentStatusStmt.run({ id, status });
  }

  function getMediaIntentStats() {
    return getMediaIntentStatsStmt.get() || { total_intents: 0, active_intents: 0, total_requests: 0, unique_media: 0, unique_sources: 0 };
  }

  function rowToMediaIntent(row) {
    if (!row) return null;
    return {
      id: row.id,
      mediaId: row.media_id,
      mediaType: row.media_type,
      season: row.season,
      episode: row.episode,
      source: row.source,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceLabel: row.source_label,
      status: row.status,
      priority: row.priority,
      requestedBy: row.requested_by,
      requestCount: row.request_count,
      lastRequestedAt: row.last_requested_at,
      lastProcessedAt: row.last_processed_at,
      lastResultCount: row.last_result_count,
      lastError: row.last_error,
      createdAt: row.created_at,
      imdbId: row.imdb_id ?? null,
      tmdbId: row.tmdb_id ?? null,
      tvdbId: row.tvdb_id ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Media request persistence functions
  // ---------------------------------------------------------------------------

  function persistMediaRequest(intent, results) {
    const now = Date.now();
    const intentLength = results.length;

    // Resolve the linked media_intents row. Callers that already created
    // the intent (e.g. the Seerr ingress) pass `intent.intentId` to skip
    // the implicit upsert. Callers without an existing row fall back to
    // the original behaviour: upsert keyed on the dedupe tuple.
    let intentId = null;
    if (intent.intentId != null) {
      intentId = intent.intentId;
    } else if (intent.source || intent.sourceType || intent.sourceId || intent.sourceLabel) {
      intentId = upsertMediaIntent({
        mediaId: intent.mediaId,
        mediaType: intent.mediaType,
        season: intent.season,
        episode: intent.episode,
        source: intent.source,
        sourceType: intent.sourceType,
        sourceId: intent.sourceId,
        sourceLabel: intent.sourceLabel,
        requestedBy: intent.requestedBy,
        priority: intent.priority,
      });
    }

    const { sql: reqSql, values: reqValues } = buildInsertMediaRequestSql({
      mediaId: intent.mediaId,
      mediaType: intent.mediaType || 'movie',
      season: intent.season,
      episode: intent.episode ?? (intent.episodes?.length ? intent.episodes[0] : null),
      resultsLength: intentLength,
      now,
      source: intent.source || null,
      sourceType: intent.sourceType || null,
      intentId,
    });

    const info = db.prepare(reqSql).run(...reqValues);
    const requestId = info.lastInsertRowid;

    const resultTemplate = buildInsertMediaRequestResultSql(intentId);

    for (const r of results) {
      db.prepare(resultTemplate.sql).run(...resultTemplate.buildValues({
        requestId,
        rank: r.rank,
        infoHash: r.infoHash,
        fileIndexKey: r.fileIndex === null || r.fileIndex === undefined ? -1 : r.fileIndex,
        filename: r.filename,
        score: r.score,
        scoreBreakdown: r.scoreBreakdown ? JSON.stringify(r.scoreBreakdown) : null,
        identityTier: r.identity?.tier || 'unknown',
        identityConfidence: r.identity?.confidence || 0,
        identityEvidence: r.identity?.evidence ? JSON.stringify(r.identity.evidence) : null,
        resolutionState: r.identity?.state || 'unresolved',
        releaseMetadata: r.release ? JSON.stringify(r.release) : null,
        rankingBreakdown: r.rankingBreakdown ? JSON.stringify(r.rankingBreakdown) : null,
        eligible: r.identity?.eligible === false ? 0 : 1,
        ineligibleReason: r.identity?.ineligibleReason || null,
        ineligibleCode: r.identity?.ineligibleCode || null,
        expectedMediaScope: r.identity?.expectedMediaScope || null,
        parsedCandidateScope: r.identity?.parsedCandidateScope || null,
        selectedFileSize:
          Number.isSafeInteger(r.selectedFileSize) && r.selectedFileSize > 0
            ? r.selectedFileSize
            : null,
      }));
    }

    return requestId;
  }

  function getMediaRequests() {
    return getMediaRequestsStmt.all();
  }

  function getMediaRequestsByMediaId(mediaId, season = null, episode = null) {
    // When season+episode are provided, scope the lookup to the exact episode
    // so series STRMs land on the matching persisted request rather than the
    // latest one for the media_id (which is the wrong episode for any series
    // with more than one episode).
    return getMediaRequestsByMediaIdStmt.get({
      media_id: mediaId,
      season: season ?? null,
      episode: episode ?? null,
    }) || null;
  }

  function getMediaRequestResults(requestId) {
    return getMediaRequestResultsStmt.all({ request_id: requestId });
  }

  // ---------------------------------------------------------------------------
  // Stored knowledge lookup for resolver debug
  // ---------------------------------------------------------------------------

  const GET_MEDIA_REQUESTS_BY_MEDIA_ID = `
    SELECT * FROM media_requests
    WHERE media_id = @media_id
      AND (@season IS NULL OR season = @season)
      AND (@episode IS NULL OR episode = @episode)
    ORDER BY created_at DESC
    LIMIT 1;
  `;

  const GET_PLAYBACK_HANDOFFS_BY_MEDIA_ID = `
    SELECT * FROM playback_handoffs
    WHERE media_id = @media_id
    ORDER BY created_at DESC
    LIMIT 1;
  `;

  const getMediaRequestsByMediaIdStmt = db.prepare(GET_MEDIA_REQUESTS_BY_MEDIA_ID);
  const getPlaybackHandoffsByMediaIdStmt = db.prepare(GET_PLAYBACK_HANDOFFS_BY_MEDIA_ID);

  /**
   * Look up existing stored knowledge for a media identity.
   * Queries persisted request/selection/handoff state without performing
   * any live discovery or cache revalidation.
   *
   * @param {string} mediaId - Media identifier
   * @returns {Object|null} Debug knowledge object or null if no stored state
   */
  function getStoredKnowledge(mediaId) {
    const request = getMediaRequestsByMediaIdStmt.get({ media_id: mediaId });
    if (!request) return null;

    const results = getMediaRequestResultsStmt.all({ request_id: request.id });
    const handoff = getPlaybackHandoffsByMediaIdStmt.get({ media_id: mediaId });

    // Build candidates from persisted results + observations
    const candidates = results.map((r) => {
      // file_index_key: -1 = torrent-level (null), 0+ = specific file
      const observations = getProviderObservations(r.info_hash, r.file_index_key, {
        includeStale: true,
      });

      // Find the most recent observation for cache state
      let cacheState = 'unknown';
      let lastChecked = null;
      if (observations.length > 0) {
        const latest = observations.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
        cacheState = latest.state || 'unknown';
        lastChecked = latest.observedAt;
      }

      return {
        releaseKey: r.release_metadata ? JSON.parse(r.release_metadata).releaseKey || null : null,
        infoHash: r.info_hash,
        fileIndex: r.file_index_key === -1 ? null : r.file_index_key,
        provider: handoff?.provider || 'unknown',
        cacheState,
        score: r.score || 0,
        lastChecked,
      };
    });

    return {
      status: 'debug',
      mediaId,
      mediaType: request.media_type,
      season: request.season,
      episode: request.episode,
      requestId: request.id,
      handoff: handoff ? rowToPlaybackHandoff(handoff) : null,
      candidates,
      storedAt: request.created_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Existing selection lookup boundary
  // ---------------------------------------------------------------------------
  // Isolated boundary for consuming persisted playback selections.
  // Can be swapped to a different contract (e.g., intelligence branch handoff)
  // without changing callers.

  /**
   * Look up an existing persisted selection for a media identity.
   * The durable playback handoff is the authoritative selection boundary.
   * Provider observations may refine its availability state, but availability
   * is revalidated by the stream route and must not erase the selection.
   *
   * @param {string} mediaId - Media identifier
   * @returns {Object|null} Selection object or null when no handoff exists
   */
  function getExistingSelection(mediaId) {
    const handoff = getPlaybackHandoffsByMediaIdStmt.get({ media_id: mediaId });
    if (!handoff) return null;

    // Prefer the latest exact-file observation when present. File-level
    // handoffs can legitimately have only a torrent-level observation, so the
    // persisted handoff state remains the fallback rather than losing selection.
    const observations = getProviderObservations(handoff.info_hash, handoff.file_index, {
      includeStale: true,
    });
    const providerObservations = observations.filter(o => o.provider === handoff.provider);
    let providerState = handoff.provider_state || 'unknown';
    if (providerObservations.length > 0) {
      const latest = providerObservations.reduce((a, b) => (
        b.observedAt > a.observedAt ? b : a
      ));
      providerState = latest.state || providerState;
    }

    return {
      status: 'selected',
      requestId: handoff.request_id,
      mediaId: handoff.media_id,
      mediaType: handoff.media_type,
      season: handoff.season,
      episode: handoff.episode,
      releaseKey: handoff.release_key,
      selectedHash: handoff.info_hash,
      fileIndex: handoff.file_index,
      filename: handoff.filename,
      provider: handoff.provider,
      providerState,
      identityTier: handoff.identity_tier,
      resolutionState: handoff.resolution_state,
      reason: handoff.selection_reason || 'existing persisted selection',
      selectedAt: handoff.selected_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Identity enrichment queue management functions
  // ---------------------------------------------------------------------------

  function rowToEnrichmentQueueItem(row) {
    if (!row) return null;
    return {
      id: row.id,
      infoHash: row.info_hash,
      fileIndexKey: row.file_index_key,
      status: row.status,
      priority: row.priority || 0,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      resolverSource: row.resolver_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextAttemptAt: row.next_attempt_at,
      errorMessage: row.error_message,
      errorCategory: row.error_category,
    };
  }

  function enqueueIdentityResolution(infoHash, fileIndex, options = {}) {
    const now = Date.now();
    insertEnrichmentQueueStmt.run({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
      priority: options.priority ?? 0,
      max_attempts: options.maxAttempts ?? 3,
      resolver_source: options.resolverSource ?? null,
      now,
    });
    return getEnrichmentQueueItem(infoHash, fileIndex);
  }

  function getPendingEnrichments(limit = 10) {
    const rows = getPendingEnrichmentStmt.all({ now: Date.now(), limit });
    return rows.map(rowToEnrichmentQueueItem);
  }

  function getEnrichmentQueueItem(infoHash, fileIndex) {
    const row = getEnrichmentQueueItemStmt.get({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return rowToEnrichmentQueueItem(row);
  }

  function updateEnrichmentStatus(infoHash, fileIndex, status, options = {}) {
    const attempts = options.attempts ?? 0;
    const nextAttemptAt = options.nextAttemptAt ?? null;
    updateEnrichmentStatusStmt.run({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
      status,
      attempts,
      now: Date.now(),
      next_attempt_at: nextAttemptAt,
      error_message: options.errorMessage ?? null,
      error_category: options.errorCategory ?? null,
      resolver_source: options.resolverSource ?? null,
    });
    return getEnrichmentQueueItem(infoHash, fileIndex);
  }

  function getEnrichmentStats() {
    const row = getEnrichmentStatsStmt.get();
    return {
      total: row.total || 0,
      pending: row.pending || 0,
      processing: row.processing || 0,
      resolved: row.resolved || 0,
      failed: row.failed || 0,
    };
  }

  /**
   * Get candidate_media coverage metrics.
   * Shows how many candidates have media associations and resolved media.
   */
  function getCandidateMediaCoverage() {
    const row = getCandidateMediaCoverageStmt.get();
    const totalCandidates = row.total_candidates || 0;
    const candidatesWithMedia = row.candidates_with_media || 0;
    const candidatesWithResolvedMedia = row.candidates_with_resolved_media || 0;
    return {
      totalCandidates,
      candidatesWithMedia,
      candidatesWithResolvedMedia,
      coveragePercentage: totalCandidates > 0 ? candidatesWithMedia / totalCandidates : 0,
      resolvedPercentage: totalCandidates > 0 ? candidatesWithResolvedMedia / totalCandidates : 0,
    };
  }

  /**
   * Get resolver success rates grouped by resolver source.
   */
  function getResolverSuccessRates() {
    const rows = getResolverSuccessRatesStmt.all();
    return rows.map((row) => ({
      resolverSource: row.resolver_source,
      totalAttempts: row.total_attempts || 0,
      resolved: row.resolved || 0,
      failed: row.failed || 0,
      pending: row.pending || 0,
      successRate: row.total_attempts > 0 ? row.resolved / row.total_attempts : 0,
    }));
  }

  /**
   * Get confidence distribution for resolved media associations.
   */
  function getConfidenceDistribution() {
    const rows = getConfidenceDistributionStmt.all();
    const distribution = {
      very_high: 0,
      high: 0,
      medium: 0,
      low: 0,
      very_low: 0,
    };
    for (const row of rows) {
      distribution[row.confidence_bucket] = row.count;
    }
    return distribution;
  }

  /**
   * Get count of unresolved candidates (pending or failed but retryable).
   */
  function getUnresolvedStats() {
    const row = getUnresolvedStatsStmt.get();
    return {
      totalUnresolved: row.total_unresolved || 0,
    };
  }

  /**
   * Get match method distribution for resolved associations.
   */
  function getMatchMethodDistribution() {
    const rows = getMatchMethodDistributionStmt.all();
    return rows.map((row) => ({
      matchMethod: row.match_method,
      count: row.count || 0,
    }));
  }

  /**
   * Get resolution state distribution for associations.
   */
  function getResolutionStateDistribution() {
    const rows = getResolutionStateDistributionStmt.all();
    return rows.map((row) => ({
      resolutionState: row.resolution_state,
      count: row.count || 0,
    }));
  }

  /**
   * Find candidates without candidate_media associations.
   * Returns candidates that need identity resolution.
   *
   * @param {Object} options
   * @param {number} [options.limit=100] - Max candidates to return
   * @param {number} [options.offset=0] - Offset for pagination
   * @returns {Array<Object>} Unresolved candidates
   */
  function getUnresolvedCandidates(options = {}) {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const rows = getUnresolvedCandidatesStmt.all({ limit, offset });
    return rows.map(rowToCandidate);
  }

  /**
   * Count total candidates without candidate_media associations.
   *
   * @returns {number} Count of unresolved candidates
   */
  function countUnresolvedCandidates() {
    const row = countUnresolvedCandidatesStmt.get();
    return row.total || 0;
  }

  /**
   * Check if a candidate is already in the enrichment queue.
   *
   * @param {string} infoHash
   * @param {number|null} fileIndex
   * @returns {boolean}
   */
  function isCandidateInQueue(infoHash, fileIndex) {
    const row = checkCandidateInQueueStmt.get({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return row !== undefined;
  }

  /**
   * Enqueue unresolved candidates for identity resolution.
   * Finds candidates without candidate_media associations and adds them
   * to the enrichment queue. Skips candidates already in queue.
   *
   * @param {Object} options
   * @param {number} [options.limit=100] - Max candidates to enqueue
   * @param {number} [options.offset=0] - Offset for pagination
   * @param {number} [options.maxAttempts=3] - Max retry attempts
   * @returns {Object} { enqueued, skipped, total }
   */
  function enqueueUnresolvedCandidates(options = {}) {
    const { limit = 100, offset = 0, maxAttempts = 3 } = options;
    const now = Date.now();

    // Get unresolved candidates
    const candidates = getUnresolvedCandidates({ limit, offset });

    let enqueued = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      // Skip if already in queue
      if (isCandidateInQueue(candidate.infoHash, candidate.fileIndex)) {
        skipped++;
        continue;
      }

      // Insert into queue, preserving first_seen as created_at
      insertEnrichmentQueueStmt.run({
        info_hash: candidate.infoHash,
        file_index_key: fileIndexKey(candidate.fileIndex),
        max_attempts: maxAttempts,
        resolver_source: null,
        now: candidate.firstSeen || now,
      });
      enqueued++;
    }

    return { enqueued, skipped, total: candidates.length };
  }

  // ---------------------------------------------------------------------------
  // Cache probe queue functions
  // ---------------------------------------------------------------------------

  function rowToCacheProbe(row) {
    if (!row) return null;
    return {
      id: row.id,
      infoHash: row.info_hash,
      priority: row.priority,
      reason: row.reason,
      status: row.status,
      attemptCount: row.attempt_count,
      lastAttempt: row.last_attempt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function enqueueProbe(infoHash, options = {}) {
    const existing = checkActiveProbeStmt.get({ info_hash: infoHash });
    if (existing) return getCacheProbeByHash(infoHash);
    const now = Date.now();
    const reason = options.reason ? String(options.reason).slice(0, 128) : 'manual';
    const priority = options.priority ?? 0;
    insertCacheProbeStmt.run({
      info_hash: infoHash,
      priority,
      reason,
      now,
    });
    return getCacheProbeByHash(infoHash);
  }

  function claimProbeBatch(limit = 1) {
    const rows = claimCacheProbesStmt.all({ now: Date.now(), limit });
    // RETURNING * doesn't guarantee order, so re-sort by priority DESC, created_at ASC
    rows.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.created_at - b.created_at;
    });
    return rows.map(rowToCacheProbe);
  }

  function completeProbe(id) {
    completeCacheProbeStmt.run({ id, now: Date.now() });
  }

  function failProbe(id) {
    failCacheProbeStmt.run({ id, now: Date.now() });
  }

  function getCacheProbeByHash(infoHash) {
    const row = getCacheProbeByHashStmt.get({ info_hash: infoHash });
    return rowToCacheProbe(row);
  }

  function getCacheProbeStats() {
    const row = getCacheProbeStatsStmt.get();
    return {
      total: row.total || 0,
      pending: row.pending || 0,
      checking: row.checking || 0,
      complete: row.complete || 0,
      failed: row.failed || 0,
    };
  }

  /**
   * Promote candidate work in response to demand signals.
   * Enqueues or promotes identity enrichment and cache probe work for given candidates.
   * Uses MAX(existingPriority, demandPriority) to avoid demotion.
   * Does not create duplicate active rows.
   *
   * @param {Array<{infoHash: string, fileIndex: number|null}>} candidates - Candidates to promote
   * @param {number} demandPriority - Priority from DEMAND_PRIORITY constants
   * @param {Object} [options] - Options
   * @param {boolean} [options.enrichment=true] - Whether to promote identity enrichment
   * @param {boolean} [options.probe=true] - Whether to promote cache probing
   * @param {string} [options.reason] - Reason for queue entry (default: 'demand')
   * @returns {Object} { enrichmentPromoted, probePromoted }
   */
  function promoteDemand(candidates, demandPriority, options = {}) {
    const { enrichment = true, probe = true, reason = 'demand' } = options;
    let enrichmentPromoted = 0;
    let probePromoted = 0;

    for (const { infoHash, fileIndex } of candidates) {
      if (!infoHash) continue;

      // Identity enrichment: only if candidate lacks media association
      if (enrichment) {
        const associations = getMediaAssociations(infoHash, fileIndex);
        if (associations.length === 0) {
          // No identity yet - enqueue/promote enrichment
          enqueueIdentityResolution(infoHash, fileIndex, {
            priority: demandPriority,
            reason,
          });
          enrichmentPromoted++;
        }
      }

      // Cache probe: enqueue or promote existing
      if (probe) {
        const existingProbe = getCacheProbeByHash(infoHash);
        if (existingProbe && (existingProbe.status === 'pending' || existingProbe.status === 'checking')) {
          // Promote existing probe (uses MAX to avoid demotion)
          promoteCacheProbeStmt.run({ priority: demandPriority, now: Date.now(), info_hash: infoHash });
        } else {
          // No active probe - enqueue new
          enqueueProbe(infoHash, {
            priority: demandPriority,
            reason,
          });
        }
        probePromoted++;
      }
    }

    return { enrichmentPromoted, probePromoted };
  }

  /**
   * Aggregate cache-intelligence diagnostics.
   * Read-only. Uses existing stores/database APIs.
   * Safe for operator/debug inspection only — never exposes tokens.
   */
  function getCacheIntelligence() {
    const now = Date.now();

    // Provider observation history aggregates (TorBox only)
    const historyAgg = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN state = 'cached' THEN 1 ELSE 0 END) as cached,
        SUM(CASE WHEN state = 'uncached' THEN 1 ELSE 0 END) as uncached,
        SUM(CASE WHEN state = 'unknown' THEN 1 ELSE 0 END) as unknown,
        SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) as error,
        MAX(observed_at) as latestObservedAt
      FROM provider_observation_events
      WHERE provider = 'torbox' AND kind = 'authoritative'
    `).get();

    // Current TorBox state (from projection)
    const currentAgg = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN state = 'cached' THEN 1 ELSE 0 END) as cached,
        SUM(CASE WHEN state = 'uncached' THEN 1 ELSE 0 END) as uncached,
        SUM(CASE WHEN state = 'unknown' THEN 1 ELSE 0 END) as unknown,
        SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) as error
      FROM provider_observation_current
      WHERE provider = 'torbox' AND kind = 'authoritative'
    `).get();

    // Fresh vs stale current observations (using expires_at)
    const freshCount = db.prepare(`
      SELECT COUNT(*) as c
      FROM provider_observation_current
      WHERE provider = 'torbox' AND kind = 'authoritative' AND expires_at IS NOT NULL AND expires_at > ?
    `).get(now).c;

    const staleCount = db.prepare(`
      SELECT COUNT(*) as c
      FROM provider_observation_current
      WHERE provider = 'torbox' AND kind = 'authoritative' AND expires_at IS NOT NULL AND expires_at <= ?
    `).get(now).c;

    // Cache hit percentage
    const totalHistorical = historyAgg.total || 0;
    const cachedHistorical = historyAgg.cached || 0;
    const cacheHitPercentage = totalHistorical > 0
      ? Math.round((cachedHistorical / totalHistorical) * 1000) / 10
      : 0;

    // Recent observations (bounded, safe fields only)
    const recentObservations = db.prepare(`
      SELECT info_hash, state, observed_at, source, latency_ms, expires_at, scope
      FROM provider_observation_events
      WHERE provider = 'torbox' AND kind = 'authoritative'
      ORDER BY observed_at DESC, id DESC
      LIMIT 10
    `).all().map(row => ({
      infoHash: row.info_hash,
      state: row.state,
      observedAt: row.observed_at,
      source: row.source,
      latencyMs: row.latency_ms,
      freshness: row.expires_at == null ? 'unbounded' : (row.expires_at > now ? 'fresh' : 'stale'),
    }));

    // Recent failed probe work
    const recentFailed = db.prepare(`
      SELECT info_hash, priority, reason, status, attempt_count, last_attempt, created_at, updated_at
      FROM cache_probe_queue
      WHERE status = 'failed'
      ORDER BY updated_at DESC
      LIMIT 10
    `).all().map(row => ({
      infoHash: row.info_hash,
      priority: row.priority,
      reason: row.reason,
      attemptCount: row.attempt_count,
      lastAttempt: row.last_attempt,
    }));

    // Queue depth stats
    const queueStats = getCacheProbeStats();

    // Oldest pending item and highest pending priority
    const pendingEdge = db.prepare(`
      SELECT priority, created_at FROM cache_probe_queue
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `).get();

    return {
      generatedAt: now,
      providerObservations: {
        total: totalHistorical,
        cached: cachedHistorical,
        uncached: historyAgg.uncached || 0,
        unknown: historyAgg.unknown || 0,
        error: historyAgg.error || 0,
        cacheHitPercentage,
        latestObservedAt: historyAgg.latestObservedAt,
      },
      currentTorBoxState: {
        total: currentAgg.total || 0,
        cached: currentAgg.cached || 0,
        uncached: currentAgg.uncached || 0,
        unknown: currentAgg.unknown || 0,
        error: currentAgg.error || 0,
        fresh: freshCount,
        stale: staleCount,
      },
      probeQueue: {
        pending: queueStats.pending,
        checking: queueStats.checking,
        complete: queueStats.complete,
        failed: queueStats.failed,
        total: queueStats.total,
        ...(pendingEdge ? {
          highestPendingPriority: pendingEdge.priority,
          oldestPendingCreatedAt: pendingEdge.created_at,
        } : {}),
      },
      recentObservations,
      recentFailedProbes: recentFailed,
    };
  }

  let closed = false;

  function isClosed() {
    return closed;
  }

  function close() {
    if (closed) return;
    closed = true;
    try { insertCandidateStmt.finalize(); } catch {}
    try { getCandidateStmt.finalize(); } catch {}
    try { insertObservationEventStmt.finalize(); } catch {}
    try { upsertCurrentObservationStmt.finalize(); } catch {}
    try { getCurrentObservationsStmt.finalize(); } catch {}
    try { getObservationHistoryStmt.finalize(); } catch {}
    try { selectAllCandidatesStmt.finalize(); } catch {}
    try { selectCandidatesByKeyStmt.finalize(); } catch {}
    try { insertMediaAssocStmt.finalize(); } catch {}
    try { upsertMediaAssocStmt.finalize(); } catch {}
    try { getMediaAssocStmt.finalize(); } catch {}
    try { getCandidatesByMediaStmt.finalize(); } catch {}
    try { insertReleaseAttributesStmt.finalize(); } catch {}
    try { getReleaseAttributesStmt.finalize(); } catch {}
    try { getReleaseAttributesBySourceStmt.finalize(); } catch {}
    try { getCandidatesWithoutAttributesStmt.finalize(); } catch {}
    try { insertEnrichmentQueueStmt.finalize(); } catch {}
    try { getPendingEnrichmentStmt.finalize(); } catch {}
    try { getEnrichmentQueueItemStmt.finalize(); } catch {}
    try { updateEnrichmentStatusStmt.finalize(); } catch {}
    try { getEnrichmentStatsStmt.finalize(); } catch {}
    try { getCandidateMediaCoverageStmt.finalize(); } catch {}
    try { getResolverSuccessRatesStmt.finalize(); } catch {}
    try { getConfidenceDistributionStmt.finalize(); } catch {}
    try { getUnresolvedStatsStmt.finalize(); } catch {}
    try { getMatchMethodDistributionStmt.finalize(); } catch {}
    try { getUnresolvedCandidatesStmt.finalize(); } catch {}
    try { countUnresolvedCandidatesStmt.finalize(); } catch {}
    try { checkCandidateInQueueStmt.finalize(); } catch {}
    try { insertCacheProbeStmt.finalize(); } catch {}
    try { checkActiveProbeStmt.finalize(); } catch {}
    try { claimCacheProbesStmt.finalize(); } catch {}
    try { completeCacheProbeStmt.finalize(); } catch {}
    try { failCacheProbeStmt.finalize(); } catch {}
    try { getCacheProbeByHashStmt.finalize(); } catch {}
    try { promoteCacheProbeStmt.finalize(); } catch {}
    try { getCacheProbeStatsStmt.finalize(); } catch {}
    db.close();
  }

  return {
    upsertCandidate,
    getCandidate,
    appendProviderObservation,
    recordProviderObservation,
    getProviderObservations,
    getProviderObservationHistory,
    queryCachedCandidates,
    associateMedia,
    getMediaAssociations,
    queryCandidatesByMedia,
    ingestCandidate,
    isClosed,
    close,
    // Release attributes (used by release-attributes.js)
    _insertReleaseAttributes,
    getReleaseAttributes,
    getCandidatesWithoutReleaseAttributes,
    // Identity enrichment queue
    enqueueIdentityResolution,
    getPendingEnrichments,
    getEnrichmentQueueItem,
    updateEnrichmentStatus,
    getEnrichmentStats,
    // Enrichment observability metrics
    getCandidateMediaCoverage,
    getResolverSuccessRates,
    getConfidenceDistribution,
    getUnresolvedStats,
    getMatchMethodDistribution,
    getResolutionStateDistribution,
    // Queue seeding
    getUnresolvedCandidates,
    countUnresolvedCandidates,
    isCandidateInQueue,
    enqueueUnresolvedCandidates,
    // Cache probe queue
    enqueueProbe,
    claimProbeBatch,
    completeProbe,
    failProbe,
    getCacheProbeByHash,
    getCacheProbeStats,
    hasFreshTorBoxObservation,
    // Cache-intelligence diagnostics (read-only)
    getCacheIntelligence,
    // Media intents
    upsertMediaIntent,
    getMediaIntent,
    getMediaIntentsByMediaId,
    getMediaIntentsBySource,
    getRecentMediaIntents,
    updateMediaIntentStatus,
    getMediaIntentStats,
    // Media request persistence
    persistMediaRequest,
    getMediaRequests,
    getMediaRequestsByMediaId,
    getMediaRequestResults,
    // Playback handoff persistence
    persistPlaybackHandoff,
    getPlaybackHandoffByRequestId,
    getPlaybackHandoffById,
    getPlaybackHandoffByMediaId,
    listMoviePlaybackHandoffs,
    getPlaybackHandoffByReleaseKey,
    getVfsMovieEntry,
    listVfsMovieEntries,
    createVfsMovieEntry,
    setVfsMovieEntrySize,
    listTvPlaybackHandoffs,
    getTvPlaybackHandoff,
    getVfsTvEntry,
    listVfsTvEntries,
    createVfsTvEntry,
    setVfsTvEntrySize,
    rowToPlaybackHandoff,
    // Stored knowledge lookup for resolver debug
    getStoredKnowledge,
    // Existing selection lookup boundary
    getExistingSelection,
    // Demand promotion
    promoteDemand,
    // Exposed for testing/inspection
    get db() { return db; },
  };
}

/**
 * Stale-While-Refresh cache query wrapper.
 *
 * Serves cache hits when fresh (age <= maxAgeMs), serves stale hits while
 * triggering a background refresh, or triggers a refresh on miss. The cache
 * is never mutated by the refresher — refresh is the caller's responsibility
 * (typically via live discovery write-through).
 *
 * Guarantees:
 * - Never throws: refresh failures are swallowed, stale data is preserved.
 * - Never blocks the caller on refresh; refresh runs asynchronously.
 * - Cache is a read substrate; discovery behavior is unchanged.
 */
export class StaleWhileRefresher {
  constructor({ cache, maxAgeMs = 300000, predicate, withObservations = false, refresh } = {}) {
    if (!cache) throw new Error('StaleWhileRefresher requires a cache');
    if (typeof refresh !== 'function') throw new Error('StaleWhileRefresher requires a refresh function');
    this.cache = cache;
    this.maxAgeMs = maxAgeMs;
    this.predicate = predicate;
    this.withObservations = withObservations;
    this.refresh = refresh;
  }

  /**
   * Query the cache and determine freshness status.
   *
   * Returns { status, candidates } where status is one of:
   * - 'fresh': cache hit within maxAgeMs, no refresh needed
   * - 'stale': cache hit but older than maxAgeMs, stale data returned while refresh triggered
   * - 'miss': no cache hit, refresh triggered
   */
  async query() {
    const options = { predicate: this.predicate, withObservations: this.withObservations };
    const candidates = this.cache.queryCachedCandidates(options);

    if (candidates.length === 0) {
      this._triggerRefresh();
      return { status: 'miss', candidates: [] };
    }

    const oldest = Math.min(...candidates.map((c) => c.lastSeen));
    const age = Date.now() - oldest;

    if (age <= this.maxAgeMs) {
      return { status: 'fresh', candidates };
    }

    this._triggerRefresh();
    return { status: 'stale', candidates };
  }

  _triggerRefresh() {
    Promise.resolve()
      .then(() => this.refresh())
      .catch(() => {});
  }
}

/**
 * Safe wrapper: returns a no-op cache if the real cache throws during a write.
 * Used by the search integration so cache failures never break discovery.
 */
export function withCacheFailureIsolation(cache, log = () => {}) {
  return {
    async ingestCandidate(candidate) {
      try {
        return await cache.ingestCandidate(candidate);
      } catch (error) {
        log(error);
        return { candidate: null, error };
      }
    },
    async appendProviderObservation(observation) {
      try {
        return await cache.appendProviderObservation(observation);
      } catch (error) {
        log(error);
        return null;
      }
    },
    async recordProviderObservation(infoHash, fileIndex, provider, observation) {
      try {
        return await cache.recordProviderObservation(infoHash, fileIndex, provider, observation);
      } catch (error) {
        log(error);
        return null;
      }
    },
    async upsertCandidate(candidate) {
      try {
        return await cache.upsertCandidate(candidate);
      } catch (error) {
        log(error);
        return null;
      }
    },
  };
}
