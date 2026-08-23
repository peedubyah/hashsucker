import crypto from 'node:crypto';

/**
 * Pipeline Diagnostic Trace — Operator/Debug Facility
 *
 * Produces a structured trace of the media request lifecycle WITHOUT
 * modifying any execution behavior. Reporting/logging only.
 *
 * Phases:
 *   Request     — query, selected media identity, selected release, handlingMode
 *   Handoff     — handoff created, identifier, timestamp
 *   Processing  — importer/materializer decision, execution path, ownership
 *   Lifecycle   — events observed, current state, timestamps
 *   Final       — final known state, outcome
 *
 * This module does not alter reconciliation, repair, importer, or
 * materialization decisions. It observes existing execution paths.
 */

// ─── Request Phase ──────────────────────────────────────────────────────────

export function buildRequestPhase({ query, media, release, handlingMode }) {
  const phase = {
    phase: 'request',
    query: query ?? null,
    selectedMedia: media ? {
      id: media.id ?? media.mediaId ?? null,
      title: media.title ?? null,
      type: media.type ?? media.mediaType ?? null,
      year: media.year ?? null,
    } : null,
    selectedRelease: release ? {
      infoHash: release.infoHash,
      fileIndex: release.fileIndex ?? null,
      releaseKey: release.releaseKey,
      filename: release.filename ?? null,
      score: release.score ?? null,
      confidence: release.confidence ?? null,
    } : null,
    handlingMode: handlingMode ?? null,
  };
  return Object.freeze(phase);
}

// ─── Handoff Phase ──────────────────────────────────────────────────────────

export function buildHandoffPhase({ handoff }) {
  if (!handoff) {
    return Object.freeze({
      phase: 'handoff',
      handoffCreated: false,
      handoffId: null,
      timestamp: null,
      handlingMode: null,
    });
  }
  return Object.freeze({
    phase: 'handoff',
    handoffCreated: true,
    handoffId: handoff.requestId ?? null,
    timestamp: handoff.createdAt ?? null,
    handlingMode: handoff.handlingMode ?? null,
  });
}

// ─── Processing Phase ───────────────────────────────────────────────────────

export function buildProcessingPhase({ handoff, requestStatus }) {
  const phase = {
    phase: 'processing',
    decision: null,
    executionPath: null,
    componentOwnership: null,
  };

  if (!handoff) {
    return Object.freeze(phase);
  }

  // Determine execution path from handlingMode
  if (handoff.handlingMode === 'download') {
    phase.decision = 'importer';
    phase.executionPath = 'download-to-local';
    phase.componentOwnership = handoff.provider ?? 'unassigned';
  } else if (handoff.handlingMode === 'stream') {
    phase.decision = 'materializer';
    phase.executionPath = 'stream-reference';
    phase.componentOwnership = handoff.provider ?? 'unassigned';
  } else {
    phase.decision = 'unknown';
    phase.executionPath = 'unresolved';
    phase.componentOwnership = handoff.provider ?? 'unassigned';
  }

  // If request status is available, enrich
  if (requestStatus) {
    phase.requestStatus = requestStatus.status ?? null;
    phase.requestId = requestStatus.requestId ?? null;
  }

  return Object.freeze(phase);
}

// ─── Lifecycle Phase ────────────────────────────────────────────────────────

export function buildLifecyclePhase({ lifecycle, binding, now = Date.now() }) {
  const phase = {
    phase: 'lifecycle',
    eventsObserved: 0,
    currentState: null,
    milestones: null,
    bindingState: null,
    observedAt: now,
  };

  if (!lifecycle) {
    return Object.freeze(phase);
  }

  if (lifecycle.events) {
    phase.eventsObserved = lifecycle.events.length;
    phase.currentState = lifecycle.events.length > 0
      ? lifecycle.events[lifecycle.events.length - 1].status
      : null;
  }

  if (lifecycle.milestones) {
    phase.milestones = Object.fromEntries(
      Object.entries(lifecycle.milestones).map(([key, event]) => [
        key,
        event ? { status: event.status, occurredAt: event.occurredAt } : null,
      ]),
    );
  }

  if (binding) {
    phase.bindingState = {
      id: binding.id ?? null,
      status: binding.status ?? null,
      version: binding.version ?? null,
      releaseKey: binding.releaseKey ?? null,
    };
  }

  return Object.freeze(phase);
}

// ─── Final Phase ────────────────────────────────────────────────────────────

export function buildFinalPhase({ requestStatus, binding, lifecycle, now = Date.now() }) {
  const phase = {
    phase: 'final',
    finalState: null,
    outcome: null,
    completedAt: now,
    errors: [],
  };

  // Determine final state from binding
  if (binding) {
    phase.finalState = binding.status ?? 'unknown';
    if (binding.status === 'active') {
      phase.outcome = 'success';
    } else if (binding.status === 'degraded') {
      phase.outcome = 'degraded';
    } else if (binding.status === 'failed') {
      phase.outcome = 'failure';
      if (binding.failureCategory) {
        phase.errors.push(binding.failureCategory);
      }
    } else if (binding.status === 'superseded') {
      phase.outcome = 'superseded';
    }
  } else if (requestStatus) {
    phase.finalState = requestStatus.status ?? 'unknown';
    phase.outcome = requestStatus.status === 'queued' ? 'pending' : requestStatus.status ?? 'unknown';
  } else {
    phase.finalState = 'unknown';
    phase.outcome = 'unknown';
  }

  // Collect lifecycle errors if available
  if (lifecycle?.events) {
    const failures = lifecycle.events.filter(e => e.status === 'failed');
    for (const fail of failures) {
      if (fail.failureCategory && !phase.errors.includes(fail.failureCategory)) {
        phase.errors.push(fail.failureCategory);
      }
    }
  }

  if (phase.outcome === null && phase.errors.length > 0) {
    phase.outcome = 'failure';
  }

  return Object.freeze(phase);
}

// ─── Full Trace Assembly ────────────────────────────────────────────────────

/**
 * Assemble a complete pipeline trace from observed components.
 *
 * All parameters are optional — missing data degrades gracefully.
 * This function never throws on missing data; it marks unknowns.
 *
 * @param {Object} input
 * @param {Object} input.request - { query, media, release, handlingMode }
 * @param {Object} input.handoff - Handoff envelope (or null)
 * @param {Object} input.requestStatus - Importer request status (or null)
 * @param {Object} input.lifecycle - Control-plane lifecycle (or null)
 * @param {Object} input.binding - Current binding (or null)
 * @param {number} input.now - Explicit timestamp (defaults to Date.now())
 * @returns {Object} Frozen structured trace
 */
export function buildPipelineTrace({
  request = null,
  handoff = null,
  requestStatus = null,
  lifecycle = null,
  binding = null,
  now = Date.now(),
} = {}) {
  const trace = Object.freeze({
    traceId: crypto.randomUUID(),
    generatedAt: now,
    phases: Object.freeze({
      request: buildRequestPhase({
        query: request?.query ?? null,
        media: request?.media ?? null,
        release: request?.release ?? null,
        handlingMode: request?.handlingMode ?? null,
      }),
      handoff: buildHandoffPhase({ handoff }),
      processing: buildProcessingPhase({ handoff, requestStatus }),
      lifecycle: buildLifecyclePhase({ lifecycle, binding, now }),
      final: buildFinalPhase({ requestStatus, binding, lifecycle, now }),
    }),
  });

  return trace;
}

// ─── Trace Summary (concise operator report) ────────────────────────────────

export function summarizeTrace(trace) {
  const { request, handoff, processing, lifecycle, final: finalPhase } = trace.phases;

  return Object.freeze({
    traceId: trace.traceId,
    generatedAt: trace.generatedAt,
    query: request.query,
    mediaId: request.selectedMedia?.id ?? null,
    releaseKey: request.selectedRelease?.releaseKey ?? null,
    handlingMode: request.handlingMode,
    handoffCreated: handoff.handoffCreated,
    handoffId: handoff.handoffId,
    executionPath: processing.executionPath,
    currentState: lifecycle.currentState,
    bindingStatus: lifecycle.bindingState?.status ?? null,
    finalOutcome: finalPhase.outcome,
    errors: finalPhase.errors,
  });
}
