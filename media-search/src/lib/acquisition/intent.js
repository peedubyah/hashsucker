export const ACQUISITION_INTENT_STATUSES = Object.freeze({
  READY: 'ready',
  DEFERRED: 'deferred',
  UNAVAILABLE: 'unavailable',
});

export const ACQUISITION_INTENT_ACTIONS = Object.freeze({
  PLACE: 'place',
});

/**
 * Pure intent factory — the boundary between a completed acquisition decision
 * and future provider execution.
 *
 * Accepts a completed acquisition decision and produces a command-like intent
 * object. This function is pure: it performs no provider calls, creates no
 * downloads, places no resources, and mutates no provider state.
 *
 * The output is a deterministic description of what the system would do and
 * why. It is consumed by a future execution slice, not by this one.
 *
 * @param {Object} input
 * @param {Object} input.decision - Completed decision from composeAcquisitionDecision.
 * @param {number} input.evaluationTime - Explicit evaluation timestamp (ms).
 * @param {Object} input.executionPolicy - Execution policy boundary (validated, reserved).
 * @returns {Object} Frozen intent object.
 */
export function createAcquisitionIntent({
  decision,
  evaluationTime,
  executionPolicy,
} = {}) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new TypeError('decision is required');
  }
  if (evaluationTime === undefined) {
    throw new TypeError('evaluationTime is required');
  }
  if (!Number.isSafeInteger(evaluationTime) || evaluationTime < 0) {
    throw new TypeError('evaluationTime must be a non-negative millisecond timestamp');
  }
  if (!executionPolicy || typeof executionPolicy !== 'object' || Array.isArray(executionPolicy)) {
    throw new TypeError('executionPolicy is required');
  }

  const reasonCodes = decision.reasonCodes ?? [];
  const decisiveObservation = decision.decisiveObservation ?? null;

  if (decision.status === 'selected') {
    if (!decision.selectedCandidate) {
      throw new TypeError('Selected decision requires a selected candidate');
    }
    if (!decisiveObservation) {
      throw new TypeError('Selected decision requires decisive evidence');
    }
    const { identity, provider, accountScope } = decision.selectedCandidate;
    if (!identity || !provider || !accountScope) {
      throw new TypeError('Selected candidate requires identity, provider, and accountScope');
    }

    return Object.freeze({
      intentStatus: ACQUISITION_INTENT_STATUSES.READY,
      action: ACQUISITION_INTENT_ACTIONS.PLACE,
      candidateIdentity: Object.freeze({
        infoHash: identity.infoHash,
        fileIndex: identity.fileIndex,
        releaseKey: identity.releaseKey,
      }),
      provider,
      accountScope,
      reasonCodes,
      evidence: decisiveObservation,
      createdAt: evaluationTime,
    });
  }

  if (decision.status === 'deferred') {
    return Object.freeze({
      intentStatus: ACQUISITION_INTENT_STATUSES.DEFERRED,
      action: null,
      candidateIdentity: null,
      provider: null,
      accountScope: null,
      reasonCodes,
      evidence: null,
      createdAt: evaluationTime,
    });
  }

  if (decision.status === 'unavailable') {
    return Object.freeze({
      intentStatus: ACQUISITION_INTENT_STATUSES.UNAVAILABLE,
      action: null,
      candidateIdentity: null,
      provider: null,
      accountScope: null,
      reasonCodes,
      evidence: null,
      createdAt: evaluationTime,
    });
  }

  throw new TypeError(`Unknown decision status: ${decision.status}`);
}
