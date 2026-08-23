export const EXECUTION_STATUSES = Object.freeze({
  READY: 'ready',
  DEFERRED: 'deferred',
  UNAVAILABLE: 'unavailable',
});

export const EXECUTION_ACTIONS = Object.freeze({
  PLACE: 'place',
});

/**
 * Pure generic execution boundary — the contract between a completed
 * acquisition intent and future provider-specific execution.
 *
 * This function consumes an acquisition intent and produces a generic
 * execution request. It is the boundary that future provider adapters
 * (TorBox, Real-Debrid, etc.) will consume.
 *
 * This function is pure: it performs no provider calls, creates no
 * downloads, places no resources, and mutates no provider state. It
 * does not know about magnets, torrent files, hashes, provider API
 * endpoints, torrent IDs, download IDs, or provider-specific state
 * machines.
 *
 * @param {Object} input
 * @param {Object} input.intent - Completed acquisition intent from createAcquisitionIntent.
 * @param {number} input.evaluationTime - Explicit evaluation timestamp (ms).
 * @returns {Object} Frozen generic execution request.
 */
export function createExecutionRequest({
  intent,
  evaluationTime,
} = {}) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new TypeError('intent is required');
  }
  if (evaluationTime === undefined) {
    throw new TypeError('evaluationTime is required');
  }
  if (!Number.isSafeInteger(evaluationTime) || evaluationTime < 0) {
    throw new TypeError('evaluationTime must be a non-negative millisecond timestamp');
  }

  const reasonCodes = intent.reasonCodes ?? [];

  if (intent.intentStatus === 'ready') {
    if (!intent.candidateIdentity) {
      throw new TypeError('Ready intent requires candidate identity');
    }
    if (!intent.provider) {
      throw new TypeError('Ready intent requires provider');
    }
    if (!intent.accountScope) {
      throw new TypeError('Ready intent requires account scope');
    }

    return Object.freeze({
      executionStatus: EXECUTION_STATUSES.READY,
      action: EXECUTION_ACTIONS.PLACE,
      candidateIdentity: Object.freeze({
        infoHash: intent.candidateIdentity.infoHash,
        fileIndex: intent.candidateIdentity.fileIndex,
        releaseKey: intent.candidateIdentity.releaseKey,
      }),
      provider: intent.provider,
      accountScope: intent.accountScope,
      reasonCodes,
      evidence: intent.evidence,
      createdAt: evaluationTime,
    });
  }

  if (intent.intentStatus === 'deferred') {
    return Object.freeze({
      executionStatus: EXECUTION_STATUSES.DEFERRED,
      action: null,
      candidateIdentity: null,
      provider: null,
      accountScope: null,
      reasonCodes,
      evidence: null,
      createdAt: evaluationTime,
    });
  }

  if (intent.intentStatus === 'unavailable') {
    return Object.freeze({
      executionStatus: EXECUTION_STATUSES.UNAVAILABLE,
      action: null,
      candidateIdentity: null,
      provider: null,
      accountScope: null,
      reasonCodes,
      evidence: null,
      createdAt: evaluationTime,
    });
  }

  throw new TypeError(`Unknown intent status: ${intent.intentStatus}`);
}
