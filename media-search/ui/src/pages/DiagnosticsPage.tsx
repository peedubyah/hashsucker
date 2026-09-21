import { useCallback } from 'react';
import { fetchDiagnostics, fetchFailedEvents } from '@/api';
import { usePoll } from '@/lib/use-poll';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState, KeyValueGrid } from '@/components/common';

export function DiagnosticsPage() {
  const [diag, error, refresh] = usePoll(useCallback(() => fetchDiagnostics(), []), 30_000);
  const [failed] = usePoll(useCallback(() => fetchFailedEvents(10).catch(() => ({ runs: [] })), []), 30_000);

  if (!diag && !error) return <LoadingState label="Loading diagnostics…" />;
  if (error && !diag) return <ErrorState message={error} onRetry={() => void refresh()} />;

  const runs = failed?.runs ?? [];
  return (
    <div className="page">
      <PageHeader
        title="Diagnostics"
        subtitle="Operator detail. Anything here is informational unless Overview asks for action."
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>Refresh</button>}
      />
      <Section title="Subsystems">
        <KeyValueGrid rows={[
          { key: 'Corpus', value: `${diag?.corpus?.state ?? '—'}${diag?.corpus?.candidates != null ? ` · ${diag.corpus.candidates.toLocaleString()} candidates` : ''}` },
          { key: 'VFS', value: diag?.publication?.vfs?.detail ?? '—' },
          { key: 'STRM', value: diag?.publication?.strm?.state ?? '—' },
          { key: 'Data plane', value: typeof diag?.dataPlane === 'string' ? diag.dataPlane : (diag?.dataPlane?.state ?? '—') },
          { key: 'Discovery DB', value: diag?.storage?.discoveryDb?.state ?? '—' },
          { key: 'Control DB', value: diag?.storage?.controlDb?.state ?? '—' },
        ]} />
      </Section>
      <Section title="Recent errors" description="Newest first. Expand a download or activity row for the plain-language version.">
        {runs.length === 0 ? (
          <EmptyState title="No recent errors" detail="Nothing has failed lately." />
        ) : (
          <ul className="check-list">
            {runs.map((r, i) => (
              <li key={i}><span className="mono small">{r.mediaId ?? r.requestId ?? '—'}</span> — {(r.error ?? 'unknown error').slice(0, 160)}</li>
            ))}
          </ul>
        )}
      </Section>
      <Section dense>
        <p className="muted small">
          Full technical state (raw payloads, worker internals, log tails) lives in the terminal
          console — run <code>npm run tui</code> in <code>media-search/</code>. The browser stays
          an appliance surface on purpose.
        </p>
      </Section>
    </div>
  );
}
