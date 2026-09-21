import { useCallback, useState } from 'react';
import { fetchActivity, mediaLabel, type ActivityItem } from '@/api';
import { usePoll } from '@/lib/use-poll';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState } from '@/components/common';

function stateTone(state?: string | null): string {
  const s = (state ?? '').toLowerCase();
  if (['done', 'published', 'fulfilled', 'completed', 'staged'].includes(s)) return 'success';
  if (['failed', 'error'].includes(s)) return 'bad';
  if (['requested', 'resolving', 'materializing', 'preparing', 'processing', 'pending'].includes(s)) return 'info';
  return 'default';
}

export function ActivityPage() {
  const [data, error, refresh] = usePoll(useCallback(() => fetchActivity(30), []), 15_000);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!data && !error) return <LoadingState label="Loading activity…" />;
  if (error && !data) return <ErrorState message={error} onRetry={() => void refresh()} />;

  const items = data?.items ?? [];
  return (
    <div className="page">
      <PageHeader
        title="Activity"
        subtitle="Recent requests and staged downloads. Failures say why in plain language."
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>Refresh</button>}
      />
      <Section dense>
        {items.length === 0 ? (
          <EmptyState title="No activity yet" detail="Requests from Seerr/Requestrr and staged downloads will appear here." />
        ) : (
          <ul className="activity-list">
            {items.map((i: ActivityItem) => (
              <li key={`${i.kind}:${i.id}`} className="activity-row">
                <button
                  type="button"
                  className="activity-main"
                  onClick={() => setExpanded((p) => (p === i.id ? null : i.id))}
                  aria-expanded={expanded === i.id}
                >
                  <span className={`badge badge-${stateTone(i.state)}`}>{i.kind === 'download' ? 'Download' : 'Request'}</span>
                  <span className="activity-title">{mediaLabel(i)}</span>
                  <span className="activity-state">{i.headline ?? i.state ?? ''}</span>
                </button>
                {expanded === i.id && (
                  <div className="activity-detail muted small">
                    state {i.state ?? '—'}
                    {i.qualityProfile ? ` · profile ${i.qualityProfile}` : ''}
                    {i.season != null ? ` · S${i.season}E${i.episode}` : ''}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
