import { createReleaseIdentity } from '../../api/release-contract.js';
import {
  createCacheObservation,
  evaluateObservationFreshness,
} from '../providers/observations.js';

export const PROJECTION_STATUSES = Object.freeze([
  'projected',
  'rejected',
]);

export const PROJECTION_REASONS = Object.freeze({
  MISSING_EVALUATION_TIME: 'missing-evaluation-time',
  MALFORMED_OBSERVATION: 'malformed-observation',
  FUTURE_OBSERVATION: 'future-observation',
  TORRENT_SCOPE_FILE_CANDIDATE: 'torrent-scope-file-candidate',
  UNSUPPORTED_SCOPE: 'unsupported-scope',
  WRONG_INFO_HASH: 'wrong-infoHash',
  WRONG_FILE_INDEX: 'wrong-fileIndex',
  NON_AUTHORITATIVE: 'non-authoritative-observation',
  UNBOUNDED: 'unbounded-observation',
  STALE: 'stale-observation',
});

/**
 * Pure projection boundary between a provider observation and an exact
 * Stage 3 candidate identity. It validates only:
 *
 *   - exact candidate identity (infoHash, fileIndex) / releaseKey
 *   - the authority relationship between observation scope and candidate
 *   - observation freshness (not future, stale, unbounded, or malformed)
 *
 * Provider/account scope is NOT candidate identity. The projection never
 * rejects on provider/account and never merges distinct provider/account
 * observations. Their metadata is preserved unchanged.
 *
 * The function performs no provider calls, persistence, or acquisition action.
 * Programmer errors (missing candidate identity, invalid `now`) throw.
 * Observation-to-candidate mismatches fail closed as rejections.
 */
export function projectExactCandidateObservation(
  { candidate, observation, now } = {},
) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('candidate must be an object');
  }
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new TypeError('observation must be an object');
  }

  const candidateIdentity = resolveCandidateIdentity(candidate);

  if (now === undefined) {
    return reject(candidateIdentity, observation, PROJECTION_REASONS.MISSING_EVALUATION_TIME);
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('now must be a non-negative millisecond timestamp');
  }

  let normalizedObservation;
  try {
    normalizedObservation = createCacheObservation(observation);
  } catch (error) {
    return reject(candidateIdentity, null, PROJECTION_REASONS.MALFORMED_OBSERVATION, error.message);
  }

  if (normalizedObservation.observedAt > now) {
    return reject(candidateIdentity, normalizedObservation, PROJECTION_REASONS.FUTURE_OBSERVATION);
  }

  const scopeError = validateScopeRelationship(candidateIdentity, normalizedObservation);
  if (scopeError) {
    return reject(candidateIdentity, normalizedObservation, scopeError);
  }

  if (normalizedObservation.kind !== 'authoritative') {
    return reject(candidateIdentity, normalizedObservation, PROJECTION_REASONS.NON_AUTHORITATIVE);
  }

  const freshness = evaluateObservationFreshness(normalizedObservation, { now });
  if (freshness.freshness === 'unbounded') {
    return reject(candidateIdentity, normalizedObservation, PROJECTION_REASONS.UNBOUNDED);
  }
  if (!freshness.fresh) {
    return reject(candidateIdentity, normalizedObservation, PROJECTION_REASONS.STALE);
  }

  return Object.freeze({
    status: 'projected',
    candidate: candidateIdentity,
    observation: normalizedObservation,
    freshness,
  });
}

function resolveCandidateIdentity(candidate) {
  const identity = createReleaseIdentity(
    candidate.infoHash ?? candidate.hash,
    candidate.fileIndex ?? null,
  );
  if (candidate.releaseKey != null && candidate.releaseKey !== identity.releaseKey) {
    throw new TypeError('candidate.releaseKey must match its exact identity');
  }
  return identity;
}

function validateScopeRelationship(candidateIdentity, observation) {
  if (observation.scope === 'torrent') {
    if (candidateIdentity.fileIndex !== null) {
      return PROJECTION_REASONS.TORRENT_SCOPE_FILE_CANDIDATE;
    }
    if (observation.infoHash !== candidateIdentity.infoHash) {
      return PROJECTION_REASONS.WRONG_INFO_HASH;
    }
    return null;
  }

  if (observation.scope === 'candidate') {
    if (observation.infoHash !== candidateIdentity.infoHash) {
      return PROJECTION_REASONS.WRONG_INFO_HASH;
    }
    if (observation.fileIndex !== candidateIdentity.fileIndex) {
      return PROJECTION_REASONS.WRONG_FILE_INDEX;
    }
    return null;
  }

  return PROJECTION_REASONS.UNSUPPORTED_SCOPE;
}

function reject(candidateIdentity, observation, reason, detail = null) {
  return Object.freeze({
    status: 'rejected',
    candidate: candidateIdentity,
    observation,
    reason,
    detail,
  });
}
