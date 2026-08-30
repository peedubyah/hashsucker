import { useCallback, useState } from 'react';
import {
  listControlPlaneItems,
  getControlPlaneItemDetail,
} from '@api/client';
import type {
  ControlPlaneItemList,
  ControlPlaneItemDetail,
} from '@/types/api';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState, MetricGrid, MetricTile } from '@/components/common';
import { StatusBadge, formatTimestamp, formatRelative } from '@/lib/format';

export function LibraryPage() {
  const [mediaId, setMediaId] = useState('');
  const [limitInput, setLimitInput] = useState('20');

  const [list, setList] = useState<ControlPlaneItemList | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [detail, setDetail] = useState<ControlPlaneItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    if (!mediaId.trim()) return;
    const limit = Math.max(1, Math.min(100, parseInt(limitInput, 10) || 20));
    setListLoading(true);
    setListError(null);
    try {
      const res: ControlPlaneItemList = await listControlPlaneItems({ mediaId: mediaId.trim(), limit });
      setList(res);
    } catch (err) {
      setListError((err as Error).message);
    } finally {
      setListLoading(false);
    }
  }, [mediaId, limitInput]);

  const loadDetail = useCallback(async (id: string) => {
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res: ControlPlaneItemDetail = await getControlPlaneItemDetail(id);
      setDetail(res);
    } catch (err) {
      setDetailError((err as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  return (
    <div className="page page-library">
      <PageHeader
        title="Library / VFS"
        subtitle="Virtual library items served by the control plane. Treat as durable fulfillment, not transient streaming."
      />

      <Section
        title="Lookup by mediaId"
        description="The control plane does not currently expose a top-level list endpoint. Enter a mediaId (e.g. tt0944947) to list its library items, then inspect one to view bindings, canonical path, lifecycle, and provider observations."
      >
        <form
          className="library-lookup"
          onSubmit={(e) => { e.preventDefault(); void loadList(); }}
        >
          <label className="filter-input">
            <span>mediaId</span>
            <input
              type="text"
              value={mediaId}
              onChange={(e) => setMediaId(e.target.value)}
              placeholder="tt0944947"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="filter-input" style={{ maxWidth: 120 }}>
            <span>Limit</span>
            <input
              type="number"
              min={1}
              max={100}
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={!mediaId.trim() || listLoading}>
            {listLoading ? 'Loading…' : 'Lookup'}
          </button>
        </form>

        {listError && <ErrorState message={listError} onRetry={loadList} />}

        {list && list.items.length > 0 && (
          <ul className="library-item-list">
            {list.items.map((it) => (
              <li key={it.item.id}>
                <button type="button" className="library-item-row" onClick={() => loadDetail(it.item.id)}>
                  <div>
                    <div className="strong">{it.item.title}</div>
                    <div className="muted small">
                      {it.item.mediaType === 'episode' ? 'Episode' : 'Movie'}
                      {it.item.year ? ` · ${it.item.year}` : ''}
                      {it.item.season != null && it.item.episode != null ? ` · S${it.item.season}E${it.item.episode}` : ''}
                    </div>
                  </div>
                  <code className="mono small">{it.item.id}</code>
                </button>
              </li>
            ))}
          </ul>
        )}

        {list && list.items.length === 0 && !listError && (
          <EmptyState
            title="No items"
            detail={`No library items found for mediaId "${mediaId}".`}
          />
        )}
      </Section>

      {detail && (
        <Section
          title={`Item: ${detail.item?.title ?? detail.item?.id ?? 'Detail'}`}
          description={detail.item?.mediaType ? `${detail.item.mediaType}${detail.item.year ? ` · ${detail.item.year}` : ''}` : undefined}
        >
          {detailLoading && <LoadingState label="Loading detail…" />}
          {detailError && <ErrorState message={detailError} />}

          <MetricGrid>
            <MetricTile
              label="Title"
              value={detail.item?.title ?? '—'}
              hint={detail.item?.mediaType ?? ''}
            />
            <MetricTile
              label="Edition"
              value={detail.item?.editionKey ?? '—'}
              hint="Internal identity key"
            />
            <MetricTile
              label="Desired state"
              value={detail.item?.desiredState ?? '—'}
              tone={detail.item?.desiredState === 'present' ? 'good' : 'neutral'}
            />
            <MetricTile
              label="Generated"
              value={detail.generatedAt ? formatRelative(detail.generatedAt) : '—'}
              hint={detail.generatedAt ? formatTimestamp(detail.generatedAt) : ''}
            />
          </MetricGrid>

          <div className="library-detail-grid">
            <div>
              <h4>Canonical path</h4>
              {detail.canonicalPath ? (
                <code className="mono small">{detail.canonicalPath.path ?? '—'}</code>
              ) : <span className="muted small">—</span>}
            </div>
            <div>
              <h4>Active binding</h4>
              {detail.activeBinding ? (
                <div>
                  <code className="mono small">{detail.activeBinding.releaseKey}</code>
                  <div className="muted small">
                    {detail.activeBinding.status} · v{String(detail.activeBinding.version)}
                  </div>
                </div>
              ) : <div className="muted small">No active binding.</div>}
            </div>
            <div>
              <h4>Lifecycle</h4>
              {Object.keys(detail.lifecycle ?? {}).length > 0 ? (
                <ul className="compact-list">
                  {Object.entries(detail.lifecycle).map(([stage, event]) => (
                    <li key={stage}>
                      <span className="strong">{stage}</span>
                      {event ? (
                        <>
                          <StatusBadge value={(event as { status?: string }).status ?? 'unknown'} />
                          {(event as { occurredAt?: number }).occurredAt != null && (
                            <span className="muted small">{formatRelative((event as { occurredAt: number }).occurredAt)}</span>
                          )}
                          {(event as { failureCategory?: string }).failureCategory && (
                            <span className="badge badge-warning">{(event as { failureCategory: string }).failureCategory}</span>
                          )}
                        </>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : <div className="muted small">No lifecycle data.</div>}
            </div>
            <div>
              <h4>Binding history</h4>
              {detail.bindingHistory && detail.bindingHistory.length > 0 ? (
                <ul className="compact-list">
                  {detail.bindingHistory.map((b) => (
                    <li key={b.id}>
                      <code className="mono small">{b.releaseKey}</code>
                      <StatusBadge value={b.status} />
                      <span className="muted small">v{String(b.version)}</span>
                      {b.failureCategory && <span className="badge badge-warning">{b.failureCategory}</span>}
                    </li>
                  ))}
                </ul>
              ) : <div className="muted small">No bindings.</div>}
            </div>
            {detail.providerObservations && detail.providerObservations.length > 0 && (
              <div>
                <h4>Provider observations</h4>
                <ul className="compact-list">
                  {detail.providerObservations.map((o, i) => (
                    <li key={`${o.provider}-${i}`}>
                      <span className="strong">{o.provider}</span>
                      <StatusBadge value={o.state} />
                      <span className="muted small">{formatRelative(o.observedAt)}</span>
                      {o.errorCategory && <span className="badge badge-warning">{o.errorCategory}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}
