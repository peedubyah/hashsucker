/**
 * Retirement eligibility policy.
 *
 * Pure evaluation over durable consumer observations. An item becomes
 * ELIGIBLE only when every gate holds; anything else names the exact
 * reason. Fail-closed throughout: UNKNOWN, stale, missing, or
 * insufficient history is never eligibility.
 *
 * Gates:
 *   POLICY_DISABLED      — RETIREMENT_ENABLED is not "1"/"true";
 *   NOT_PUBLISHED        — item state is not 'published';
 *   NO_OBSERVATION       — no row for (consumer, item);
 *   CONSUMER_UNKNOWN     — latest check failed/unmappable (present NULL);
 *   OBSERVATION_STALE    — latest check older than max age;
 *   PRESENT_IN_<C>       — consumer currently reports present;
 *   INSUFFICIENT_HISTORY — watched for less than the grace period;
 *   ABSENCE_GRACE_NOT_MET— absent but grace period not yet met;
 *   ELIGIBLE             — all required consumers absent past grace.
 */

export function readRetirementPolicy(env = process.env) {
  const flag = String(env.RETIREMENT_ENABLED ?? '').toLowerCase();
  const required = String(env.RETIREMENT_REQUIRED_CONSUMERS ?? 'jellyfin')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const grace = Number(env.RETIREMENT_ABSENCE_GRACE_MS ?? 7 * 24 * 60 * 60 * 1000);
  const maxAge = Number(env.CONSUMER_OBSERVATION_MAX_AGE_MS ?? 60 * 60 * 1000);
  return {
    enabled: flag === '1' || flag === 'true',
    requiredConsumers: required.length > 0 ? required : ['jellyfin'],
    absenceGraceMs: Number.isSafeInteger(grace) && grace > 0 ? grace : 7 * 24 * 60 * 60 * 1000,
    observationMaxAgeMs: Number.isSafeInteger(maxAge) && maxAge > 0 ? maxAge : 60 * 60 * 1000,
  };
}

/**
 * @param {Object} item - { mediaId, season, episode, state }
 * @param {Array} observations - rows for this item from listConsumerObservations
 * @param {Object} policy - readRetirementPolicy()
 * @param {number} now - ms epoch
 * @returns {{ eligible: boolean, reason: string, absenceAgeMs: number|null,
 *             presence: Record<string, string> }}
 */
export function evaluateRetirement(item, observations, policy, now = Date.now()) {
  const presence = {};
  if (!policy.enabled) {
    return { eligible: false, reason: 'POLICY_DISABLED', absenceAgeMs: null, presence };
  }
  if (item?.state !== 'published') {
    return { eligible: false, reason: 'NOT_PUBLISHED', absenceAgeMs: null, presence };
  }
  const key = (o) => `${o.consumer}|${o.mediaId}|${o.season ?? ''}|${o.episode ?? ''}`;
  const want = `${item.mediaId}|${item.season ?? ''}|${item.episode ?? ''}`;
  let oldestAbsence = null;
  for (const consumer of policy.requiredConsumers) {
    const obs = observations.find((o) => o.consumer === consumer && key(o) === `${consumer}|${want}`);
    if (!obs) {
      presence[consumer] = 'NO_OBSERVATION';
      return { eligible: false, reason: 'NO_OBSERVATION', absenceAgeMs: null, presence };
    }
    if (obs.present == null) {
      presence[consumer] = 'UNKNOWN';
      return { eligible: false, reason: 'CONSUMER_UNKNOWN', absenceAgeMs: null, presence };
    }
    if (now - obs.lastCheckedAt > policy.observationMaxAgeMs) {
      presence[consumer] = 'STALE';
      return { eligible: false, reason: 'OBSERVATION_STALE', absenceAgeMs: null, presence };
    }
    if (obs.present === 1) {
      presence[consumer] = 'PRESENT';
      return { eligible: false, reason: `PRESENT_IN_${consumer.toUpperCase()}`, absenceAgeMs: 0, presence };
    }
    presence[consumer] = 'ABSENT';
    // Sustained watching required: the item must have been observed since
    // before the grace window opened, otherwise one or two missing scans
    // could retire it.
    const watchedSince = obs.firstCheckedAt ?? obs.lastCheckedAt;
    if (now - watchedSince < policy.absenceGraceMs) {
      return { eligible: false, reason: 'INSUFFICIENT_HISTORY', absenceAgeMs: now - (obs.lastSeenPresentAt ?? watchedSince), presence };
    }
    const lastSeen = obs.lastSeenPresentAt;
    const absenceAge = lastSeen == null ? now - watchedSince : now - lastSeen;
    if (absenceAge < policy.absenceGraceMs) {
      if (oldestAbsence == null || absenceAge < oldestAbsence) oldestAbsence = absenceAge;
      return { eligible: false, reason: 'ABSENCE_GRACE_NOT_MET', absenceAgeMs: absenceAge, presence };
    }
    if (oldestAbsence == null || absenceAge < oldestAbsence) oldestAbsence = absenceAge;
  }
  return { eligible: true, reason: 'ELIGIBLE', absenceAgeMs: oldestAbsence, presence };
}
