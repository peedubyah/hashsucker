import { useCallback, useEffect, useState } from 'react';
import {
  getSearchStats,
  searchDmmCorpus,
  getOperatorSearchDebug,
} from '@api/client';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState, MetricGrid, MetricTile, DataTable } from '@/components/common';
import { formatNumber } from '@/lib/format';

interface SearchStats {
  indexed: number;
  total: number;
}

interface InternalRow {
  hash: string;
  title: string;
  filename: string;
  score: number;
  resolution: string | null;
  year: number | null;
  releaseGroup: string | null;
  size: number | null;
  confidence: number;
  sources: string[] | null;
}

interface SearchDebugRow {
  title: string;
  score: number;
  components: Record<string, number> | null;
  source: string;
}

export function CorpusPage() {
  const [stats, setStats] = useState<SearchStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [internalRows, setInternalRows] = useState<InternalRow[] | null>(null);
  const [internalTotal, setInternalTotal] = useState(0);
  const [internalLoading, setInternalLoading] = useState(false);
  const [internalError, setInternalError] = useState<string | null>(null);

  const [debugRows, setDebugRows] = useState<SearchDebugRow[] | null>(null);
  const [debugTotal, setDebugTotal] = useState(0);
  const [debugError, setDebugError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const res = await getSearchStats();
      setStats(res);
    } catch (err) {
      setStatsError((err as Error).message);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => { void loadStats(); }, [loadStats]);

  const runInternal = useCallback(async () => {
    if (!query.trim()) return;
    setInternalLoading(true);
    setInternalError(null);
    try {
      const res = await searchDmmCorpus(query.trim(), 50, 0);
      setInternalRows((res.results as unknown as Array<Record<string, unknown>> ?? []).map((r) => ({
        hash: String(r.hash ?? ''),
        title: String(r.title ?? ''),
        filename: String(r.filename ?? ''),
        score: Number(r.score ?? 0),
        resolution: (r.resolution as string | null) ?? null,
        year: (r.year as number | null) ?? null,
        releaseGroup: (r.releaseGroup as string | null) ?? null,
        size: (r.size as number | null) ?? null,
        confidence: Number(r.confidence ?? 0),
        sources: (r.sources as string[] | null) ?? null,
      })));
      setInternalTotal(res.total ?? 0);
    } catch (err) {
      setInternalError((err as Error).message);
    } finally {
      setInternalLoading(false);
    }
  }, [query]);

  const runDebug = useCallback(async () => {
    if (!query.trim()) return;
    try {
      const res = await getOperatorSearchDebug(query.trim());
      setDebugRows(res.results as SearchDebugRow[]);
      setDebugTotal(res.total);
    } catch (err) {
      setDebugError((err as Error).message);
    }
  }, [query]);

  return (
    <div className="page page-corpus">
      <PageHeader
        title="Corpus / Discovery"
        subtitle="Operator visibility into the DMM corpus and ranked candidate debug view."
        actions={
          <button type="button" className="btn btn-secondary" onClick={loadStats} disabled={statsLoading}>
            {statsLoading ? 'Refreshing…' : 'Refresh stats'}
          </button>
        }
      />

      <MetricGrid>
        <MetricTile
          label="Indexed"
          value={stats ? formatNumber(stats.indexed) : '—'}
          tone="good"
          hint="FTS5 corpus rows"
        />
        <MetricTile
          label="Total"
          value={stats ? formatNumber(stats.total) : '—'}
          tone="info"
        />
        <MetricTile
          label="Last query total"
          value={internalTotal || debugTotal || '—'}
          hint="Whichever ran last"
        />
      </MetricGrid>

      {statsError && <Section><ErrorState message={statsError} onRetry={loadStats} /></Section>}

      <Section
        title="Query tools"
        description="Internal FTS5 search returns raw corpus rows. Search-debug surfaces the ranked candidate list the resolver would see, with score components."
      >
        <form
          className="inline-form"
          onSubmit={e => { e.preventDefault(); void runInternal(); void runDebug(); }}
        >
          <input
            type="search"
            className="search-input"
            placeholder="Query corpus…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={!query.trim()}>
            Run both
          </button>
          <button type="button" className="btn btn-secondary" disabled={!query.trim()} onClick={runInternal}>
            Internal only
          </button>
          <button type="button" className="btn btn-secondary" disabled={!query.trim()} onClick={runDebug}>
            Debug only
          </button>
        </form>
      </Section>

      {internalLoading && <Section><LoadingState label="Querying FTS5…" /></Section>}
      {internalError && <Section><ErrorState message={internalError} /></Section>}
      {debugError && <Section><ErrorState message={debugError} /></Section>}

      {internalRows && (
        <Section title={`Internal search (${internalTotal} total)`}>
          {internalRows.length === 0 ? (
            <EmptyState title="No corpus rows" detail={`No FTS5 matches for "${query}"`} />
          ) : (
            <DataTable<InternalRow>
              rows={internalRows.slice(0, 50)}
              getRowKey={(r) => r.hash}
              columns={[
                { key: 'title', header: 'Title', render: (r) => (
                  <div>
                    <div className="strong">{r.title || r.filename}</div>
                    <div className="muted small mono">{r.hash.slice(0, 16)}…</div>
                  </div>
                ) },
                { key: 'resolution', header: 'Res', width: '80px', render: (r) => r.resolution ?? '—' },
                { key: 'year', header: 'Year', width: '70px', align: 'right', render: (r) => r.year ?? '—' },
                { key: 'group', header: 'Group', width: '110px', render: (r) => r.releaseGroup ?? '—' },
                { key: 'size', header: 'Size', width: '90px', align: 'right', render: (r) => r.size ? `${(r.size / 1_000_000_000).toFixed(1)} GB` : '—' },
                { key: 'conf', header: 'Conf', width: '70px', align: 'right', render: (r) => `${Math.round(r.confidence * 100)}%` },
                { key: 'score', header: 'Score', width: '70px', align: 'right', render: (r) => r.score.toFixed(3) },
                { key: 'sources', header: 'Sources', render: (r) => (
                  <div className="muted small">{r.sources?.join(', ') ?? '—'}</div>
                ) },
              ]}
            />
          )}
        </Section>
      )}

      {debugRows && (
        <Section
          title={`Operator search-debug (${debugTotal} total · top 20 by score)`}
          description="Exposes the same ranked list the resolver sees, including per-component scoring. Use to investigate identity / ranking defects surfaced on the Search page."
        >
          {debugRows.length === 0 ? (
            <EmptyState title="No debug rows" />
          ) : (
            <DataTable<SearchDebugRow>
              rows={debugRows}
              getRowKey={(r) => `${r.title}-${r.source}`}
              columns={[
                { key: 'title', header: 'Title', render: (r) => <span className="strong">{r.title}</span> },
                { key: 'source', header: 'Source', width: '100px', render: (r) => r.source },
                { key: 'relevance', header: 'Relev.', width: '70px', align: 'right', render: (r) => r.components?.relevance?.toFixed(2) ?? '—' },
                { key: 'quality', header: 'Qual.', width: '70px', align: 'right', render: (r) => r.components?.quality?.toFixed(2) ?? '—' },
                { key: 'relConf', header: 'Release', width: '80px', align: 'right', render: (r) => r.components?.releaseConfidence?.toFixed(2) ?? '—' },
                { key: 'ident', header: 'Identity', width: '90px', align: 'right', render: (r) => r.components?.identityConfidence?.toFixed(2) ?? '—' },
                { key: 'prov', header: 'Provider', width: '90px', align: 'right', render: (r) => r.components?.providerAvailability?.toFixed(2) ?? '—' },
                { key: 'ep', header: 'Episode', width: '90px', align: 'right', render: (r) => r.components?.episodeMatch?.toFixed(2) ?? '—' },
                { key: 'score', header: 'Score', width: '90px', align: 'right', render: (r) => r.score.toFixed(3) },
              ]}
            />
          )}
        </Section>
      )}
    </div>
  );
}
