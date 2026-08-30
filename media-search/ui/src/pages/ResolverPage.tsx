import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getResolverTelemetry,
  getControlPlaneHealth,
} from '@api/client';
import type {
  ResolverTelemetry,
  ResolverTelemetryRecord,
  ControlPlaneHealth,
} from '@/types/api';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState, MetricGrid, MetricTile, DataTable } from '@/components/common';
import { StatusBadge, formatRelative, formatTimestamp, formatDuration } from '@/lib/format';

export function ResolverPage() {
  const [telemetry, setTelemetry] = useState<ResolverTelemetry | null>(null);
  const [health, setHealth] = useState<ControlPlaneHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, h] = await Promise.all([
        getResolverTelemetry({ limit }),
        getControlPlaneHealth(),
      ]);
      setTelemetry(t);
      setHealth(h);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => { void load(); }, [load]);

  const stats = useMemo(() => computeStats(telemetry), [telemetry]);
  const selectedRecord = useMemo(() =>
    telemetry?.records.find(r => r.requestId === selectedId) ?? null,
  [telemetry, selectedId]);

  return (
    <div className="page page-resolver">
      <PageHeader
        title="Resolver"
        subtitle="Recent /stream resolution attempts, fallback behavior, and provider-check telemetry."
        actions={
          <button type="button" className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      {stats && (
        <MetricGrid>
          <MetricTile label="Total" value={stats.total} />
          <MetricTile label="Resolved" value={stats.resolved} tone="good" hint={`${stats.resolvedPct}%`} />
          <MetricTile label="Redirected" value={stats.redirected} tone="good" hint={`${stats.redirectedPct}%`} />
          <MetricTile label="Failed" value={stats.failed} tone="bad" hint={`${stats.failedPct}%`} />
          <MetricTile label="Avg latency" value={stats.avgLatency != null ? formatDuration(stats.avgLatency) : '—'} />
          <MetricTile label="Fallbacks" value={stats.fallbackCount} tone="warn" />
        </MetricGrid>
      )}

      <Section
        title="Recent resolution attempts"
        actions={
          <label className="filter-select">
            <span>Limit</span>
            <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
        }
      >
        {loading && !telemetry && <LoadingState label="Loading telemetry…" />}
        {error && <ErrorState message={error} onRetry={load} />}
        {!loading && !error && telemetry && telemetry.records.length === 0 && (
          <EmptyState
            title="No resolver telemetry"
            detail="No /stream/:type/:id resolution attempts recorded yet."
          />
        )}
        {!loading && !error && telemetry && telemetry.records.length > 0 && (
          <>
            <DataTable<ResolverTelemetryRecord>
              rows={telemetry.records}
              getRowKey={(r) => r.requestId}
              onRowClick={(r) => setSelectedId(prev => prev === r.requestId ? null : r.requestId)}
              columns={[
                { key: 'outcome', header: 'Outcome', width: '120px', render: (r) => (
                  <StatusBadge value={r.outcome} />
                ) },
                { key: 'mediaId', header: 'Media', render: (r) => (
                  <code className="mono small">{r.mediaId}</code>
                ) },
                { key: 'provider', header: 'Selected', width: '130px', render: (r) => (
                  r.provider ? <span className="strong">{r.provider}</span> : <span className="muted">—</span>
                ) },
                { key: 'fallback', header: 'Fallback', width: '80px', render: (r) => (
                  r.fallbackUsed ? <StatusBadge value="yes" /> : <span className="muted">no</span>
                ) },
                { key: 'fallbackRank', header: 'FB rank', width: '80px', align: 'right', render: (r) => (
                  r.fallbackRank != null ? `#${r.fallbackRank}` : <span className="muted">—</span>
                ) },
                { key: 'availabilitySource', header: 'Avail. source', width: '130px', render: (r) => (
                  r.availabilitySource ?? <span className="muted">—</span>
                ) },
                { key: 'providerCheck', header: 'Check', width: '80px', align: 'center', render: (r) => (
                  r.providerCheckOccurred ? <StatusBadge value="yes" /> : <span className="muted">no</span>
                ) },
                { key: 'latency', header: 'Latency', width: '80px', align: 'right', render: (r) => (
                  r.durationMs != null ? formatDuration(r.durationMs) : <span className="muted">—</span>
                ) },
                { key: 'timestamp', header: 'When', width: '140px', render: (r) => (
                  r.timestamp ? formatRelative(r.timestamp) : <span className="muted">—</span>
                ) },
              ]}
            />

            {selectedId && selectedRecord && (
              <div className="resolver-detail">
                <h4>Record detail: {selectedRecord.requestId}</h4>
                <dl className="kv-grid">
                  <div className="kv-row">
                    <dt className="kv-key">Outcome</dt>
                    <dd className="kv-val"><StatusBadge value={selectedRecord.outcome} /></dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Code</dt>
                    <dd className="kv-val">{selectedRecord.code ?? '—'}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Media ID</dt>
                    <dd className="kv-val mono">{selectedRecord.mediaId}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Media type</dt>
                    <dd className="kv-val">{selectedRecord.mediaType ?? '—'}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Info hash</dt>
                    <dd className="kv-val mono">{selectedRecord.infoHash ?? '—'}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Release key</dt>
                    <dd className="kv-val mono">{selectedRecord.releaseKey ?? '—'}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Provider</dt>
                    <dd className="kv-val">{selectedRecord.provider ?? '—'}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Selected provider</dt>
                    <dd className="kv-val">{selectedRecord.selectedProvider ?? '—'}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Selected release key</dt>
                    <dd className="kv-val mono">{selectedRecord.selectedReleaseKey ?? '—'}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Fallback used</dt>
                    <dd className="kv-val">{selectedRecord.fallbackUsed ? 'yes' : 'no'}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Fallback rank</dt>
                    <dd className="kv-val">{selectedRecord.fallbackRank != null ? `#${selectedRecord.fallbackRank}` : '—'}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Availability source</dt>
                    <dd className="kv-val">{selectedRecord.availabilitySource ?? '—'}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Provider check occurred</dt>
                    <dd className="kv-val">{selectedRecord.providerCheckOccurred ? 'yes' : 'no'}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Latency</dt>
                    <dd className="kv-val">{selectedRecord.durationMs != null ? formatDuration(selectedRecord.durationMs) : '—'}</dd>
                  </div>
                  <div className="kv-row">
                    <dt className="kv-key">Timestamp</dt>
                    <dd className="kv-val">{selectedRecord.timestamp ? formatTimestamp(selectedRecord.timestamp) : '—'}</dd>
                  </div>
                </dl>
                {selectedRecord.details && Object.keys(selectedRecord.details).length > 0 && (
                  <div className="json-details-wrap">
                    <h4>Details</h4>
                    <pre className="mono small">{JSON.stringify(selectedRecord.details, null, 2)}</pre>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Section>

      {health && (
        <Section title="Control plane health">
          <MetricGrid>
            <MetricTile
              label="Mode"
              value={health.mode}
              tone={health.mode === 'read-only-shadow' ? 'info' : 'neutral'}
            />
            <MetricTile
              label="Storage"
              value={health.storage?.status ?? '—'}
              tone={health.storage?.status === 'healthy' ? 'good' : health.storage?.status === 'error' ? 'bad' : 'neutral'}
            />
          </MetricGrid>
          <div>
            <h4>Mounts</h4>
            <ul className="compact-list">
              {health.mounts?.map((m, i) => (
                <li key={i}>
                  <span className="strong">{m.name}</span>
                  <StatusBadge value={m.status} />
                  {m.errorCategory && <span className="badge badge-warning">{m.errorCategory}</span>}
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )}
    </div>
  );
}

function computeStats(t: ResolverTelemetry | null) {
  if (!t?.records.length) return null;
  const records = t.records;
  const total = records.length;
  const resolved = records.filter(r => r.outcome === 'resolved' || r.outcome === 'redirected').length;
  const redirected = records.filter(r => r.outcome === 'redirected').length;
  const failed = records.filter(r => r.outcome === 'failed').length;
  const fallbackCount = records.filter(r => r.fallbackUsed).length;
  const latencies = records.map(r => r.durationMs).filter((d): d is number => d != null);
  const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  return {
    total,
    resolved,
    redirected,
    failed,
    fallbackCount,
    avgLatency,
    resolvedPct: total ? ((resolved / total) * 100).toFixed(1) : '0',
    redirectedPct: total ? ((redirected / total) * 100).toFixed(1) : '0',
    failedPct: total ? ((failed / total) * 100).toFixed(1) : '0',
  };
}
