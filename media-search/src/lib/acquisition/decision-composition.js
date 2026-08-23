import { projectExactCandidateObservation } from './exact-candidate-projection.js';
import { decideAcquisition } from './decision.js';

export const DECISION_COMPOSITION_STATUSES = Object.freeze({
  SELECTED: 'selected',
  DEFERRED: 'deferred',
  UNAVAILABLE: 'unavailable',
});

/**
 * Pure composition helper around the existing decision evaluator.
 *
 * Combines unchanged Stage 3 ranked candidates, decision-ready provider
 * observations, and explicit acquisition policy to produce an explainable
 * acquisition decision.
 *
 * This function is a pure boundary: it preserves input order, performs no
 * provider calls, and never re-ranks candidates. It wraps `decideAcquisition`
 * and adds explicit projection validation via `projectExactCandidateObservation`.
 *
 * The function does not execute acquisition, create provider resources,
 * publish requests, or perform any persistence or scheduling.
 *
 * @param {Object} input
 * @param {Object[]} input.candidates - Ranked Stage 3 candidates (order preserved).
 * @param {Object[]} input.observations - Decision-ready provider observations.
 * @param {Object} input.policy - Acquisition policy from `createAcquisitionPolicy`.
 * @param {number} input.evaluationTime - Explicit evaluation timestamp (ms).
 * @returns {Object} Frozen decision result.
 */
export function composeAcquisitionDecision({
  candidates,
  observations,
  policy,
  evaluationTime,
} = {}) {
  if (!Array.isArray(candidates)) {
    throw new TypeError('candidates must be an array');
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('policy is required');
  }
  if (evaluationTime === undefined) {
    throw new TypeError('evaluationTime is required');
  }
  if (!Number.isSafeInteger(evaluationTime) || evaluationTime < 0) {
    throw new TypeError('evaluationTime must be a non-negative millisecond timestamp');
  }
  if (!Array.isArray(observations)) {
    throw new TypeError('observations must be an array');
  }

  // All observations are passed through to `decideAcquisition`, which
  // silently skips non-candidate observations during current-observation
  // projection. The composition layer does not pre-filter by scope —
  // projection is the authority gate.
  const decision = decideAcquisition({
    rankedCandidates: candidates,
    observations,
    policy,
  }, { now: evaluationTime });

  const selectedCandidate = decision.selected
    ? {
        candidate: decision.selected.candidate,
        identity: decision.selected.identity,
        rank: decision.selected.rank,
        provider: decision.selected.provider,
        accountScope: decision.selected.accountScope,
      }
    : null;

  const decisiveObservation = decision.selected?.observation ?? null;

  // Explicit projection validation for the decisive observation.
  // This ensures the selected candidate-observation pair passes exact
  // identity and scope validation. A rejection fails closed as deferred.
  if (selectedCandidate && decisiveObservation) {
    const projection = projectExactCandidateObservation({
      candidate: selectedCandidate.candidate,
      observation: decisiveObservation,
      now: evaluationTime,
    });
    if (projection.status !== 'projected') {
      return Object.freeze({
        status: 'deferred',
        selectedCandidate: null,
        decisiveObservation: null,
        candidateEvaluations: decision.candidates.map(transformCandidateEvaluation),
        reasonCodes: Object.freeze(['projection-rejection', projection.reason]),
      });
    }
  }

  const candidateEvaluations = decision.candidates.map(transformCandidateEvaluation);
  const reasonCodes = decision.reason?.code ? [decision.reason.code] : [];

  return Object.freeze({
    status: decision.status,
    selectedCandidate: selectedCandidate ? Object.freeze(selectedCandidate) : null,
    decisiveObservation,
    candidateEvaluations: Object.freeze(candidateEvaluations),
    reasonCodes: Object.freeze(reasonCodes),
  });
}

function transformCandidateEvaluation(candidateEval) {
  return Object.freeze({
    candidate: candidateEval.candidate,
    identity: candidateEval.identity,
    rank: candidateEval.rank,
    status: candidateEval.status,
    provider: candidateEval.provider,
    accountScope: candidateEval.accountScope,
    observation: candidateEval.observation,
    targets: candidateEval.targets,
  });
}
