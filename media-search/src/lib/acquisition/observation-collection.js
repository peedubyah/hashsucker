import { createReleaseIdentity } from '../../api/release-contract.js';
import { projectExactCandidateObservation } from './exact-candidate-projection.js';

export const COLLECTION_STATUSES = Object.freeze({
  SUCCESS: 'success',
  EMPTY: 'empty',
});

/**
 * Pure orchestration boundary between Stage 3 ranked candidates and Stage 4
 * acquisition decisions. This function:
 *
 *   1. Windows candidates preserving Stage 3 order (no re-ranking).
 *   2. Extracts unique infoHashes for batch provider observation.
 *   3. Maps provider observations back to candidates via exact projection.
 *
 * The function performs no persistence, fulfillment, scheduling, or
 * provider mutation. Provider errors become observation states, not thrown
 * exceptions. Missing evidence does not become `uncached`.
 *
 * `now` is required (no wall-clock fallback). `maxCandidates` is required.
 * Programmer errors throw; observation mismatches fail closed as rejections.
 */
export async function collectCandidateObservations({
  candidates,
  providerCapability,
  now,
  maxCandidates,
} = {}) {
  if (!Array.isArray(candidates)) {
    throw new TypeError('candidates must be an array');
  }
  if (now === undefined) {
    throw new TypeError('now is required');
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('now must be a non-negative millisecond timestamp');
  }
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) {
    throw new TypeError('maxCandidates must be a positive integer');
  }
  if (!providerCapability || typeof providerCapability.observeCache !== 'function') {
    throw new TypeError('providerCapability must implement observeCache');
  }

  if (candidates.length === 0) {
    return Object.freeze({
      status: COLLECTION_STATUSES.EMPTY,
      observations: Object.freeze([]),
      projections: Object.freeze([]),
      queries: Object.freeze([]),
    });
  }

  // 1. Window candidates preserving order.
  const windowed = candidates.slice(0, maxCandidates);

  // 2. Extract unique infoHashes, preserving candidate identity mapping.
  const hashToCandidates = new Map();
  const uniqueHashes = [];

  for (const candidate of windowed) {
    const infoHash = candidate?.infoHash ?? candidate?.hash;
    if (!infoHash || !/^[0-9a-f]{40}$/.test(String(infoHash).toLowerCase())) {
      throw new TypeError('Each candidate must have a valid infoHash');
    }
    const normalized = String(infoHash).toLowerCase();

    if (!hashToCandidates.has(normalized)) {
      hashToCandidates.set(normalized, []);
      uniqueHashes.push(normalized);
    }
    hashToCandidates.get(normalized).push(candidate);
  }

  // 3. Batch provider observation (one call, unique hashes only).
  const subjects = uniqueHashes.map((infoHash) => ({ infoHash }));
  const observations = await providerCapability.observeCache(subjects);

  // 4. Map observations back to candidates via exact projection.
  const projections = [];

  for (const candidate of windowed) {
    const infoHash = String(candidate?.infoHash ?? candidate?.hash).toLowerCase();
    const candidateIdentity = createReleaseIdentity(infoHash, candidate?.fileIndex ?? null);

    // Find the observation for this candidate's infoHash
    const observation = observations.find((obs) => obs.infoHash === infoHash);

    if (!observation) {
      projections.push(Object.freeze({
        status: 'rejected',
        reason: 'missing-observation',
        candidate: candidateIdentity,
        observation: null,
      }));
      continue;
    }

    const projection = projectExactCandidateObservation({
      candidate,
      observation,
      now,
    });

    projections.push(projection);
  }

  return Object.freeze({
    status: COLLECTION_STATUSES.SUCCESS,
    observations: Object.freeze(observations),
    projections: Object.freeze(projections),
    queries: Object.freeze([{ infoHashes: uniqueHashes }]),
  });
}
