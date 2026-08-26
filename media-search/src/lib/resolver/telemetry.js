/**
 * Resolver Attempt Telemetry
 *
 * Records one structured attempt record per /stream/:type/:id resolution.
 * Uses the existing lifecycle_events table — no new storage subsystem.
 *
 * Invariants:
 * - append-only, never mutates playback state
 * - never logs media bytes, tokens, or full provider URLs
 * - telemetry recording failure never blocks resolution
 * - preserves typed failure reasons
 */

import { randomUUID } from 'node:crypto';

export const RESOLVER_STAGE = 'resolver-attempt';
export const RESOLVER_COMPONENT = 'stream-resolver';

export const RESOLVER_OUTCOME = Object.freeze({
  REDIRECTED: 'redirected',
  FAILED: 'failed',
});

/**
 * Create a resolver telemetry recorder bound to an event store.
 *
 * @param {Object} dependencies
 * @param {Object} dependencies.eventStore - Lifecycle event store instance
 * @param {Function} [dependencies.now] - Clock function
 */
export function createResolverTelemetry(dependencies = {}) {
  const { eventStore, now = () => Date.now() } = dependencies;

  if (!eventStore || typeof eventStore.recordEvent !== 'function') {
    throw new TypeError('eventStore with recordEvent is required');
  }

  /**
   * Record a resolver attempt.
   *
   * This is fire-and-forget. Any error is caught and logged but never
   * thrown, so telemetry failures never block playback resolution.
   *
   * @param {Object} attempt - Resolver attempt data
   * @returns {string|null} requestId of the recorded telemetry, or null on failure
   */
  function recordAttempt(attempt) {
    const requestId = randomUUID();
    const timestamp = now();

    try {
      // Sanitize: remove any sensitive fields, but preserve extra fields like fallback telemetry
      const sanitized = {
        mediaId: attempt.mediaId ?? null,
        mediaType: attempt.mediaType ?? null,
        releaseKey: attempt.releaseKey ?? null,
        infoHash: attempt.infoHash ?? null,
        provider: attempt.provider ?? null,
        availabilitySource: attempt.availabilitySource ?? null,
        providerCheckOccurred: attempt.providerCheckOccurred ?? null,
        outcome: attempt.outcome ?? null,
        failureCode: attempt.failureCode ?? null,
        redirectStatus: attempt.redirectStatus ?? null,
        durationMs: attempt.durationMs ?? null,
        // Preserve fallback telemetry fields if present
        ...(attempt.fallbackUsed ? { fallbackUsed: attempt.fallbackUsed } : {}),
        ...(attempt.originalReleaseKey ? { originalReleaseKey: attempt.originalReleaseKey } : {}),
        ...(attempt.selectedReleaseKey ? { selectedReleaseKey: attempt.selectedReleaseKey } : {}),
        ...(attempt.fallbackRank != null ? { fallbackRank: attempt.fallbackRank } : {}),
        ...(attempt.reason ? { reason: attempt.reason } : {}),
      };

      // First record a request_run (required by FK constraint)
      eventStore.recordRequestRun({
        requestId,
        createdAt: timestamp,
        completedAt: timestamp,
        finalStatus: attempt.outcome === RESOLVER_OUTCOME.REDIRECTED ? 'completed' : 'failed',
        totalDurationMs: attempt.durationMs ?? null,
        mediaId: sanitized.mediaId,
        releaseKey: sanitized.releaseKey,
        provider: sanitized.provider,
        failureReason: sanitized.failureCode,
        failureStage: RESOLVER_STAGE,
      });

      eventStore.recordEvent({
        requestId,
        stage: RESOLVER_STAGE,
        component: RESOLVER_COMPONENT,
        status: attempt.outcome === RESOLVER_OUTCOME.REDIRECTED ? 'completed' : 'failed',
        timestamp,
        durationMs: attempt.durationMs ?? null,
        errorCode: attempt.failureCode ?? null,
        details: sanitized,
      });

      return requestId;
    } catch (error) {
      // Telemetry must never block resolution
      if (typeof console !== 'undefined' && console.error) {
        console.error(JSON.stringify({
          timestamp: new Date(timestamp).toISOString(),
          event: 'resolver_telemetry_error',
          error: error.message,
          mediaId: attempt.mediaId,
        }));
      }
      return null;
    }
  }

  return { recordAttempt };
}

/**
 * Retrieve recent resolver telemetry records from the event store.
 *
 * @param {Object} eventStore - Lifecycle event store instance
 * @param {Object} [options]
 * @param {number} [options.limit] - Max records to return (default: 50)
 * @returns {Array<Object>} Recent resolver attempt records
 */
export function getRecentResolverTelemetry(eventStore, options = {}) {
  const limit = options.limit ?? 50;

  if (!eventStore || typeof eventStore.getEventsByStage !== 'function') {
    return [];
  }

  const events = eventStore.getEventsByStage(RESOLVER_STAGE, limit);
  return events.map(eventStoreRowToTelemetryRecord);
}

/**
 * Convert event store query result to telemetry record.
 */
function eventStoreRowToTelemetryRecord(event) {
  const details = event.detailsJson ?? event.details ?? {};
  return {
    requestId: event.requestId,
    timestamp: event.timestamp,
    createdAt: event.timestampIso,
    stage: event.stage,
    component: event.component,
    status: event.status,
    durationMs: event.durationMs,
    errorCode: event.errorCode,
    ...details,
  };
}
