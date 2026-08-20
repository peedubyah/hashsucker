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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  info_hash TEXT NOT NULL,
  file_index INTEGER,
  file_index_key INTEGER NOT NULL DEFAULT -1,
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
CREATE INDEX IF NOT EXISTS idx_observations_checked_at ON provider_observations(checked_at);
`;

const INSERT_CANDIDATE = `
INSERT INTO candidates (
  info_hash, file_index, file_index_key, title, filename, size, seeders, leechers,
  publish_date, magnet, download_url, metadata, sources, first_seen, last_seen
) VALUES (
  @info_hash, @file_index, @file_index_key, @title, @filename, @size, @seeders, @leechers,
  @publish_date, @magnet, @download_url, @metadata, @sources, @first_seen, @last_seen
)
ON CONFLICT(info_hash, file_index_key) DO UPDATE SET
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

const GET_OBSERVATIONS = `
SELECT provider, cached, evidence, checked_at
FROM provider_observations
WHERE info_hash = @info_hash AND file_index_key = @file_index_key;
`;

const UPSERT_OBSERVATION = `
INSERT INTO provider_observations (
  info_hash, file_index, file_index_key, provider, cached, evidence, checked_at
) VALUES (
  @info_hash, @file_index, @file_index_key, @provider, @cached, @evidence, @checked_at
)
ON CONFLICT(info_hash, file_index_key, provider) DO UPDATE SET
  cached = EXCLUDED.cached,
  evidence = EXCLUDED.evidence,
  checked_at = EXCLUDED.checked_at;
`;

export function createDiscoveryCache({ dbPath = ':memory:', database = null } = {}) {
  const db = database || new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  const insertCandidateStmt = db.prepare(INSERT_CANDIDATE);
  const getCandidateStmt = db.prepare(GET_CANDIDATE);
  const upsertObservationStmt = db.prepare(UPSERT_OBSERVATION);
  const getObservationsStmt = db.prepare(GET_OBSERVATIONS);

  function fileIndexKey(fileIndex) {
    return fileIndex == null ? -1 : fileIndex;
  }

  function normalizeCandidate(candidate) {
    const now = Date.now();
    return {
      info_hash: candidate.infoHash,
      file_index: candidate.fileIndex ?? null,
      file_index_key: fileIndexKey(candidate.fileIndex),
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

  function rowToObservation(row) {
    return {
      provider: row.provider,
      cached: row.cached === 1 ? true : row.cached === 0 ? false : null,
      evidence: row.evidence ? JSON.parse(row.evidence) : null,
      checkedAt: row.checked_at,
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
   * Record a provider observation for a candidate. Independent of candidate
   * existence — observations can be recorded before a candidate row is written,
   * though normal flow writes the candidate first.
   */
  function recordProviderObservation(infoHash, fileIndex, provider, observation) {
    upsertObservationStmt.run({
      info_hash: infoHash,
      file_index: fileIndex ?? null,
      file_index_key: fileIndexKey(fileIndex),
      provider,
      cached: observation.cached === true ? 1 : observation.cached === false ? 0 : null,
      evidence: observation.evidence != null ? JSON.stringify(observation.evidence) : null,
      checked_at: observation.checkedAt ?? Date.now(),
    });
  }

  function getProviderObservations(infoHash, fileIndex) {
    const rows = getObservationsStmt.all({
      info_hash: infoHash,
      file_index_key: fileIndexKey(fileIndex),
    });
    return rows.map(rowToObservation);
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
      return { ...incoming, firstSeen: incoming.firstSeen ?? Date.now(), lastSeen: Date.now() };
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

  function close() {
    db.close();
  }

  return {
    upsertCandidate,
    getCandidate,
    recordProviderObservation,
    getProviderObservations,
    ingestCandidate,
    close,
    // Exposed for testing/inspection
    get db() { return db; },
  };
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
    async recordProviderObservation(infoHash, fileIndex, provider, observation) {
      try {
        return await cache.recordProviderObservation(infoHash, fileIndex, provider, observation);
      } catch (error) {
        log(error);
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
