/**
 * Request Lifecycle Timing Instrumentation
 *
 * Non-blocking timing tracker for request pipeline stages.
 * Measures duration at every major boundary without changing behavior.
 *
 * Pipeline stages:
 *   request.received → identity.resolved → metadata.resolved →
 *   corpus.lookup.completed → live.discovery.started → live.discovery.completed →
 *   candidate.ranking.completed → candidate.selected → cache.checked →
 *   handoff.created → stream.url.generated → strm.created → request.completed
 *
 * Usage:
 *   const timing = new RequestTiming(requestId);
 *   timing.start('identity.resolved');
 *   // ... do work ...
 *   timing.end('identity.resolved');
 *   timing.summary(); // { totalDurationMs, stages: { ... } }
 */

/**
 * Generate a high-resolution timestamp in milliseconds.
 * Uses performance.now() if available, falls back to Date.now().
 */
function nowMs() {
  if (typeof performance !== 'undefined' && performance.now) {
    return performance.now();
  }
  return Date.now();
}

/**
 * Request timing tracker.
 *
 * Tracks start/end timestamps for named stages and computes durations.
 * All operations are fail-safe — timing errors never throw.
 */
export class RequestTiming {
  /**
   * @param {string} requestId - Request identifier
   */
  constructor(requestId) {
    this.requestId = requestId;
    this.stages = new Map();
    this._startTs = nowMs();
    this._completed = false;
    this._completedAt = null;
  }

  /**
   * Mark the start of a stage.
   *
   * @param {string} stage - Stage name (e.g., 'identity.resolved')
   * @param {Object} [metadata] - Additional metadata to attach
   */
  start(stage, metadata = {}) {
    try {
      this.stages.set(stage, {
        stage,
        startedAt: new Date().toISOString(),
        startedAtMs: nowMs(),
        completedAt: null,
        completedAtMs: null,
        durationMs: null,
        status: 'in_progress',
        ...metadata,
      });
    } catch {
      // Timing must never break the pipeline
    }
  }

  /**
   * Mark the end of a stage.
   *
   * @param {string} stage - Stage name
   * @param {string} [status='completed'] - Stage status
   * @param {Object} [metadata] - Additional metadata
   */
  end(stage, status = 'completed', metadata = {}) {
    try {
      const record = this.stages.get(stage);
      if (!record) {
        // Stage was never started — create a synthetic record
        const ts = nowMs();
        this.stages.set(stage, {
          stage,
          startedAt: new Date(ts).toISOString(),
          startedAtMs: ts,
          completedAt: new Date(ts).toISOString(),
          completedAtMs: ts,
          durationMs: 0,
          status,
          ...metadata,
        });
        return;
      }

      const ts = nowMs();
      record.completedAt = new Date(ts).toISOString();
      record.completedAtMs = ts;
      record.durationMs = Math.round((ts - record.startedAtMs) * 100) / 100;
      record.status = status;
      Object.assign(record, metadata);
    } catch {
      // Timing must never break the pipeline
    }
  }

  /**
   * Mark a stage as failed.
   *
   * @param {string} stage - Stage name
   * @param {string} [error] - Error message
   * @param {Object} [details] - Additional failure details
   * @param {string} [details.errorCode] - Error code (e.g., 'NO_CACHED_CANDIDATES')
   * @param {string} [details.component] - Component responsible for failure
   */
  fail(stage, error = null, details = {}) {
    this.end(stage, 'failed', {
      ...(error ? { error } : {}),
      ...details,
    });
    
    // Track request-level failure info
    this._failure = {
      stage,
      errorCode: details.errorCode || null,
      error,
      component: details.component || null,
      failedAt: new Date().toISOString(),
      elapsedMs: this._startTs ? Math.round((nowMs() - this._startTs) * 100) / 100 : null,
    };
  }

  /**
   * Mark the entire request as completed.
   */
  complete() {
    if (this._completed) return;
    this._completed = true;
    this._completedAt = nowMs();
  }

  /**
   * Check if the request failed.
   *
   * @returns {boolean}
   */
  isFailed() {
    return this._failure != null;
  }

  /**
   * Get failure details.
   *
   * @returns {Object|null}
   */
  getFailure() {
    return this._failure || null;
  }

  /**
   * Get the duration of a specific stage.
   *
   * @param {string} stage - Stage name
   * @returns {number|null} Duration in ms, or null if stage not found
   */
  getStageDuration(stage) {
    const record = this.stages.get(stage);
    return record?.durationMs ?? null;
  }

  /**
   * Get a timing summary.
   *
   * @returns {Object} Summary with totalDurationMs and per-stage breakdown
   */
  summary() {
    const stages = {};
    let totalDurationMs = 0;

    for (const [name, record] of this.stages) {
      const { stage, startedAtMs, completedAtMs, ...rest } = record;
      stages[name] = {
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
        status: record.status,
        ...rest,
      };
      if (record.durationMs != null) {
        totalDurationMs += record.durationMs;
      }
    }

    // If completed, use the actual total span
    if (this._completed && this._completedAt != null) {
      totalDurationMs = Math.round((this._completedAt - this._startTs) * 100) / 100;
    }

    const result = {
      requestId: this.requestId,
      totalDurationMs: Math.round(totalDurationMs * 100) / 100,
      stages,
      completed: this._completed,
    };

    // Include failure information if the request failed
    if (this._failure) {
      result.failure = this._failure;
    }

    return result;
  }

  /**
   * Get all stage records as an array (for event emission).
   *
   * @returns {Array<Object>}
   */
  getStages() {
    return Array.from(this.stages.values()).map(r => {
      const { stage, startedAt, completedAt, durationMs, status, startedAtMs, ...rest } = r;
      return { stage, startedAt, completedAt, durationMs, status, ...rest };
    });
  }
}

/**
 * Create a timing tracker for a request.
 *
 * @param {string} requestId
 * @returns {RequestTiming}
 */
export function createRequestTiming(requestId) {
  return new RequestTiming(requestId);
}
