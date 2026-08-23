import { useState } from 'react';
import type { OperatorRequestDetail as OperatorRequestDetailType } from '@/types/api';
import { Badge } from '@/components/Badge';

interface Props {
  detail: OperatorRequestDetailType;
  onBack: () => void;
  onRetry: (id: string) => Promise<void>;
  onReset: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function OperatorRequestDetail({ detail, onBack, onRetry, onReset, onDelete }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const { request, trace } = detail;

  const handleCopyDiagnostic = () => {
    const report = [
      `Request: ${detail.requestId}`,
      `Media: ${(request as Record<string, unknown>).mediaTitle || (request as Record<string, unknown>).mediaId}`,
      `Release: ${(request as Record<string, unknown>).releaseTitle || (request as Record<string, unknown>).releaseKey}`,
      `State: ${detail.status}`,
      `Pipeline: ${trace.timeline.map(t => `${t.status === 'complete' ? '✓' : t.status === 'error' ? '✗' : '○'} ${t.label}`).join(', ')}`,
      `Error: ${(request as Record<string, unknown>).lastError || 'none'}`,
      `Timestamp: ${(request as Record<string, unknown>).updatedAt || (request as Record<string, unknown>).updated_at}`,
    ].join('\n');

    navigator.clipboard.writeText(report);
  };

  return (
    <div className="operator-detail">
      <div className="operator-detail-header">
        <button className="operator-back-btn" onClick={onBack}>← Back</button>
        <h2>
          Request <span className="mono">{detail.requestId.slice(0, 12)}...</span>
        </h2>
        <Badge variant={statusVariant(detail.status)}>{detail.status}</Badge>
      </div>

      <section className="operator-section">
        <h3>Current</h3>
        <div className="operator-current">
          <div className="operator-current-item">
            <span className="operator-label">State:</span>
            <span>{trace.current.state}</span>
          </div>
          <div className="operator-current-item">
            <span className="operator-label">Owner:</span>
            <span>{trace.current.owner || '-'}</span>
          </div>
          <div className="operator-current-item">
            <span className="operator-label">Next action:</span>
            <span>{trace.current.nextAction}</span>
          </div>
        </div>
      </section>

      <section className="operator-section">
        <h3>Timeline</h3>
        <div className="operator-timeline">
          {trace.timeline.map((event, i) => (
            <div key={i} className={`timeline-event ${event.status}`}>
              <span className="timeline-timestamp">{event.timestamp?.slice(11, 19) || '--:--:--'}</span>
              <span className="timeline-icon">
                {event.status === 'complete' ? '✓' : event.status === 'error' ? '✗' : event.status === 'active' ? '●' : '○'}
              </span>
              <span className="timeline-label">{event.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="operator-section">
        <h3>Actions</h3>
        <div className="operator-actions">
          {(detail.status === 'failed' || detail.status === 'done') && (
            <button className="btn btn-primary" onClick={() => onRetry(detail.requestId)}>
              Retry Request
            </button>
          )}
          {detail.status !== 'queued' && (
            <button className="btn btn-secondary" onClick={() => onReset(detail.requestId)}>
              Reset to Pending
            </button>
          )}
          {!confirmDelete ? (
            <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
              Remove Request
            </button>
          ) : (
            <button className="btn btn-danger-confirm" onClick={() => onDelete(detail.requestId)}>
              Confirm Delete
            </button>
          )}
          <button className="btn btn-secondary" onClick={handleCopyDiagnostic}>
            Copy Debug Report
          </button>
        </div>
      </section>

      <section className="operator-section">
        <h3>
          <button className="operator-toggle-btn" onClick={() => setShowRaw(!showRaw)}>
            {showRaw ? '▼' : '▶'} Raw Payload
          </button>
        </h3>
        {showRaw && (
          <pre className="operator-raw">
            {JSON.stringify(request, null, 2)}
          </pre>
        )}
      </section>
    </div>
  );
}

function statusVariant(status: string) {
  switch (status) {
    case 'done': return 'success';
    case 'failed': return 'error';
    case 'processing': return 'info';
    case 'queued': return 'warning';
    default: return 'default';
  }
}
