import { useCallback } from 'react';
import { fetchDiagnostics } from '@/api';
import { usePoll } from '@/lib/use-poll';
import { PageHeader, Section, ErrorState, LoadingState, KeyValueGrid } from '@/components/common';

function hostOf(url?: string): string {
  try {
    return url ? new URL(url).host : '—';
  } catch {
    return '—';
  }
}

export function SettingsPage() {
  const [diag, error, refresh] = usePoll(useCallback(() => fetchDiagnostics(), []), 60_000);

  if (!diag && !error) return <LoadingState label="Loading settings…" />;
  if (error && !diag) return <ErrorState message={error} onRetry={() => void refresh()} />;

  const tbConfigured = (diag?.providers?.torbox?.state ?? '').toLowerCase() !== 'unknown';
  const rdConfigured = (diag?.providers?.realdebrid?.state ?? '').toLowerCase() !== 'unknown';
  const plex = diag?.consumers?.plex;
  const jelly = diag?.consumers?.jellyfin;
  const arr = diag?.arr;

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        subtitle="What HashSucker is configured with. Changes live in .env — credentials are never shown here."
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>Refresh</button>}
      />
      <Section title="Providers" description="At least one debrid provider is required. Set TORBOX_API_KEY / REALDEBRID_API_KEY in .env.">
        <KeyValueGrid rows={[
          { key: 'TorBox', value: tbConfigured ? `Configured (${diag?.providers?.torbox?.state})` : 'Not configured' },
          { key: 'Real-Debrid', value: rdConfigured ? `Configured (${diag?.providers?.realdebrid?.state})` : 'Not configured' },
        ]} />
      </Section>
      <Section title="Playback visibility" description="Optional. Plex/Jellyfin hosts only — tokens stay in .env.">
        <KeyValueGrid rows={[
          { key: 'Plex', value: `${plex?.state ?? '—'} · ${hostOf(plex?.endpoint)}` },
          { key: 'Jellyfin', value: `${jelly?.state ?? '—'} · ${hostOf(jelly?.endpoint)}` },
        ]} />
      </Section>
      <Section title="Request intake" description="Optional. Sonarr/Radarr/Seerr feed future intents; Requestrr drives downloads.">
        <KeyValueGrid rows={[
          { key: 'Radarr', value: arr?.radarr?.configured ? `Configured (${arr?.radarr?.state ?? '—'})` : 'Not configured' },
          { key: 'Sonarr', value: arr?.sonarr?.configured ? `Configured (${arr?.sonarr?.state ?? '—'})` : 'Not configured' },
        ]} />
      </Section>
      <Section title="Defaults" description="Library titles start balanced; change intent per title on the Library page.">
        <KeyValueGrid rows={[{ key: 'Default quality intent', value: 'balanced' }]} />
      </Section>
    </div>
  );
}
