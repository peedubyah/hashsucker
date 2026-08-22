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
  PRIMARY KEY (info_hash, file_index_key, media_id)
);

CREATE INDEX IF NOT EXISTS idx_candidate_media_media_id ON candidate_media(media_id);

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
  info_hash, file_index_key, media_id, source, confidence, evidence, associated_at
) VALUES (
  @info_hash, @file_index_key, @media_id, @source, @confidence, @evidence, @associated_at
)
ON CONFLICT(info_hash, file_index_key, media_id) DO UPDATE SET
  source = EXCLUDED.source,
  confidence = EXCLUDED.confidence,
  evidence = EXCLUDED.evidence,
  associated_at = EXCLUDED.associated_at;
`;

const UPSERT_MEDIA_ASSOCIATION = `
INSERT INTO candidate_media (
  info_hash, file_index_key, media_id, source, confidence, evidence, associated_at
) VALUES (
  @info_hash, @file_index_key, @media_id, @source, @confidence, @evidence, @associated_at
)
ON CONFLICT(info_hash, file_index_key, media_id) DO UPDATE SET
  source = EXCLUDED.source,
  confidence = EXCLUDED.confidence,
  evidence = COALESCE(EXCLUDED.evidence, candidate_media.evidence),
  associated_at = EXCLUDED.associated_at;
`;

const GET_MEDIA_ASSOCIATIONS = `
SELECT media_id, source, confidence, evidence, associated_at
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

export function createDiscoveryCache({ dbPath = ':memory:', database = null } = {}) {
  const db = database || new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  migrateLegacyProviderObservations(db);

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
