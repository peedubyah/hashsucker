import type { OperatorRequestList as OperatorRequestListType, OperatorRequestItem } from '@/types/api';
import { Badge } from '@/components/Badge';

interface Props {
  requests: OperatorRequestListType | null;
  onSelect: (requestId: string) => void;
  onFilter: (filter: string) => void;
}

export function OperatorRequestList({ requests, onSelect, onFilter }: Props) {
  if (!requests) {
    return <div className="operator-empty">No requests loaded.</div>;
  }

  return (
    <div className="operator-requests">
      <div className="operator-requests-header">
        <h2>Requests</h2>
        <div className="operator-filter-bar">
          {['all', 'queued', 'processing', 'failed', 'done'].map(f => (
            <button
              key={f}
              className="operator-filter-btn"
              onClick={() => onFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <table className="data-table operator-request-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Media</th>
            <th>State</th>
            <th>Age</th>
            <th>Provider</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {requests.requests.map(req => (
            <RequestRow key={req.requestId} request={req} onSelect={onSelect} />
          ))}
        </tbody>
      </table>

      {requests.requests.length === 0 && (
        <div className="operator-empty">No requests match filter.</div>
      )}
    </div>
  );
}

function RequestRow({ request, onSelect }: { request: OperatorRequestItem; onSelect: (id: string) => void }) {
  const age = request.createdAt ? formatAge(request.createdAt) : '-';

  return (
    <tr className="clickable" onClick={() => onSelect(request.requestId)}>
      <td className="mono">{request.requestId.slice(0, 8)}...</td>
      <td>{request.mediaTitle || request.mediaId || '-'}</td>
      <td>
        <Badge variant={statusVariant(request.status)}>{request.status}</Badge>
      </td>
      <td>{age}</td>
      <td>{request.provider || '-'}</td>
      <td className="error-cell">{request.lastError || '-'}</td>
    </tr>
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

function formatAge(createdAt: string): string {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const diff = now - created;

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}
