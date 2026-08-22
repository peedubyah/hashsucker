import type { ControlPlaneItemSummary, LifecycleMilestone } from '@/types/api';
import { Badge } from './Badge';

const MILESTONES: Array<{ key: LifecycleMilestone; label: string }> = [
  { key: 'requested', label: 'Requested' },
  { key: 'checked', label: 'Checked' },
  { key: 'placed', label: 'Placed' },
  { key: 'provider-ready', label: 'Provider ready' },
  { key: 'exposed', label: 'Exposed' },
  { key: 'exact-file-mapped', label: 'Exact file mapped' },
  { key: 'bound', label: 'Bound' },
  { key: 'cataloged', label: 'Cataloged' },
  { key: 'playable', label: 'Playable' },
];

export function LifecycleStatus({ items, error }: { items: ControlPlaneItemSummary[]; error?: string | null }) {
  if (error) return <div className="lifecycle-status"><strong>Lifecycle unavailable:</strong> {error}</div>;
  if (items.length === 0) return <div className="lifecycle-status">No control-plane library item exists for this media.</div>;

  return (
    <section className="lifecycle-status" aria-label="Control-plane lifecycle">
      <h2>Virtual-library lifecycle</h2>
      <p>Each milestone is independent; an earlier success does not imply exposure, cataloging, or playback.</p>
      {items.length > 1 && <p>{items.length} library items match this media. None is selected implicitly.</p>}
      {items.map(({ item, canonicalPath, lifecycle }) => (
        <div className="lifecycle-item" key={item.id}>
          <div><strong>{item.title}</strong> · {item.editionKey} · desired {item.desiredState}</div>
          {canonicalPath && <div className="mono">{canonicalPath.path}</div>}
          <div className="provider-status">
            {MILESTONES.map(({ key, label }) => {
              const event = lifecycle[key];
              const status = event?.status ?? 'not observed';
              const variant = status === 'satisfied' ? 'success'
                : status === 'failed' || status === 'degraded' ? 'error' : 'default';
              return <Badge key={key} variant={variant} title={event?.reason ?? undefined}>{label}: {status}</Badge>;
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
