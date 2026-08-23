import type { ProviderObservation, ReleaseResult } from '@/types/api';

export function releaseProviderEvidence(release: ReleaseResult): ProviderObservation[] {
  if (Array.isArray(release.providerObservations) && release.providerObservations.length > 0) {
    return release.providerObservations;
  }
  return Object.entries(release.providers ?? {}).map(([provider, observation]) => ({
    ...observation,
    provider,
  }));
}

export function isFreshAuthoritative(observation: ProviderObservation): boolean {
  return observation.kind === 'authoritative'
    && observation.freshness === 'fresh'
    && observation.fresh === true;
}

export function hasConfirmedCached(release: ReleaseResult): boolean {
  return releaseProviderEvidence(release)
    .some(observation => isFreshAuthoritative(observation) && observation.cached === true);
}

export function hasConfirmedUncached(release: ReleaseResult): boolean {
  return releaseProviderEvidence(release)
    .some(observation => isFreshAuthoritative(observation) && observation.cached === false);
}
