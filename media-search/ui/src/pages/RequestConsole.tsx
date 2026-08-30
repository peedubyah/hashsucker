import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  inspectAllRequests,
  inspectRequest,
  retryFailedRequest,
  resetStuckRequest,
  deleteOrphanedRequest,
} from '@api/client';
import { readQuery, updateQuery } from '@/lib/url-state';
import {
  CopyValue,
  JsonDetails,
  StatusBadge,
  formatNumber,
  formatRelative,
  formatTimestamp,
} from '@/lib/format';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'queued', label: 'Queued' },
  { value: 'processing', label: 'Processing' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
] as const;
type FilterValue = (typeof FILTERS)[number]['value'];

interface OperatorItem {
  requestId: string;
  status: 'queued' | 'processing' | 'done' | 'failed' | string;
  createdAt: string | null;
  handlingMode: string | null;
  mediaTitle: string | null;
  mediaId: string | null;
  releaseTitle: string | null;
  provider: string | null;
  lastError: string | null;
}

interface OperatorList {
  requests: OperatorItem[];
  total: number;
}

interface OperatorTraceEvent {
  timestamp: string | null;
  label: string;
  status: 'complete' | 'error' | 'active' | 'pending' | string;
}

interface OperatorTrace {
  current: { state: string; owner: string | null; nextAction: string };
  timeline: OperatorTraceEvent[];
}

interface OperatorDetail {
  requestId: string;
  status: string;
  request: Record<string, unknown>;
  trace: OperatorTrace;
}

interface ActionLog {
  requestId: string;
  action: string;
  at: string;
}

/**
 * RequestConsole — the operator view of the request ingress queue.
 *
 * Consumes:
 *   inspectAllRequests({ filter }) → OperatorList
 *   inspectRequest(id)              → OperatorDetail
 *   retryFailedRequest(id)          → { requestId, status, action }
 *   resetStuckRequest(id)           → { requestId, status, action }
 *   deleteOrphanedRequest(id)       → { requestId, action }
 *
 * The console restores filter/selected ID from the URL so refresh and
 * browser back/forward keep operators in the same view.
 */
export function RequestConsole() {
  const initial = readQuery();
  const filter = ((initial.get('filter') as FilterValue | null) ?? 'all') as FilterValue;
  const selectedId = initial.get('id');

  const [list, setList] = useState<OperatorList | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [detail, setDetail] = useState<OperatorDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionLog, setActionLog] = useState<ActionLog[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const reloadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const data = await inspectAllRequests({ filter });
      setList(data);
    } catch (err) {
      setListError((err as Error).message);
    } finally {
      setListLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    reloadList();
  }, [reloadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    inspectRequest(selectedId)
      .then(data => { if (!cancelled) setDetail(data); })
      .catch(err => { if (!cancelled) setDetailError((err as Error).message); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { queued: 0, processing: 0, done: 0, failed: 0 };
    for (const r of list?.requests ?? []) {
      out[r.status] = (out[r.status] ?? 0) + 1;
    }
    return out;
  }, [list]);

  const runAction = useCallback(
    async (kind: 'retry' | 'reset' | 'delete', id: string) => {
      setActionPending(id);
      try {
        if (kind === 'retry') await retryFailedRequest(id);
        if (kind === 'reset') await resetStuckRequest(id);
        if (kind === 'delete') await deleteOrphanedRequest(id);
        setActionLog(prev => [
          { requestId: id, action: kind, at: new Date().toISOString() },
          ...prev,
        ].slice(0, 25));
        await reloadList();
        if (selectedId === id) {
          try {
            setDetail(await inspectRequest(id));
          } catch (err) {
            setDetailError((err as Error).message);
          }
        }
      } catch (err) {
        setListError((err as Error).message);
      } finally {
        setActionPending(null);
        setConfirmDelete(null);
      }
    },
    [reloadList, selectedId]
  );

  const updateUrl = (updates: Record<string, string | null>) => updateQuery(updates);

  const canRetry = (status: string | null) => status === 'failed' || status === 'done';
  const canReset = (status: string | null) => status === 'processing';

  return (
    <div className="request-console">
      <div className="request-console-bar">
        <label className="filter-select compact">
          <span className="filter-label">Filter</span>
          <select
            value={filter}
            onChange={e => updateUrl({ filter: e.target.value === 'all' ? null : e.target.value, id: null })}
          >
            {FILTERS.map(f => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={reloadList} disabled={listLoading}>Refresh</button>
        <span className="muted small">
          Total {formatNumber(list?.total ?? 0)} ·
          Q {counts.queued ?? 0} · P {counts.processing ?? 0} · D {counts.done ?? 0} · F {counts.failed ?? 0}
        </span>
        {actionLog[0] && (
          <span className="muted small">Last action: {actionLog[0].action} {actionLog[0].requestId.slice(0, 8)}</span>
        )}
      </div>

      {listError && <div className="error-state" role="alert"><span>!</span><span>{listError}</span></div>}

      <div className="request-console-grid">
        <aside className="request-console-list">
          {listLoading && <div className="loading-state" role="status"><div className="spinner" /><span>Loading queue…</span></div>}
          {!listLoading && (list?.requests.length ?? 0) === 0 && (
            <div className="empty-state"><span>No requests match the current filter</span></div>
          )}
          <ul>
            {(list?.requests ?? []).map(item => (
              <li key={item.requestId}>
                <button
                  type="button"
                  className={`request-console-row ${selectedId === item.requestId ? 'active' : ''}`}
                  onClick={() => updateUrl({ id: item.requestId === selectedId ? null : item.requestId })}
                  aria-pressed={selectedId === item.requestId}
                >
                  <div className="request-console-row-main">
                    <strong>{item.mediaTitle ?? item.mediaId ?? item.requestId.slice(0, 8)}</strong>
                    <span className="muted small">{item.releaseTitle ?? ''}</span>
                  </div>
                  <div className="request-console-row-meta">
                    <StatusBadge value={item.status} />
                    {item.handlingMode && <span className="muted small">{item.handlingMode}</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="request-console-detail">
          {!selectedId && (
            <div className="empty-state"><span>Select a request to inspect its full trace and payload.</span></div>
          )}
          {selectedId && detailLoading && (
            <div className="loading-state" role="status"><div className="spinner" /><span>Loading request…</span></div>
          )}
          {selectedId && detailError && (
            <div className="error-state" role="alert"><span>!</span><span>{detailError}</span></div>
          )}
          {selectedId && detail && (
            <article className="card">
              <header className="card-row">
                <div>
                  <h3>Request {detail.requestId.slice(0, 8)}</h3>
                  <span className="muted small"><StatusBadge value={detail.status} /></span>
                </div>
                <div className="card-actions">
                  <button
                    type="button"
                    onClick={() => runAction('retry', detail.requestId)}
                    disabled={!canRetry(detail.status) || actionPending === detail.requestId}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={() => runAction('reset', detail.requestId)}
                    disabled={!canReset(detail.status) || actionPending === detail.requestId}
                  >
                    Reset
                  </button>
                  {confirmDelete === detail.requestId ? (
                    <>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => runAction('delete', detail.requestId)}
                        disabled={actionPending === detail.requestId}
                      >
                        Confirm delete
                      </button>
                      <button type="button" className="ghost" onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setConfirmDelete(detail.requestId)}
                      disabled={actionPending === detail.requestId}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </header>

              <dl className="kv">
                <div><dt>requestId</dt><dd><CopyValue value={detail.requestId} /></dd></div>
                <div><dt>status</dt><dd><StatusBadge value={detail.status} /></dd></div>
                <div><dt>created</dt><dd>{formatTimestamp((detail.request as Record<string, unknown>).createdAt as string ?? null)} <span className="muted small">{formatRelative((detail.request as Record<string, unknown>).createdAt as string ?? null)}</span></dd></div>
                <div><dt>mediaId</dt><dd><CopyValue value={((detail.request as Record<string, unknown>).mediaId as string) ?? null} /></dd></div>
                <div><dt>handlingMode</dt><dd><StatusBadge value={String((detail.request as Record<string, unknown>).handlingMode ?? '')} /></dd></div>
                <div><dt>provider</dt><dd>{String((detail.request as Record<string, unknown>).provider ?? '—')}</dd></div>
                {(detail.request as Record<string, unknown>).lastError != null && (
                  <div className="span-2">
                    <dt>lastError</dt>
                    <dd><span className="error-text">{String((detail.request as Record<string, unknown>).lastError)}</span></dd>
                  </div>
                )}
              </dl>

              {detail.trace && (
                <section className="subsection">
                  <h4>Trace</h4>
                  <p className="muted small">
                    current <code>{detail.trace.current?.state}</code> · next <code>{detail.trace.current?.nextAction ?? '—'}</code>
                  </p>
                  <ol className="trace-list">
                    {(detail.trace.timeline ?? []).map((event, idx) => (
                      <li key={`${event.label}-${idx}`}>
                        <StatusBadge value={event.status} />
                        <span>{event.label}</span>
                        <span className="muted small">{formatRelative(event.timestamp ?? null)}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              <JsonDetails value={detail.request} summary="Show raw request payload" />
            </article>
          )}
        </main>
      </div>
    </div>
  );
}
