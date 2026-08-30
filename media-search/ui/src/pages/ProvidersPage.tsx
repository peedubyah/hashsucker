import { useCallback, useEffect, useState } from 'react';
import {
  getControlPlaneHealth,
  getCacheIntelligence,
  getSearchCacheMetrics,
} from '@api/client';
import type {
  ControlPlaneHealth,
  CacheIntelligence,
  SearchCacheMetrics,
} from '@/types/api';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState, MetricGrid, MetricTile, DataTable } from '@/components/common';
import { StatusBadge, formatNumber, formatRelative } from '@/lib/format';

interface ProviderSummary {
  name: string;
  state: 'configured' | 'not-configured' | 'error' | 'unknown';
  capability: string | null;
  observationCount: number;
  freshCount: number;
  staleCount: number;
  unboundedCount: number;
  missingCount: number;
  cachedCount: number;
  uncachedCount: number;
  unknownCount: number;
}

export function ProvidersPage() {
  const [health, setHealth] = useState<ControlPlaneHealth | null>(null);
  const [cacheIntel, setCacheIntel] = useState<CacheIntelligence | null>(null);
  const [cacheMetrics, setCacheMetrics] = useState<SearchCacheMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [h, ci, cm] = await Promise.all([
        getControlPlaneHealth(),
        getCacheIntelligence(),
        getSearchCacheMetrics(),
      ]);
      setHealth(h);
      setCacheIntel(ci);
      setCacheMetrics(cm);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const summaries = aggregateProviderSummaries(health, cacheIntel);

  return (
    <div className="page page-providers">
      <PageHeader
        title="Providers"
        subtitle="TorBox and Real-Debrid state, observations, and freshness. No secrets, no provider URLs."
        actions={
          <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      {error && <Section><ErrorState message={error} onRetry={load} /></Section>}
      {loading && !health && <Section><LoadingState label="Loading provider state…" /></Section>}

      {health && (
        <Section title="Provider registry">
          <DataTable<ProviderSummary>
            rows={summaries}
            getRowKey={(r) => r.name}
            empty={<EmptyState title="No providers" detail="Control plane reports no provider capability." />}
            columns={[
              { key: 'name', header: 'Provider', render: (r) => <span className="strong">{r.name}</span> },
              { key: 'state', header: 'State', width: '160px', render: (r) => <StatusBadge value={r.state} /> },
              { key: 'capability', header: 'Capability', render: (r) => r.capability ?? <span className="muted">—</span> },
              { key: 'obs', header: 'Observations', width: '120px', align: 'right', render: (r) => formatNumber(r.observationCount) },
              { key: 'cached', header: 'Cached', width: '100px', align: 'right', render: (r) => formatNumber(r.cachedCount), },
              { key: 'fresh', header: 'Fresh', width: '100px', align: 'right', render: (r) => formatNumber(r.freshCount) },
            ]}
          />
        </Section>
      )}

      {cacheIntel && (
        <Section title="Cache intelligence"
          description={`Generated ${formatRelative(cacheIntel.generatedAt)} · ${formatNumber(cacheIntel.observationCount)} observations`}
        >
          <MetricGrid>
            <MetricTile
              label="Observations"
              value={formatNumber(cacheIntel.observationCount)}
            />
            <MetricTile
              label="Fresh"
              value={formatNumber(cacheIntel.byFreshness?.fresh ?? 0)}
              tone="good"
            />
            <MetricTile
              label="Stale"
              value={formatNumber(cacheIntel.byFreshness?.stale ?? 0)}
              tone="warn"
            />
            <MetricTile
              label="Unbounded"
              value={formatNumber(cacheIntel.byFreshness?.unbounded ?? 0)}
              tone="info"
            />
            <MetricTile
              label="Probe queue"
              value={cacheIntel.probeQueue?.depth ?? 0}
              hint={`${cacheIntel.probeQueue?.inFlight ?? 0} in flight · ${cacheIntel.probeQueue?.scheduled ?? 0} scheduled`}
            />
          </MetricGrid>

          {cacheIntel.torboxCurrent && (
            <div className="provider-note">
              <strong>TorBox current state:</strong> <StatusBadge value={cacheIntel.torboxCurrent.state} />
              {cacheIntel.torboxCurrent.detail && <span className="muted small"> · {cacheIntel.torboxCurrent.detail}</span>}
            </div>
          )}

          <div className="cache-by-state">
            <h4>Observations by state</h4>
            <ul className="compact-list">
              {Object.entries(cacheIntel.byState ?? {}).map(([state, count]) => (
                <li key={state}>
                  <StatusBadge value={state} />
                  <span>{formatNumber(count)}</span>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )}

      {cacheMetrics && (
        <Section title="Search cache">
          <MetricGrid>
            <MetricTile label="Hits" value={formatNumber(cacheMetrics.hits)} tone="good" />
            <MetricTile label="Misses" value={formatNumber(cacheMetrics.misses)} />
            <MetricTile label="Hit ratio" value={`${(cacheMetrics.hitRatio * 100).toFixed(1)}%`} />
            <MetricTile label="Size" value={`${formatNumber(cacheMetrics.size)} / ${formatNumber(cacheMetrics.maxEntries)}`} />
            <MetricTile label="Evictions" value={formatNumber(cacheMetrics.evictions)} />
          </MetricGrid>
        </Section>
      )}
    </div>
  );
}

function aggregateProviderSummaries(
  health: ControlPlaneHealth | null,
  cacheIntel: CacheIntelligence | null,
): ProviderSummary[] {
  if (!health) return [];
  const names = new Set<string>([
    ...Object.keys(health.providerCapabilities ?? {}),
    ...Object.keys(cacheIntel?.byProvider ?? {}),
  ]);
  const out: ProviderSummary[] = [];
  for (const name of names) {
    const cap = health.providerCapabilities?.[name] ?? null;
    const observationCount = cacheIntel?.byProvider?.[name] ?? 0;
    out.push({
      name,
      state: cap ? 'configured' : 'not-configured',
      capability: cap,
      observationCount,
      freshCount: 0,
      staleCount: 0,
      unboundedCount: 0,
      missingCount: 0,
      cachedCount: 0,
      uncachedCount: 0,
      unknownCount: 0,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
