/**
 * Canonical Play orchestration — one intent to exactly one terminal state.
 *
 *   Play(media intent) → resolve → choose → Binding? → READY
 *     → executable alternative? → retry once, widened → READY
 *     → acceptable candidate? → start/join preparation → PREPARING
 *     → nothing acceptable? → NOT_AVAILABLE
 *     → true media ambiguity → AMBIGUOUS (needs user decision)
 *
 * This module owns the PRODUCT decision flow, not provider implementation:
 * it reuses resolvePlaybackIntent (warm + cold paths unchanged), the
 * existing pipeline for all binding, and the prepare driver for everything
 * asynchronous. Provider/source/route decisions never escape to the user;
 * only genuine media ambiguity does.
 *
 * Representation reasons recorded on every non-ready outcome:
 * preferred | equivalent-executable | quality-floor-fallback |
 * prepared-representation. Ranking itself is the quality authority — no
 * new floor is invented here.
 */

import {
  resolvePlaybackIntent,
  PlaybackObjectApiError,
} from '../../api/playback-object.js';

export const PLAY_OUTCOME = Object.freeze({
  READY: 'ready',
  PREPARING: 'preparing',
  AMBIGUOUS: 'ambiguous',
  NOT_AVAILABLE: 'not-available',
  ERROR: 'error',
});

/**
 * Classify a failed-to-bind pipeline result WITHOUT new provider calls.
 * Pure function over ranked results + selection record.
 *
 * Returns one of:
 * - { kind: 'no-candidates' }
 * - { kind: 'no-eligible' }
 * - { kind: 'executable-alternative', candidate, reason } — an acceptable
 *   candidate with executable availability the traversal demonstrably did
 *   not attempt (absent from skipped). Defensive: the pipeline usually
 *   traverses everything eligible, so this is rarely populated in prod.
 * - { kind: 'prepare-candidate', candidate } — best acceptable candidate
 *   (rank order), all attempts exhausted or ineligible-for-other-reasons.
 * - { kind: 'nothing-acceptable' }
 */
export function classifyUnboundResult(prepareResult) {
  const results = Array.isArray(prepareResult?.results) ? prepareResult.results : [];
  const selection = prepareResult?.selection ?? {};
  if (results.length === 0) return { kind: 'no-candidates' };
  const eligible = results.filter((r) => r?.identity?.eligible !== false);
  if (eligible.length === 0) {
    return { kind: 'no-eligible', skipped: Array.isArray(selection.skipped) ? selection.skipped.length : 0 };
  }
  const attempted = new Set(
    (Array.isArray(selection.skipped) ? selection.skipped : [])
      .map((s) => s?.infoHash)
      .filter(Boolean),
  );
  const isExecutable = (r) => {
    const states = [
      r?.availability?.torbox?.state,
      ...(Array.isArray(r?.observations) ? r.observations.map((o) => (o?.cached ? 'cached' : o?.state)) : []),
    ].filter(Boolean).map(String);
    return states.some((s) => ['cached', 'serviceable'].includes(s.toLowerCase()));
  };
  // Best executable candidate the traversal demonstrably did not attempt.
  // Rank order is the quality authority: first acceptable executable wins.
  for (const candidate of eligible) {
    if (!candidate?.infoHash || attempted.has(candidate.infoHash)) continue;
    if (isExecutable(candidate)) {
      const rank = Number(candidate.rank ?? 1);
      return {
        kind: 'executable-alternative',
        candidate,
        reason: rank <= 1 ? 'preferred' : 'quality-floor-fallback',
      };
    }
  }
  // Everything executable was attempted (or nothing is executable):
  // the best acceptable candidate is preparation material.
  const best = eligible[0] ?? null;
  if (!best?.infoHash) return { kind: 'nothing-acceptable' };
  return { kind: 'prepare-candidate', candidate: best };
}

/**
 * Resolve one Play intent to exactly one terminal product state.
 *
 * @param {object} args — resolvePlaybackIntent args, plus:
 * @param {Function} [args.prepareDeps] — () => ({ driver, adapters, controlPlaneStore, eligibleProviders, rebindFn }) | null.
 *   When null/absent, unbound intents resolve NOT_AVAILABLE (no preparation
 *   machinery wired — today's behavior, preserved exactly).
 * @param {Function} [args.serviceabilityProbe] — threaded into a single
 *   widened retry when (and only when) an untried executable candidate exists.
 * @param {number} [args.retryAlternates] — traversal bound for that retry.
 * @returns {Promise<object>} { outcome, ... } — never throws for product
 *   states; PlaybackObjectApiError surfaces only for infrastructure errors.
 */
export async function resolvePlayback(args = {}) {
  const { prepareDeps = null, serviceabilityProbe = null, retryAlternates = 25, ...intentArgs } = args;
  const baseContext = {
    mediaId: intentArgs.mediaId ?? null,
    mediaType: intentArgs.mediaType ?? null,
    season: intentArgs.season ?? null,
    episode: intentArgs.episode ?? null,
  };
  // 1. The existing paths, unchanged: warm → READY, cold-bound → READY.
  try {
    const ready = await resolvePlaybackIntent(intentArgs);
    return { outcome: PLAY_OUTCOME.READY, representationReason: 'preferred', ...ready };
  } catch (error) {
    if (!(error instanceof PlaybackObjectApiError)) throw error;
    if (error.code === 'AMBIGUOUS_INTENT') {
      return {
        outcome: PLAY_OUTCOME.AMBIGUOUS, ...baseContext,
        candidates: error.candidates ?? null,
        message: error.message,
      };
    }
    if (error.code !== 'NO_AUTHORITATIVE_REPRESENTATION') {
      return {
        outcome: PLAY_OUTCOME.ERROR, ...baseContext,
        code: error.code ?? 'UNKNOWN', message: error.message,
      };
    }
    // 2. Cold path bound nothing. Classify without new provider calls.
    const classification = classifyUnboundResult(error.prepareResult ?? null);
    if (classification.kind === 'no-candidates') {
      return { outcome: PLAY_OUTCOME.NOT_AVAILABLE, ...baseContext, reason: 'no-candidate', detail: null };
    }
    if (classification.kind === 'no-eligible' || classification.kind === 'nothing-acceptable') {
      return {
        outcome: PLAY_OUTCOME.NOT_AVAILABLE, ...baseContext,
        reason: classification.kind === 'no-eligible' ? 'no-eligible-candidate' : 'no-acceptable-candidate',
        detail: null,
      };
    }
    // 3. Defensive single retry: an executable candidate the traversal
    // demonstrably did not attempt. Widened bound + probe, exactly once.
    if (classification.kind === 'executable-alternative') {
      try {
        const retry = await resolvePlaybackIntent({
          ...intentArgs,
          extraRequest: { ...(intentArgs.extraRequest ?? {}) },
          prepareFn: intentArgs.prepareFn
            ? async (cache, request) => intentArgs.prepareFn(cache, {
              ...request,
              maxServiceabilityAlternates: retryAlternates,
              ...(typeof serviceabilityProbe === 'function' ? { serviceabilityProbe } : {}),
            })
            : intentArgs.prepareFn,
        });
        return { outcome: PLAY_OUTCOME.READY, representationReason: 'equivalent-executable', ...retry };
      } catch {
        // Retry changed nothing — fall through to preparation with the
        // same candidate as material below.
      }
    }
    // 4. Preparation: best acceptable candidate (rank order = quality
    // authority), provider-neutral strategy, durable single-flight.
    // Reached when every executable alternative was attempted (or none
    // exists) — including after a no-op retry above.
    const candidate = classification.candidate;
    if (!candidate?.infoHash) {
      return { outcome: PLAY_OUTCOME.NOT_AVAILABLE, ...baseContext, reason: 'no-preparable-candidate', detail: null };
    }
    if (typeof prepareDeps !== 'function') {
      // No preparation machinery wired: today's exact behavior.
      return { outcome: PLAY_OUTCOME.NOT_AVAILABLE, ...baseContext, reason: 'preparation-unavailable', detail: null };
    }
    let deps = null;
    try {
      deps = await prepareDeps();
    } catch {
      deps = null;
    }
    if (!deps?.driver) {
      return { outcome: PLAY_OUTCOME.NOT_AVAILABLE, ...baseContext, reason: 'preparation-unavailable', detail: null };
    }
    const started = deps.driver.startPreparation({
      infoHash: candidate.infoHash,
      mediaType: baseContext.mediaType === 'series' ? 'series' : 'movie',
      mediaId: baseContext.mediaId,
      season: baseContext.season,
      episode: baseContext.episode,
      title: candidate.title ?? candidate.filename ?? null,
      candidate: {
        filename: candidate.filename ?? candidate.title ?? null,
        size: Number.isSafeInteger(Number(candidate.selectedFileSize)) ? Number(candidate.selectedFileSize) : null,
        rank: candidate.rank ?? null,
      },
      providers: Array.isArray(deps.eligibleProviders) ? deps.eligibleProviders : [],
      source: 'play',
      sessionId: intentArgs.sessionId ?? null,
    });
    if (!started?.preparation) {
      return {
        outcome: PLAY_OUTCOME.NOT_AVAILABLE, ...baseContext,
        reason: started?.reason ?? 'preparation-rejected', detail: null,
      };
    }
    return {
      outcome: PLAY_OUTCOME.PREPARING, ...baseContext,
      preparationId: started.preparation.id,
      provider: started.preparation.provider,
      joined: started.joined === true,
      representationReason: 'prepared-representation',
      candidate: { infoHash: candidate.infoHash, rank: candidate.rank ?? null },
      message: started.joined
        ? 'preparation already running for this release; will play automatically when ready'
        : 'preparation started; will play automatically when ready',
    };
  }
}
