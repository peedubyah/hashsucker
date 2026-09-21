import { useCallback, useState } from 'react';
import { fetchDownloads, retryDownload, formatBytes, mediaLabel, type DownloadItem } from '@/api';
import { usePoll } from '@/lib/use-poll';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState } from '@/components/common';

function stateTone(state: string): string {
  if (state === 'staged') return 'success';
  if (state === 'failed') return 'bad';
  if (['requested', 'resolving', 'materializing'].includes(state)) return 'info';
  return 'default';
}

function describe(d: DownloadItem): string {
  if (d.state === 'failed') return d.headline ?? 'Failed';
  if (d.state === 'staged') {
    if (d.handoffState === 'completed') {
      return d.cleanupDoneAt ? 'Imported — staged copy cleaned up' : 'Imported — staged copy will be cleaned up';
    }
    if (d.handoffState === 'failed') return 'Importer reported failure — staged copy kept';
    if (d.handoffState && d.handoffState !== 'none') return `With importer (${d.handoffState})`;
    if (d.filePresent === false) return 'Staged file moved — will re-stage on next request';
    return 'Staged, waiting for importer';
  }
  if (d.state === 'materializing' && d.expectedSize) {
    return `Downloading — ${formatBytes(d.bytesComplete ?? 0)} of ${formatBytes(d.expectedSize)}`;
  }
  return d.headline ?? d.state;
}

export function DownloadsPage() {
  const [data, error, refresh] = usePoll(useCallback(() => fetchDownloads(50), []), 15_000);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const retry = async (d: DownloadItem) => {
    setActing(d.downloadRequestId);
    setNotice(null);
    try {
      await retryDownload(d);
      setNotice(`Retry queued for ${mediaLabel(d)}.`);
      void refresh();
    } catch (err) {
      setNotice(`Retry failed: ${(err as Error).message}`);
    } finally {
      setActing(null);
    }
  };

  if (!data && !error) return <LoadingState label="Loading downloads…" />;
  if (error && !data) return <ErrorState message={error} onRetry={() => void refresh()} />;

  const items = data?.items ?? [];
  return (
    <div className="page">
      <PageHeader
        title="Downloads"
        subtitle="Staged files for external importers. HashSucker cleans up after a confirmed import."
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>Refresh</button>}
      />
      {notice && <Section dense><div className="muted small" role="status">{notice}</div></Section>}
      <Section dense>
        {items.length === 0 ? (
          <EmptyState title="No downloads" detail="Requestrr download intents will appear here as they resolve, stage, and hand off." />
        ) : (
          <ul className="card-list">
            {items.map((d) => (
              <li key={d.downloadRequestId} className="media-card">
                <div className="media-card-main">
                  <div className="media-name">{mediaLabel(d)}</div>
                  <div className="media-sub muted small">{describe(d)}</div>
                  <div className="tag-row">
                    <span className={`badge badge-${stateTone(d.state)}`}>{d.state}</span>
                    <span className="badge badge-default">{d.qualityProfile ?? 'balanced'}</span>
                    {d.retryPending && <span className="badge badge-info">Retry scheduled</span>}
                  </div>
                  {expanded === d.downloadRequestId && (
                    <div className="activity-detail muted small">
                      handoff {d.handoffState ?? 'none'}
                      {d.attempts ? ` · attempts ${d.attempts}` : ''}
                      {d.expectedSize ? ` · ${formatBytes(d.expectedSize)}` : ''}
                      {d.detail ? ` · ${d.detail}` : ''}
                    </div>
                  )}
                </div>
                <div className="card-actions">
                  <button type="button" className="btn btn-secondary btn-sm"
                    onClick={() => setExpanded((p) => (p === d.downloadRequestId ? null : d.downloadRequestId))}>
                    {expanded === d.downloadRequestId ? 'Less' : 'Details'}
                  </button>
                  {d.state === 'failed' && !d.retryPending && (
                    <button type="button" className="btn btn-primary btn-sm" disabled={acting === d.downloadRequestId}
                      onClick={() => void retry(d)}>
                      {acting === d.downloadRequestId ? 'Retrying…' : 'Retry'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
