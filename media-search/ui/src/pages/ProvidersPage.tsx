import { useCallback } from 'react';
import { fetchDiagnostics, fetchFailedEvents } from '@/api';
import { usePoll } from '@/lib/use-poll';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState, MetricTile, MetricGrid } from '@/components/common';

function tone(state?: string): 'good' | 'bad' | 'warn' | 'neutral' {
  const s = (state ?? '').toLowerCase();
  if (['ok', 'reachable', 'configured'].includes(s)) return 'good';
  if (['error', 'unreachable', 'failed'].includes(s)) return 'bad';
  if (['degraded', 'unknown', 'skipped'].includes(s)) return 'warn';
  return 'neutral';
}

export function ProvidersPage() {
  const [diag, error, refresh] = usePoll(useCallback(() => fetchDiagnostics(), []), 30_000);
  const [failed] = usePoll(useCallback(() => fetchFailedEvents(20).catch(() => ({ runs: [] })), []), 30_000);

  if (!diag && !error) return <LoadingState label="Checking providers…" />;
  if (error && !diag) return <ErrorState message={error} onRetry={() => void refresh()} />;

  const tb = diag?.providers?.torbox;
  const rd = diag?.providers?.realdebrid;
  const throttle = (failed?.runs ?? []).filter((r) => /429|rate|limit|throttle/i.test(r.error ?? ''));

  const card = (name: string, p?: { state?: string; detail?: string }) => (
    <Section key={name} title={name} meta={<span className={`badge badge-${tone(p?.state)}`}>{p?.state ?? 'unknown'}</span>}>
      <p className="muted small">{p?.detail ?? 'No status reported.'}</p>
      {name === 'TorBox' && dot(tb?.state) && <p className="muted small">Cached files play instantly; uncached titles are fetched on demand.</p>}
    </Section>
  );
  const dot = (s?: string) => tone(s) === 'good';

  return (
    <div className="page">
      <PageHeader
        title="Providers"
        subtitle="Debrid connections. Placement counts live on each library title."
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>Refresh</button>}
      />
      {card('TorBox', tb)}
      {card('Real-Debrid', rd)}
      <Section title="Recent strain" description="Rate limits and degraded responses. Retries are automatic.">
        {throttle.length === 0 ? (
          <EmptyState title="No strain" detail="No recent throttling or degraded provider responses." />
        ) : (
          <ul className="check-list">
            {throttle.slice(0, 5).map((r, i) => (
              <li key={i}>{r.mediaId ?? r.requestId ?? 'A request'} — {(r.error ?? '').slice(0, 140)}</li>
            ))}
          </ul>
        )}
      </Section>
      <Section dense>
        <MetricGrid>
          <MetricTile label="Note" value="No action needed" tone="neutral" hint="HashSucker backs off and retries on its own." />
        </MetricGrid>
      </Section>
    </div>
  );
}
