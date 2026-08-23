import type { OperatorLogs as OperatorLogsType } from '@/types/api';
import { Badge } from '@/components/Badge';

interface Props {
  logs: OperatorLogsType | null;
  loading: boolean;
  onLoad: (limit?: number) => void;
}

export function OperatorLogs({ logs, loading, onLoad }: Props) {
  return (
    <div className="operator-logs">
      <div className="operator-logs-header">
        <h2>Worker Activity</h2>
        <div className="operator-logs-controls">
          <button className="btn btn-secondary" onClick={() => onLoad(25)}>Last 25</button>
          <button className="btn btn-secondary" onClick={() => onLoad(50)}>Last 50</button>
          <button className="btn btn-secondary" onClick={() => onLoad(100)}>Last 100</button>
        </div>
      </div>

      {loading && <div className="operator-loading">Loading...</div>}

      {logs && (
        <div className="log-entries">
          {logs.logs.map((entry, i) => (
            <div key={i} className={`log-entry ${entry.status}`}>
              <span className="log-timestamp">
                {entry.updatedAt?.slice(11, 19) || '--:--:--'}
              </span>
              <span className="log-status">
                <Badge variant={entry.status === 'failed' ? 'error' : 'info'}>
                  {entry.status}
                </Badge>
              </span>
              <span className="log-request mono">{entry.requestId.slice(0, 12)}</span>
              <span className="log-error">{entry.lastError || '-'}</span>
            </div>
          ))}

          {logs.logs.length === 0 && (
            <div className="operator-empty">No recent activity.</div>
          )}
        </div>
      )}
    </div>
  );
}
