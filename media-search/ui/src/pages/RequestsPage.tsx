import { useCallback } from 'react';
import { fetchRequests, mediaLabel, type RequestItem } from '@/api';
import { usePoll } from '@/lib/use-poll';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState } from '@/components/common';

function tone(state?: string | null): string {
  if (state === 'ready' || state === 'completed') return 'success';
  if (state === 'failed') return 'bad';
  if (state === 'retry scheduled') return 'warning';
  return 'info';
}

function stageLabel(item: RequestItem): string {
  if (item.stage === 'ready') return 'Ready';
  if (item.stage === 'failed') return 'Failed';
  if (item.stage === 'retry scheduled') return 'Retry scheduled';
  return item.stage ? item.stage[0].toUpperCase() + item.stage.slice(1) : 'Working';
}

export function RequestsPage() {
  const [data, error, refresh] = usePoll(useCallback(() => fetchRequests(50), []), 10_000);
  if (!data && !error) return <LoadingState label="Loading requests…" />;
  if (error && !data) return <ErrorState message={error} onRetry={() => void refresh()} />;
  const items = data?.items ?? [];
  return <div className="page">
    <PageHeader title="Requests" subtitle="The latest things you asked HashSucker to find or prepare." actions={<button className="btn btn-secondary btn-sm" type="button" onClick={() => void refresh()}>Refresh</button>} />
    <Section dense>
      {items.length === 0 ? <EmptyState title="No requests yet" detail="Search for a movie or show to get started." /> : <div className="request-list">{items.map((item) => <article className="request-card" key={item.id}>
        {item.posterUrl ? <img className="media-poster" src={item.posterUrl} alt="" /> : null}<div className="request-card-main"><h2>{mediaLabel(item)}</h2><div className="tag-row"><span className={`badge badge-${tone(item.stage)}`}>{stageLabel(item)}</span><span className="badge badge-default">{item.intentLabel}</span>{item.qualityProfile && <span className="badge badge-default">{item.qualityProfile}</span>}</div><p className="muted">{item.message}</p></div><time className="muted small">{item.createdAt ? new Date(item.createdAt).toLocaleString() : '—'}</time>
      </article>)}</div>}
    </Section>
  </div>;
}
