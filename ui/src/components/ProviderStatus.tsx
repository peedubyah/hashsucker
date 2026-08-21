import type { ProviderObservation } from '@/types/api';
import { Badge } from './Badge';

interface Props {
  providers: Record<string, ProviderObservation>;
}

export function ProviderStatus({ providers }: Props) {
  const entries = Object.entries(providers);

  if (entries.length === 0) {
    return <span className="provider-none">—</span>;
  }

  return (
    <div className="provider-status">
      {entries.map(([name, obs]) => (
        <Badge
          key={name}
          variant={obs.cached === true ? 'success' : obs.cached === false ? 'error' : 'default'}
          title={obs.evidence?.join(', ') || undefined}
        >
          {name}
          {obs.cached === true && ' ✓'}
          {obs.cached === false && ' ✗'}
        </Badge>
      ))}
    </div>
  );
}
