import { createReleaseIdentity } from '../../api/release-contract.js';
import {
  createCacheObservation,
  evaluateObservationFreshness,
} from '../providers/observations.js';
import { createAcquisitionPolicy } from './policy.js';

export const ACQUISITION_DECISION_STATUSES = Object.freeze([
  'selected',
  'deferred',
  'unavailable',
]);

/**
 * Combine an already-ranked Stage 3 candidate set with current provider
 * observations and explicit policy. This function is pure: it preserves input
 * order, performs no provider calls, and never re-ranks candidates.
 */
export function decideAcquisition(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Acquisition decision input must be an object');
  }
  if (!Array.isArray(input.rankedCandidates)) {
    throw new TypeError('rankedCandidates must be an array');
  }
  if (!Array.isArray(input.observations)) {
    throw new TypeError('observations must be an array');
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('now must be a non-negative millisecond timestamp');
  }

  const policy = createAcquisitionPolicy(input.policy);
  const candidates = input.rankedCandidates.map((candidate, rank) => ({
    candidate,
    rank,
    identity: candidateIdentity(candidate, rank),
  }));
  const currentObservations = currentObservationProjection(input.observations);
  const evaluations = candidates.map(({ candidate, rank, identity }) =>
    evaluateCandidate(candidate, rank, identity, policy, currentObservations, now));

  // Only authoritative unavailability permits falling through to a lower Stage
  // 3 rank. Unknown, error, stale, or non-authoritative evidence defers rather
  // than silently treating the higher-ranked candidate as uncached.
  const decisive = evaluations.find((candidate) => candidate.status !== 'unavailable');
  if (decisive?.status === 'available') {
    return Object.freeze({
      status: 'selected',
      policy,
      selected: Object.freeze({
        candidate: decisive.candidate,
        identity: decisive.identity,
        rank: decisive.rank,
        provider: decisive.provider,
        accountScope: decisive.accountScope,
        observation: decisive.observation,
      }),
      reason: Object.freeze({
        code: 'fresh-authoritative-cache-hit',
        message: `Selected ranked candidate ${decisive.identity.releaseKey} at ${decisive.provider}/${decisive.accountScope}`,
      }),
      candidates: Object.freeze(evaluations),
    });
  }

  return Object.freeze({
    status: decisive ? 'deferred' : 'unavailable',
    policy,
    selected: null,
    reason: Object.freeze(decisive
      ? {
          code: 'provider-reality-unresolved',
          message: `Provider reality is unresolved for higher-ranked candidate ${decisive.identity.releaseKey}`,
        }
      : {
          code: 'authoritatively-uncached',
          message: 'Every ranked candidate is authoritatively uncached at every policy target',
        }),
    candidates: Object.freeze(evaluations),
  });
}

function evaluateCandidate(candidate, rank, identity, policy, observations, now) {
  const targetEvaluations = policy.targets.map((target, preference) => {
    const key = observationKey(target.provider, target.accountScope, identity.releaseKey);
    const observation = observations.get(key) ?? null;
    return evaluateTarget(target, preference, observation, now);
  });
  const available = targetEvaluations.find((target) => target.state === 'cached');
  const status = available
    ? 'available'
    : targetEvaluations.every((target) => target.state === 'uncached')
      ? 'unavailable'
      : 'unresolved';

  return Object.freeze({
    candidate,
    identity,
    rank,
    status,
    provider: available?.provider ?? null,
    accountScope: available?.accountScope ?? null,
    observation: available?.observation ?? null,
    targets: Object.freeze(targetEvaluations),
  });
}

function evaluateTarget(target, preference, observation, now) {
  if (observation == null) {
    return targetEvaluation(target, preference, 'unknown', 'missing-observation', null, null);
  }
  if (observation.kind !== 'authoritative') {
    return targetEvaluation(
      target,
      preference,
      'unknown',
      'non-authoritative-observation',
      observation,
      null,
    );
  }

  const freshness = evaluateObservationFreshness(observation, { now });
  if (freshness.freshness !== 'fresh' || freshness.fresh !== true) {
    return targetEvaluation(target, preference, 'unknown', 'stale-or-unbounded-observation', observation, freshness);
  }
  if (observation.state === 'cached' || observation.state === 'uncached') {
    return targetEvaluation(target, preference, observation.state, 'fresh-authoritative-observation', observation, freshness);
  }
  if (observation.state === 'error') {
    return targetEvaluation(target, preference, 'error', 'provider-error', observation, freshness);
  }
  return targetEvaluation(target, preference, 'unknown', 'provider-state-unknown', observation, freshness);
}

function targetEvaluation(target, preference, state, reason, observation, freshness) {
  return Object.freeze({
    provider: target.provider,
    accountScope: target.accountScope,
    preference,
    state,
    reason,
    observation,
    freshness,
  });
}

function currentObservationProjection(observations) {
  const current = new Map();
  observations.forEach((input, index) => {
    let observation;
    try {
      observation = createCacheObservation(input);
    } catch (error) {
      throw new TypeError(`Invalid observations[${index}]: ${error.message}`, { cause: error });
    }

    // Key the observation by its own (infoHash, fileIndex) identity.
    // A torrent-scoped observation is keyed by `hash:torrent` and matches a
    // torrent-level candidate (fileIndex=null). A candidate-scoped observation
    // is keyed by `hash:N` and matches a file-level candidate. Only these two
    // scopes are admissible — all other scopes (provider-resource, exposure,
    // mount, etc.) are rejected here. This is the observation admission
    // boundary; projectExactCandidateObservation() remains the authority gate.
    const identity = createReleaseIdentity(observation.infoHash, observation.fileIndex);
    const expectedSubjectKey = observation.scope === 'torrent'
      ? identity.infoHash
      : observation.scope === 'candidate'
        ? identity.releaseKey
        : null;
    if (expectedSubjectKey === null) {
      throw new TypeError(`observations[${index}] has unsupported scope: ${observation.scope}`);
    }
    if (observation.subjectKey !== expectedSubjectKey) {
      throw new TypeError(`observations[${index}] subjectKey must match its own identity`);
    }

    const key = observationKey(observation.provider, observation.accountScope, identity.releaseKey);
    const existing = current.get(key);
    if (!existing || observation.observedAt >= existing.observedAt) {
      current.set(key, observation);
    }
  });
  return current;
}

function candidateIdentity(candidate, rank) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError(`rankedCandidates[${rank}] must be an object`);
  }
  const infoHash = candidate.infoHash ?? candidate.hash;
  const fileIndex = candidate.fileIndex ?? null;
  const identity = createReleaseIdentity(infoHash, fileIndex);
  if (candidate.releaseKey != null && candidate.releaseKey !== identity.releaseKey) {
    throw new TypeError(`rankedCandidates[${rank}].releaseKey must match its exact identity`);
  }
  return Object.freeze(identity);
}

function observationKey(provider, accountScope, releaseKey) {
  return `${provider.toLowerCase()}\0${accountScope.toLowerCase()}\0${releaseKey}`;
}
