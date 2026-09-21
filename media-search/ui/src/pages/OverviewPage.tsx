import { useCallback } from 'react';
import { fetchDiagnostics, fetchFailedEvents, fetchReady } from '@/api';
import { usePoll } from '@/lib/use-poll';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState, MetricTile, MetricGrid } from '@/components/common';

function dot(state?: string): 'good' | 'bad' | 'warn' | 'neutral' {
  const s = (state ?? '').toLowerCase();
  if (['ok', 'healthy', 'ready', 'reachable', 'usable', 'configured'].includes(s)) return 'good';
  if (['error', 'failed', 'unreachable', 'down'].includes(s)) return 'bad';
  if (['degraded', 'not_ready', 'unknown', 'skipped'].includes(s)) return 'warn';
  return 'neutral';
}

export function OverviewPage() {
  const [diag, diagErr, refreshDiag] = usePoll(useCallback(() => fetchDiagnostics(), []), 30_000);
  const [ready] = usePoll(useCallback(() => fetchReady().catch(() => null), []), 30_000);
  const [failed] = usePoll(useCallback(() => fetchFailedEvents(5).catch(() => ({ runs: [] })), []), 30_000);

  if (!diag && !diagErr) return <LoadingState label="Checking health…" />;
  if (diagErr && !diag) return <ErrorState message={diagErr} onRetry={() => void refreshDiag()} />;

  const providers = diag?.providers ?? {};
  const tb = providers.torbox?.state ?? 'unknown';
  const rd = providers.realdebrid?.state ?? 'unknown';
  const providersReady = dot(tb) === 'good' || dot(rd) === 'good';
  const corpus = diag?.corpus;
  const corpusOk = (corpus?.usable ?? dot(corpus?.state) === 'good') as boolean;
  const dp = typeof diag?.dataPlane === 'string' ? diag.dataPlane : diag?.dataPlane?.state;
  const vfs = diag?.publication?.vfs;
  const consumers = diag?.consumers ?? {};
  const plexState = consumers.plex?.state;
  const jellyState = consumers.jellyfin?.state;
  const integrationsConfigured = dot(plexState) === 'good' || dot(jellyState) === 'good';
  const failedRuns = failed?.runs ?? [];

  // First-run: no provider can serve anything yet.
  if (!providersReady) {
    return (
      <div className="page">
        <PageHeader title="HashSucker needs configuration" subtitle="Nothing can be fetched until a provider is connected." />
        <Section title="What is missing">
          <ul className="check-list">
            <li>
              <strong>Debrid provider.</strong> Set <code>TORBOX_API_KEY</code> and/or{' '}
              <code>REALDEBRID_API_KEY</code> in <code>.env</code> and restart media-search.
              {tb !== 'unknown' && <> TorBox: {providers.torbox?.detail ?? tb}.</>}
              {rd !== 'unknown' && <> Real-Debrid: {providers.realdebrid?.detail ?? rd}.</>}
            </li>
          </ul>
        </Section>
        <Section title="Optional integrations" description="HashSucker works without these.">
          <ul className="check-list">
            <li>Plex / Jellyfin — playback visibility ({dot(plexState) === 'good' || dot(jellyState) === 'good' ? 'at least one connected' : 'none connected'}).</li>
            <li>Sonarr / Radarr / Seerr / Requestrr — request intake.</li>
          </ul>
        </Section>
      </div>
    );
  }

  const attention: string[] = [];
  for (const r of failedRuns) {
    if (r.error) attention.push(`${r.mediaId ?? r.requestId ?? 'A request'} — ${r.error.slice(0, 120)}`);
  }

  return (
    <div className="page">
      <PageHeader
        title="HashSucker is ready"
        subtitle="Optional integrations are marked; only real problems ask for attention."
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshDiag()}>Refresh</button>}
      />
      <Section dense>
        <MetricGrid>
          <MetricTile label="Health" value={ready?.status ?? diag?.status ?? '—'} tone={dot(ready?.status ?? diag?.status)} />
          <MetricTile label="Providers" value={dot(tb) === 'good' && dot(rd) === 'good' ? 'Both' : dot(tb) === 'good' ? 'TorBox' : 'Real-Debrid'} tone="good" hint={`TorBox ${tb} · RD ${rd}`} />
          <MetricTile label="Corpus" value={corpusOk ? 'Usable' : (corpus?.state ?? '—')} tone={corpusOk ? 'good' : 'warn'} hint={corpus?.candidates != null ? `${corpus.candidates.toLocaleString()} candidates` : undefined} />
          <MetricTile label="Data plane" value={dp ?? '—'} tone={dot(dp)} />
          <MetricTile label="Library" value={vfs?.detail ?? `${vfs?.movies ?? 0} movies · ${vfs?.episodes ?? 0} episodes`} tone={dot(vfs?.state)} />
          <MetricTile label="Plex / Jellyfin" value={integrationsConfigured ? 'Connected' : 'Optional'} tone={integrationsConfigured ? 'good' : 'neutral'} hint={`Plex ${plexState ?? '—'} · Jellyfin ${jellyState ?? '—'}`} />
        </MetricGrid>
      </Section>
      <Section title="Needs attention" description={attention.length ? undefined : 'Nothing is failing.'}>
        {attention.length === 0 ? (
          <EmptyState title="All quiet" detail="No recent failures need a human." />
        ) : (
          <ul className="check-list">
            {attention.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        )}
      </Section>
    </div>
  );
}
