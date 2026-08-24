import { useState, useCallback } from 'react';
import {
  inspectAllRequests,
  inspectRequest,
  retryFailedRequest,
  resetStuckRequest,
  deleteOrphanedRequest,
} from '@api/client';

interface TimelineEvent {
  label: string;
  timestamp: string;
  status: 'complete' | 'failed' | 'pending';
}

interface Request {
  requestId: string;
  state: string;
  created_at: string;
  updated_at: string;
  last_event: string;
  queue_location: string;
  failure_reason: string | null;
  retry_count: number;
  timeline: TimelineEvent[];
}

interface Recommendation {
  type: string;
  severity: string;
  requestId?: string;
  library_item_id?: string;
  reason: string;
  suggestion: string;
}

interface InspectionResult {
  requests: Request[];
  recommendations: Recommendation[];
  summary: {
    total: number;
    queued: number;
    processing: number;
    done: number;
    failed: number;
    recommendations: number;
  };
}

interface ActionLog {
  requestId: string;
  action: string;
  previousState: string;
  newState: string;
}

export function RequestConsole() {
  const [result, setResult] = useState<InspectionResult | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<Request | null>(null);
  const [loading, setLoading] = useState(false);
  const [actions, setActions] = useState<ActionLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchId, setSearchId] = useState('');

  const loadInspection = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelectedRequest(null);
    try {
      const data = await inspectAllRequests();
      const mapped: InspectionResult = {
        ...data,
        requests: data.requests.map(r => ({
          ...r,
          timeline: r.timeline.map(e => ({
            ...e,
            status: (e.status as string) === 'complete' ? 'complete' as const
              : (e.status as string) === 'failed' ? 'failed' as const
              : 'pending' as const,
          })),
        })),
      };
      setResult(mapped);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = useCallback(async () => {
    if (!searchId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await inspectRequest(searchId.trim());
      const mapped: Request = {
        ...data.request,
        timeline: data.request.timeline.map(e => ({
          ...e,
          status: (e.status as string) === 'complete' ? 'complete' as const
            : (e.status as string) === 'failed' ? 'failed' as const
            : 'pending' as const,
        })),
      };
      setSelectedRequest(mapped);
    } catch (err) {
      setError((err as Error).message);
      setSelectedRequest(null);
    } finally {
      setLoading(false);
    }
  }, [searchId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleRetry = useCallback(async (requestId: string) => {
    setError(null);
    try {
      const res = await retryFailedRequest(requestId);
      setActions(prev => [{ ...res, action: 'retry' }, ...prev].slice(0, 50));
      await loadInspection();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadInspection]);

  const handleReset = useCallback(async (requestId: string) => {
    setError(null);
    try {
      const res = await resetStuckRequest(requestId);
      setActions(prev => [{ ...res, action: 'reset' }, ...prev].slice(0, 50));
      await loadInspection();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadInspection]);

  const handleDelete = useCallback(async (requestId: string) => {
    setError(null);
    try {
      const res = await deleteOrphanedRequest(requestId);
      setActions(prev => [{ ...res, action: 'delete' }, ...prev].slice(0, 50));
      await loadInspection();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadInspection]);

  const getRecommendationForRequest = (requestId: string): Recommendation | undefined => {
    return result?.recommendations.find(r => r.requestId === requestId);
  };

  const formatDate = (dateStr: string | undefined): string => {
    if (!dateStr) return '—';
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  };

  const formatAge = (ms: number): string => {
    if (ms < 0) ms = 0;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  };

  const getAge = (request: Request): string => {
    const lastUpdate = request.updated_at || request.created_at;
    if (!lastUpdate) return 'unknown';
    return formatAge(Date.now() - new Date(lastUpdate).getTime());
  };

  return (
    <div className="request-console">
      <div className="request-console-header">
        <input
          className="console-input"
          type="text"
          placeholder="Request ID (e.g., d80a9153-...)"
          value={searchId}
          onChange={e => setSearchId(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          className="console-btn"
          onClick={handleSearch}
          disabled={loading || !searchId.trim()}
        >
          Inspect
        </button>
        <button
          className="console-btn"
          onClick={loadInspection}
          disabled={loading}
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="request-console-error">
          Error: {error}
        </div>
      )}

      {!result && !selectedRequest && !loading && !error && (
        <div className="request-console-empty">
          Enter a request ID to inspect, or click Refresh to load all requests
        </div>
      )}

      {selectedRequest && (
        <RequestDetail
          request={selectedRequest}
          recommendation={getRecommendationForRequest(selectedRequest.requestId)}
          onRetry={handleRetry}
          onReset={handleReset}
          onDelete={handleDelete}
          formatDate={formatDate}
        />
      )}

      {result && !selectedRequest && (
        <div className="request-console-content">
          <pre className="request-console-text">
{`REQUEST HEALTH
==============
Total: ${result.summary.total} | Queued: ${result.summary.queued} | Processing: ${result.summary.processing} | Done: ${result.summary.done} | Failed: ${result.summary.failed}

Failed:${result.requests.filter(r => r.state === 'failed').length === 0 ? ' (none)' : ''}
${result.requests
  .filter(r => r.state === 'failed')
  .map(r => `- ${r.requestId.slice(0, 8)}... ${r.failure_reason || 'unknown failure'} [${getAge(r)} old]`)
  .join('\n')}

Stuck:${result.requests.filter(r => r.state === 'processing').length === 0 ? ' (none)' : ''}
${result.requests
  .filter(r => r.state === 'processing')
  .map(r => `- ${r.requestId.slice(0, 8)}... age: ${getAge(r)} state: ${r.state}`)
  .join('\n')}

Orphaned:${result.requests.filter(r => r.state === 'incoming').length === 0 ? ' (none)' : ''}
${result.requests
  .filter(r => r.state === 'incoming')
  .map(r => `- ${r.requestId.slice(0, 8)}... queued: ${getAge(r)}`)
  .join('\n')}

Recommendations: ${result.recommendations.length}
${result.recommendations
  .map(r => `- [${r.severity}] ${r.type}: ${r.suggestion} (${r.reason})`)
  .join('\n')}`}
          </pre>

          {result.requests.length > 0 && (
            <div className="request-console-actions">
              <div className="request-console-actions-title">Actions:</div>
              {result.requests.map(request => {
                const rec = getRecommendationForRequest(request.requestId);
                if (!rec) return null;
                return (
                  <div key={request.requestId} className="request-console-action-row">
                    <span className="request-console-action-id">{request.requestId.slice(0, 8)}...</span>
                    <button
                      className="console-btn console-btn-mini"
                      onClick={() => setSelectedRequest(request)}
                    >
                      [View]
                    </button>
                    {rec.suggestion === 'retry' && request.state === 'failed' && (
                      <button
                        className="console-btn console-btn-mini"
                        onClick={() => handleRetry(request.requestId)}
                      >
                        [Retry]
                      </button>
                    )}
                    {rec.suggestion === 'reset or delete request' && request.state === 'processing' && (
                      <button
                        className="console-btn console-btn-mini"
                        onClick={() => handleReset(request.requestId)}
                      >
                        [Reset]
                      </button>
                    )}
                    {(rec.suggestion === 'delete request' || rec.type === 'corrupted-file') && (
                      <button
                        className="console-btn console-btn-mini"
                        onClick={() => handleDelete(request.requestId)}
                      >
                        [Delete]
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {actions.length > 0 && (
            <div className="request-console-log">
              <div className="request-console-log-title">Action Log:</div>
              {actions.map((log, i) => (
                <div key={i} className="request-console-log-entry">
                  {log.requestId.slice(0, 8)}... {log.action}: {log.previousState} → {log.newState}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface RequestDetailProps {
  request: Request;
  recommendation?: Recommendation;
  onRetry: (id: string) => void;
  onReset: (id: string) => void;
  onDelete: (id: string) => void;
  formatDate: (date: string | undefined) => string;
}

function RequestDetail({ request, recommendation, onRetry, onReset, onDelete, formatDate }: RequestDetailProps) {
  const formatAge = (ms: number): string => {
    if (ms < 0) ms = 0;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  };

  const age = Date.now() - new Date(request.created_at || Date.now()).getTime();

  return (
    <div className="request-console-content">
      <pre className="request-console-text">
{`REQUEST ${request.requestId.slice(0, 8)}
${'='.repeat(40)}

State:
${request.state.toUpperCase()}

Created: ${formatDate(request.created_at)}
Updated: ${formatDate(request.updated_at)}
Age: ${formatAge(age)}
Location: ${request.queue_location}
Retries: ${request.retry_count}

Timeline:
${request.timeline.map(e => {
  const icon = e.status === 'complete' ? '✓' : e.status === 'failed' ? '✗' : '○';
  return `${icon} ${e.label} (${formatDate(e.timestamp)})`;
}).join('\n')}${request.timeline.length === 0 ? '  (no events recorded)' : ''}
${request.failure_reason ? `\nFailure:\n${request.failure_reason}\n` : ''}
${recommendation ? `\nSuggested Action:\n${recommendation.suggestion}\n(${recommendation.reason})\n` : ''}`}
      </pre>

      <div className="request-console-actions">
        <div className="request-console-actions-title">Actions:</div>
        <div className="request-console-action-row">
          <span className="request-console-action-id">{request.requestId.slice(0, 8)}...</span>
          {request.state === 'failed' && (
            <button
              className="console-btn console-btn-mini"
              onClick={() => onRetry(request.requestId)}
            >
              [Retry]
            </button>
          )}
          {request.state === 'processing' && (
            <button
              className="console-btn console-btn-mini"
              onClick={() => onReset(request.requestId)}
            >
              [Reset]
            </button>
          )}
          <button
            className="console-btn console-btn-mini"
            onClick={() => onDelete(request.requestId)}
          >
            [Delete]
          </button>
        </div>
      </div>
    </div>
  );
}
