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

-- ============================================================================
-- DMM source provenance (lifecycle, refresh generations, stale detection)
-- ============================================================================
-- Authoritative refresh-generation record for a DMM tree. A row is INSERTed
-- at the start of every in-tree ingest (and by the rebuild script) and only
-- moves to status='complete' when the source has been fully observed. A
-- generation that is interrupted, still running, or has unresolved failures
-- stays in 'running' or 'incomplete' and is NEVER consulted for stale
-- detection, so a crashed refresh cannot make the previous generation look
-- stale.
--
-- Identity here is additive metadata only. It does not change candidate,
-- release, or attribute identity. file_index_key = -1 remains the
-- torrent-level identity for DMM data; per-file records would carry 0,1,...
CREATE TABLE IF NOT EXISTS dmm_ingestion_generations (
  generation_id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'dmm-hashlist',
  tree_sha TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  fragments_total INTEGER NOT NULL DEFAULT 0,
  fragments_complete INTEGER NOT NULL DEFAULT 0,
  fragments_failed INTEGER NOT NULL DEFAULT 0,
  records_seen INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running','complete','incomplete','failed'))
);

CREATE INDEX IF NOT EXISTS idx_dmm_generations_status
  ON dmm_ingestion_generations(status, started_at DESC);

-- Many-to-many membership: which source observation justifies which candidate
-- identity, in which generation. One row per (candidate identity, source,
-- fragment, generation). Re-ingesting the same fragment/generation is a no-op
-- via INSERT OR IGNORE on the deterministic primary key. Multiple fragments
-- and multiple generations may each contribute observations for the same
-- candidate without mutating the candidate row.
CREATE TABLE IF NOT EXISTS dmm_source_observations (
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  source TEXT NOT NULL,
  fragment_name TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  records_seen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (info_hash, file_index_key, source, fragment_name, generation_id)
);

CREATE INDEX IF NOT EXISTS idx_dmm_obs_generation
  ON dmm_source_observations(generation_id, source);
CREATE INDEX IF NOT EXISTS idx_dmm_obs_candidate
  ON dmm_source_observations(info_hash, file_index_key);
CREATE INDEX IF NOT EXISTS idx_dmm_obs_fragment
  ON dmm_source_observations(generation_id, source, fragment_name);

-- Historical provider evidence (source-vs-snapshot model)
--
-- Stores persistent corpus-membership signals such as:
--   "Real-Debrid has seen/served this release before"
-- These are PRIORS, not current observations. They do NOT imply
--   current cache hit, current placement, current availability, or
--   current delivery capability.
--
-- Identity model — two layers:
--
--   source_id        = identity of an INDEPENDENT witness/source
--                        (e.g. "rd-history-import"). Two distinct
--                        source_ids count as two corroborating
--                        witnesses at query time.
--   source_version    = version/generation/snapshot of that same
--                        witness. Different versions of the SAME
--                        source_id are NOT independent corroboration;
--                        they are repeated sightings from the same
--                        witness. source_version participates only
--                        in snapshot-membership identity (the
--                        sightings table below).
--
-- Replay semantics:
--   Replaying the same (source_id, source_version) snapshot is a
--   no-op at both tables. The PRIMARY KEY of the sightings table
--   is the snapshot-membership identity; replay cannot create new
--   rows or bump counters on existing rows.
--
-- Two tables:
--
--   historical_provider_evidence_sightings
--     one row per (provider, source_id, source_event_id, info_hash,
--                  file_index_key, evidence_type). source_event_id
--                  is the stable, source-derived event identity:
--                  e.g. RD torrent id, or a SHA256 of the immutable
--                  source fields. It is NOT an acquisition timestamp.
--                  A second acquisition of unchanged source content
--                  re-uses the same source_event_id and is a no-op
--                  (insert OR ignore). A genuinely new source event
--                  (e.g. a new RD torrent) gets a fresh source_event_id
--                  and creates a new row.
--
--   historical_provider_evidence
--     one row per (provider, source_id, info_hash, file_index_key,
--                  evidence_type). source_event_id is NOT in the key.
--     Maintained deterministically from the sightings table.
--     distinct_snapshot_count = COUNT(DISTINCT source_version) of
--     sightings for the same (provider, source_id) identity;
--     first_seen_at / last_seen_at aggregate across sightings.
--     source_version is a snapshot provenance field — distinct
--     versions of the same source are NOT independent corroboration,
--     they are repeated acquisitions of the same witness.
--
-- For non-event-derived sources (no source_event_id supplied by the
-- caller), the importer synthesizes a deterministic
-- "legacy:<source_version>:<info_hash>:<file_index_key>" event id so
-- the PK uniqueness invariant is preserved without changing the
-- generic source/version semantics. Legacy rows from before this
-- migration are backfilled in migrateHistoricalProviderEvidenceEventId.
--
-- file_index_key=-1 is the canonical release-level coordinate
-- (matching the convention used throughout dmm_source_observations,
-- candidates, etc.).
--
-- metadata_json is intentionally absent. We do not persist URLs,
-- filenames, or ordinals.
CREATE TABLE IF NOT EXISTS historical_provider_evidence_sightings (
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  provider TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_event_id TEXT NOT NULL DEFAULT '',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (info_hash, file_index_key, provider, evidence_type, source_id, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_hpe_sightings_candidate
  ON historical_provider_evidence_sightings(info_hash, file_index_key);
CREATE INDEX IF NOT EXISTS idx_hpe_sightings_source
  ON historical_provider_evidence_sightings(provider, source_id, source_version);
CREATE INDEX IF NOT EXISTS idx_hpe_sightings_event
  ON historical_provider_evidence_sightings(provider, source_id, source_event_id);

CREATE TABLE IF NOT EXISTS historical_provider_evidence (
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  provider TEXT NOT NULL,
  account_scope TEXT,
  evidence_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  distinct_snapshot_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (info_hash, file_index_key, provider, evidence_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_historical_provider_evidence_candidate
  ON historical_provider_evidence(info_hash, file_index_key);
CREATE INDEX IF NOT EXISTS idx_historical_provider_evidence_source
  ON historical_provider_evidence(provider, source_id);
`;

// ============================================================================
// RD /downloads raw observation + correlation tables
//
// Architectural role:
//   /downloads is RD's per-download-event log. It has NO infoHash and
//   NO deterministic bridge to /torrents. We persist it as raw
//   observation only — never as historical_provider_evidence, which
//   requires an infoHash PK.
//
//   rd_download_observations:
//     one row per RD download event (one RD download id = one row).
//     The (provider, source_id, rd_id) tuple is the stable primary
//     identity. Re-importing the same RD download id is a no-op.
//     Distinct RD download ids with identical (filename, filesize)
//     remain distinct rows (the 52 Oppenheimer rows are NOT collapsed).
//     source_version is the snapshot provenance, identical to
//     historical_provider_evidence's source_version semantics.
//
//   rd_download_correlations:
//     DERIVED HYPOTHESIS CACHE. May be empty (we build it only if
//     correlation quality is materially useful; see
//     scripts/correlate-rd-downloads.js). The correlation layer is
//     a pure function of (observations, candidates) and is safe to
//     rebuild from scratch. It is never authoritative identity.
//     A row here says "for observation rd_id, candidate info_hash
//     + file_index is the closest match given the available evidence;
//     see reasons_json for which features fired." It is NOT a
//     historical_provider_evidence row, NOT a release-identity
//     statement, and NOT safe to feed into ranking without the
//     separate gate in lib/discovery/ranking.js (which currently
//     does not consult this table — ranking is unchanged by this
//     schema addition).
// ============================================================================

const CREATE_RD_DOWNLOAD_OBSERVATIONS = `
CREATE TABLE IF NOT EXISTS rd_download_observations (
  provider TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  rd_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  normalized_filename TEXT NOT NULL,
  exact_bytes INTEGER NOT NULL,
  mime_type TEXT,
  streamable INTEGER NOT NULL DEFAULT 0,
  generated_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  parsed_title TEXT,
  parsed_year INTEGER,
  season INTEGER,
  episode INTEGER,
  resolution TEXT,
  source_type TEXT,
  codec TEXT,
  release_group TEXT,
  parser_confidence REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, source_id, source_event_id)
);
`;

const CREATE_RD_DOWNLOAD_OBSERVATIONS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_rd_download_obs_filename_bytes
  ON rd_download_observations(provider, source_id, normalized_filename, exact_bytes);
CREATE INDEX IF NOT EXISTS idx_rd_download_obs_version
  ON rd_download_observations(provider, source_id, source_version);
CREATE INDEX IF NOT EXISTS idx_rd_download_obs_generated
  ON rd_download_observations(generated_at);
`;

const CREATE_RD_DOWNLOAD_CORRELATIONS = `
CREATE TABLE IF NOT EXISTS rd_download_correlations (
  provider TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  rd_id TEXT NOT NULL,
  candidate_info_hash TEXT NOT NULL,
  candidate_file_index_key INTEGER NOT NULL,
  correlation_class TEXT NOT NULL,
  correlation_score REAL NOT NULL,
  reasons_json TEXT NOT NULL,
  ambiguity_count INTEGER NOT NULL,
  parsed_filename TEXT,
  exact_bytes INTEGER,
  generated_at INTEGER,
  correlated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, source_id, source_event_id, candidate_info_hash, candidate_file_index_key)
);
`;

const CREATE_RD_DOWNLOAD_CORRELATIONS_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_rd_download_corr_candidate
  ON rd_download_correlations(candidate_info_hash, candidate_file_index_key);
CREATE INDEX IF NOT EXISTS idx_rd_download_corr_class
  ON rd_download_correlations(provider, source_id, correlation_class);
CREATE INDEX IF NOT EXISTS idx_rd_download_corr_event
  ON rd_download_correlations(provider, source_id, source_event_id);
`;

// ============================================================================
// DMM source provenance SQL
// ============================================================================

const INSERT_GENERATION = `
INSERT INTO dmm_ingestion_generations
  (generation_id, source, tree_sha, started_at, status)
VALUES (@generation_id, @source, @tree_sha, @started_at, 'running')
ON CONFLICT(generation_id) DO UPDATE SET
  started_at = MIN(dmm_ingestion_generations.started_at, excluded.started_at);
`;

const UPDATE_GENERATION_PROGRESS = `
UPDATE dmm_ingestion_generations SET
  fragments_total = @fragments_total,
  fragments_complete = @fragments_complete,
  fragments_failed = @fragments_failed,
  records_seen = records_seen + @records_seen_delta
WHERE generation_id = @generation_id;
`;

const COMPLETE_GENERATION = `
UPDATE dmm_ingestion_generations SET
  completed_at = @completed_at,
  fragments_total = @fragments_total,
  fragments_complete = @fragments_complete,
  fragments_failed = @fragments_failed,
  status = @status
WHERE generation_id = @generation_id;
`;

const GET_GENERATION = `
SELECT * FROM dmm_ingestion_generations WHERE generation_id = ?;
`;

const GET_CURRENT_COMPLETE_GENERATION = `
SELECT * FROM dmm_ingestion_generations
WHERE source = ? AND status = 'complete'
ORDER BY completed_at DESC, rowid DESC
LIMIT 1;
`;

const INSERT_SOURCE_OBSERVATION = `
INSERT OR IGNORE INTO dmm_source_observations
  (info_hash, file_index_key, source, fragment_name, generation_id,
   first_seen_at, last_seen_at, records_seen)
VALUES
  (@info_hash, @file_index_key, @source, @fragment_name, @generation_id,
   @first_seen_at, @last_seen_at, @records_seen);
`;

// Touch the last_seen_at of an existing observation row so repeated
// observation of the same fragment/generation is monotonically timestamped
// without amplifying rows. Does not touch first_seen_at.
const TOUCH_SOURCE_OBSERVATION = `
UPDATE dmm_source_observations SET
  last_seen_at = MAX(last_seen_at, @last_seen_at),
  records_seen = records_seen + @records_seen_delta
WHERE info_hash = @info_hash
  AND file_index_key = @file_index_key
  AND source = @source
  AND fragment_name = @fragment_name
  AND generation_id = @generation_id;
`;

// Stale detection: observations present in the previous generation but
// missing from the given generation. Drives the "fragment disappeared" and
// "fragment no longer contains this candidate" analyses.
const SELECT_STALE_OBSERVATIONS = `
SELECT info_hash, file_index_key, source, fragment_name, generation_id
FROM dmm_source_observations
WHERE generation_id = @prev_generation
  AND (info_hash, file_index_key, source, fragment_name) NOT IN (
    SELECT info_hash, file_index_key, source, fragment_name
    FROM dmm_source_observations
    WHERE generation_id = @current_generation
  )
ORDER BY info_hash, file_index_key, source, fragment_name;
`;

// Stale fragments: fragment names that appeared in the previous generation
// but are entirely absent from the current generation (whether or not
// individual candidates carried them).
const SELECT_STALE_FRAGMENTS = `
SELECT DISTINCT source, fragment_name
FROM dmm_source_observations
WHERE generation_id = @prev_generation
  AND (source, fragment_name) NOT IN (
    SELECT DISTINCT source, fragment_name
    FROM dmm_source_observations
    WHERE generation_id = @current_generation
  )
ORDER BY source, fragment_name;
`;

// Candidate identities that have ZERO active source observations in the
// given generation. These are prune-eligible ONLY when the generation is
// 'complete' (otherwise interrupted refreshes would silently mark live
// candidates as stale).
const SELECT_PRUNE_ELIGIBLE_CANDIDATES = `
SELECT c.info_hash, c.file_index_key
FROM candidates c
WHERE NOT EXISTS (
  SELECT 1 FROM dmm_source_observations o
  WHERE o.info_hash = c.info_hash
    AND o.file_index_key = c.file_index_key
    AND o.generation_id = @current_generation
);
`;

// Same shape for release_attributes: attributes without any source
// observation justifying them in the current generation.
const SELECT_PRUNE_ELIGIBLE_ATTRIBUTES = `
SELECT ra.info_hash, ra.file_index_key, ra.source
FROM release_attributes ra
WHERE NOT EXISTS (
  SELECT 1 FROM dmm_source_observations o
  WHERE o.info_hash = ra.info_hash
    AND o.file_index_key = ra.file_index_key
    AND o.generation_id = @current_generation
);
`;

// Source-observation membership for a specific candidate. Used by
// justification-aware pruning: a candidate is globally stale only when it
// has zero observations in the current generation; the many-to-many design
// means a candidate can be justified by multiple fragments/generations.
const SELECT_OBSERVATIONS_FOR_CANDIDATE = `
SELECT source, fragment_name, generation_id,
       first_seen_at, last_seen_at, records_seen
FROM dmm_source_observations
WHERE info_hash = @info_hash
  AND file_index_key = @file_index_key
ORDER BY generation_id DESC, source, fragment_name;
`;

const COUNT_OBSERVATIONS = `
SELECT COUNT(*) AS n FROM dmm_source_observations WHERE generation_id = ?;
`;

// ============================================================================
// Historical provider evidence SQL — source-vs-snapshot model
//
// Idempotency strategy (the design contract this slice repairs):
//
//     Sightings table = the idempotency boundary.
//       PRIMARY KEY (info_hash, file_index_key, provider, evidence_type,
//                    source_id, source_version)
//
//       This identity is "snapshot membership": a row exists iff THIS
//       (source_id, source_version) snapshot reports THIS sighting.
//       Re-ingesting the SAME (source_id, source_version) is a no-op
//       (ON CONFLICT DO NOTHING). Replay cannot create new rows or
//       bump counters — replay is genuinely idempotent.
//
//       A NEW source_version (e.g. snapshot-2025-02) creates a NEW
//       sightings row. A genuinely distinct source_id creates a NEW
//       sightings row. Both are "more evidence" but only a distinct
//       source_id is "more corroboration".
//
//     Aggregate table = a deterministic projection over the sightings.
//       PRIMARY KEY (info_hash, file_index_key, provider, evidence_type,
//                    source_id)
//       — note: source_version is NOT in the key. distinct_snapshot_count
//       = COUNT(*) of sightings for the same (provider, source_id).
//
//     observation_count in the sightings row preserves the per-snapshot
//     delta. The aggregate does NOT sum observation_count across snapshots;
//     it counts the number of distinct snapshots that reported the
//     sighting. This means replay is idempotent and snapshot evolution
//     is observable.
// ============================================================================

// 1. Per-event witness (idempotency boundary).
//    ON CONFLICT DO NOTHING: replay of the same (source_id, source_event_id)
//    is a no-op. The unique key is now driven by source_event_id (the
//    stable, source-derived event identity) instead of source_version
//    (an acquisition provenance field). A second acquisition of the
//    same underlying source event re-uses the same source_event_id and
//    does not create a new row, does not bump counters. A genuinely
//    new source event (different source_event_id) creates a new row.
//    first_seen_at / last_seen_at / observation_count are recorded
//    ONLY on the first ingest of that exact source event.
const INSERT_HISTORICAL_PROVIDER_SIGHTING = `
INSERT OR IGNORE INTO historical_provider_evidence_sightings
  (info_hash, file_index_key, provider, evidence_type,
   source_id, source_version, source_event_id,
   first_seen_at, last_seen_at, observation_count)
VALUES
  (@info_hash, @file_index_key, @provider, @evidence_type,
   @source_id, @source_version, @source_event_id,
   @first_seen_at, @last_seen_at, @observation_count);
`;

// 2. Aggregate recompute. Source event id is NOT in the key. The aggregate
//    is recomputed from the sightings table so that:
//      - replay produces the same aggregate (idempotent)
//      - snapshot evolution is observable via distinct_snapshot_count
//        (count of distinct source_version values across sightings
//         for this source_id, NOT count of sighting rows — so repeated
//         acquisitions of unchanged source content do not strengthen
//         historical evidence beyond a single new version)
//      - first_seen_at = MIN(first_seen_at) across all sightings
//      - last_seen_at  = MAX(last_seen_at)  across all sightings
//      - account_scope = the first non-null scope across sightings
const UPSERT_HISTORICAL_PROVIDER_EVIDENCE = `
INSERT INTO historical_provider_evidence
  (info_hash, file_index_key, provider, account_scope, evidence_type,
   source_id, first_seen_at, last_seen_at, distinct_snapshot_count)
SELECT
  s.info_hash, s.file_index_key, s.provider, @account_scope, s.evidence_type,
  s.source_id, MIN(s.first_seen_at), MAX(s.last_seen_at),
  COUNT(DISTINCT s.source_version)
FROM historical_provider_evidence_sightings s
WHERE s.provider          = @provider
  AND s.source_id         = @source_id
  AND s.evidence_type     = @evidence_type
  AND s.info_hash         = @info_hash
  AND s.file_index_key    = @file_index_key
GROUP BY s.info_hash, s.file_index_key, s.provider, s.evidence_type, s.source_id
ON CONFLICT(info_hash, file_index_key, provider, evidence_type, source_id)
DO UPDATE SET
  first_seen_at           = MIN(historical_provider_evidence.first_seen_at, excluded.first_seen_at),
  last_seen_at            = MAX(historical_provider_evidence.last_seen_at, excluded.last_seen_at),
  distinct_snapshot_count = excluded.distinct_snapshot_count,
  account_scope           = COALESCE(historical_provider_evidence.account_scope, excluded.account_scope);
`;

// 3. Read API (caller-aggregate view).
const SELECT_HISTORICAL_PROVIDER_EVIDENCE_FOR_CANDIDATE = `
SELECT provider, account_scope, evidence_type, source_id,
       first_seen_at, last_seen_at, distinct_snapshot_count
FROM historical_provider_evidence
WHERE info_hash = @info_hash
  AND file_index_key = @file_index_key
ORDER BY provider, source_id;
`;

// 4. Count helpers.
const COUNT_HISTORICAL_PROVIDER_EVIDENCE = `
SELECT COUNT(*) AS n FROM historical_provider_evidence;
`;

const COUNT_HISTORICAL_PROVIDER_SIGHTINGS = `
SELECT COUNT(*) AS n FROM historical_provider_evidence_sightings;
`;

const COUNT_HISTORICAL_PROVIDER_EVIDENCE_FOR_CANDIDATE = `
SELECT COUNT(*) AS n FROM historical_provider_evidence
WHERE info_hash = @info_hash AND file_index_key = @file_index_key;
`;

const COUNT_HISTORICAL_PROVIDER_SIGHTINGS_FOR_CANDIDATE = `
SELECT COUNT(*) AS n FROM historical_provider_evidence_sightings
WHERE info_hash = @info_hash AND file_index_key = @file_index_key;
`;

// ============================================================================
// RD /downloads raw observations SQL
// ============================================================================

// Idempotent insert keyed on (provider, source_id, source_event_id).
// Re-importing the same RD download id is a no-op (r.changes === 0).
// A genuinely new RD download id (a new /downloads row) creates a
// new observation row.
//
// We use INSERT OR IGNORE (not DO UPDATE) because the raw observation
// log is immutable per (provider, source_id, source_event_id): each
// RD download event is its own source of truth. If the same RD
// download id appears in two acquisitions (e.g. a re-run of the
// snapshot), the row's first/last_seen_at and source_version are
// NOT updated — only the existence of the row is recorded. This
// matches the historical_provider_evidence_sightings model: replay
// is a no-op, not a refresh.
//
// The correlatable downstream state (rd_download_correlations) is
// the place where snapshot-version changes take effect; it is
// rebuilt from scratch on every correlation run.
const INSERT_RD_DOWNLOAD_OBSERVATION = `
INSERT OR IGNORE INTO rd_download_observations (
  provider, source_id, source_version, source_event_id, rd_id,
  filename, normalized_filename, exact_bytes,
  mime_type, streamable, generated_at,
  first_seen_at, last_seen_at,
  parsed_title, parsed_year, season, episode,
  resolution, source_type, codec, release_group,
  parser_confidence
) VALUES (
  @provider, @source_id, @source_version, @source_event_id, @rd_id,
  @filename, @normalized_filename, @exact_bytes,
  @mime_type, @streamable, @generated_at,
  @first_seen_at, @last_seen_at,
  @parsed_title, @parsed_year, @season, @episode,
  @resolution, @source_type, @codec, @release_group,
  @parser_confidence
);
`;

const SELECT_ALL_RD_DOWNLOAD_OBSERVATIONS = `
SELECT * FROM rd_download_observations
ORDER BY generated_at ASC, source_event_id ASC;
`;

const SELECT_RD_DOWNLOAD_OBS_BY_FILENAME_BYTES = `
SELECT * FROM rd_download_observations
WHERE provider = @provider AND source_id = @source_id
  AND normalized_filename = @normalized_filename
  AND exact_bytes = @exact_bytes
ORDER BY generated_at ASC, source_event_id ASC;
`;

const COUNT_RD_DOWNLOAD_OBSERVATIONS = `
SELECT COUNT(*) AS n FROM rd_download_observations
WHERE provider = @provider AND source_id = @source_id;
`;

// ============================================================================
// RD /downloads correlation SQL
// ============================================================================

const INSERT_RD_DOWNLOAD_CORRELATION = `
INSERT INTO rd_download_correlations (
  provider, source_id, source_version, source_event_id, rd_id,
  candidate_info_hash, candidate_file_index_key,
  correlation_class, correlation_score, reasons_json, ambiguity_count,
  parsed_filename, exact_bytes, generated_at, correlated_at
) VALUES (
  @provider, @source_id, @source_version, @source_event_id, @rd_id,
  @candidate_info_hash, @candidate_file_index_key,
  @correlation_class, @correlation_score, @reasons_json, @ambiguity_count,
  @parsed_filename, @exact_bytes, @generated_at, @correlated_at
)
ON CONFLICT(provider, source_id, source_event_id, candidate_info_hash, candidate_file_index_key) DO UPDATE SET
  source_version = excluded.source_version,
  correlation_class = excluded.correlation_class,
  correlation_score = excluded.correlation_score,
  reasons_json = excluded.reasons_json,
  ambiguity_count = excluded.ambiguity_count,
  parsed_filename = excluded.parsed_filename,
  exact_bytes = excluded.exact_bytes,
  generated_at = excluded.generated_at,
  correlated_at = excluded.correlated_at;
`;

// Clear the (provider, source_id) partition of correlations. Used at
// the start of a correlation rerun so the table is a pure function
// of the current (observations, candidates) state. The observations
// table is NEVER cleared.
const CLEAR_RD_DOWNLOAD_CORRELATIONS = `
DELETE FROM rd_download_correlations
WHERE provider = @provider AND source_id = @source_id;
`;

const SELECT_ALL_RD_DOWNLOAD_CORRELATIONS = `
SELECT * FROM rd_download_correlations
ORDER BY source_event_id, correlation_score DESC;
`;

const COUNT_RD_DOWNLOAD_CORRELATIONS = `
SELECT COUNT(*) AS n FROM rd_download_correlations
WHERE provider = @provider AND source_id = @source_id;
`;

const COUNT_RD_DOWNLOAD_CORRELATIONS_BY_CLASS = `
SELECT correlation_class, COUNT(*) AS n
FROM rd_download_correlations
WHERE provider = @provider AND source_id = @source_id
GROUP BY correlation_class;
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

// Streaming raw candidates: used by analysis tools that need to walk
// the whole corpus without loading it into memory in one shot. The
// cursor is on (info_hash, file_index_key) so paging is stable and
// uses the primary key index.
const SELECT_RAW_CANDIDATES_PAGE = `
SELECT * FROM candidates
WHERE info_hash > @cursor_info_hash
   OR (info_hash = @cursor_info_hash AND file_index_key > @cursor_file_index_key)
ORDER BY info_hash ASC, file_index_key ASC
LIMIT @limit;
`;

// Batch variant: when you have many search_keys, an IN-clause
// avoids a per-key roundtrip. Caller passes a JSON-serialized array.
const SELECT_CANDIDATES_BY_KEYS = `
SELECT * FROM candidates WHERE search_key IN (
  SELECT value FROM json_each(@search_keys)
) ORDER BY last_seen DESC;
`;

// Token-OR prefilter: returns candidate rows whose filename or title
// contains ANY of the supplied tokens as a word boundary. Used by the
// north-side correlate layer as a coarse prefilter before scoring.
//
// The clause is built with parameterized LIKEs so it stays safe from
// injection. Tokens are passed in as a JSON array; empty/short tokens
// are dropped by the caller before we ever build the SQL.
const SELECT_CANDIDATES_BY_TOKENS_TEMPLATE = `
SELECT * FROM candidates
WHERE {CLAUSE}
ORDER BY last_seen DESC
LIMIT @limit;
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

// Slice 5: provider evidence reconciliation. A fresh transient
// (state=error|unknown) MUST NOT erase a prior known state
// (state=cached|uncached) at the current projection. The history log
// always receives the new event; the current projection is gated so
// the most recent KNOWN state survives a transient disruption.
//
// Concretely: the WHERE clause on the DO UPDATE branch is satisfied
// only when (a) the new observation is at least as recent as the
// current one AND (b) the new observation is NOT a transient that
// would clobber a known current state.
//
// A transient MAY overwrite another transient (e.g. error→unknown is
// allowed; unknown→error is allowed). A known state MAY overwrite a
// transient (cached→unknown is forbidden but unknown→cached is allowed).
// A known state MAY overwrite a known state of a different sign
// (uncached→cached or cached→uncached — fresh contradictions are
// resolved in favor of the newer observation, per spec rule 1+2).
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
WHERE EXCLUDED.observed_at >= provider_observation_current.observed_at
  AND NOT (
    -- A fresh transient MUST NOT erase a known current state.
    EXCLUDED.state IN ('error', 'unknown')
    AND provider_observation_current.state IN ('cached', 'uncached')
  );
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
// Slice 2.6: enforce a single durable handoff slot per media identity
// (media_type, media_id, season, episode). The partial index plus
// ON CONFLICT in persistPlaybackHandoff converts a duplicate insert into
// an upsert against the canonical row, so Seerr resends, retries, and
// concurrent identical requests all converge on the same handoff id.
const PLAYBACK_HANDOFF_IDENTITY_INDEX = 'playback-handoffs-identity-unique-v1';
// Slice 3.0: enforce that within one request, the same physical release
// (info_hash, file_index_key) and the same rank value are each persisted
// at most once. Legacy rows may carry duplicates from upstream
// live-discovery quirks where the same info_hash was reported with two
// different fileIndex representations; the migration collapses them to a
// single row per physical release per request, keeping the lowest-rank
// survivor (highest-priority presentation). The persistence write path
// then uses INSERT OR IGNORE so any future duplicate is silently
// collapsed instead of erroring.
const MEDIA_REQUEST_RESULTS_IDENTITY_INDEX = 'media-request-results-identity-unique-v1';
const MEDIA_REQUEST_RESULTS_RANK_INDEX = 'media-request-results-rank-unique-v1';
// Slice 3.0: marks the FK-enforcement PRAGMA migration. The migration is a
// no-op schema-wise (PRAGMAs are not stored in schema_migrations) but the
// marker record is written so that the production census can confirm FKs
// were ever turned on. Without this record, an existing legacy production
// database could still be missing the PRAGMA application (the PRAGMA is
// re-applied at every open).
const FOREIGN_KEYS_ENFORCED = 'foreign-keys-enforced-v1';
// Slice 4: evidence snapshot provenance. Each persisted media_request_result
// row carries a frozen JSON snapshot of the evidence/projection state that
// the scorer actually saw at ranking time. The snapshot is a historical
// record, not live provider state: it is captured from the SAME ranked
// result object whose score was persisted, then serialized. A schema
// version marker is embedded in the snapshot itself (and mirrored to a
// dedicated column for indexing) so future ranking/evidence models remain
// interpretable without pretending old rows used the current model.
//
// Legacy rows from before this migration remain valid and report snapshot
// unavailable — no destructive backfill is performed.
export const EVIDENCE_SNAPSHOT_VERSION = 1;
const MEDIA_REQUEST_RESULTS_EVIDENCE_SNAPSHOT = 'media-request-results-evidence-snapshot-v1';

// Forbidden fields that must NEVER reach the snapshot. Listed as a
// module-level constant so the snapshot builder is a deterministic
// pure function — no closure state, no implicit dependencies.
const FORBIDDEN_SNAPSHOT_KEYS = new Set([
  'magnet', 'downloadUrl', 'download_url', 'provider', 'providers',
  'auth', 'token', 'apiKey', 'api_key', 'password', 'passwd', 'secret',
  'capability', 'capabilities', 'manifestUrl', 'manifest_url',
  'resolver', 'resolverUrl', 'resolver_url',
]);

/**
 * Slice 4: build a frozen, deterministic, versioned JSON snapshot of the
 * evidence/projection state the scorer actually saw at ranking time.
 * The snapshot is a HISTORICAL record — it must describe what the
 * scorer saw, not what current provider state says now. The build is
 * pure: it reads fields off the input ranked-result object and
 * serializes a stable, sorted JSON object.
 *
 * Forbidden fields (intentionally never extracted): magnet, download_url,
 * provider, capability URLs, auth/token/apiKey/password/secret.
 *
 * Returns { snapshot, version } where:
 *   snapshot: JSON string or null (when no ranked input is available —
 *     e.g. operator-selection rows that pre-date ranking)
 *   version: EVIDENCE_SNAPSHOT_VERSION (1) when a snapshot was built,
 *     null otherwise
 */
export function buildEvidenceSnapshot(result) {
  if (!result || typeof result !== 'object') return { snapshot: null, version: null };
  const justification = result.justification || null;
  const components = result.components || null;
  const contributions = result.contributions || null;
  const sources = Array.isArray(result.sources) ? result.sources : [];
  const providerObservations = Array.isArray(result.providerObservations)
    ? result.providerObservations
    : [];

  const fresh = typeof justification?.freshProviderAvailability === 'number'
    ? justification.freshProviderAvailability
    : (components?.providerAvailability ?? 0);
  const prior = typeof justification?.historicalPrior === 'number'
    ? justification.historicalPrior
    : 0;
  const hasObservations = providerObservations.length > 0;
  let providerAvailabilityState = 'missing';
  if (hasObservations) {
    if (fresh >= 0.5) providerAvailabilityState = 'fresh';
    else if (fresh > 0 || prior > 0) providerAvailabilityState = 'historical';
    else providerAvailabilityState = 'stale';
  } else if (prior > 0) {
    providerAvailabilityState = 'historical';
  } else if (result.hasLiveDiscovery === true) {
    providerAvailabilityState = 'fresh';
  }

  let providerEvidenceObservedAt = null;
  for (const o of providerObservations) {
    const t = Number(o?.observedAt ?? o?.checked_at ?? o?.checkedAt);
    if (Number.isFinite(t) && (providerEvidenceObservedAt == null || t > providerEvidenceObservedAt)) {
      providerEvidenceObservedAt = t;
    }
  }
  const providerEvidenceFreshness = providerEvidenceObservedAt != null
    ? Math.max(0, Date.now() - providerEvidenceObservedAt)
    : null;

  const sourceFamilies = Array.from(new Set(
    sources.map((s) => (s && typeof s === 'object' ? s.origin : null))
      .filter((o) => typeof o === 'string' && o.length > 0),
  )).sort();

  const reasonKeys = contributions && typeof contributions === 'object'
    ? Object.keys(contributions)
      .filter((k) => !FORBIDDEN_SNAPSHOT_KEYS.has(k))
      .sort((a, b) => {
        const diff = (contributions[b] || 0) - (contributions[a] || 0);
        if (diff !== 0) return diff;
        return a < b ? -1 : a > b ? 1 : 0;
      })
    : [];

  const projection = {
    version: EVIDENCE_SNAPSHOT_VERSION,
    providerAvailabilityState,
    providerEvidenceFreshness,
    providerEvidenceObservedAt,
    historicalPrior: prior,
    freshProviderAvailability: fresh,
    identityConfidence: typeof result.identity?.confidence === 'number'
      ? result.identity.confidence
      : (components?.identityConfidence ?? 0),
    confidenceProjection: components?.providerAvailability ?? fresh,
    rankingBreakdown: components && contributions
      ? {
          components: Object.fromEntries(
            Object.entries(components)
              .filter(([k]) => !FORBIDDEN_SNAPSHOT_KEYS.has(k))
              .map(([k, v]) => [k, typeof v === 'number' ? v : 0]),
          ),
          contributions: Object.fromEntries(
            Object.entries(contributions)
              .filter(([k]) => !FORBIDDEN_SNAPSHOT_KEYS.has(k))
              .map(([k, v]) => [k, typeof v === 'number' ? v : 0]),
          ),
          weights: justification && justification.weights
            ? Object.fromEntries(
              Object.entries(justification.weights)
                .filter(([k]) => !FORBIDDEN_SNAPSHOT_KEYS.has(k))
                .map(([k, v]) => [k, typeof v === 'number' ? v : 0]),
            )
            : null,
        }
      : null,
    rankingReasons: reasonKeys,
    sourceFamilies,
    eligibilityReason: typeof result.identity?.ineligibleReason === 'string'
      ? result.identity.ineligibleReason
      : null,
    eligibilityCode: typeof result.identity?.ineligibleCode === 'string'
      ? result.identity.ineligibleCode
      : null,
    expectedMediaScope: typeof result.identity?.expectedMediaScope === 'string'
      ? result.identity.expectedMediaScope
      : null,
    parsedCandidateScope: typeof result.identity?.parsedCandidateScope === 'string'
      ? result.identity.parsedCandidateScope
      : null,
  };

  return {
    snapshot: JSON.stringify(projection),
    version: EVIDENCE_SNAPSHOT_VERSION,
  };
}

// Slice 2.6: enforce a single durable handoff slot per media identity so
// duplicate / concurrent persistPlaybackHandoff calls converge on the same
// row. Older databases may carry many duplicate rows for the same media
// slot; the migration deduplicates first (keeping the most-recent
// authoritative handoff when one exists, otherwise the most-recent row)
// before installing the unique index. Without dedupe the CREATE UNIQUE
// INDEX would fail on production data.
function migratePlaybackHandoffsIdentityUnique(db) {
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(PLAYBACK_HANDOFF_IDENTITY_INDEX);
  if (applied) return;

  // Dedupe existing rows. Authoritative rows (torrent_file_id IS NOT NULL)
  // win over legacy rows (NULL); ties broken by id DESC. Older databases
  // can carry many duplicate rows for the same media slot; we keep the
  // survivor per (media_type, media_id, season, episode) group and delete
  // the rest before installing the unique index.
  const fullRows = db.prepare(`
    SELECT h.id, h.media_type, h.media_id, h.season, h.episode, h.torrent_file_id
    FROM playback_handoffs h
  `).all();
  const groupMap = new Map();
  for (const row of fullRows) {
    const key = `${row.media_type}|${row.media_id}|${row.season ?? -1}|${row.episode ?? -1}`;
    const cur = groupMap.get(key);
    const authoritative = row.torrent_file_id != null ? 1 : 0;
    if (!cur
      || authoritative > cur.authoritative
      || (authoritative === cur.authoritative && row.id > cur.id)) {
      groupMap.set(key, { id: row.id, authoritative });
    }
  }
  const survivorIds = new Set(Array.from(groupMap.values()).map((v) => v.id));
  const toDelete = fullRows.map((r) => r.id).filter((id) => !survivorIds.has(id));
  if (toDelete.length > 0) {
    const stmt = db.prepare('DELETE FROM playback_handoffs WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of toDelete) stmt.run(id);
      db.prepare(
        'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
      ).run(PLAYBACK_HANDOFF_IDENTITY_INDEX, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else {
    db.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    ).run(PLAYBACK_HANDOFF_IDENTITY_INDEX, Date.now());
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_playback_handoffs_identity
    ON playback_handoffs(
      media_type,
      media_id,
      IFNULL(season, -1),
      IFNULL(episode, -1)
    )
  `);
}

// Slice 3.0: enforce that within one persisted request, the same physical
// release (info_hash, file_index_key) is stored at most once, and that
// rank values are also unique. Legacy prod data carries duplicates from
// upstream live-discovery quirks where the same info_hash was reported
// with two different fileIndex representations (e.g. fileIndex=0 vs
// fileIndex=null/fileIndex=-1). The migration collapses them to a single
// row per physical release per request, keeping the lowest-rank survivor
// (highest-priority presentation) so the audit trail still shows the
// rank the user was shown. The write path then uses INSERT OR IGNORE
// so any future duplicate is silently collapsed.
function migrateMediaRequestResultsIdentityUnique(db) {
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(MEDIA_REQUEST_RESULTS_IDENTITY_INDEX);
  if (applied) return;

  // Dedupe existing (request_id, info_hash, file_index_key) groups.
  // Strategy: for each group, keep the row with the lowest rank (most
  // visible in the UI); delete the rest. The lowest-rank survivor
  // also preserves the rank value, so we do not need to re-rank.
  const allRows = db.prepare(`
    SELECT r.id, r.request_id, r.info_hash, r.file_index_key, r.rank
    FROM media_request_results r
  `).all();
  const groupMap = new Map();
  for (const row of allRows) {
    const key = `${row.request_id}|${row.info_hash}|${row.file_index_key}`;
    const cur = groupMap.get(key);
    if (!cur || row.rank < cur.rank) {
      groupMap.set(key, { id: row.id, rank: row.rank });
    }
  }
  const survivorIds = new Set(Array.from(groupMap.values()).map((v) => v.id));
  const toDelete = allRows.map((r) => r.id).filter((id) => !survivorIds.has(id));
  if (toDelete.length > 0) {
    const deleteStmt = db.prepare('DELETE FROM media_request_results WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of toDelete) deleteStmt.run(id);
      db.prepare(
        'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
      ).run(MEDIA_REQUEST_RESULTS_IDENTITY_INDEX, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else {
    db.prepare(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
    ).run(MEDIA_REQUEST_RESULTS_IDENTITY_INDEX, Date.now());
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_request_results_identity
    ON media_request_results(request_id, info_hash, file_index_key)
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_request_results_rank
    ON media_request_results(request_id, rank)
  `);
}

// Slice 4: add the evidence_snapshot / evidence_snapshot_version columns to
// media_request_results. Existing rows keep NULL — they are valid legacy
// rows and report snapshot unavailable on read. No destructive backfill:
// historical evidence cannot be reconstructed for rows persisted under a
// previous ranking model.
function migrateMediaRequestResultsEvidenceSnapshot(db) {
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(MEDIA_REQUEST_RESULTS_EVIDENCE_SNAPSHOT);
  if (applied) return;
  const info = db.prepare('PRAGMA table_info(media_request_results)').all();
  if (!info.some((col) => col.name === 'evidence_snapshot')) {
    db.exec('ALTER TABLE media_request_results ADD COLUMN evidence_snapshot TEXT');
  }
  if (!info.some((col) => col.name === 'evidence_snapshot_version')) {
    db.exec('ALTER TABLE media_request_results ADD COLUMN evidence_snapshot_version INTEGER');
  }
  db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  ).run(MEDIA_REQUEST_RESULTS_EVIDENCE_SNAPSHOT, Date.now());
}

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

// =============================================================================
// Historical provider evidence: introduce per-event identity.
//
// The sightings PK used to be (info_hash, file_index_key, provider,
// evidence_type, source_id, source_version). This meant a second
// acquisition of the same cumulative source (e.g. an RD history
// re-read with a new acquisition timestamp) would treat the
// source_version change as a brand-new batch of sightings, which is
// wrong: repeated acquisition frequency must NOT strengthen
// historical evidence.
//
// This migration:
//   1. Adds a source_event_id column (TEXT NOT NULL DEFAULT '').
//      For rows that pre-date the per-event identity, the column is
//      backfilled with a deterministic legacy value derived from
//      source_version|info_hash|file_index_key, which preserves the
//      original snapshot-membership uniqueness for non-event-derived
//      sources (e.g. DMM-corpus witnesses).
//   2. Recreates the table with the new PRIMARY KEY
//      (info_hash, file_index_key, provider, evidence_type, source_id,
//       source_event_id) and copies rows in. Collisions on the new PK
//      are not possible: the legacy value already incorporates all
//      fields that made the old PK unique, so each row maps to a
//      distinct (provider, source_id, source_event_id) tuple.
//   3. Recreates the dependent indexes.
//   4. Recomputes the aggregate distinct_snapshot_count using
//      COUNT(DISTINCT source_version) — see the new UPSERT in SCHEMA.
//
// Fresh installs: SCHEMA's CREATE TABLE includes the new column
// and PK, so this migration is a no-op for them.
// =============================================================================
const HISTORICAL_PROVIDER_EVENT_ID_MIGRATION = 'historical-provider-event-id-v1';
const RD_DOWNLOADS_SCHEMA_MIGRATION = 'rd-downloads-raw-observations-v1';

function migrateRdDownloadsSchema(db) {
  // Idempotent: the SCHEMA above already runs CREATE TABLE IF NOT
  // EXISTS for the new tables. This migration only exists to mark
  // the application of these tables in schema_migrations so future
  // schema-evolution work can rely on a recorded "this database
  // has been opened by a version that knows about /downloads
  // observations" marker. The marker carries no data and is
  // recorded on every fresh open (idempotent INSERT OR IGNORE
  // semantics are not needed because schema_migrations PK is the
  // name itself).
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(RD_DOWNLOADS_SCHEMA_MIGRATION);
  if (applied) return;

  // Defensive: SCHEMA above creates these tables, but if a caller
  // wired a pre-existing database (e.g. a restored backup from a
  // version of HashSucker that never had the SCHEMA block) we
  // still want them present.
  db.exec(CREATE_RD_DOWNLOAD_OBSERVATIONS);
  db.exec(CREATE_RD_DOWNLOAD_OBSERVATIONS_INDEXES);
  db.exec(CREATE_RD_DOWNLOAD_CORRELATIONS);
  db.exec(CREATE_RD_DOWNLOAD_CORRELATIONS_INDEXES);

  db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  ).run(RD_DOWNLOADS_SCHEMA_MIGRATION, Date.now());
}

function migrateHistoricalProviderEvidenceEventId(db) {
  const applied = db.prepare(
    'SELECT 1 FROM schema_migrations WHERE name = ?',
  ).get(HISTORICAL_PROVIDER_EVENT_ID_MIGRATION);
  if (applied) return;

  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='historical_provider_evidence_sightings'"
  ).get();
  if (!tableExists) return; // fresh install — SCHEMA creates the new shape

  const cols = db.prepare('PRAGMA table_info(historical_provider_evidence_sightings)').all();
  const hasEventId = cols.some((c) => c.name === 'source_event_id');
  if (!hasEventId) {
    // Add the column with a non-empty default so existing rows get a
    // stable legacy event id. We backfill below.
    db.exec(`ALTER TABLE historical_provider_evidence_sightings
             ADD COLUMN source_event_id TEXT NOT NULL DEFAULT ''`);
  }

  // Backfill any row that has the empty default. Use the deterministic
  // legacy value `legacy:<source_version>:<info_hash>:<file_index_key>`.
  // This preserves the old PK's uniqueness for non-event-derived
  // sources: V1 hashA fileIndex=0 → distinct id; V2 hashA fileIndex=0
  // → distinct id (the V1/V2 versions were the original snapshot
  // discriminator and remain so via this synthesized id).
  db.exec(`
    UPDATE historical_provider_evidence_sightings
       SET source_event_id = 'legacy:' || source_version
                              || ':' || info_hash
                              || ':' || file_index_key
     WHERE source_event_id = ''
  `);

  // Detect the PK shape. If the PK is already keyed on source_event_id,
  // we are done — only the backfill + aggregate UPSERT are needed.
  // Otherwise, rebuild the table.
  const pkInfo = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='historical_provider_evidence_sightings'"
  ).get();
  const pkSql = pkInfo ? String(pkInfo.sql) : '';
  const needsRebuild = !/PRIMARY KEY\s*\([^)]*source_event_id/i.test(pkSql);

  if (needsRebuild) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Move the existing data aside, then rebuild under the new shape.
      // We use a unique temp name to avoid clashing with future migrations.
      db.exec(`
        ALTER TABLE historical_provider_evidence_sightings
          RENAME TO historical_provider_evidence_sightings__legacy_pre_event;
      `);
      // Recreate the table with the new PK (matches SCHEMA's
      // CREATE TABLE IF NOT EXISTS so a re-run after a fresh SCHEMA
      // also lines up byte-for-byte).
      db.exec(`
        CREATE TABLE historical_provider_evidence_sightings (
          info_hash TEXT NOT NULL,
          file_index_key INTEGER NOT NULL DEFAULT -1,
          provider TEXT NOT NULL,
          evidence_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_version TEXT NOT NULL,
          source_event_id TEXT NOT NULL DEFAULT '',
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          observation_count INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (info_hash, file_index_key, provider, evidence_type, source_id, source_event_id)
        );
      `);
      db.exec(`
        INSERT INTO historical_provider_evidence_sightings
          (info_hash, file_index_key, provider, evidence_type, source_id,
           source_version, source_event_id, first_seen_at, last_seen_at,
           observation_count)
        SELECT info_hash, file_index_key, provider, evidence_type, source_id,
               source_version, source_event_id, first_seen_at, last_seen_at,
               observation_count
        FROM historical_provider_evidence_sightings__legacy_pre_event;
      `);
      db.exec('DROP TABLE historical_provider_evidence_sightings__legacy_pre_event;');
      // Recreate indexes (the SCHEMA does this too, but we are not
      // re-running SCHEMA here; fresh installs rely on SCHEMA's
      // CREATE INDEX IF NOT EXISTS).
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_hpe_sightings_candidate
          ON historical_provider_evidence_sightings(info_hash, file_index_key);
        CREATE INDEX IF NOT EXISTS idx_hpe_sightings_source
          ON historical_provider_evidence_sightings(provider, source_id, source_version);
        CREATE INDEX IF NOT EXISTS idx_hpe_sightings_event
          ON historical_provider_evidence_sightings(provider, source_id, source_event_id);
      `);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  // Recompute the aggregate from the rebuilt sightings so that
  // distinct_snapshot_count = COUNT(DISTINCT source_version) lines
  // up with the new UPSERT semantics. We do this by re-running the
  // aggregate UPSERT for every distinct (provider, source_id,
  // evidence_type, info_hash, file_index_key) tuple.
  db.exec(`
    INSERT INTO historical_provider_evidence
      (info_hash, file_index_key, provider, account_scope, evidence_type,
       source_id, first_seen_at, last_seen_at, distinct_snapshot_count)
    SELECT
      s.info_hash, s.file_index_key, s.provider, NULL, s.evidence_type,
      s.source_id, MIN(s.first_seen_at), MAX(s.last_seen_at),
      COUNT(DISTINCT s.source_version)
    FROM historical_provider_evidence_sightings s
    GROUP BY s.info_hash, s.file_index_key, s.provider, s.evidence_type, s.source_id
    ON CONFLICT(info_hash, file_index_key, provider, evidence_type, source_id)
    DO UPDATE SET
      first_seen_at           = MIN(historical_provider_evidence.first_seen_at, excluded.first_seen_at),
      last_seen_at            = MAX(historical_provider_evidence.last_seen_at, excluded.last_seen_at),
      distinct_snapshot_count = excluded.distinct_snapshot_count;
  `);

  db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  ).run(HISTORICAL_PROVIDER_EVENT_ID_MIGRATION, Date.now());
}

export function createDiscoveryCache({ dbPath = ':memory:', database = null } = {}) {
  const db = database || new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  // Slice 2.6: bound concurrent-writer wait to absorb the brief lock window
  // when two requests for the same media hit playback_handoffs together.
  // SQLite will retry the write up to 5s instead of failing with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');
  // Slice 3.0: enforce declared foreign keys (request_id → media_requests.id,
  // intent_id → media_intents.id). Without this PRAGMA SQLite parses FK
  // declarations but does not validate them on INSERT/UPDATE/DELETE, so a
  // partial persistMediaRequest failure can leave orphan result rows
  // pointing at a deleted request. The PRAGMA is per-connection so we
  // re-apply on every open. Legacy prod data may already carry 9 orphan
  // result rows (request_ids 157/158/159 no longer exist); these are not
  // touched by the PRAGMA (it does not retroactively validate existing
  // rows) and the audit report marks them as F-1 (pre-existing, out of
  // scope for this slice).
  db.exec('PRAGMA foreign_keys = ON');

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
  migratePlaybackHandoffsIdentityUnique(db);
  migrateMediaRequestResultsIdentityUnique(db);
  migrateMediaRequestResultsEvidenceSnapshot(db);
  // Slice 1.75: the torrent_file_id index can only be created once the
  // column is present. For legacy prod databases, the column is added by
  // migratePlaybackHandoffsTorrentFileId above. For fresh installs the
  // column is part of the SCHEMA CREATE TABLE.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_playback_handoffs_torrent_file '
    + 'ON playback_handoffs(torrent_file_id)'
  );
  migrateCacheProbeQueue(db);
  migrateHistoricalProviderEvidenceEventId(db);
  migrateRdDownloadsSchema(db);

  const insertCandidateStmt = db.prepare(INSERT_CANDIDATE);
  const getCandidateStmt = db.prepare(GET_CANDIDATE);
  const insertObservationEventStmt = db.prepare(INSERT_OBSERVATION_EVENT);
  const upsertCurrentObservationStmt = db.prepare(UPSERT_CURRENT_OBSERVATION);
  const getCurrentObservationsStmt = db.prepare(GET_CURRENT_OBSERVATIONS);
  const getObservationHistoryStmt = db.prepare(GET_OBSERVATION_HISTORY);
  const selectAllCandidatesStmt = db.prepare(SELECT_ALL_CANDIDATES);
  const selectCandidatesByKeyStmt = db.prepare(SELECT_CANDIDATES_BY_KEY);
  const selectCandidatesByKeysStmt = db.prepare(SELECT_CANDIDATES_BY_KEYS);
  const selectRawCandidatesPageStmt = db.prepare(SELECT_RAW_CANDIDATES_PAGE);
  const insertMediaAssocStmt = db.prepare(INSERT_MEDIA_ASSOCIATION);
  const upsertMediaAssocStmt = db.prepare(UPSERT_MEDIA_ASSOCIATION);
  const getMediaAssocStmt = db.prepare(GET_MEDIA_ASSOCIATIONS);
  const getCandidatesByMediaStmt = db.prepare(GET_CANDIDATES_BY_MEDIA);
  const insertReleaseAttributesStmt = db.prepare(INSERT_RELEASE_ATTRIBUTES);
  const getReleaseAttributesStmt = db.prepare(GET_RELEASE_ATTRIBUTES);
  const getReleaseAttributesBySourceStmt = db.prepare(GET_RELEASE_ATTRIBUTES_BY_SOURCE);
  const getCandidatesWithoutAttributesStmt = db.prepare(GET_CANDIDATES_WITHOUT_ATTRIBUTES);
  const insertGenerationStmt = db.prepare(INSERT_GENERATION);
  const updateGenerationProgressStmt = db.prepare(UPDATE_GENERATION_PROGRESS);
  const completeGenerationStmt = db.prepare(COMPLETE_GENERATION);
  const getGenerationStmt = db.prepare(GET_GENERATION);
  const getCurrentCompleteGenerationStmt = db.prepare(GET_CURRENT_COMPLETE_GENERATION);
  const insertSourceObservationStmt = db.prepare(INSERT_SOURCE_OBSERVATION);
  const touchSourceObservationStmt = db.prepare(TOUCH_SOURCE_OBSERVATION);
  const selectStaleObservationsStmt = db.prepare(SELECT_STALE_OBSERVATIONS);
  const selectStaleFragmentsStmt = db.prepare(SELECT_STALE_FRAGMENTS);
  const selectPruneEligibleCandidatesStmt = db.prepare(SELECT_PRUNE_ELIGIBLE_CANDIDATES);
  const selectPruneEligibleAttributesStmt = db.prepare(SELECT_PRUNE_ELIGIBLE_ATTRIBUTES);
  const selectObservationsForCandidateStmt = db.prepare(SELECT_OBSERVATIONS_FOR_CANDIDATE);
  const countObservationsStmt = db.prepare(COUNT_OBSERVATIONS);
  // Historical provider evidence (source-vs-snapshot model)
  const insertHistoricalProviderSightingStmt = db.prepare(INSERT_HISTORICAL_PROVIDER_SIGHTING);
  const upsertHistoricalProviderEvidenceStmt = db.prepare(UPSERT_HISTORICAL_PROVIDER_EVIDENCE);
  const selectHistoricalProviderEvidenceForCandidateStmt = db.prepare(SELECT_HISTORICAL_PROVIDER_EVIDENCE_FOR_CANDIDATE);
  const countHistoricalProviderEvidenceStmt = db.prepare(COUNT_HISTORICAL_PROVIDER_EVIDENCE);
  const countHistoricalProviderSightingsStmt = db.prepare(COUNT_HISTORICAL_PROVIDER_SIGHTINGS);
  const countHistoricalProviderEvidenceForCandidateStmt = db.prepare(COUNT_HISTORICAL_PROVIDER_EVIDENCE_FOR_CANDIDATE);
  const countHistoricalProviderSightingsForCandidateStmt = db.prepare(COUNT_HISTORICAL_PROVIDER_SIGHTINGS_FOR_CANDIDATE);
  // RD /downloads raw observations + correlations
  const insertRdDownloadObservationStmt = db.prepare(INSERT_RD_DOWNLOAD_OBSERVATION);
  const selectAllRdDownloadObservationsStmt = db.prepare(SELECT_ALL_RD_DOWNLOAD_OBSERVATIONS);
  const selectRdDownloadObservationsByFileBytesStmt = db.prepare(SELECT_RD_DOWNLOAD_OBS_BY_FILENAME_BYTES);
  const countRdDownloadObservationsStmt = db.prepare(COUNT_RD_DOWNLOAD_OBSERVATIONS);
  const insertRdDownloadCorrelationStmt = db.prepare(INSERT_RD_DOWNLOAD_CORRELATION);
  const clearRdDownloadCorrelationsStmt = db.prepare(CLEAR_RD_DOWNLOAD_CORRELATIONS);
  const selectAllRdDownloadCorrelationsStmt = db.prepare(SELECT_ALL_RD_DOWNLOAD_CORRELATIONS);
  const countRdDownloadCorrelationsStmt = db.prepare(COUNT_RD_DOWNLOAD_CORRELATIONS);
  const countRdDownloadCorrelationsByClassStmt = db.prepare(COUNT_RD_DOWNLOAD_CORRELATIONS_BY_CLASS);


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

  // ==========================================================================
  // DMM source provenance — generation lifecycle
  // ==========================================================================

  /**
   * Begin a new DMM ingestion generation, or resume an existing one.
   * Idempotent: INSERT OR IGNORE semantics preserve existing started_at.
   * Must be called BEFORE processing any fragments of a new generation.
   *
   * @param {Object} opts
   * @param {string} opts.generationId  - stable generation identifier (tree_sha)
   * @param {string} opts.source        - ingestion source name
   * @param {string} [opts.treeSha]      - DMM tree SHA (set to generationId if omitted)
   * @returns {Object|null} generation row or null on error
   */
  function startDmmGeneration({ generationId, source = 'dmm-hashlist', treeSha = null } = {}) {
    if (!generationId) return null;
    try {
      insertGenerationStmt.run({
        generation_id: generationId,
        source,
        tree_sha: treeSha || generationId,
        started_at: Date.now(),
      });
      return getGenerationStmt.get(generationId) || null;
    } catch {
      return null;
    }
  }

  /**
   * Record per-fragment processing progress on a running generation.
   * Called from flushBatch and from per-fragment complete/incomplete paths.
   * Does NOT change generation status; call completeDmmGeneration for that.
   *
   * @param {string} generationId
   * @param {Object} delta - records_seen_delta, fragments_total, fragments_complete, fragments_failed
   */
  function updateDmmGenerationProgress(generationId, delta = {}) {
    if (!generationId) return;
    try {
      updateGenerationProgressStmt.run({
        generation_id: generationId,
        records_seen_delta: delta.recordsSeenDelta ?? 0,
        fragments_total: delta.fragmentsTotal ?? 0,
        fragments_complete: delta.fragmentsComplete ?? 0,
        fragments_failed: delta.fragmentsFailed ?? 0,
      });
    } catch { /* swallow */ }
  }

  /**
   * Mark a generation as complete, incomplete, or failed.
   * Only 'complete' generations are consulted for stale detection.
   *
   * @param {string} generationId
   * @param {string} status - 'complete' | 'incomplete' | 'failed'
   * @param {Object} [counts] - fragments_total, fragments_complete, fragments_failed
   */
  function completeDmmGeneration(generationId, status = 'complete', counts = {}) {
    if (!generationId) return;
    try {
      completeGenerationStmt.run({
        generation_id: generationId,
        completed_at: status === 'complete' ? Date.now() : null,
        fragments_total: counts.fragmentsTotal ?? 0,
        fragments_complete: counts.fragmentsComplete ?? 0,
        fragments_failed: counts.fragmentsFailed ?? 0,
        status,
      });
    } catch { /* swallow */ }
  }

  /**
   * Get a generation by ID.
   * @param {string} generationId
   * @returns {Object|null}
   */
  function getDmmGeneration(generationId) {
    if (!generationId) return null;
    try {
      return getGenerationStmt.get(generationId) || null;
    } catch {
      return null;
    }
  }

  /**
   * Get the most recently COMPLETED generation for a source.
   * This is the generation used for stale detection queries.
   * Only 'complete' status is consulted — interrupted generations are invisible.
   *
   * @param {string} [source] - defaults to 'dmm-hashlist'
   * @returns {Object|null}
   */
  function getCurrentDmmGeneration(source = 'dmm-hashlist') {
    try {
      return getCurrentCompleteGenerationStmt.get(source) || null;
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // DMM source provenance — per-fragment observation recording
  // ==========================================================================

  /**
   * Record source observations for ingested candidate entries.
   * Called INSIDE the same flushBatch transaction so that observations and
   * candidate upserts are co-atomic.
   *
   * Idempotent: INSERT OR IGNORE on (info_hash, file_index_key, source,
   * fragment_name, generation_id) means re-processing the same fragment in the
   * same or a subsequent generation is a no-op for already-observed records.
   * The TOUCH step updates last_seen_at for already-present rows so repeated
   * observation is monotonically timestamped without amplifying rows.
   *
   * @param {Object} opts
   * @param {string} opts.source        - ingestion source ('dmm-hashlist')
   * @param {string} opts.fragmentName - fragment identifier (e.g. '2024-01-fragment.html')
   * @param {string} opts.generationId - tree_sha of the DMM tree being ingested
   * @param {Array}  opts.entries      - candidate entries from ingestCandidates
   * @param {number} [opts.now]        - timestamp (defaults to Date.now())
   */
  function recordDmmSourceObservations({
    source = 'dmm-hashlist',
    fragmentName,
    generationId,
    entries = [],
    now = Date.now(),
  } = {}) {
    if (!generationId || !fragmentName || entries.length === 0) return;
    for (const entry of entries) {
      const fik = fileIndexKey(entry.fileIndex);
      // INSERT OR IGNORE: first observation of this (candidate, source, fragment, gen)
      // creates the row. Subsequent calls for the same composite key are no-ops
      // at this step.
      insertSourceObservationStmt.run({
        info_hash: entry.infoHash,
        file_index_key: fik,
        source,
        fragment_name: fragmentName,
        generation_id: generationId,
        first_seen_at: now,
        last_seen_at: now,
        records_seen: 1,
      });
      // TOUCH: update last_seen_at and records_seen for already-existing rows.
      // This handles the case where the same fragment is re-processed (e.g. retry)
      // or where multiple entries for the same candidate arrive in the same batch.
      touchSourceObservationStmt.run({
        info_hash: entry.infoHash,
        file_index_key: fik,
        source,
        fragment_name: fragmentName,
        generation_id: generationId,
        last_seen_at: now,
        records_seen_delta: 1,
      });
    }
  }

  // ==========================================================================
  // DMM source provenance — stale detection queries
  // ==========================================================================

  /**
   * Find observations present in prevGeneration but absent in currentGeneration.
   * Used to surface candidates and fragments that disappeared between generations.
   * Safe to call even when currentGeneration is still running (results may be
   * partial until the generation is marked complete).
   *
   * @param {string} prevGeneration - generation ID of the older generation
   * @param {string} currentGeneration - generation ID of the newer generation
   * @returns {Array} rows with info_hash, file_index_key, source, fragment_name, generation_id
   */
  function findStaleObservations(prevGeneration, currentGeneration) {
    if (!prevGeneration || !currentGeneration) return [];
    try {
      return selectStaleObservationsStmt.all({
        prev_generation: prevGeneration,
        current_generation: currentGeneration,
      });
    } catch {
      return [];
    }
  }

  /**
   * Find fragment names that appeared in prevGeneration but are absent from
   * currentGeneration. Indicates which source fragments have been removed from
   * the DMM tree entirely.
   *
   * @param {string} prevGeneration
   * @param {string} currentGeneration
   * @returns {Array} rows with source, fragment_name
   */
  function findStaleFragments(prevGeneration, currentGeneration) {
    if (!prevGeneration || !currentGeneration) return [];
    try {
      return selectStaleFragmentsStmt.all({
        prev_generation: prevGeneration,
        current_generation: currentGeneration,
      });
    } catch {
      return [];
    }
  }

  /**
   * Find candidate identities with ZERO active source observations in the
   * given generation. These are candidates that cannot be justified by any
   * source observation in currentGeneration.
   *
   * IMPORTANT: only call this when currentGeneration is status='complete'.
   * Calling it on a running or incomplete generation will over-report stale
   * candidates because the generation has not yet been fully observed.
   *
   * @param {string} currentGeneration
   * @returns {Array} rows with info_hash, file_index_key
   */
  function findPruneEligibleCandidates(currentGeneration) {
    if (!currentGeneration) return [];
    try {
      return selectPruneEligibleCandidatesStmt.all({ current_generation: currentGeneration });
    } catch {
      return [];
    }
  }

  /**
   * Find release_attributes rows with ZERO active source observations in the
   * given generation. These are attributes that cannot be justified by any
   * source observation in currentGeneration.
   *
   * @param {string} currentGeneration
   * @returns {Array} rows with info_hash, file_index_key, source
   */
  function findPruneEligibleAttributes(currentGeneration) {
    if (!currentGeneration) return [];
    try {
      return selectPruneEligibleAttributesStmt.all({ current_generation: currentGeneration });
    } catch {
      return [];
    }
  }

  /**
   * Get all source observations for a specific candidate identity.
   * Returns observations across all generations, newest generation first.
   * Used to determine whether a prune-eligible candidate is still justified
   * by another source/generation before any pruning action is taken.
   *
   * @param {string} infoHash
   * @param {number} [fileIndex]
   * @returns {Array} rows with source, fragment_name, generation_id, timestamps
   */
  function getDmmObservationsForCandidate(infoHash, fileIndex = null) {
    if (!infoHash) return [];
    try {
      return selectObservationsForCandidateStmt.all({
        info_hash: infoHash,
        file_index_key: fileIndexKey(fileIndex),
      });
    } catch {
      return [];
    }
  }

  /**
   * Count total observations in a generation. Useful for estimating backfill
   * scope and verifying generation population.
   *
   * @param {string} generationId
   * @returns {number}
   */
  function countDmmObservations(generationId) {
    if (!generationId) return 0;
    try {
      return countObservationsStmt.get(generationId)?.n ?? 0;
    } catch {
      return 0;
    }
  }

  // =========================================================================
  // Historical provider evidence
  //
  // Bounded, idempotent batch ingest for persistent corpus-membership signals.
  // This is intentionally DECOUPLED from current provider observations:
  //   - Fresh RD probe results → provider_observation_events + _current
  //   - Historical RD history  → historical_provider_evidence
  // They have different lifecycles and feed different confidence axes.
  // =========================================================================

  /**
   * Validate that a string is a plausible hexadecimal BitTorrent v1
   * info hash (SHA-1, 40 lowercase/uppercase hex chars).
   *
   * HashSucker's canonical candidate identity uses BitTorrent v1
   * infohashes; there is no in-tree BitTorrent v2 / SHA-256 path.
   * Accepting 64-char SHA-256 here would let historical evidence rows
   * exist that cannot be joined to a `candidates` row. We therefore
   * enforce the 40-char rule explicitly and reject everything else,
   * matching the candidate ingestion convention used elsewhere in
   * the project.
   *
   * @param {string} hash
   * @returns {boolean}
   */
  function isValidInfoHash(hash) {
    if (typeof hash !== 'string' || hash.length === 0) return false;
    return /^[a-fA-F0-9]{40}$/.test(hash);
  }

  /**
   * Ingest a bounded batch of historical provider evidence.
   *
   * Source-vs-snapshot semantics:
   *
   *   A historical evidence *aggregate* is identified by:
   *     (provider, source_id, infoHash, fileIndexKey, evidenceType)
   *
   *   A *snapshot* is one concrete instance of that witness (a specific
   *   source_version of a source_id, e.g. an export file dated 2025-01).
   *
   *   Replay contract:
   *     Re-ingesting the same (source_id, source_version) snapshot is a
   *     no-op. The sightings table's PRIMARY KEY is the snapshot-membership
   *     identity, so INSERT OR IGNORE is the entire idempotency story.
   *     The aggregate is recomputed from the sightings so replay produces
   *     byte-identical logical state.
   *
   *     A genuinely NEW source_version creates a NEW sightings row and
   *     bumps distinct_snapshot_count. A genuinely NEW source_id
   *     creates a NEW sightings row AND a NEW aggregate row, which
   *     is the unit of corroboration at query time.
   *
   *   source_version is REQUIRED (non-empty) for this contract. An empty
   *   source_version would let two genuinely different snapshots of the
   *   same source collapse into the same row, defeating replay.
   *
   * @param {Object} opts
   * @param {string} opts.provider         - provider name (e.g. 'realdebrid')
   * @param {string} opts.sourceId           - identifier of the INDEPENDENT
   *                                            historical source (e.g. an
   *                                            RD export lineage)
   * @param {string} opts.sourceVersion      - version/snapshot of that source
   *                                            (e.g. 'snapshot-2025-01').
   *                                            Required for replay safety.
   * @param {Array}  opts.observations     - array of observation objects
   * @param {number} [opts.now]             - current timestamp (default Date.now())
   * @param {string} [opts.accountScope]    - account scope if applicable (default null)
   * @param {string} [opts.evidenceType]   - evidence type (default 'historical_hit')
   * @returns {{ ingested: number, skipped: number, errors: Array,
   *            snapshots: number, aggregateRows: number }}
   */
  function ingestHistoricalProviderEvidence({
    provider,
    sourceId,
    sourceVersion,
    observations = [],
    now = Date.now(),
    accountScope = null,
    evidenceType = 'historical_hit',
  } = {}) {
    if (!provider || typeof provider !== 'string') {
      return { ingested: 0, skipped: 0, errors: [{ message: 'provider is required' }], snapshots: 0, aggregateRows: 0 };
    }
    if (!sourceId || typeof sourceId !== 'string') {
      return { ingested: 0, skipped: 0, errors: [{ message: 'sourceId is required' }], snapshots: 0, aggregateRows: 0 };
    }
    // sourceVersion is REQUIRED (non-empty string). An empty sourceVersion
    // would let two genuinely different snapshots of the same source
    // collapse into one row, defeating replay idempotency.
    if (typeof sourceVersion !== 'string' || sourceVersion.length === 0) {
      return {
        ingested: 0, skipped: 0,
        errors: [{ message: 'sourceVersion is required (snapshot identity must be tracked)' }],
        snapshots: 0, aggregateRows: 0,
      };
    }
    if (!Array.isArray(observations) || observations.length === 0) {
      return { ingested: 0, skipped: 0, errors: [], snapshots: 0, aggregateRows: 0 };
    }

    const errors = [];
    let ingested = 0;
    let inserted = 0;
    let skipped = 0;

    // Bounded transaction: process in one atomic unit.
    // Uses IMMEDIATE to acquire a RESERVED lock early, reducing lock contention
    // on long-running imports.
    db.exec('BEGIN IMMEDIATE');
    try {
      // Track the set of (infoHash, fileIndexKey) pairs that got a NEW
      // sighting row in this batch so we can recompute the aggregate
      // for each of them. A replay that inserts zero rows is a no-op
      // here (the sightings table is unchanged, the aggregate is unchanged).
      const affectedCandidates = new Set();

      for (const obs of observations) {
        // Normalize infoHash: lowercase hex
        const infoHash = typeof obs.infoHash === 'string'
          ? obs.infoHash.toLowerCase()
          : null;

        // Reject malformed hashes. The historical evidence store mirrors
        // the candidate identity rules: 40-char SHA-1 hex only.
        if (!infoHash || !isValidInfoHash(infoHash)) {
          errors.push({
            infoHash: obs.infoHash,
            message: 'invalid infoHash: must be a 40 character SHA-1 hex string',
          });
          skipped++;
          continue;
        }

        const fik = obs.fileIndex == null ? -1 : obs.fileIndex;
        const firstSeenAt = typeof obs.firstSeenAt === 'number' && obs.firstSeenAt > 0
          ? obs.firstSeenAt
          : now;
        const lastSeenAt = typeof obs.lastSeenAt === 'number' && obs.lastSeenAt > 0
          ? obs.lastSeenAt
          : now;
        const delta = typeof obs.observationCount === 'number' && obs.observationCount > 0
          ? obs.observationCount
          : 1;

        // sourceEventId is the stable, source-derived event identity.
        // When the caller (e.g. RD acquirer) supplies one, it is used
        // verbatim as the PK member. When absent, we synthesize a
        // deterministic legacy id from sourceVersion+infoHash+fileIndex
        // so existing per-snapshot uniqueness behavior is preserved
        // for non-event-derived sources.
        let eventId = typeof obs.sourceEventId === 'string'
          ? obs.sourceEventId.trim()
          : '';
        if (eventId.length === 0) {
          eventId = `legacy:${sourceVersion}:${infoHash}:${fik}`;
        }

        const insertParams = {
          info_hash: infoHash,
          file_index_key: fik,
          provider,
          evidence_type: evidenceType,
          source_id: sourceId,
          source_version: sourceVersion,
          source_event_id: eventId,
          first_seen_at: firstSeenAt,
          last_seen_at: lastSeenAt,
          observation_count: delta,
        };

        try {
          // INSERT OR IGNORE: the entire idempotency contract.
          // - Replay of the same source_event_id (same source, same event)
          //   is a no-op (changes() == 0, no aggregate recompute needed
          //   for THIS row). A second acquisition of unchanged RD history
          //   re-uses the same source_event_id and does not strengthen
          //   historical evidence.
          // - New sighting row → changes() == 1, we mark the candidate
          //   for aggregate recompute below.
          const r = insertHistoricalProviderSightingStmt.run(insertParams);
          ingested++;
          if (r.changes > 0) {
            inserted++;
            affectedCandidates.add(`${infoHash}\x00${fik}`);
          }
        } catch (err) {
          errors.push({ infoHash, message: err.message });
          skipped++;
        }
      }

      // Recompute the aggregate for every candidate that got a new
      // sighting row. Replay (zero affected candidates) is a no-op here.
      // The UPSERT is itself idempotent: a recompute over an unchanged
      // sightings set produces an identical aggregate.
      //
      // account_scope is the only column not derivable from the
      // sightings (it is per-source, not per-sighting). We pass it as
      // a parameter and use COALESCE in the UPSERT so the first
      // non-null value wins and is never overwritten.
      for (const key of affectedCandidates) {
        const sep = key.indexOf('\x00');
        const ih = key.slice(0, sep);
        const fik = Number(key.slice(sep + 1));
        try {
          upsertHistoricalProviderEvidenceStmt.run({
            provider,
            source_id: sourceId,
            evidence_type: evidenceType,
            info_hash: ih,
            file_index_key: fik,
            account_scope: accountScope,
          });
        } catch (err) {
          errors.push({ infoHash: ih, message: `aggregate upsert failed: ${err.message}` });
        }
      }

      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      errors.push({ message: `transaction failed: ${err.message}` });
      return { ingested: 0, skipped: observations.length, errors, snapshots: 0, aggregateRows: 0 };
    }

    return {
      ingested,
      inserted,
      skipped,
      errors,
      snapshots: countHistoricalProviderSightingsStmt.get()?.n ?? 0,
      aggregateRows: countHistoricalProviderEvidenceStmt.get()?.n ?? 0,
    };
  }

  /**
   * Retrieve all historical provider evidence aggregates for a candidate.
   *
   * This is a READ-ONLY query. It returns the aggregate table (one row per
   * independent source_id), not the underlying sightings. Callers that need
   * per-snapshot details should query the sightings table directly.
   *
   * @param {string} infoHash
   * @param {number|null} [fileIndex]
   * @returns {Array} rows with provider, account_scope, evidence_type, source_id,
   *                  first_seen_at, last_seen_at, distinct_snapshot_count
   */
  function getHistoricalProviderEvidence(infoHash, fileIndex = null) {
    if (!infoHash) return [];
    try {
      return selectHistoricalProviderEvidenceForCandidateStmt.all({
        info_hash: infoHash.toLowerCase(),
        file_index_key: fileIndexKey(fileIndex),
      });
    } catch {
      return [];
    }
  }

  /**
   * Count total historical provider evidence rows in the table.
   *
   * @returns {number}
   */
  function countHistoricalProviderEvidence() {
    try {
      return countHistoricalProviderEvidenceStmt.get()?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Count historical provider evidence rows for a specific candidate.
   *
   * @param {string} infoHash
   * @param {number|null} [fileIndex]
   * @returns {number}
   */
  function countHistoricalProviderEvidenceForCandidate(infoHash, fileIndex = null) {
    if (!infoHash) return 0;
    try {
      return countHistoricalProviderEvidenceForCandidateStmt.get({
        info_hash: infoHash.toLowerCase(),
        file_index_key: fileIndexKey(fileIndex),
      })?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Count total historical provider sighting rows (per-snapshot witnesses).
   * This is the raw count of every distinct (source_id, source_version)
   * sighting across the table. The aggregate table's count will normally
   * be smaller because one aggregate row covers many sighting rows.
   *
   * @returns {number}
   */
  function countHistoricalProviderSightings() {
    try {
      return countHistoricalProviderSightingsStmt.get()?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Count historical provider sighting rows for a specific candidate.
   *
   * @param {string} infoHash
   * @param {number|null} [fileIndex]
   * @returns {number}
   */
  function countHistoricalProviderSightingsForCandidate(infoHash, fileIndex = null) {
    if (!infoHash) return 0;
    try {
      return countHistoricalProviderSightingsForCandidateStmt.get({
        info_hash: infoHash.toLowerCase(),
        file_index_key: fileIndexKey(fileIndex),
      })?.n ?? 0;
    } catch {
      return 0;
    }
  }

  // ========================================================================
  // RD /downloads raw observation API
  // ========================================================================

  /**
   * Ingest a batch of normalized /downloads raw observations.
   *
   * Idempotent: re-importing the same RD download id is a no-op
   * (changes() === 0). Distinct RD download ids with the same
   * (filename, filesize) remain distinct rows.
   *
   * @param {object} opts
   * @param {string} opts.sourceVersion   Snapshot provenance (from acquirer's
   *                                      manifest.sourceVersion — identical
   *                                      semantics to historical_provider_evidence)
   * @param {Array} opts.observations    Array of normalized /downloads rows
   *                                      (from rd-downloads.js normalizeDownloadEntry)
   * @param {number} [opts.now]          Wallclock for first_seen_at
   * @returns {{ ingested, inserted, skipped, errors, observationRows }}
   */
  function ingestRdDownloadObservations({ sourceVersion, observations = [], now = Date.now() } = {}) {
    if (!sourceVersion || typeof sourceVersion !== 'string' || sourceVersion.length === 0) {
      return { ingested: 0, inserted: 0, skipped: 0, errors: [{ message: 'sourceVersion is required' }], observationRows: 0 };
    }
    if (!Array.isArray(observations)) {
      return { ingested: 0, inserted: 0, skipped: 0, errors: [{ message: 'observations must be an array' }], observationRows: 0 };
    }

    const errors = [];
    let ingested = 0;
    let inserted = 0;
    let skipped = 0;

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const obs of observations) {
        const params = {
          provider: 'realdebrid',
          source_id: 'downloads',
          source_version: sourceVersion,
          source_event_id: String(obs.source_event_id || ''),
          rd_id: String(obs.rd_id || ''),
          filename: String(obs.filename || ''),
          normalized_filename: String(obs.normalized_filename || ''),
          exact_bytes: Number.isSafeInteger(obs.exact_bytes) ? obs.exact_bytes : 0,
          mime_type: obs.mime_type || null,
          streamable: obs.streamable ? 1 : 0,
          generated_at: Number.isSafeInteger(obs.generated_at) ? obs.generated_at : now,
          first_seen_at: Number.isSafeInteger(obs.first_seen_at) ? obs.first_seen_at : now,
          last_seen_at: Number.isSafeInteger(obs.last_seen_at) ? obs.last_seen_at : now,
          parsed_title: obs.parsed_title || null,
          parsed_year: Number.isSafeInteger(obs.parsed_year) ? obs.parsed_year : null,
          season: Number.isSafeInteger(obs.season) ? obs.season : null,
          episode: Number.isSafeInteger(obs.episode) ? obs.episode : null,
          resolution: obs.resolution || null,
          source_type: obs.source_type || null,
          codec: obs.codec || null,
          release_group: obs.release_group || null,
          parser_confidence: typeof obs.parser_confidence === 'number' ? obs.parser_confidence : 0,
        };

        if (!params.source_event_id) {
          errors.push({ message: 'source_event_id is required', filename: params.filename });
          skipped += 1;
          continue;
        }

        try {
          const r = insertRdDownloadObservationStmt.run(params);
          ingested += 1;
          if (r.changes > 0) inserted += 1;
        } catch (err) {
          errors.push({ source_event_id: params.source_event_id, message: err.message });
          skipped += 1;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      return { ingested: 0, inserted: 0, skipped: observations.length, errors: [{ message: `transaction failed: ${err.message}` }], observationRows: 0 };
    }

    return {
      ingested,
      inserted,
      skipped,
      errors,
      observationRows: countRdDownloadObservationsStmt.get({ provider: 'realdebrid', source_id: 'downloads' })?.n ?? 0,
    };
  }

  /**
   * Retrieve all raw RD /downloads observations.
   * @returns {Array}
   */
  function getAllRdDownloadObservations() {
    try {
      return selectAllRdDownloadObservationsStmt.all();
    } catch {
      return [];
    }
  }

  /**
   * Count total raw RD /downloads observations.
   * @returns {number}
   */
  function countRdDownloadObservations() {
    try {
      return countRdDownloadObservationsStmt.get({ provider: 'realdebrid', source_id: 'downloads' })?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Retrieve RD /downloads observations matching a specific (filename, bytes) pair.
   * Used by the correlation layer to find exact-file candidates.
   *
   * @param {string} normalizedFilename
   * @param {number} exactBytes
   * @returns {Array}
   */
  function getRdDownloadObservationsByFileBytes(normalizedFilename, exactBytes) {
    try {
      return selectRdDownloadObservationsByFileBytesStmt.all({
        provider: 'realdebrid',
        source_id: 'downloads',
        normalized_filename: normalizedFilename,
        exact_bytes: exactBytes,
      });
    } catch {
      return [];
    }
  }

  /**
   * Write correlation results for the RD /downloads observation set.
   *
   * Clears the (realdebrid, downloads) partition first, then inserts
   * the new results. The table is always a pure function of the current
   * (observations, candidates) state — safe to rebuild from scratch.
   *
   * @param {object} opts
   * @param {string} opts.sourceVersion    Snapshot version of the observation set
   * @param {Array} opts.correlations     Array of correlation result rows
   * @param {number} [opts.now]
   * @returns {{ written, errors }}
   */
  function writeRdDownloadCorrelations({ sourceVersion, correlations = [], now = Date.now() } = {}) {
    if (!sourceVersion || typeof sourceVersion !== 'string' || sourceVersion.length === 0) {
      return { written: 0, errors: [{ message: 'sourceVersion is required' }] };
    }
    if (!Array.isArray(correlations)) {
      return { written: 0, errors: [{ message: 'correlations must be an array' }] };
    }

    const errors = [];
    let written = 0;

    db.exec('BEGIN IMMEDIATE');
    try {
      // Clear old correlations for this source — fresh rebuild each run
      clearRdDownloadCorrelationsStmt.run({ provider: 'realdebrid', source_id: 'downloads' });

      for (const c of correlations) {
        const params = {
          provider: 'realdebrid',
          source_id: 'downloads',
          source_version: sourceVersion,
          source_event_id: String(c.source_event_id || ''),
          rd_id: String(c.rd_id || ''),
          candidate_info_hash: String(c.candidate_info_hash || ''),
          candidate_file_index_key: fileIndexKey(c.candidate_file_index_key ?? null),
          correlation_class: String(c.correlation_class || 'UNMATCHED'),
          correlation_score: typeof c.correlation_score === 'number' ? c.correlation_score : 0,
          reasons_json: JSON.stringify(c.reasons_json || []),
          ambiguity_count: Number.isSafeInteger(c.ambiguity_count) ? c.ambiguity_count : 0,
          parsed_filename: c.parsed_filename || null,
          exact_bytes: Number.isSafeInteger(c.exact_bytes) ? c.exact_bytes : null,
          generated_at: Number.isSafeInteger(c.generated_at) ? c.generated_at : null,
          correlated_at: now,
        };

        try {
          insertRdDownloadCorrelationStmt.run(params);
          written += 1;
        } catch (err) {
          errors.push({ source_event_id: params.source_event_id, message: err.message });
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      return { written: 0, errors: [{ message: `transaction failed: ${err.message}` }] };
    }

    return { written, errors };
  }

  /**
   * Retrieve all RD /downloads correlations.
   * @returns {Array}
   */
  function getAllRdDownloadCorrelations() {
    try {
      return selectAllRdDownloadCorrelationsStmt.all();
    } catch {
      return [];
    }
  }

  /**
   * Count total RD /downloads correlations.
   * @returns {number}
   */
  function countRdDownloadCorrelations() {
    try {
      return countRdDownloadCorrelationsStmt.get({ provider: 'realdebrid', source_id: 'downloads' })?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Count RD /downloads correlations by class.
   * @returns {Array<{correlation_class, n}>}
   */
  function countRdDownloadCorrelationsByClass() {
    try {
      return countRdDownloadCorrelationsByClassStmt.all({ provider: 'realdebrid', source_id: 'downloads' });
    } catch {
      return [];
    }
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
   * Batch-fetch candidates matching any of the given search_keys.
   * Returns raw candidate rows (NOT the public Candidate shape) so
   * the caller can hand them to correlation without paying the
   * public-shape conversion cost.
   *
   * Duplicates across keys (the same info_hash can be returned for
   * multiple keys) are de-duplicated by (info_hash, file_index).
   *
   * @param {object} options
   * @param {string[]} options.searchKeys
   * @returns {Array<object>}
   */
  function queryRawCandidatesBySearchKeys({ searchKeys } = {}) {
    if (!Array.isArray(searchKeys) || searchKeys.length === 0) return [];
    const params = { search_keys: JSON.stringify(searchKeys) };
    const rows = selectCandidatesByKeysStmt.all(params);
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const k = `${r.info_hash}\x00${r.file_index == null ? -1 : r.file_index}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  }

  /**
   * Per-observation coarse prefilter: returns candidate rows whose
   * filename or title contains any of the supplied tokens as a word
   * boundary. De-duplicates by (info_hash, file_index_key).
   *
   * This is the bottleneck fix for north-side correlation: scoring
   * 1M+ candidates against 100+ observations is intractable, but
   * per-obs SQL LIKE prefilter on a handful of distinctive tokens
   * narrows the candidate set to a few hundred per observation.
   *
   * Tokens shorter than 3 chars or containing only digits are
   * dropped to avoid token-storm matches.
   *
   * @param {object} options
   * @param {string[]} options.tokens  Distinctive title tokens
   * @param {number} [options.limit=2000]  Max rows to return
   * @returns {Array<object>}  Raw candidate rows (caller maps to shape)
   */
  function queryRawCandidatesByTokens({ tokens, limit = 2000 }) {
    if (!Array.isArray(tokens) || tokens.length === 0) return [];
    const safe = tokens
      .filter((t) => typeof t === 'string' && t.length >= 3 && /[a-z]/i.test(t))
      .map((t) => t.replace(/[%_]/g, ''))
      .filter((t) => t.length >= 3)
      .slice(0, 16); // hard cap on tokens per obs
    if (safe.length === 0) return [];
    const clauses = [];
    const params = { limit };
    for (let i = 0; i < safe.length; i += 1) {
      const k = `t${i}`;
      params[k] = `%${safe[i]}%`;
      clauses.push(`(filename LIKE @${k} OR title LIKE @${k})`);
    }
    const sql = SELECT_CANDIDATES_BY_TOKENS_TEMPLATE.replace(
      '{CLAUSE}',
      clauses.join(' OR '),
    );
    const stmt = db.prepare(sql);
    try {
      const rows = stmt.all(params);
      // De-dupe by (info_hash, file_index_key) in JS
      const seen = new Set();
      const out = [];
      for (const r of rows) {
        const fik = r.file_index == null ? -1 : r.file_index;
        const k = `${r.info_hash}::${fik}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(r);
        if (out.length >= limit) break;
      }
      return out;
    } finally {
      try { stmt.finalize(); } catch { /* ignore */ }
    }
  }

  /**
   * Stream the candidate corpus in pages, ordered by id ASC. This is
   * the only way to walk a multi-million-row corpus without OOM.
   *
   * @param {object} options
   * @param {number} [options.pageSize=50000]  rows per page
   * @returns {Generator<{rows: Array<object>, lastId: number}>}
   */
  function* iterateRawCandidates({ pageSize = 50000 } = {}) {
    let cursorInfoHash = '';
    let cursorFileIndexKey = -1;
    while (true) {
      const rows = selectRawCandidatesPageStmt.all({
        cursor_info_hash: cursorInfoHash,
        cursor_file_index_key: cursorFileIndexKey,
        limit: pageSize,
      });
      if (rows.length === 0) return;
      cursorInfoHash = rows[rows.length - 1].info_hash;
      cursorFileIndexKey = rows[rows.length - 1].file_index == null ? -1 : rows[rows.length - 1].file_index;
      yield { rows, lastInfoHash: cursorInfoHash, lastFileIndexKey: cursorFileIndexKey };
      if (rows.length < pageSize) return;
    }
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
    )
    ON CONFLICT(media_type, media_id, IFNULL(season, -1), IFNULL(episode, -1))
    DO UPDATE SET
      -- Slice 2.6: only fire the update when the new handoff is
      -- authoritative AND the existing row is legacy. The excluded row
      -- carries the new payload; the playback_handoffs row is the
      -- existing canonical row. The WHERE guards against overwriting an
      -- existing authoritative identity (we keep the winner) and against
      -- re-asserting the same physical identity with stale metadata.
      request_id = excluded.request_id,
      release_key = excluded.release_key,
      info_hash = excluded.info_hash,
      file_index = excluded.file_index,
      filename = excluded.filename,
      provider = excluded.provider,
      provider_state = excluded.provider_state,
      identity_tier = excluded.identity_tier,
      resolution_state = excluded.resolution_state,
      selection_reason = excluded.selection_reason,
      selected_at = excluded.selected_at,
      torrent_file_id = excluded.torrent_file_id
    WHERE
      (
        playback_handoffs.torrent_file_id IS NULL
        AND excluded.torrent_file_id IS NOT NULL
      )
      OR
      (
        playback_handoffs.torrent_file_id IS NOT NULL
        AND excluded.torrent_file_id IS NOT NULL
        AND playback_handoffs.torrent_file_id != excluded.torrent_file_id
      )
    ;
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

  // Slice 2.6: look up the canonical handoff slot for upsert idempotency.
  // Identical-shape query to GET_TV_PLAYBACK_HANDOFF but parameterized for
  // either movies (season/episode NULL) or episodes (both set). Returns the
  // single durable row in the slot, or null when the slot is empty.
  const GET_PLAYBACK_HANDOFF_BY_MEDIA_IDENTITY = `
    SELECT * FROM playback_handoffs
    WHERE media_type = @media_type
      AND media_id = @media_id
      AND IFNULL(season, -1) = IFNULL(@season, -1)
      AND IFNULL(episode, -1) = IFNULL(@episode, -1)
    ORDER BY torrent_file_id IS NOT NULL DESC, id DESC
    LIMIT 1;
  `;

  const insertPlaybackHandoffStmt = db.prepare(INSERT_PLAYBACK_HANDOFF);
  const getPlaybackHandoffByRequestStmt = db.prepare(GET_PLAYBACK_HANDOFF_BY_REQUEST);
  const getPlaybackHandoffByIdStmt = db.prepare(GET_PLAYBACK_HANDOFF_BY_ID);
  const getPlaybackHandoffByMediaStmt = db.prepare(GET_PLAYBACK_HANDOFF_BY_MEDIA);
  const getPlaybackHandoffByMediaIdentityStmt = db.prepare(GET_PLAYBACK_HANDOFF_BY_MEDIA_IDENTITY);
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
  // Atomic supersede of a legacy vfs_movie_entries row with TorrentFile-backed
  // identity. Only fires when the existing row has torrent_file_id IS NULL —
  // authoritative rows must be reconciled by application code, never silently
  // overwritten. canonical_path is preserved so the published library alias
  // (and any downstream WebDAV/Plex/Jellyfin references) remains stable.
  const supersedeVfsMovieEntryStmt = db.prepare(`
    UPDATE vfs_movie_entries
    SET release_key = @release_key,
        info_hash = @info_hash,
        file_index = NULL,
        canonical_path = @canonical_path,
        torrent_file_id = @torrent_file_id,
        size = @size,
        updated_at = @updated_at
    WHERE media_id = @media_id
      AND torrent_file_id IS NULL
  `);

  // Worker A — Defect A: rejection-supersede path for movies.
  // Mirrors the TV variant. Triggered when the existing row's infoHash
  // differs from the new handoff (a previous TorrentFile was terminal-
  // evidenced) and the new handoff is authoritative (carries
  // torrentFileIdentity). The canonical_path alias stays stable.
  const supersedeVfsMovieEntryRejectionStmt = db.prepare(`
    UPDATE vfs_movie_entries
    SET release_key = @release_key,
        info_hash = @info_hash,
        file_index = NULL,
        canonical_path = @canonical_path,
        torrent_file_id = @torrent_file_id,
        size = @size,
        updated_at = @updated_at
    WHERE media_id = @media_id
      AND info_hash != @info_hash
  `);

  function persistPlaybackHandoff(handoff) {
    return upsertPlaybackHandoff(handoff).id;
  }

  /**
   * Upsert a playback handoff against the canonical (media_type, media_id,
   * season, episode) slot. Idempotency contract (slice 2.6):
   *
   *   - No prior row           -> insert and return { id, status: 'inserted' }.
   *   - Prior identical row    -> return its id, status: 'noop'. The handoff
   *                               row is left untouched (selected_at and
   *                               request_id are preserved).
   *   - Prior legacy (no
   *     torrent_file_id),
   *     new authoritative      -> upgrade the existing row in place and
   *                               return its id, status: 'upgraded'. The
   *                               canonical (latest) selection is now
   *                               authoritative; the row is the same
   *                               physical identity.
   *   - Prior authoritative,
   *     new legacy             -> keep the authoritative row. Return its id,
   *                               status: 'kept-authoritative'. The legacy
   *                               payload is dropped: the authoritative row
   *                               is the durable identity.
   *
   * The return value is always the id of the canonical row in the slot, so
   * subsequent VFS materialization / STRM publication / hydration hooks
   * always operate on the same durable identity. Callers that only need the
   * id should use persistPlaybackHandoff (thin wrapper).
   */
  function upsertPlaybackHandoff(handoff) {
    const params = {
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
    };
    const newIsAuthoritative = params.torrent_file_id != null;
    const existedBefore = getPlaybackHandoffByMediaIdentityStmt.get({
      media_id: params.media_id,
      media_type: params.media_type,
      season: params.season,
      episode: params.episode,
    });
    const info = insertPlaybackHandoffStmt.run(params);
    const id = Number(info.lastInsertRowid);
    if (!existedBefore) {
      const inserted = rowToPlaybackHandoff(
        getPlaybackHandoffByMediaIdentityStmt.get({
          media_id: params.media_id,
          media_type: params.media_type,
          season: params.season,
          episode: params.episode,
        }),
      );
      return { id, status: 'inserted', handoff: inserted };
    }
    if (existedBefore.id === id) {
      // Conflict: the ON CONFLICT DO UPDATE fired (same row id was
      // updated in-place). Re-read the canonical row so callers always
      // receive the authoritative state after upsert — not the stale
      // pre-update handoff object. This matters for the rank-5
      // promotion path (Defect B): the existing authoritative handoff's
      // torrent_file_id must be replaced by the new one, and the returned
      // object must reflect the updated row.
      const updated = rowToPlaybackHandoff(
        getPlaybackHandoffByMediaIdentityStmt.get({
          media_id: params.media_id,
          media_type: params.media_type,
          season: params.season,
          episode: params.episode,
        }),
      );
      return { id, status: 'noop', handoff: updated };
    }
    // Conflict: classify the upsert outcome relative to the new payload.
    const wasAuthoritative = existedBefore.torrent_file_id != null;
    let status;
    if (newIsAuthoritative && !wasAuthoritative) status = 'upgraded';
    else if (!newIsAuthoritative && wasAuthoritative) status = 'kept-authoritative';
    else status = 'noop';
    const after = getPlaybackHandoffByMediaIdentityStmt.get({
      media_id: params.media_id,
      media_type: params.media_type,
      season: params.season,
      episode: params.episode,
    });
    return { id: Number(after.id), status, handoff: rowToPlaybackHandoff(after) };
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

  /**
   * Atomically supersede a legacy movie VFS row (torrent_file_id IS NULL)
   * with a TorrentFile-backed authoritative row. The existing canonical_path
   * is preserved verbatim so the published library alias (and any downstream
   * WebDAV / Plex / Jellyfin references) remains stable. Returns the
   * resulting row, or null when no legacy row was found (caller must insert).
   *
   * This is the only path that may overwrite an existing VFS entry's
   * physical identity. Authoritative rows (torrent_file_id IS NOT NULL) are
   * not touched here — those are reconciled in application code with a
   * fail-closed conflict check.
   */
  /**
   * Atomically supersede a legacy movie VFS row (torrent_file_id IS NULL) with
   * a TorrentFile-backed authoritative row. The existing canonical_path is
   * preserved verbatim so the published library alias stays stable.
   *
   * Worker A — Defect A: when { allowRejectionSupersede: true } is passed and
   * the existing row's info_hash differs from the incoming handoff, the row
   * is replaced even though its torrent_file_id IS NOT NULL. This is the
   * only way a previously-terminal-evidenced TorrentFile can be replaced by
   * a promoted alternate through the normal lifecycle.
   */
  function replaceVfsMovieEntry(entry, options = {}) {
    const stmt = options.allowRejectionSupersede === true
      ? supersedeVfsMovieEntryRejectionStmt
      : supersedeVfsMovieEntryStmt;
    const info = stmt.run({
      media_id: entry.mediaId,
      release_key: entry.releaseKey,
      info_hash: entry.infoHash,
      canonical_path: entry.canonicalPath,
      torrent_file_id: entry.torrentFileId,
      size: entry.size,
      updated_at: entry.updatedAt,
    });
    return info.changes === 1 ? getVfsMovieEntry(entry.mediaId) : null;
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
  // Prefer the authoritative handoff (torrent_file_id IS NOT NULL) when one
  // exists. This is needed because Slice 2.1 persisted authoritative handoffs
  // (with torrent_file_id) alongside legacy ones (NULL). The legacy row was
  // inserted first; without this ordering the WebDAV supersede path would read
  // the stale legacy handoff and fail to reconcile the legacy VFS row.
  const getTvPlaybackHandoffStmt = db.prepare(`
    SELECT * FROM playback_handoffs
    WHERE media_id = @media_id
      AND season = @season
      AND episode = @episode
      AND media_type IN ('series', 'tv')
    ORDER BY torrent_file_id IS NOT NULL DESC, created_at DESC, id DESC
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
  // Atomic supersede of a legacy vfs_tv_entries row with TorrentFile-backed
  // identity. Only fires when the existing row has torrent_file_id IS NULL —
  // authoritative rows must be reconciled by application code, never silently
  // overwritten. canonical_path is preserved so the published library alias
  // (and any downstream WebDAV/Plex/Jellyfin references) remains stable.
  const supersedeVfsTvEntryStmt = db.prepare(`
    UPDATE vfs_tv_entries
    SET release_key = @release_key,
        info_hash = @info_hash,
        file_index = NULL,
        canonical_path = @canonical_path,
        torrent_file_id = @torrent_file_id,
        size = @size,
        updated_at = @updated_at
    WHERE media_id = @media_id
      AND season = @season
      AND episode = @episode
      AND torrent_file_id IS NULL
  `);

  // Worker A — Defect A: rejection-supersede path for TV.
  // Triggered when the existing VFS row points at a TorrentFile that
  // was terminal-evidenced and the new handoff's infoHash differs (a
  // promoted rank-5 alternate). The canonical_path alias is preserved
  // so published clients retain the same URI.
  const supersedeVfsTvEntryRejectionStmt = db.prepare(`
    UPDATE vfs_tv_entries
    SET release_key = @release_key,
        info_hash = @info_hash,
        file_index = NULL,
        canonical_path = @canonical_path,
        torrent_file_id = @torrent_file_id,
        size = @size,
        updated_at = @updated_at
    WHERE media_id = @media_id
      AND season = @season
      AND episode = @episode
      AND info_hash != @info_hash
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

  /**
   * Atomically supersede a legacy TV VFS row (torrent_file_id IS NULL) with
   * a TorrentFile-backed authoritative row. The existing canonical_path is
   * preserved verbatim so the published library alias (and any downstream
   * WebDAV / Plex / Jellyfin references) remains stable. Returns the
   * resulting row, or null when no legacy row was found (caller must insert).
   *
   * This is the only path that may overwrite an existing VFS entry's
   * physical identity. Authoritative rows (torrent_file_id IS NOT NULL) are
   * not touched here — those are reconciled in application code with a
   * fail-closed conflict check.
   */
  function replaceVfsTvEntry(entry, options = {}) {
    const stmt = options.allowRejectionSupersede === true
      ? supersedeVfsTvEntryRejectionStmt
      : supersedeVfsTvEntryStmt;
    const info = stmt.run({
      media_id: entry.mediaId,
      season: entry.season,
      episode: entry.episode,
      release_key: entry.releaseKey,
      info_hash: entry.infoHash,
      canonical_path: entry.canonicalPath,
      torrent_file_id: entry.torrentFileId,
      size: entry.size,
      updated_at: entry.updatedAt,
    });
    return info.changes === 1 ? getVfsTvEntry(entry.mediaId, entry.season, entry.episode) : null;
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

  // Slice 3.0: insert a media_request_results row but silently collapse
  // physical-release duplicates. The original INSERT in
  // buildInsertMediaRequestResultSql throws SQLITE_CONSTRAINT_UNIQUE when
  // the same (request_id, info_hash, file_index_key) appears twice in the
  // input list (upstream live-discovery quirk). INSERT OR IGNORE lets the
  // first row win (lowest rank) and drops the rest without failing the
  // whole request persistence. The rank-unique constraint still applies
  // because INSERT OR IGNORE only skips on constraint conflicts; a
  // genuine rank collision (two results at the same rank) is asserted
  // up-front in persistMediaRequest.
  const INSERT_MEDIA_REQUEST_RESULT_IGNORE = (intentId) => {
    const cols = [
      'request_id', 'rank', 'info_hash', 'file_index_key', 'filename', 'score',
      'score_breakdown', 'identity_tier', 'identity_confidence', 'identity_evidence',
      'resolution_state', 'release_metadata', 'ranking_breakdown',
      'eligible', 'ineligible_reason', 'ineligible_code', 'expected_media_scope', 'parsed_candidate_scope',
      'selected_file_size', 'evidence_snapshot', 'evidence_snapshot_version'
    ];
    if (intentId) { cols.push('intent_id'); }
    const placeholders = cols.map(() => '?').join(', ');
    return `INSERT OR IGNORE INTO media_request_results (${cols.join(', ')}) VALUES (${placeholders});`;
  };

  function persistMediaRequest(intent, results) {
    const now = Date.now();
    const intentLength = results.length;

    // Defensive assertion: the (request_id, rank) UNIQUE INDEX in the
    // schema rejects rank collisions, but the new write path uses
    // INSERT OR IGNORE which would silently drop the second row at the
    // same rank. Rank uniqueness is a precondition of the input list,
    // not a property of the persistence layer; we surface the violation
    // explicitly so a caller bug is not hidden.
    const seenRanks = new Set();
    for (const r of results) {
      if (r == null) continue;
      if (seenRanks.has(r.rank)) {
        throw new Error(
          `persistMediaRequest: duplicate rank ${r.rank} in results for `
          + `media_id=${intent.mediaId} (rank uniqueness is a caller contract)`
        );
      }
      seenRanks.add(r.rank);
    }

    // Resolve the linked media_intents row BEFORE the transaction. The
    // intent upsert has its own BEGIN IMMEDIATE (upsertMediaIntent) and
    // SQLite cannot nest transactions. Doing the intent work first is
    // safe because the intent's request_count is an accounting field —
    // if the request/results block fails, the count is slightly inflated
    // by one (a request the user did not end up seeing), which is a
    // small accounting drift, not a structural integrity defect. The
    // request/results block is the structural boundary that we want
    // transactional; the intent work is a best-effort prelude.
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

    // Slice 3.0: wrap the request + results block in BEGIN IMMEDIATE so
    // any throw in the result loop rolls back the request row too. The
    // FK on media_request_results.request_id means that without this
    // boundary a partial persist could leave the request without its
    // result rows (or vice versa). BEGIN IMMEDIATE acquires the writer
    // lock up front to avoid SQLITE_BUSY under concurrent persist calls.
    db.exec('BEGIN IMMEDIATE');
    try {
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

      const resultSql = INSERT_MEDIA_REQUEST_RESULT_IGNORE(intentId);
      const resultStmt = db.prepare(resultSql);

      for (const r of results) {
        if (r == null) continue;
        // Slice 4: build the evidence snapshot from the SAME ranked
        // object whose score we are about to persist. The snapshot is
        // a historical record of what the scorer saw — do not re-query
        // current provider state to populate it. When the caller
        // surfaces the unranked input (no .justification / .components)
        // we still produce a deterministic snapshot from whatever
        // evidence fields are present so the persisted row is
        // explainable after restart.
        const { snapshot, version } = buildEvidenceSnapshot(r);
        resultStmt.run(
          requestId,
          r.rank,
          r.infoHash,
          r.fileIndex === null || r.fileIndex === undefined ? -1 : r.fileIndex,
          r.filename,
          r.score,
          r.scoreBreakdown ? JSON.stringify(r.scoreBreakdown) : null,
          r.identity?.tier || 'unknown',
          r.identity?.confidence || 0,
          r.identity?.evidence ? JSON.stringify(r.identity.evidence) : null,
          r.identity?.state || 'unresolved',
          r.release ? JSON.stringify(r.release) : null,
          r.rankingBreakdown ? JSON.stringify(r.rankingBreakdown) : null,
          r.identity?.eligible === false ? 0 : 1,
          r.identity?.ineligibleReason || null,
          r.identity?.ineligibleCode || null,
          r.identity?.expectedMediaScope || null,
          r.identity?.parsedCandidateScope || null,
          Number.isSafeInteger(r.selectedFileSize) && r.selectedFileSize > 0
            ? r.selectedFileSize
            : null,
          snapshot,
          version,
          ...(intentId ? [intentId] : []),
        );
      }

      db.exec('COMMIT');
      return requestId;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
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

  // Slice 4: read API for evidence snapshots. Returns the parsed snapshot
  // object (or null when the row has no snapshot) and the persisted
  // version marker. A row with snapshot_version IS NOT NULL and snapshot
  // IS NULL is treated as snapshot unavailable and surfaced explicitly
  // to callers — never silently coerced to an empty object.
  function getMediaRequestResultEvidenceSnapshot(requestId, rank) {
    const row = db.prepare(`
      SELECT evidence_snapshot, evidence_snapshot_version
      FROM media_request_results
      WHERE request_id = @request_id AND rank = @rank
    `).get({ request_id: requestId, rank });
    if (!row) return null;
    if (row.evidence_snapshot == null) {
      return {
        snapshot: null,
        version: row.evidence_snapshot_version ?? null,
        available: false,
      };
    }
    let parsed = null;
    try { parsed = JSON.parse(row.evidence_snapshot); } catch { parsed = null; }
    return {
      snapshot: parsed,
      version: row.evidence_snapshot_version,
      available: true,
    };
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
    try { selectCandidatesByKeysStmt.finalize(); } catch {}
    try { selectRawCandidatesPageStmt.finalize(); } catch {}
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

  /**
   * Escape hatch: returns the underlying node:sqlite DatabaseSync handle.
   * Intended for opt-in tables (e.g. importer checkpoint state) that live
   * alongside the cache but are not part of the discovery schema contract.
   * Callers MUST NOT mutate any table that the cache manages directly.
   * The returned handle is owned by the cache; do not close it.
   */
  function getRawDb() {
    return db;
  }

  return {
    upsertCandidate,
    getCandidate,
    appendProviderObservation,
    recordProviderObservation,
    getProviderObservations,
    getProviderObservationHistory,
    queryCachedCandidates,
    queryRawCandidatesBySearchKeys,
    queryRawCandidatesByTokens,
    iterateRawCandidates,
    associateMedia,
    getMediaAssociations,
    queryCandidatesByMedia,
    ingestCandidate,
    isClosed,
    close,
    getRawDb,
    // Release attributes (used by release-attributes.js)
    _insertReleaseAttributes,
    getReleaseAttributes,
    getCandidatesWithoutReleaseAttributes,
    // DMM source provenance (lifecycle + stale detection)
    startDmmGeneration,
    updateDmmGenerationProgress,
    completeDmmGeneration,
    getDmmGeneration,
    getCurrentDmmGeneration,
    recordDmmSourceObservations,
    findStaleObservations,
    findStaleFragments,
    findPruneEligibleCandidates,
    findPruneEligibleAttributes,
    getDmmObservationsForCandidate,
    countDmmObservations,
    // Historical provider evidence (durable prior store, NOT current observations)
    ingestHistoricalProviderEvidence,
    getHistoricalProviderEvidence,
    countHistoricalProviderEvidence,
    countHistoricalProviderEvidenceForCandidate,
    countHistoricalProviderSightings,
    countHistoricalProviderSightingsForCandidate,
    // RD /downloads raw observations (NOT historical_provider_evidence —
    // /downloads has no infoHash, no deterministic bridge to /torrents)
    ingestRdDownloadObservations,
    getAllRdDownloadObservations,
    getRdDownloadObservationsByFileBytes,
    countRdDownloadObservations,
    writeRdDownloadCorrelations,
    getAllRdDownloadCorrelations,
    countRdDownloadCorrelations,
    countRdDownloadCorrelationsByClass,
    isValidInfoHash,
    // Escape hatch for opt-in tables (importer checkpoint state etc.)
    getRawDb,
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
    getMediaRequestResultEvidenceSnapshot,
    buildEvidenceSnapshot,
    // Playback handoff persistence
    persistPlaybackHandoff,
    upsertPlaybackHandoff,
    getPlaybackHandoffByRequestId,
    getPlaybackHandoffById,
    getPlaybackHandoffByMediaId,
    listMoviePlaybackHandoffs,
    getPlaybackHandoffByReleaseKey,
    getVfsMovieEntry,
    listVfsMovieEntries,
    createVfsMovieEntry,
    setVfsMovieEntrySize,
    replaceVfsMovieEntry,
    listTvPlaybackHandoffs,
    getTvPlaybackHandoff,
    getVfsTvEntry,
    listVfsTvEntries,
    createVfsTvEntry,
    setVfsTvEntrySize,
    replaceVfsTvEntry,
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
