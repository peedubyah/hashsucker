import type { ProviderObservation } from '@/types/api';
import { Badge } from './Badge';

interface Props {
  providers?: Record<string, ProviderObservation>;
  observations?: ProviderObservation[];
}

function observationLabel(observation: ProviderObservation) {
  if (observation.state === 'error' || observation.errorCategory) return 'error';
  if (observation.cached === true) return 'cached';
  if (observation.cached === false) return 'uncached';
  return observation.state ?? 'unknown';
}

export function ProviderStatus({ providers = {}, observations = [] }: Props) {
  const entries = observations.length > 0
    ? observations.map((observation, index) => [observation.provider ?? 'unknown', observation, index] as const)
    : Object.entries(providers).map(([provider, observation], index) => [provider, observation, index] as const);

  if (entries.length === 0) return <span className="provider-none">—</span>;

  return (
    <div className="provider-status">
      {entries.map(([name, observation, index]) => {
        const state = observationLabel(observation);
        const confirmed = observation.kind === 'authoritative'
          && observation.freshness === 'fresh'
          && observation.fresh === true;
        const variant = confirmed && state === 'cached'
          ? 'success'
          : confirmed && (state === 'uncached' || state === 'error') ? 'error' : 'default';
        const title = [
          `state: ${state}`,
          `kind: ${observation.kind ?? 'legacy/unknown'}`,
          `freshness: ${observation.freshness ?? 'unknown'}`,
          observation.errorCategory ? `error: ${observation.errorCategory}` : null,
          observation.retryable != null ? `retryable: ${observation.retryable ? 'yes' : 'no'}` : null,
        ].filter(Boolean).join('; ');
        return (
          <Badge key={`${name}:${observation.accountScope ?? 'default'}:${observation.scope ?? 'candidate'}:${index}`} variant={variant} title={title}>
            {name}: {state} · {observation.kind ?? 'unknown'} · {observation.freshness ?? 'unknown'}
          </Badge>
        );
      })}
    </div>
  );
}
