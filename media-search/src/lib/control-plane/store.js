import { randomUUID } from 'node:crypto';

import { DatabaseSync } from 'node:sqlite';

import { createReleaseIdentity, validateReleaseIdentity } from '../../api/release-contract.js';
import {
  addDeterministicCollisionSuffix,
  buildPreferredCanonicalPath,
  createLibraryIdentityKey,
  normalizeCanonicalPath,
  stableLibraryItemId,
} from './canonical-path.js';
import { createLifecycleEvent, projectLifecycle } from './lifecycle.js';

const CONTROL_PLANE_SCHEMA = `
CREATE TABLE IF NOT EXISTS library_items (
  id TEXT PRIMARY KEY,
  identity_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'episode')),
  media_id TEXT NOT NULL,
  edition_key TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL,
  year INTEGER,
  season INTEGER,
  episode INTEGER,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('present', 'absent')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((media_type = 'movie' AND season IS NULL AND episode IS NULL)
    OR (media_type = 'episode' AND season IS NOT NULL AND episode IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS library_paths (
  id TEXT PRIMARY KEY,
  library_item_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  preferred_path TEXT NOT NULL,
  collision_key TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  FOREIGN KEY (library_item_id) REFERENCES library_items(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_library_paths_one_active
  ON library_paths(library_item_id) WHERE active = 1;

CREATE TABLE IF NOT EXISTS provider_placements (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  info_hash TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'degraded', 'error', 'removed', 'unknown')),
  ownership TEXT NOT NULL CHECK (ownership IN ('owned', 'reused', 'external', 'unknown')),
  owner_key TEXT,
  provenance TEXT NOT NULL,
  idempotency_key TEXT,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  failure_category TEXT,
  retryable INTEGER,
  UNIQUE (provider, account_scope, provider_resource_id),
  UNIQUE (provider, account_scope, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_provider_placements_hash
  ON provider_placements(provider, account_scope, info_hash);

CREATE TABLE IF NOT EXISTS provider_placement_observations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  info_hash TEXT NOT NULL,
  observation_state TEXT NOT NULL CHECK (observation_state IN ('present', 'missing', 'error')),
  placement_id TEXT,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  failure_category TEXT,
  retryable INTEGER,
  UNIQUE (provider, account_scope, info_hash),
  FOREIGN KEY (placement_id) REFERENCES provider_placements(id)
);

CREATE TABLE IF NOT EXISTS provider_readiness_observations (
  placement_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'degraded', 'error', 'removed', 'unknown')),
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  failure_category TEXT,
  retryable INTEGER,
  FOREIGN KEY (placement_id) REFERENCES provider_placements(id)
);

CREATE TABLE IF NOT EXISTS provider_files (
  id TEXT PRIMARY KEY,
  placement_id TEXT NOT NULL,
  provider_file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER,
  selected INTEGER CHECK (selected IN (0, 1)),
  media_hint TEXT,
  corpus_file_index INTEGER,
  present INTEGER NOT NULL DEFAULT 1 CHECK (present IN (0, 1)),
  inventory_observed_at INTEGER NOT NULL,
  inventory_expires_at INTEGER,
  missing_since INTEGER,
  evidence TEXT,
  UNIQUE (placement_id, provider_file_id),
  FOREIGN KEY (placement_id) REFERENCES provider_placements(id)
);

CREATE TABLE IF NOT EXISTS provider_inventory_snapshots (
  placement_id TEXT PRIMARY KEY,
  authoritative INTEGER NOT NULL CHECK (authoritative IN (0, 1)),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  observed_at INTEGER NOT NULL,
  expires_at INTEGER,
  file_count INTEGER NOT NULL,
  evidence TEXT,
  FOREIGN KEY (placement_id) REFERENCES provider_placements(id)
);

CREATE TABLE IF NOT EXISTS candidate_file_mappings (
  id TEXT PRIMARY KEY,
  info_hash TEXT NOT NULL,
  file_index INTEGER,
  file_index_key INTEGER NOT NULL,
  release_key TEXT NOT NULL,
  placement_id TEXT NOT NULL,
  provider_file_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('mapped', 'ambiguous', 'missing', 'stale')),
  method TEXT NOT NULL,
  authoritative INTEGER NOT NULL CHECK (authoritative IN (0, 1)),
  evidence TEXT,
  mapped_at INTEGER NOT NULL,
  failure_category TEXT,
  UNIQUE (release_key, placement_id),
  FOREIGN KEY (placement_id) REFERENCES provider_placements(id),
  FOREIGN KEY (placement_id, provider_file_id) REFERENCES provider_files(placement_id, provider_file_id)
);

CREATE TABLE IF NOT EXISTS exposures (
  id TEXT PRIMARY KEY,
  placement_id TEXT NOT NULL,
  provider_file_id TEXT NOT NULL,
  account_scope TEXT NOT NULL DEFAULT 'default',
  mount_scope TEXT NOT NULL DEFAULT 'default',
  transport TEXT NOT NULL,
  exposure_key TEXT NOT NULL,
  relative_path TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'visible', 'missing', 'degraded', 'error', 'unknown')),
  read_only INTEGER NOT NULL CHECK (read_only IN (0, 1)),
  observed_at INTEGER NOT NULL,
  expires_at INTEGER,
  failure_category TEXT,
  retryable INTEGER,
  UNIQUE (transport, exposure_key, placement_id, provider_file_id),
  FOREIGN KEY (placement_id, provider_file_id) REFERENCES provider_files(placement_id, provider_file_id)
);

CREATE TABLE IF NOT EXISTS zurg_metadata_observations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  instance_scope TEXT NOT NULL,
  info_hash TEXT NOT NULL,
  metadata_path TEXT NOT NULL,
  observation_state TEXT NOT NULL CHECK (observation_state IN ('present', 'missing', 'error')),
  zurg_state TEXT,
  zurg_state_when INTEGER,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER,
  source TEXT NOT NULL,
  failure_category TEXT,
  retryable INTEGER,
  evidence TEXT,
  UNIQUE (provider, account_scope, instance_scope, info_hash, metadata_path)
);
CREATE INDEX IF NOT EXISTS idx_zurg_metadata_hash
  ON zurg_metadata_observations(provider, account_scope, instance_scope, info_hash);

CREATE TABLE IF NOT EXISTS bindings (
  id TEXT PRIMARY KEY,
  library_item_id TEXT NOT NULL,
  library_path_id TEXT NOT NULL,
  release_key TEXT NOT NULL,
  info_hash TEXT NOT NULL,
  file_index INTEGER,
  file_index_key INTEGER NOT NULL,
  placement_id TEXT NOT NULL,
  provider_file_id TEXT NOT NULL,
  exposure_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'degraded', 'failed')),
  reason TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  superseded_at INTEGER,
  reconciled_at INTEGER NOT NULL,
  failure_category TEXT,
  UNIQUE (library_item_id, version),
  FOREIGN KEY (library_item_id) REFERENCES library_items(id),
  FOREIGN KEY (library_path_id) REFERENCES library_paths(id),
  FOREIGN KEY (placement_id, provider_file_id) REFERENCES provider_files(placement_id, provider_file_id),
  FOREIGN KEY (exposure_id) REFERENCES exposures(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_one_active
  ON bindings(library_item_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS repair_transactions (
  id TEXT PRIMARY KEY,
  plan_key TEXT NOT NULL,
  library_item_id TEXT NOT NULL,
  info_hash TEXT NOT NULL CHECK (length(info_hash) = 40 AND info_hash NOT GLOB '*[^0-9a-f]*'),
  file_index INTEGER CHECK (file_index IS NULL OR file_index >= 0),
  file_index_key INTEGER NOT NULL CHECK (file_index_key = COALESCE(file_index, -1)),
  release_key TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  instance_scope TEXT NOT NULL,
  mount_scope TEXT NOT NULL,
  expected_binding_version INTEGER NOT NULL CHECK (expected_binding_version > 0),
  status TEXT NOT NULL CHECK (status IN ('planned', 'authorized', 'executing', 'failed', 'succeeded')),
  plan TEXT NOT NULL CHECK (json_valid(plan)),
  authorized_actions TEXT CHECK (authorized_actions IS NULL OR json_valid(authorized_actions)),
  authorized_by TEXT,
  created_at INTEGER NOT NULL,
  authorized_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  failure_category TEXT,
  CHECK (release_key = info_hash || ':' || CASE WHEN file_index IS NULL THEN 'torrent' ELSE CAST(file_index AS TEXT) END),
  UNIQUE (plan_key, expected_binding_version),
  FOREIGN KEY (library_item_id) REFERENCES library_items(id)
);
CREATE INDEX IF NOT EXISTS idx_repair_transactions_item
  ON repair_transactions(library_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS repair_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repair_transaction_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  request TEXT CHECK (request IS NULL OR json_valid(request)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  failure_category TEXT,
  retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK ((status = 'running' AND completed_at IS NULL) OR (status != 'running' AND completed_at IS NOT NULL)),
  UNIQUE (repair_transaction_id, action, attempt),
  FOREIGN KEY (repair_transaction_id) REFERENCES repair_transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_repair_steps_transaction
  ON repair_steps(repair_transaction_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_steps_one_running
  ON repair_steps(repair_transaction_id, action) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS lifecycle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_item_id TEXT NOT NULL,
  milestone TEXT NOT NULL,
  status TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  failure_category TEXT,
  retryable INTEGER,
  retry_after_ms INTEGER,
  source TEXT NOT NULL,
  reason TEXT,
  evidence TEXT,
  correlation_id TEXT,
  recorded_at INTEGER NOT NULL,
  FOREIGN KEY (library_item_id) REFERENCES library_items(id)
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_item
  ON lifecycle_events(library_item_id, milestone, occurred_at DESC);
`;

export function createControlPlaneStore({ dbPath = ':memory:', database = null, now = () => Date.now() } = {}) {
  const db = database || new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(CONTROL_PLANE_SCHEMA);
  migrateExposureSchema(db);
  let closed = false;

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function ensureLibraryItem(input) {
    const identityKey = createLibraryIdentityKey(input);
    const id = stableLibraryItemId(identityKey);
    const timestamp = now();
    const mediaType = input.mediaType;
    const season = input.season ?? null;
    const episode = input.episode ?? null;
    db.prepare(`
      INSERT INTO library_items (
        id, identity_key, media_type, media_id, edition_key, title, year,
        season, episode, desired_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_key) DO UPDATE SET
        title = EXCLUDED.title,
        year = COALESCE(EXCLUDED.year, library_items.year),
        desired_state = EXCLUDED.desired_state,
        updated_at = EXCLUDED.updated_at
    `).run(
      id, identityKey, mediaType, input.mediaId, input.editionKey ?? 'default',
      requireString(input.title, 'title'), input.year ?? null, season, episode,
      input.desiredState ?? 'present', timestamp, timestamp,
    );
    return getLibraryItem(id);
  }

  function getLibraryItem(id) {
    const row = db.prepare('SELECT * FROM library_items WHERE id = ?').get(id);
    return row ? rowToLibraryItem(row) : null;
  }

  function listLibraryItems({ mediaId, limit = 50 } = {}) {
    const exactMediaId = requireString(mediaId, 'mediaId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('limit must be between 1 and 100');
    }
    return db.prepare(`
      SELECT * FROM library_items
      WHERE media_id = ?
      ORDER BY identity_key
      LIMIT ?
    `).all(exactMediaId, limit).map(rowToLibraryItem);
  }

  function getActiveCanonicalPath(libraryItemId) {
    requireLibraryItem(libraryItemId);
    const row = db.prepare(
      'SELECT * FROM library_paths WHERE library_item_id = ? AND active = 1',
    ).get(libraryItemId);
    return row ? rowToLibraryPath(row) : null;
  }

  function ensureCanonicalPath(libraryItemId, options = {}) {
    const item = requireLibraryItem(libraryItemId);
    const preferredPath = options.canonicalPath
      ? normalizeCanonicalPath(options.canonicalPath)
      : buildPreferredCanonicalPath(item, options);
    const existing = db.prepare(
      'SELECT * FROM library_paths WHERE library_item_id = ? AND active = 1',
    ).get(libraryItemId);
    if (existing) return rowToLibraryPath(existing);

    const owner = db.prepare(
      'SELECT library_item_id FROM library_paths WHERE canonical_path = ? AND active = 1',
    ).get(preferredPath);
    const canonicalPath = owner && owner.library_item_id !== libraryItemId
      ? addDeterministicCollisionSuffix(preferredPath, item.identityKey)
      : preferredPath;
    const timestamp = now();
    const id = `lp_${randomUUID()}`;
    db.prepare(`
      INSERT INTO library_paths (
        id, library_item_id, canonical_path, preferred_path, collision_key, active, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(id, libraryItemId, canonicalPath, preferredPath, item.identityKey, timestamp);
    return rowToLibraryPath(db.prepare('SELECT * FROM library_paths WHERE id = ?').get(id));
  }

  function recordPlacement(input) {
    const identity = createReleaseIdentity(input.infoHash, null);
    const provider = normalizeIdentifier(input.provider);
    const accountScope = normalizeIdentifier(input.accountScope ?? 'default');
    const providerResourceId = requireString(input.providerResourceId, 'providerResourceId');
    const ownership = input.ownership ?? 'unknown';
    const observedAt = input.observedAt ?? now();
    const timestamp = now();
    const existing = db.prepare(`
      SELECT * FROM provider_placements
      WHERE provider = ? AND account_scope = ? AND provider_resource_id = ?
    `).get(provider, accountScope, providerResourceId);
    if (existing && existing.info_hash !== identity.infoHash) {
      throw new Error('Provider resource observation cannot change its torrent hash');
    }
    if (existing && observedAt < existing.observed_at) return rowToPlacement(existing);

    const id = input.id ?? `pl_${randomUUID()}`;
    db.prepare(`
      INSERT INTO provider_placements (
        id, provider, account_scope, info_hash, provider_resource_id, state,
        ownership, owner_key, provenance, idempotency_key, observed_at, expires_at,
        created_at, updated_at, failure_category, retryable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, account_scope, provider_resource_id) DO UPDATE SET
        state = EXCLUDED.state,
        ownership = EXCLUDED.ownership,
        owner_key = EXCLUDED.owner_key,
        provenance = EXCLUDED.provenance,
        idempotency_key = COALESCE(EXCLUDED.idempotency_key, provider_placements.idempotency_key),
        observed_at = EXCLUDED.observed_at,
        expires_at = EXCLUDED.expires_at,
        updated_at = EXCLUDED.updated_at,
        failure_category = EXCLUDED.failure_category,
        retryable = EXCLUDED.retryable
      WHERE EXCLUDED.observed_at >= provider_placements.observed_at
    `).run(
      id, provider, accountScope, identity.infoHash, providerResourceId,
      input.state ?? 'unknown', ownership, input.ownerKey ?? null,
      requireString(input.provenance, 'provenance'), input.idempotencyKey ?? null,
      observedAt, input.expiresAt ?? null, timestamp, timestamp,
      input.failureCategory ?? null, booleanOrNull(input.retryable),
    );
    return rowToPlacement(db.prepare(`
      SELECT * FROM provider_placements
      WHERE provider = ? AND account_scope = ? AND provider_resource_id = ?
    `).get(provider, accountScope, providerResourceId));
  }

  function findPlacement(provider, accountScope, providerResourceId) {
    const row = db.prepare(`
      SELECT * FROM provider_placements
      WHERE provider = ? AND account_scope = ? AND provider_resource_id = ?
    `).get(
      normalizeIdentifier(provider), normalizeIdentifier(accountScope ?? 'default'),
      requireString(providerResourceId, 'providerResourceId'),
    );
    return row ? rowToPlacement(row) : null;
  }

  function findPlacementByInfoHash(provider, infoHash) {
    // Removed placements must not be reused by delivery. They are retained for
    // observability; recovery lifecycle is responsible for creating a new one.
    const row = db.prepare(`
      SELECT * FROM provider_placements
      WHERE provider = ? AND info_hash = ? AND state != 'removed'
    `).get(normalizeIdentifier(provider), normalizeInfoHash(infoHash));
    return row ? rowToPlacement(row) : null;
  }

  function markPlacementRemoved(placementId, options = {}) {
    const reason = options.reason ?? 'stale-resource';
    const observedAt = options.observedAt ?? now();
    const timestamp = now();
    return transaction(() => {
      const placement = requirePlacement(placementId);
      if (placement.state === 'removed') return placement;
      db.prepare(`
        UPDATE provider_placements
        SET state = 'removed',
            observed_at = ?,
            updated_at = ?,
            failure_category = ?
        WHERE id = ? AND state != 'removed'
      `).run(observedAt, timestamp, reason, placementId);
      // Demote the candidate mappings anchored to this placement so the next
      // call to findFileMapping (during recovery) cannot reuse them.
      db.prepare(`
        UPDATE candidate_file_mappings
        SET state = 'stale',
            failure_category = ?
        WHERE placement_id = ? AND state = 'mapped'
      `).run(reason, placementId);
      return requirePlacement(placementId);
    });
  }

  function findFileMapping(releaseKey, placementId) {
    const row = db.prepare(`
      SELECT * FROM candidate_file_mappings
      WHERE release_key = ? AND placement_id = ?
    `).get(releaseKey, placementId);
    return row ? rowToFileMapping(row) : null;
  }

  function recordPlacementLookupObservation(input) {
    const identity = createReleaseIdentity(input.infoHash, null);
    const provider = normalizeIdentifier(input.provider);
    const accountScope = normalizeIdentifier(input.accountScope ?? 'default');
    const observationState = requireEnum(
      input.observationState, ['present', 'missing', 'error'], 'observationState',
    );
    const observedAt = requireTimestamp(input.observedAt, 'observedAt');
    const expiresAt = requireBoundedExpiry(input.expiresAt, observedAt, 'placement lookup');
    let placementId = null;
    if (input.placementId != null) {
      const placement = requirePlacement(input.placementId);
      if (placement.provider !== provider || placement.accountScope !== accountScope
        || placement.infoHash !== identity.infoHash) {
        throw new Error('Placement lookup observation scope does not match placement');
      }
      placementId = placement.id;
    }
    if (observationState === 'present' && !placementId) {
      throw new TypeError('Present placement lookup observation requires placementId');
    }
    const existing = db.prepare(`
      SELECT * FROM provider_placement_observations
      WHERE provider = ? AND account_scope = ? AND info_hash = ?
    `).get(provider, accountScope, identity.infoHash);
    if (existing && observedAt < existing.observed_at) return rowToPlacementLookupObservation(existing);

    const id = input.id ?? `po_${randomUUID()}`;
    db.prepare(`
      INSERT INTO provider_placement_observations (
        id, provider, account_scope, info_hash, observation_state, placement_id,
        observed_at, expires_at, source, failure_category, retryable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, account_scope, info_hash) DO UPDATE SET
        observation_state = EXCLUDED.observation_state,
        placement_id = EXCLUDED.placement_id,
        observed_at = EXCLUDED.observed_at,
        expires_at = EXCLUDED.expires_at,
        source = EXCLUDED.source,
        failure_category = EXCLUDED.failure_category,
        retryable = EXCLUDED.retryable
      WHERE EXCLUDED.observed_at >= provider_placement_observations.observed_at
    `).run(
      id, provider, accountScope, identity.infoHash, observationState, placementId,
      observedAt, expiresAt, requireString(input.source, 'source'),
      input.failureCategory ?? null, booleanOrNull(input.retryable),
    );
    return rowToPlacementLookupObservation(db.prepare(`
      SELECT * FROM provider_placement_observations
      WHERE provider = ? AND account_scope = ? AND info_hash = ?
    `).get(provider, accountScope, identity.infoHash));
  }

  function recordReadinessObservation(input) {
    const placement = requirePlacement(input.placementId);
    const observedAt = requireTimestamp(input.observedAt, 'observedAt');
    const expiresAt = requireBoundedExpiry(input.expiresAt, observedAt, 'readiness');
    const state = requireEnum(
      input.state, ['pending', 'ready', 'degraded', 'error', 'removed', 'unknown'], 'readiness state',
    );
    const existing = db.prepare(
      'SELECT * FROM provider_readiness_observations WHERE placement_id = ?',
    ).get(placement.id);
    if (existing && observedAt < existing.observed_at) return rowToReadinessObservation(existing);
    db.prepare(`
      INSERT INTO provider_readiness_observations (
        placement_id, state, observed_at, expires_at, source, failure_category, retryable
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(placement_id) DO UPDATE SET
        state = EXCLUDED.state,
        observed_at = EXCLUDED.observed_at,
        expires_at = EXCLUDED.expires_at,
        source = EXCLUDED.source,
        failure_category = EXCLUDED.failure_category,
        retryable = EXCLUDED.retryable
      WHERE EXCLUDED.observed_at >= provider_readiness_observations.observed_at
    `).run(
      placement.id, state, observedAt, expiresAt, requireString(input.source, 'source'),
      input.failureCategory ?? null, booleanOrNull(input.retryable),
    );
    return rowToReadinessObservation(db.prepare(
      'SELECT * FROM provider_readiness_observations WHERE placement_id = ?',
    ).get(placement.id));
  }

  function replaceProviderFileInventory(placementId, files, options = {}) {
    requirePlacement(placementId);
    if (!Array.isArray(files)) throw new TypeError('files must be an array');
    const observedAt = options.observedAt ?? now();
    const current = getProviderInventorySnapshot(placementId);
    if (current && options.enforceObservationOrder === true && observedAt < current.observedAt) {
      return listProviderFiles(placementId);
    }
    const seen = new Set();
    return transaction(() => {
      const upsert = db.prepare(`
        INSERT INTO provider_files (
          id, placement_id, provider_file_id, path, name, size, selected, media_hint,
          corpus_file_index, present, inventory_observed_at, inventory_expires_at,
          missing_since, evidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?)
        ON CONFLICT(placement_id, provider_file_id) DO UPDATE SET
          path = EXCLUDED.path,
          name = EXCLUDED.name,
          size = EXCLUDED.size,
          selected = EXCLUDED.selected,
          media_hint = EXCLUDED.media_hint,
          corpus_file_index = EXCLUDED.corpus_file_index,
          present = 1,
          inventory_observed_at = EXCLUDED.inventory_observed_at,
          inventory_expires_at = EXCLUDED.inventory_expires_at,
          missing_since = NULL,
          evidence = EXCLUDED.evidence
      `);
      for (const file of files) {
        const providerFileId = requireString(file.providerFileId, 'providerFileId');
        if (seen.has(providerFileId)) throw new TypeError(`Duplicate providerFileId: ${providerFileId}`);
        seen.add(providerFileId);
        upsert.run(
          `pf_${randomUUID()}`, placementId, providerFileId,
          requireString(file.path, 'path', 2000), requireString(file.name, 'name', 1000),
          file.size ?? null, booleanOrNull(file.selected), file.mediaHint ?? null,
          normalizeOptionalFileIndex(file.corpusFileIndex), observedAt,
          options.expiresAt ?? null,
          file.evidence == null ? null : JSON.stringify(file.evidence),
        );
      }
      if (seen.size === 0) {
        db.prepare(`
          UPDATE provider_files
          SET present = 0, inventory_observed_at = ?, inventory_expires_at = ?,
              missing_since = COALESCE(missing_since, ?)
          WHERE placement_id = ? AND present = 1
        `).run(observedAt, options.expiresAt ?? null, observedAt, placementId);
      } else {
        const placeholders = [...seen].map(() => '?').join(', ');
        db.prepare(`
          UPDATE provider_files
          SET present = 0, inventory_observed_at = ?, inventory_expires_at = ?,
              missing_since = COALESCE(missing_since, ?)
          WHERE placement_id = ? AND present = 1
            AND provider_file_id NOT IN (${placeholders})
        `).run(observedAt, options.expiresAt ?? null, observedAt, placementId, ...seen);
      }
      db.prepare(`
        INSERT INTO provider_inventory_snapshots (
          placement_id, authoritative, complete, observed_at, expires_at, file_count, evidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(placement_id) DO UPDATE SET
          authoritative = EXCLUDED.authoritative,
          complete = EXCLUDED.complete,
          observed_at = EXCLUDED.observed_at,
          expires_at = EXCLUDED.expires_at,
          file_count = EXCLUDED.file_count,
          evidence = EXCLUDED.evidence
      `).run(
        placementId, Number(options.authoritative === true), Number(options.complete === true),
        observedAt, options.expiresAt ?? null, files.length,
        options.evidence == null ? null : JSON.stringify(options.evidence),
      );
      return listProviderFiles(placementId);
    });
  }

  function listProviderFiles(placementId, { includeMissing = false } = {}) {
    return db.prepare(`
      SELECT * FROM provider_files
      WHERE placement_id = ?${includeMissing ? '' : ' AND present = 1'}
      ORDER BY path, provider_file_id
    `).all(placementId).map(rowToProviderFile);
  }

  function getProviderInventorySnapshot(placementId) {
    const row = db.prepare(
      'SELECT * FROM provider_inventory_snapshots WHERE placement_id = ?',
    ).get(placementId);
    return row ? rowToProviderInventorySnapshot(row) : null;
  }

  function recordFileMapping(input) {
    const identity = validateReleaseIdentity(input);
    const placement = requirePlacement(input.placementId);
    if (placement.infoHash !== identity.infoHash) {
      throw new Error('Candidate mapping hash must match provider placement hash');
    }
    const file = requireProviderFile(input.placementId, input.providerFileId);
    const id = input.id ?? `fm_${randomUUID()}`;
    db.prepare(`
      INSERT INTO candidate_file_mappings (
        id, info_hash, file_index, file_index_key, release_key, placement_id,
        provider_file_id, state, method, authoritative, evidence, mapped_at, failure_category
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(release_key, placement_id) DO UPDATE SET
        provider_file_id = EXCLUDED.provider_file_id,
        state = EXCLUDED.state,
        method = EXCLUDED.method,
        authoritative = EXCLUDED.authoritative,
        evidence = EXCLUDED.evidence,
        mapped_at = EXCLUDED.mapped_at,
        failure_category = EXCLUDED.failure_category
    `).run(
      id, identity.infoHash, identity.fileIndex, identity.fileIndex ?? -1, identity.releaseKey,
      input.placementId, file.providerFileId, input.state ?? 'mapped',
      requireString(input.method, 'method'), Number(input.authoritative === true),
      input.evidence == null ? null : JSON.stringify(input.evidence), input.mappedAt ?? now(),
      input.failureCategory ?? null,
    );
    return rowToFileMapping(db.prepare(`
      SELECT * FROM candidate_file_mappings WHERE release_key = ? AND placement_id = ?
    `).get(identity.releaseKey, input.placementId));
  }

  function recordExposure(input) {
    const placement = requirePlacement(input.placementId);
    requireProviderFile(input.placementId, input.providerFileId);
    const accountScope = normalizeIdentifier(input.accountScope ?? placement.accountScope);
    if (accountScope !== placement.accountScope) {
      throw new Error('Exposure account scope must match provider placement account scope');
    }
    const mountScope = normalizeIdentifier(input.mountScope ?? 'default');
    const transport = normalizeIdentifier(input.transport);
    const exposureKey = requireString(input.exposureKey, 'exposureKey', 1000);
    const observedAt = input.observedAt ?? now();
    const existing = db.prepare(`
      SELECT * FROM exposures
      WHERE transport = ? AND exposure_key = ? AND placement_id = ? AND provider_file_id = ?
    `).get(transport, exposureKey, input.placementId, input.providerFileId);
    if (existing && observedAt < existing.observed_at) return rowToExposure(existing);

    const id = input.id ?? `ex_${randomUUID()}`;
    db.prepare(`
      INSERT INTO exposures (
        id, placement_id, provider_file_id, account_scope, mount_scope, transport,
        exposure_key, relative_path, state, read_only, observed_at, expires_at,
        failure_category, retryable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transport, exposure_key, placement_id, provider_file_id) DO UPDATE SET
        account_scope = EXCLUDED.account_scope,
        mount_scope = EXCLUDED.mount_scope,
        state = EXCLUDED.state,
        relative_path = EXCLUDED.relative_path,
        read_only = EXCLUDED.read_only,
        observed_at = EXCLUDED.observed_at,
        expires_at = EXCLUDED.expires_at,
        failure_category = EXCLUDED.failure_category,
        retryable = EXCLUDED.retryable
      WHERE EXCLUDED.observed_at >= exposures.observed_at
    `).run(
      id, input.placementId, input.providerFileId, accountScope, mountScope, transport,
      exposureKey, input.relativePath ?? null, input.state ?? 'unknown',
      Number(input.readOnly === true), observedAt, input.expiresAt ?? null,
      input.failureCategory ?? null, booleanOrNull(input.retryable),
    );
    return rowToExposure(db.prepare(`
      SELECT * FROM exposures
      WHERE transport = ? AND exposure_key = ? AND placement_id = ? AND provider_file_id = ?
    `).get(transport, exposureKey, input.placementId, input.providerFileId));
  }

  function recordZurgMetadataObservation(input) {
    const identity = createReleaseIdentity(input.infoHash, null);
    const provider = normalizeIdentifier(input.provider);
    const accountScope = normalizeIdentifier(input.accountScope ?? 'default');
    const instanceScope = normalizeIdentifier(input.instanceScope ?? 'default');
    const metadataPath = requireString(input.metadataPath, 'metadataPath', 4000);
    const observedAt = requireTimestamp(input.observedAt, 'observedAt');
    const existing = db.prepare(`
      SELECT * FROM zurg_metadata_observations
      WHERE provider = ? AND account_scope = ? AND instance_scope = ?
        AND info_hash = ? AND metadata_path = ?
    `).get(provider, accountScope, instanceScope, identity.infoHash, metadataPath);
    if (existing && observedAt < existing.observed_at) return rowToZurgMetadataObservation(existing);

    const id = input.id ?? `zm_${randomUUID()}`;
    db.prepare(`
      INSERT INTO zurg_metadata_observations (
        id, provider, account_scope, instance_scope, info_hash, metadata_path,
        observation_state, zurg_state, zurg_state_when, observed_at, expires_at,
        source, failure_category, retryable, evidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, account_scope, instance_scope, info_hash, metadata_path) DO UPDATE SET
        observation_state = EXCLUDED.observation_state,
        zurg_state = EXCLUDED.zurg_state,
        zurg_state_when = EXCLUDED.zurg_state_when,
        observed_at = EXCLUDED.observed_at,
        expires_at = EXCLUDED.expires_at,
        source = EXCLUDED.source,
        failure_category = EXCLUDED.failure_category,
        retryable = EXCLUDED.retryable,
        evidence = EXCLUDED.evidence
      WHERE EXCLUDED.observed_at >= zurg_metadata_observations.observed_at
    `).run(
      id, provider, accountScope, instanceScope, identity.infoHash, metadataPath,
      requireEnum(input.observationState, ['present', 'missing', 'error'], 'observationState'),
      input.zurgState ?? null, input.zurgStateWhen ?? null, observedAt, input.expiresAt ?? null,
      requireString(input.source, 'source'), input.failureCategory ?? null,
      booleanOrNull(input.retryable), input.evidence == null ? null : JSON.stringify(input.evidence),
    );
    return rowToZurgMetadataObservation(db.prepare(`
      SELECT * FROM zurg_metadata_observations
      WHERE provider = ? AND account_scope = ? AND instance_scope = ?
        AND info_hash = ? AND metadata_path = ?
    `).get(provider, accountScope, instanceScope, identity.infoHash, metadataPath));
  }

  function listZurgMetadataObservations(identityInput, scope = {}) {
    const identity = createReleaseIdentity(identityInput.infoHash, null);
    const clauses = ['info_hash = ?'];
    const params = [identity.infoHash];
    for (const [field, column] of [
      ['provider', 'provider'], ['accountScope', 'account_scope'], ['instanceScope', 'instance_scope'],
    ]) {
      if (scope[field] != null) {
        clauses.push(`${column} = ?`);
        params.push(normalizeIdentifier(scope[field]));
      }
    }
    return db.prepare(`
      SELECT * FROM zurg_metadata_observations
      WHERE ${clauses.join(' AND ')}
      ORDER BY provider, account_scope, instance_scope, metadata_path
    `).all(...params).map(rowToZurgMetadataObservation);
  }

  function activateBinding(input) {
    const identity = validateReleaseIdentity(input);
    const item = requireLibraryItem(input.libraryItemId);
    const libraryPath = db.prepare(
      'SELECT * FROM library_paths WHERE id = ? AND library_item_id = ? AND active = 1',
    ).get(input.libraryPathId, item.id);
    if (!libraryPath) throw new Error('Active canonical path does not belong to library item');
    const placement = requirePlacement(input.placementId);
    if (placement.infoHash !== identity.infoHash) {
      throw new Error('Binding hash must match provider placement hash');
    }
    const readiness = db.prepare(
      'SELECT * FROM provider_readiness_observations WHERE placement_id = ?',
    ).get(placement.id);
    const file = requireProviderFile(input.placementId, input.providerFileId);
    const inventorySnapshot = db.prepare(
      'SELECT * FROM provider_inventory_snapshots WHERE placement_id = ?',
    ).get(placement.id);
    const mapping = db.prepare(`
      SELECT * FROM candidate_file_mappings
      WHERE release_key = ? AND placement_id = ? AND provider_file_id = ?
        AND state = 'mapped' AND authoritative = 1
    `).get(identity.releaseKey, input.placementId, file.providerFileId);
    const exposure = db.prepare(`
      SELECT * FROM exposures
      WHERE id = ? AND placement_id = ? AND provider_file_id = ?
    `).get(input.exposureId, input.placementId, file.providerFileId);
    if (!exposure) throw new Error('Exposure does not identify the mapped provider file');
    if (exposure.account_scope !== placement.accountScope) {
      throw new Error('Exposure account scope must match provider placement account scope');
    }
    if (exposure.state !== 'visible') throw new Error('Cannot bind a provider file without visible exposure');
    if (exposure.read_only !== 1) throw new Error('Cannot bind a provider file through writable exposure');
    if (!mapping) throw new Error('Binding requires an authoritative exact file mapping');
    const timestamp = now();
    if (readiness) {
      if (readiness.state !== 'ready') throw new Error('Cannot bind before provider readiness');
      if (readiness.expires_at <= timestamp) {
        throw new Error('Cannot bind through a stale provider readiness observation');
      }
    } else if (placement.state !== 'ready') {
      throw new Error('Cannot bind before provider readiness');
    }
    if (!inventorySnapshot || inventorySnapshot.authoritative !== 1 || inventorySnapshot.complete !== 1) {
      throw new Error('Binding requires an authoritative complete inventory snapshot');
    }
    if (inventorySnapshot.expires_at == null || inventorySnapshot.expires_at <= timestamp
      || file.inventoryExpiresAt == null || file.inventoryExpiresAt <= timestamp) {
      throw new Error('Cannot bind through a stale or unbounded provider inventory observation');
    }
    if (exposure.expires_at == null || exposure.expires_at <= timestamp) {
      throw new Error('Cannot bind through a stale or unbounded exposure observation');
    }

    return transaction(() => {
      const active = db.prepare(
        "SELECT * FROM bindings WHERE library_item_id = ? AND status = 'active'",
      ).get(item.id);
      const newest = db.prepare(
        "SELECT * FROM bindings WHERE library_item_id = ? ORDER BY version DESC LIMIT 1",
      ).get(item.id);
      if (input.expectedBindingVersion != null
        && input.expectedBindingVersion !== (newest?.version ?? 0)) {
        throw new Error('Active binding version changed during reconciliation');
      }
      if (active && active.release_key === identity.releaseKey
        && active.placement_id === input.placementId
        && active.provider_file_id === input.providerFileId
        && active.exposure_id === input.exposureId) {
        return rowToBinding(active);
      }

      if (active) {
        db.prepare(`
          UPDATE bindings SET status = 'superseded', superseded_at = ?, reconciled_at = ?
          WHERE id = ?
        `).run(timestamp, timestamp, active.id);
      } else {
        // Supersede any non-active, non-superseded bindings (e.g. degraded)
        // that would otherwise block version monotonicity.
        const stale = db.prepare(
          "SELECT * FROM bindings WHERE library_item_id = ? AND status NOT IN ('superseded')",
        ).get(item.id);
        if (stale && stale.release_key === identity.releaseKey
          && (stale.placement_id !== input.placementId
            || stale.provider_file_id !== input.providerFileId
            || stale.exposure_id !== input.exposureId)) {
          db.prepare(`
            UPDATE bindings SET status = 'superseded', superseded_at = ?, reconciled_at = ?
            WHERE id = ?
          `).run(timestamp, timestamp, stale.id);
        }
      }
      const version = (db.prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM bindings WHERE library_item_id = ?',
      ).get(item.id).version ?? 0) + 1;
      const id = `bd_${randomUUID()}`;
      db.prepare(`
        INSERT INTO bindings (
          id, library_item_id, library_path_id, release_key, info_hash, file_index,
          file_index_key, placement_id, provider_file_id, exposure_id, version,
          status, reason, valid_from, reconciled_at, failure_category
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `).run(
        id, item.id, libraryPath.id, identity.releaseKey, identity.infoHash,
        identity.fileIndex, identity.fileIndex ?? -1, input.placementId,
        input.providerFileId, input.exposureId, version,
        requireString(input.reason, 'reason', 1000), timestamp, timestamp,
        input.failureCategory ?? null,
      );
      return rowToBinding(db.prepare('SELECT * FROM bindings WHERE id = ?').get(id));
    });
  }

  function listBindings(libraryItemId) {
    return db.prepare(
      'SELECT * FROM bindings WHERE library_item_id = ? ORDER BY version',
    ).all(libraryItemId).map(rowToBinding);
  }

  function listActiveBindingsForPlacement(placementId) {
    requirePlacement(placementId);
    return db.prepare(`
      SELECT * FROM bindings
      WHERE placement_id = ? AND status = 'active'
      ORDER BY library_item_id, version
    `).all(placementId).map(rowToBinding);
  }

  function markBindingDegraded(input) {
    const item = requireLibraryItem(input.libraryItemId);
    const timestamp = now();
    return transaction(() => {
      const active = db.prepare(
        "SELECT * FROM bindings WHERE library_item_id = ? AND status = 'active'",
      ).get(item.id);
      if (!active) {
        throw new Error('No active binding to degrade');
      }
      if (input.expectedBindingVersion != null
        && input.expectedBindingVersion !== active.version) {
        throw new Error('Active binding version changed during degradation');
      }
      const result = db.prepare(`
        UPDATE bindings
        SET status = 'degraded', reconciled_at = ?, failure_category = ?
        WHERE id = ? AND status = 'active'
      `).run(timestamp, input.failureCategory ?? 'unknown', active.id);
      if (Number(result.changes) !== 1) {
        throw new Error('Binding state changed concurrently during degradation');
      }
      return rowToBinding(db.prepare('SELECT * FROM bindings WHERE id = ?').get(active.id));
    });
  }

  function createRepairTransaction(input) {
    const item = requireLibraryItem(input.libraryItemId);
    const identity = validateReleaseIdentity(input.desiredIdentity);
    const planIdentity = validateReleaseIdentity(input.plan?.desiredIdentity);
    if (input.plan?.status !== 'repair-required' || input.plan?.planKey !== input.planKey
      || input.plan?.binding?.version !== input.expectedBindingVersion
      || planIdentity.releaseKey !== identity.releaseKey
      || !sameRepairScope(input.plan?.scope, input.scope)
      || !sameStringSet(input.plan?.permittedActions, input.plan?.actionSequence)) {
      throw new TypeError('Repair transaction requires a consistent executable repair plan');
    }
    const binding = db.prepare(
      "SELECT * FROM bindings WHERE library_item_id = ? ORDER BY version DESC LIMIT 1",
    ).get(item.id);
    if (!binding || binding.release_key !== identity.releaseKey
      || binding.version !== input.expectedBindingVersion
      || binding.id !== input.plan.binding.id
      || binding.placement_id !== input.plan.binding.placementId
      || binding.provider_file_id !== input.plan.binding.providerFileId
      || binding.exposure_id !== input.plan.binding.exposureId) {
      throw new Error('Repair plan binding version is no longer current');
    }
    const timestamp = now();
    const id = input.id ?? `rp_${randomUUID()}`;
    db.prepare(`
      INSERT INTO repair_transactions (
        id, plan_key, library_item_id, info_hash, file_index, file_index_key,
        release_key, account_scope, instance_scope, mount_scope,
        expected_binding_version, status, plan, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)
      ON CONFLICT(plan_key, expected_binding_version) DO NOTHING
    `).run(
      id, requireString(input.planKey, 'planKey', 1000), item.id,
      identity.infoHash, identity.fileIndex, identity.fileIndex ?? -1, identity.releaseKey,
      normalizeIdentifier(input.scope.accountScope),
      normalizeIdentifier(input.scope.instanceScope),
      normalizeIdentifier(input.scope.mountScope),
      input.expectedBindingVersion, JSON.stringify(input.plan), timestamp, timestamp,
    );
    const row = db.prepare(`
      SELECT * FROM repair_transactions
      WHERE plan_key = ? AND expected_binding_version = ?
    `).get(input.planKey, input.expectedBindingVersion);
    return repairTransactionWithSteps(row);
  }

  function authorizeRepairTransaction(id, input) {
    const transactionId = requireString(id, 'repairTransactionId');
    const row = db.prepare('SELECT * FROM repair_transactions WHERE id = ?').get(transactionId);
    if (!row) throw new Error(`Unknown repair transaction: ${transactionId}`);
    if (row.status !== 'planned' && row.status !== 'authorized') {
      throw new Error(`Repair transaction cannot be authorized from ${row.status}`);
    }
    const binding = db.prepare(
      "SELECT * FROM bindings WHERE library_item_id = ? ORDER BY version DESC LIMIT 1",
    ).get(row.library_item_id);
    if (!binding || binding.version !== row.expected_binding_version
      || binding.release_key !== row.release_key) {
      throw new Error('Repair authorization binding version is no longer current');
    }
    const plan = JSON.parse(row.plan);
    const requested = requireStringArray(input.actions, 'actions');
    const sequence = plan.actionSequence ?? [];
    const permitted = new Set(plan.permittedActions ?? []);
    if (requested.some((action) => !permitted.has(action))) {
      throw new Error('Repair authorization includes an action not permitted by the plan');
    }
    const ordered = sequence.filter((action) => requested.includes(action));
    if (ordered.length !== requested.length || ordered.some((action, index) => action !== requested[index])) {
      throw new Error('Repair authorization actions must preserve the plan action order');
    }
    const timestamp = now();
    const result = db.prepare(`
      UPDATE repair_transactions
      SET status = 'authorized', authorized_actions = ?, authorized_by = ?,
        authorized_at = COALESCE(authorized_at, ?), updated_at = ?, failure_category = NULL
      WHERE id = ? AND status = ?
    `).run(
      JSON.stringify(requested), requireString(input.authorizedBy, 'authorizedBy'),
      timestamp, timestamp, transactionId, row.status,
    );
    if (Number(result.changes) !== 1) throw new Error('Repair authorization state changed concurrently');
    return getRepairTransaction(transactionId);
  }

  function startRepairStep(id, action, request = null) {
    const transactionId = requireString(id, 'repairTransactionId');
    return transaction(() => {
      const row = db.prepare('SELECT * FROM repair_transactions WHERE id = ?').get(transactionId);
      if (!row) throw new Error(`Unknown repair transaction: ${transactionId}`);
      if (!['authorized', 'executing'].includes(row.status)) {
        throw new Error(`Repair transaction cannot execute from ${row.status}`);
      }
      const authorized = new Set(JSON.parse(row.authorized_actions ?? '[]'));
      if (!authorized.has(action)) throw new Error(`Repair action is not authorized: ${action}`);
      const prior = db.prepare(`
        SELECT * FROM repair_steps
        WHERE repair_transaction_id = ? AND action = ? AND status = 'succeeded'
        ORDER BY attempt DESC LIMIT 1
      `).get(transactionId, action);
      if (prior) return rowToRepairStep(prior);
      const running = db.prepare(`
        SELECT * FROM repair_steps
        WHERE repair_transaction_id = ? AND action = ? AND status = 'running'
        ORDER BY attempt DESC LIMIT 1
      `).get(transactionId, action);
      if (running) return rowToRepairStep(running);
      const timestamp = now();
      const transition = db.prepare(`
        UPDATE repair_transactions SET status = 'executing',
          started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND status IN ('authorized', 'executing')
      `).run(timestamp, timestamp, transactionId);
      if (Number(transition.changes) !== 1) throw new Error('Repair transaction state changed concurrently');
      const attempt = Number(db.prepare(`
        SELECT COALESCE(MAX(attempt), 0) AS value FROM repair_steps
        WHERE repair_transaction_id = ? AND action = ?
      `).get(transactionId, action).value) + 1;
      const result = db.prepare(`
        INSERT INTO repair_steps (
          repair_transaction_id, action, status, attempt, request, started_at
        ) VALUES (?, ?, 'running', ?, ?, ?)
      `).run(
        transactionId, requireString(action, 'action'), attempt,
        request == null ? null : JSON.stringify(request), timestamp,
      );
      return rowToRepairStep(
        db.prepare('SELECT * FROM repair_steps WHERE id = ?').get(result.lastInsertRowid),
      );
    });
  }

  function completeRepairStep(stepId, result = null) {
    const step = db.prepare('SELECT * FROM repair_steps WHERE id = ?').get(stepId);
    if (!step) throw new Error(`Unknown repair step: ${stepId}`);
    if (step.status === 'succeeded') return rowToRepairStep(step);
    if (step.status !== 'running') throw new Error(`Repair step cannot succeed from ${step.status}`);
    const timestamp = now();
    transaction(() => {
      const stepResult = db.prepare(`
        UPDATE repair_steps SET status = 'succeeded', result = ?, completed_at = ?
        WHERE id = ? AND status = 'running'
      `).run(result == null ? null : JSON.stringify(result), timestamp, stepId);
      if (Number(stepResult.changes) !== 1) throw new Error('Repair step state changed concurrently');
      const transactionResult = db.prepare(`
        UPDATE repair_transactions SET updated_at = ?
        WHERE id = ? AND status = 'executing'
      `).run(timestamp, step.repair_transaction_id);
      if (Number(transactionResult.changes) !== 1) {
        throw new Error('Repair transaction state changed concurrently');
      }
    });
    return rowToRepairStep(db.prepare('SELECT * FROM repair_steps WHERE id = ?').get(stepId));
  }

  function failRepairStep(stepId, error = {}) {
    const step = db.prepare('SELECT * FROM repair_steps WHERE id = ?').get(stepId);
    if (!step) throw new Error(`Unknown repair step: ${stepId}`);
    if (step.status !== 'running') throw new Error(`Repair step cannot fail from ${step.status}`);
    const timestamp = now();
    const category = requireString(error.failureCategory ?? 'repair-operation-failed', 'failureCategory');
    transaction(() => {
      const stepResult = db.prepare(`
        UPDATE repair_steps SET status = 'failed', result = ?, failure_category = ?,
          retryable = ?, completed_at = ? WHERE id = ? AND status = 'running'
      `).run(
        error.result == null ? null : JSON.stringify(error.result), category,
        booleanOrNull(error.retryable), timestamp, stepId,
      );
      if (Number(stepResult.changes) !== 1) throw new Error('Repair step state changed concurrently');
      const transactionResult = db.prepare(`
        UPDATE repair_transactions SET status = 'failed', failure_category = ?,
          completed_at = ?, updated_at = ? WHERE id = ? AND status = 'executing'
      `).run(category, timestamp, timestamp, step.repair_transaction_id);
      if (Number(transactionResult.changes) !== 1) {
        throw new Error('Repair transaction state changed concurrently');
      }
    });
    return rowToRepairStep(db.prepare('SELECT * FROM repair_steps WHERE id = ?').get(stepId));
  }

  function failRepairTransaction(id, error = {}) {
    const transactionId = requireString(id, 'repairTransactionId');
    const row = db.prepare('SELECT * FROM repair_transactions WHERE id = ?').get(transactionId);
    if (!row) throw new Error(`Unknown repair transaction: ${transactionId}`);
    if (!['authorized', 'executing'].includes(row.status)) {
      throw new Error(`Repair transaction cannot fail from ${row.status}`);
    }
    const category = requireString(error.failureCategory ?? 'repair-operation-failed', 'failureCategory');
    const timestamp = now();
    const result = db.prepare(`
      UPDATE repair_transactions SET status = 'failed', failure_category = ?,
        completed_at = ?, updated_at = ? WHERE id = ? AND status = ?
    `).run(category, timestamp, timestamp, transactionId, row.status);
    if (Number(result.changes) !== 1) throw new Error('Repair transaction state changed concurrently');
    return getRepairTransaction(transactionId);
  }

  function resumeRepairTransaction(id) {
    const transactionId = requireString(id, 'repairTransactionId');
    const row = db.prepare('SELECT * FROM repair_transactions WHERE id = ?').get(transactionId);
    if (!row) throw new Error(`Unknown repair transaction: ${transactionId}`);
    if (row.status !== 'failed') throw new Error(`Repair transaction cannot resume from ${row.status}`);
    const ambiguous = db.prepare(`
      SELECT COUNT(*) AS count FROM repair_steps
      WHERE repair_transaction_id = ? AND status = 'running'
    `).get(transactionId).count;
    if (ambiguous > 0) {
      throw new Error('Repair transaction has an ambiguous running operation requiring manual resolution');
    }
    const timestamp = now();
    const result = db.prepare(`
      UPDATE repair_transactions SET status = 'authorized', failure_category = NULL,
        completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'failed'
    `).run(timestamp, transactionId);
    if (Number(result.changes) !== 1) throw new Error('Repair transaction state changed concurrently');
    return getRepairTransaction(transactionId);
  }

  function completeRepairTransaction(id) {
    const transactionId = requireString(id, 'repairTransactionId');
    const row = db.prepare('SELECT * FROM repair_transactions WHERE id = ?').get(transactionId);
    if (!row) throw new Error(`Unknown repair transaction: ${transactionId}`);
    if (row.status === 'succeeded') return getRepairTransaction(transactionId);
    if (row.status !== 'executing') throw new Error(`Repair transaction cannot succeed from ${row.status}`);
    const incomplete = db.prepare(`
      SELECT COUNT(*) AS count FROM repair_steps
      WHERE repair_transaction_id = ? AND status = 'running'
    `).get(transactionId).count;
    if (incomplete > 0) throw new Error('Repair transaction has incomplete steps');
    const authorized = JSON.parse(row.authorized_actions ?? '[]');
    const succeeded = new Set(db.prepare(`
      SELECT action FROM repair_steps
      WHERE repair_transaction_id = ? AND status = 'succeeded'
    `).all(transactionId).map((step) => step.action));
    if (authorized.some((action) => !succeeded.has(action))) {
      throw new Error('Repair transaction has actions without successful attempts');
    }
    const timestamp = now();
    const result = db.prepare(`
      UPDATE repair_transactions SET status = 'succeeded', completed_at = ?,
        updated_at = ?, failure_category = NULL WHERE id = ? AND status = 'executing'
    `).run(timestamp, timestamp, transactionId);
    if (Number(result.changes) !== 1) throw new Error('Repair transaction state changed concurrently');
    return getRepairTransaction(transactionId);
  }

  function getRepairTransaction(id) {
    const row = db.prepare('SELECT * FROM repair_transactions WHERE id = ?')
      .get(requireString(id, 'repairTransactionId'));
    return row ? repairTransactionWithSteps(row) : null;
  }

  function listRepairTransactions(libraryItemId) {
    requireLibraryItem(libraryItemId);
    return db.prepare(`
      SELECT * FROM repair_transactions WHERE library_item_id = ? ORDER BY created_at, id
    `).all(libraryItemId).map(repairTransactionWithSteps);
  }

  function repairTransactionWithSteps(row) {
    return {
      ...rowToRepairTransaction(row),
      steps: db.prepare(`
        SELECT * FROM repair_steps WHERE repair_transaction_id = ? ORDER BY id
      `).all(row.id).map(rowToRepairStep),
    };
  }

  function getReconciliationSnapshot(libraryItemId, identityInput) {
    const item = requireLibraryItem(libraryItemId);
    const identity = validateReleaseIdentity(identityInput);
    const placements = db.prepare(`
      SELECT p.*, COUNT(b.id) AS dependent_binding_count
      FROM provider_placements p
      LEFT JOIN bindings b
        ON b.placement_id = p.id AND b.status = 'active'
      WHERE p.info_hash = ?
      GROUP BY p.id
      ORDER BY p.provider, p.account_scope, p.id
    `).all(identity.infoHash).map((row) => ({
      ...rowToPlacement(row),
      dependentBindingCount: Number(row.dependent_binding_count),
    }));
    const placementIds = placements.map((placement) => placement.id);
    const placementObservations = db.prepare(`
      SELECT * FROM provider_placement_observations WHERE info_hash = ?
      ORDER BY provider, account_scope
    `).all(identity.infoHash).map(rowToPlacementLookupObservation);
    const readinessObservations = queryRowsForIds(
      db, 'SELECT * FROM provider_readiness_observations WHERE placement_id', placementIds,
    ).map(rowToReadinessObservation);
    const providerFiles = queryRowsForIds(
      db, 'SELECT * FROM provider_files WHERE present = 1 AND placement_id', placementIds,
    ).map(rowToProviderFile);
    const inventorySnapshots = queryRowsForIds(
      db, 'SELECT * FROM provider_inventory_snapshots WHERE placement_id', placementIds,
    ).map(rowToProviderInventorySnapshot);
    const mappings = queryRowsForIds(
      db, 'SELECT * FROM candidate_file_mappings WHERE placement_id', placementIds,
    ).filter((row) => row.release_key === identity.releaseKey).map(rowToFileMapping);
    const exposures = queryRowsForIds(
      db, 'SELECT * FROM exposures WHERE placement_id', placementIds,
    ).map(rowToExposure);
    const zurgMetadata = listZurgMetadataObservations(identity);
    const newestBindingRow = db.prepare(
      "SELECT * FROM bindings WHERE library_item_id = ? ORDER BY version DESC LIMIT 1",
    ).get(item.id);
    return {
      desired: {
        libraryItemId: item.id,
        libraryPathId: db.prepare(
          'SELECT id FROM library_paths WHERE library_item_id = ? AND active = 1',
        ).get(item.id)?.id ?? null,
        desiredState: item.desiredState,
        ...identity,
      },
      placements,
      placementObservations,
      readinessObservations,
      inventorySnapshots,
      providerFiles,
      mappings,
      exposures,
      zurgMetadata,
      currentBinding: newestBindingRow ? rowToBinding(newestBindingRow) : null,
    };
  }

  function appendLifecycleEvent(input) {
    requireLibraryItem(input.libraryItemId);
    const event = createLifecycleEvent(input, { now: now() });
    const result = db.prepare(`
      INSERT INTO lifecycle_events (
        library_item_id, milestone, status, occurred_at, failure_category,
        retryable, retry_after_ms, source, reason, evidence, correlation_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.libraryItemId, event.milestone, event.status, event.occurredAt,
      event.failureCategory, booleanOrNull(event.retryable), event.retryAfterMs,
      event.source, event.reason, event.evidence == null ? null : JSON.stringify(event.evidence),
      event.correlationId, now(),
    );
    return rowToLifecycleEvent(db.prepare('SELECT * FROM lifecycle_events WHERE id = ?').get(result.lastInsertRowid));
  }

  function getLifecycle(libraryItemId) {
    requireLibraryItem(libraryItemId);
    const events = db.prepare(
      'SELECT * FROM lifecycle_events WHERE library_item_id = ? ORDER BY occurred_at, id',
    ).all(libraryItemId).map(rowToLifecycleEvent);
    return { events, milestones: projectLifecycle(events) };
  }

  function requireLibraryItem(id) {
    const item = getLibraryItem(id);
    if (!item) throw new Error(`Unknown library item: ${id}`);
    return item;
  }
  function requirePlacement(id) {
    const row = db.prepare('SELECT * FROM provider_placements WHERE id = ?').get(id);
    if (!row) throw new Error(`Unknown provider placement: ${id}`);
    return rowToPlacement(row);
  }
  function requireProviderFile(placementId, providerFileId) {
    const row = db.prepare(`
      SELECT * FROM provider_files
      WHERE placement_id = ? AND provider_file_id = ? AND present = 1
    `).get(placementId, providerFileId);
    if (!row) throw new Error('Provider file is not present in authoritative placement inventory');
    return rowToProviderFile(row);
  }

  return {
    ensureLibraryItem,
    getLibraryItem,
    listLibraryItems,
    getActiveCanonicalPath,
    ensureCanonicalPath,
    recordPlacement,
    findPlacement,
    findPlacementByInfoHash,
    findFileMapping,
    recordPlacementLookupObservation,
    recordReadinessObservation,
    markPlacementRemoved,
    replaceProviderFileInventory,
    listProviderFiles,
    getProviderInventorySnapshot,
    recordFileMapping,
    recordExposure,
    recordZurgMetadataObservation,
    listZurgMetadataObservations,
    activateBinding,
    markBindingDegraded,
    listBindings,
    listActiveBindingsForPlacement,
    createRepairTransaction,
    authorizeRepairTransaction,
    startRepairStep,
    completeRepairStep,
    failRepairStep,
    failRepairTransaction,
    resumeRepairTransaction,
    completeRepairTransaction,
    getRepairTransaction,
    listRepairTransactions,
    getReconciliationSnapshot,
    appendLifecycleEvent,
    getLifecycle,
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
    get db() { return db; },
  };
}

function rowToLibraryItem(row) {
  return {
    id: row.id, identityKey: row.identity_key, mediaType: row.media_type,
    mediaId: row.media_id, editionKey: row.edition_key, title: row.title,
    year: row.year, season: row.season, episode: row.episode,
    desiredState: row.desired_state, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function rowToLibraryPath(row) {
  return {
    id: row.id, libraryItemId: row.library_item_id, canonicalPath: row.canonical_path,
    preferredPath: row.preferred_path, collisionKey: row.collision_key,
    active: row.active === 1, createdAt: row.created_at, retiredAt: row.retired_at,
  };
}
function rowToPlacement(row) {
  return {
    id: row.id, provider: row.provider, accountScope: row.account_scope,
    infoHash: row.info_hash, providerResourceId: row.provider_resource_id,
    state: row.state, ownership: row.ownership, ownerKey: row.owner_key,
    provenance: row.provenance, idempotencyKey: row.idempotency_key,
    observedAt: row.observed_at, expiresAt: row.expires_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
    failureCategory: row.failure_category, retryable: fromSqlBoolean(row.retryable),
  };
}
function rowToPlacementLookupObservation(row) {
  return {
    id: row.id, provider: row.provider, accountScope: row.account_scope,
    infoHash: row.info_hash, fileIndex: null, releaseKey: `${row.info_hash}:torrent`,
    observationState: row.observation_state, placementId: row.placement_id,
    observedAt: row.observed_at, expiresAt: row.expires_at, source: row.source,
    failureCategory: row.failure_category, retryable: fromSqlBoolean(row.retryable),
  };
}
function rowToReadinessObservation(row) {
  return {
    placementId: row.placement_id, state: row.state,
    observedAt: row.observed_at, expiresAt: row.expires_at, source: row.source,
    failureCategory: row.failure_category, retryable: fromSqlBoolean(row.retryable),
  };
}
function rowToProviderFile(row) {
  return {
    id: row.id, placementId: row.placement_id, providerFileId: row.provider_file_id,
    path: row.path, name: row.name, size: row.size, selected: fromSqlBoolean(row.selected),
    mediaHint: row.media_hint, corpusFileIndex: row.corpus_file_index,
    present: row.present === 1, inventoryObservedAt: row.inventory_observed_at,
    inventoryExpiresAt: row.inventory_expires_at, missingSince: row.missing_since,
    evidence: row.evidence ? JSON.parse(row.evidence) : null,
  };
}
function rowToProviderInventorySnapshot(row) {
  return {
    placementId: row.placement_id,
    authoritative: row.authoritative === 1,
    complete: row.complete === 1,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    fileCount: row.file_count,
    evidence: row.evidence ? JSON.parse(row.evidence) : null,
  };
}
function rowToFileMapping(row) {
  return {
    id: row.id, infoHash: row.info_hash, fileIndex: row.file_index,
    releaseKey: row.release_key, placementId: row.placement_id,
    providerFileId: row.provider_file_id, state: row.state, method: row.method,
    authoritative: row.authoritative === 1, evidence: row.evidence ? JSON.parse(row.evidence) : null,
    mappedAt: row.mapped_at, failureCategory: row.failure_category,
  };
}
function rowToExposure(row) {
  return {
    id: row.id, placementId: row.placement_id, providerFileId: row.provider_file_id,
    accountScope: row.account_scope, mountScope: row.mount_scope,
    transport: row.transport, exposureKey: row.exposure_key, relativePath: row.relative_path,
    state: row.state, readOnly: row.read_only === 1, observedAt: row.observed_at,
    expiresAt: row.expires_at, failureCategory: row.failure_category,
    retryable: fromSqlBoolean(row.retryable),
  };
}
function rowToZurgMetadataObservation(row) {
  return {
    id: row.id, provider: row.provider, accountScope: row.account_scope,
    instanceScope: row.instance_scope, infoHash: row.info_hash, fileIndex: null,
    releaseKey: `${row.info_hash}:torrent`, metadataPath: row.metadata_path,
    observationState: row.observation_state, zurgState: row.zurg_state,
    zurgStateWhen: row.zurg_state_when, observedAt: row.observed_at,
    expiresAt: row.expires_at, source: row.source,
    failureCategory: row.failure_category, retryable: fromSqlBoolean(row.retryable),
    evidence: row.evidence ? JSON.parse(row.evidence) : null,
  };
}
function rowToBinding(row) {
  return {
    id: row.id, libraryItemId: row.library_item_id, libraryPathId: row.library_path_id,
    releaseKey: row.release_key, infoHash: row.info_hash, fileIndex: row.file_index,
    placementId: row.placement_id, providerFileId: row.provider_file_id,
    exposureId: row.exposure_id, version: row.version, status: row.status,
    reason: row.reason, validFrom: row.valid_from, supersededAt: row.superseded_at,
    reconciledAt: row.reconciled_at, failureCategory: row.failure_category,
  };
}
function rowToRepairTransaction(row) {
  const desiredIdentity = createReleaseIdentity(row.info_hash, row.file_index);
  if (desiredIdentity.releaseKey !== row.release_key
    || row.file_index_key !== (desiredIdentity.fileIndex ?? -1)) {
    throw new Error('Persisted repair transaction canonical identity is inconsistent');
  }
  return {
    id: row.id, planKey: row.plan_key, libraryItemId: row.library_item_id,
    desiredIdentity,
    scope: {
      accountScope: row.account_scope,
      instanceScope: row.instance_scope,
      mountScope: row.mount_scope,
    },
    expectedBindingVersion: row.expected_binding_version,
    status: row.status, plan: JSON.parse(row.plan),
    authorizedActions: row.authorized_actions ? JSON.parse(row.authorized_actions) : [],
    authorizedBy: row.authorized_by, createdAt: row.created_at,
    authorizedAt: row.authorized_at, startedAt: row.started_at,
    completedAt: row.completed_at, updatedAt: row.updated_at,
    failureCategory: row.failure_category,
  };
}
function rowToRepairStep(row) {
  return {
    id: Number(row.id), repairTransactionId: row.repair_transaction_id,
    action: row.action, status: row.status, attempt: row.attempt,
    request: row.request ? JSON.parse(row.request) : null,
    result: row.result ? JSON.parse(row.result) : null,
    failureCategory: row.failure_category, retryable: fromSqlBoolean(row.retryable),
    startedAt: row.started_at, completedAt: row.completed_at,
  };
}
function rowToLifecycleEvent(row) {
  return {
    id: Number(row.id), libraryItemId: row.library_item_id, milestone: row.milestone,
    status: row.status, occurredAt: row.occurred_at, failureCategory: row.failure_category,
    retryable: fromSqlBoolean(row.retryable), retryAfterMs: row.retry_after_ms,
    source: row.source, reason: row.reason,
    evidence: row.evidence ? JSON.parse(row.evidence) : null,
    correlationId: row.correlation_id,
  };
}
function queryRowsForIds(db, prefix, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`${prefix} IN (${placeholders})`).all(...ids);
}
function migrateExposureSchema(db) {
  const columns = db.prepare('PRAGMA table_info(exposures)').all();
  if (columns.length === 0) return;
  const hasAccountScope = columns.some((row) => row.name === 'account_scope');
  const hasMountScope = columns.some((row) => row.name === 'mount_scope');
  const uniqueColumns = db.prepare('PRAGMA index_list(exposures)').all()
    .filter((row) => row.unique === 1)
    .map((row) => db.prepare(`PRAGMA index_info(${row.name})`).all().map((entry) => entry.name));
  const hasVersionedTargetKey = uniqueColumns.some((names) =>
    names.join(',') === 'transport,exposure_key,placement_id,provider_file_id');
  if (hasAccountScope && hasMountScope && hasVersionedTargetKey) return;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE exposures_stage6 (
        id TEXT PRIMARY KEY,
        placement_id TEXT NOT NULL,
        provider_file_id TEXT NOT NULL,
        account_scope TEXT NOT NULL,
        mount_scope TEXT NOT NULL,
        transport TEXT NOT NULL,
        exposure_key TEXT NOT NULL,
        relative_path TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'visible', 'missing', 'degraded', 'error', 'unknown')),
        read_only INTEGER NOT NULL CHECK (read_only IN (0, 1)),
        observed_at INTEGER NOT NULL,
        expires_at INTEGER,
        failure_category TEXT,
        retryable INTEGER,
        UNIQUE (transport, exposure_key, placement_id, provider_file_id),
        FOREIGN KEY (placement_id, provider_file_id) REFERENCES provider_files(placement_id, provider_file_id)
      );
    `);
    const accountExpression = hasAccountScope ? 'e.account_scope' : 'p.account_scope';
    const mountExpression = hasMountScope ? 'e.mount_scope' : "'legacy-unverified'";
    db.exec(`
      INSERT INTO exposures_stage6 (
        id, placement_id, provider_file_id, account_scope, mount_scope, transport,
        exposure_key, relative_path, state, read_only, observed_at, expires_at,
        failure_category, retryable
      )
      SELECT e.id, e.placement_id, e.provider_file_id, ${accountExpression}, ${mountExpression},
        e.transport, e.exposure_key, e.relative_path, e.state, e.read_only,
        e.observed_at, e.expires_at, e.failure_category, e.retryable
      FROM exposures e
      JOIN provider_placements p ON p.id = e.placement_id;
      DROP TABLE exposures;
      ALTER TABLE exposures_stage6 RENAME TO exposures;
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
function normalizeOptionalFileIndex(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('corpusFileIndex must be null or a non-negative safe integer');
  }
  return value;
}
function normalizeIdentifier(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.trim())) {
    throw new TypeError('Provider identifier is invalid');
  }
  return value.trim().toLowerCase();
}
function requireTimestamp(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}
function requireBoundedExpiry(value, observedAt, subject) {
  const expiresAt = requireTimestamp(value, 'expiresAt');
  if (expiresAt <= observedAt) {
    throw new TypeError(`${subject} observation requires a future expiresAt`);
  }
  return expiresAt;
}
function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw new TypeError(`Invalid ${field}: ${value}`);
  return value;
}
function normalizeInfoHash(infoHash) {
  return String(infoHash || '').trim().toLowerCase();
}
function requireString(value, field, max = 256) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}
function requireStringArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty array`);
  }
  const normalized = value.map((entry) => requireString(entry, field));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${field} must contain unique values`);
  }
  return normalized;
}
function sameRepairScope(left, right) {
  if (!left || !right) return false;
  return ['accountScope', 'instanceScope', 'mountScope']
    .every((key) => left[key] === right[key]);
}
function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)
    || left.length === 0 || left.length !== right.length) return false;
  const leftSet = new Set(left);
  return leftSet.size === left.length && right.every((entry) => leftSet.has(entry));
}
function booleanOrNull(value) {
  return value == null ? null : Number(Boolean(value));
}
function fromSqlBoolean(value) {
  return value == null ? null : value === 1;
}
