/**
 * Repair failure-classification event taxonomy (Slice 2.6).
 *
 * The control plane's lifecycle_events table is reserved for the strict
 * canonical milestones (see lifecycle.js). Repair, inventory, and delivery
 * outcomes use a separate, additive event family that the torbox-delivery
 * and selection seams write to lifecycle_events via raw SQL — exactly as
 * applyMappingConflict already does for torrent-file-mapping-conflict.
 *
 * Each event is keyed on a stable failure_category string from
 * REPAIR_FAILURE_CATEGORIES, recorded with source='control-plane-repair'.
 * The library_item_id is resolved from the affected info_hash when one
 * exists; events without a library item are still recorded so that
 * observability does not depend on cataloging.
 *
 * Categories:
 *   - stale-placement-repaired:          a provider placement was missing
 *      upstream and was successfully recreated with cached-only semantics.
 *   - stale-placement-unrecoverable:     a stale placement could not be
 *      recreated (cache miss, recreate failure, inventory missing, etc).
 *   - cached-only-placement-recreation-failed: a TorBox creative response
 *      was rejected by the cached-only contract.
 *   - inventory-refresh-failed:          an authoritative provider inventory
 *      call failed and the existing snapshot is left in place.
 *   - inventory-mapping-conflict:        a provider file collided with an
 *      existing TorrentFile on (size, internal_path) and was demoted to
 *      mapping_state='conflict'. The underlying canonical mapping is
 *      durable; the conflict is observable here.
 *   - requestdl-rate-limited:            TorBox requestdl returned 429.
 *      The capability is left valid; only back-pressure fires.
 *   - requestdl-upstream-5xx:            TorBox requestdl returned 5xx and
 *      the request was bounded (no retry, no further provider mutation).
 *   - delivery-capability-expired:       a cached CDN URL was rejected as
 *      401/403/404 and was invalidated; the next call re-resolves once.
 *   - delivery-capability-recovered:     a fresh CDN URL was re-resolved
 *      after the previous capability was invalidated.
 *   - provider-byte-read-failure:        a 4xx/5xx response from the
 *      upstream byte read; never poisons a valid capability.
 */

export const REPAIR_FAILURE_CATEGORIES = Object.freeze({
  STALE_PLACEMENT_REPAIRED: 'stale-placement-repaired',
  STALE_PLACEMENT_UNRECOVERABLE: 'stale-placement-unrecoverable',
  CACHED_ONLY_PLACEMENT_RECREATION_FAILED: 'cached-only-placement-recreation-failed',
  INVENTORY_REFRESH_FAILED: 'inventory-refresh-failed',
  INVENTORY_MAPPING_CONFLICT: 'inventory-mapping-conflict',
  REQUESTDL_RATE_LIMITED: 'requestdl-rate-limited',
  REQUESTDL_UPSTREAM_5XX: 'requestdl-upstream-5xx',
  DELIVERY_CAPABILITY_EXPIRED: 'delivery-capability-expired',
  DELIVERY_CAPABILITY_RECOVERED: 'delivery-capability-recovered',
  PROVIDER_BYTE_READ_FAILURE: 'provider-byte-read-failure',
});

const REPAIR_SOURCE = 'control-plane-repair';
const REPAIR_MILESTONE = 'provider-repair-event';

/**
 * Append a repair event to lifecycle_events.
 *
 * @param {Object} store  Control-plane store exposing db + lifecycle insert
 * @param {Object} input
 * @param {string} input.failureCategory  one of REPAIR_FAILURE_CATEGORIES
 * @param {string|null} [input.libraryItemId]  optional library item
 * @param {string|null} [input.infoHash]       used to resolve a library item
 *                                             if libraryItemId is absent
 * @param {string} [input.status='degraded']   'satisfied' for repaired/recovered
 * @param {boolean} [input.retryable=false]
 * @param {string|null} [input.reason]
 * @param {Object|null} [input.evidence]
 * @param {string|null} [input.correlationId]
 * @param {number} [input.observedAt]
 * @param {Function} input.now
 */
export function recordRepairEvent(store, input) {
  if (!store || !store.db) {
    throw new TypeError('recordRepairEvent requires a control-plane store');
  }
  const category = requireCategory(input?.failureCategory);
  const now = input?.now ?? (() => Date.now());
  const occurredAt = requireInteger(input?.observedAt ?? now(), 'observedAt');
  const libraryItemId = input?.libraryItemId
    ?? resolveLibraryItemId(store, input?.infoHash);
  // Failure categories always require retryable to be present (true|false).
  // 'satisfied' recovery events are also explicit about non-retry.
  const retryable = input?.retryable === true ? 1 : 0;
  const status = input?.status ?? (category === REPAIR_FAILURE_CATEGORIES.STALE_PLACEMENT_REPAIRED
    || category === REPAIR_FAILURE_CATEGORIES.DELIVERY_CAPABILITY_RECOVERED
    ? 'satisfied' : 'degraded');
  const reason = typeof input?.reason === 'string' ? input.reason : null;
  const evidence = input?.evidence == null ? null : safeStringify(input.evidence);
  const correlationId = typeof input?.correlationId === 'string' ? input.correlationId : null;
  const recordedAt = now();
  if (!libraryItemId) {
    // Repair events with no library item are recorded as best-effort
    // observability on a per-info_hash evidence row via the
    // repair_evidence table created below. This keeps the lifecycle
    // projection honest and lets operators grep the DB for failure
    // categories that did not have a library context at write time.
    recordRepairEvidence(store, {
      failureCategory: category,
      infoHash: input?.infoHash ?? null,
      reason,
      evidence,
      correlationId,
      occurredAt,
      recordedAt,
    });
    return;
  }
  store.db.prepare(`
    INSERT INTO lifecycle_events (
      library_item_id, milestone, status, occurred_at, failure_category,
      retryable, retry_after_ms, source, reason, evidence, correlation_id, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(
    libraryItemId, REPAIR_MILESTONE, status, occurredAt, category,
    retryable, REPAIR_SOURCE, reason, evidence, correlationId, recordedAt,
  );
}

function requireCategory(value) {
  if (typeof value !== 'string') {
    throw new TypeError('failureCategory must be a string');
  }
  const allowed = new Set(Object.values(REPAIR_FAILURE_CATEGORIES));
  if (!allowed.has(value)) {
    throw new TypeError(`Unsupported repair failure category: ${value}`);
  }
  return value;
}

function requireInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function resolveLibraryItemId(store, infoHash) {
  if (!infoHash) return null;
  if (typeof store.findLibraryItemByInfoHash === 'function') {
    const item = store.findLibraryItemByInfoHash(infoHash);
    return item?.id ?? null;
  }
  return null;
}

function recordRepairEvidence(store, payload) {
  // The repair_evidence table is created eagerly by
  // migrateRepairEvidenceSchema in the control-plane store. This call
  // is a no-op safety net for the case where recordRepairEvent is
  // invoked with a store that was not initialized through the standard
  // control-plane-store path (e.g. legacy test fixtures).
  ensureRepairEvidenceTable(store);
  store.db.prepare(`
    INSERT INTO repair_evidence (
      failure_category, info_hash, reason, evidence,
      correlation_id, occurred_at, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.failureCategory, payload.infoHash, payload.reason, payload.evidence,
    payload.correlationId, payload.occurredAt, payload.recordedAt,
  );
}

function ensureRepairEvidenceTable(store) {
  // Idempotent CREATE TABLE / CREATE INDEX. Both statements are
  // individually no-ops when the schema already exists.
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS repair_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      failure_category TEXT NOT NULL,
      info_hash TEXT,
      reason TEXT,
      evidence TEXT,
      correlation_id TEXT,
      occurred_at INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repair_evidence_category_time
      ON repair_evidence(failure_category, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_repair_evidence_hash_time
      ON repair_evidence(info_hash, occurred_at DESC);
  `);
}
