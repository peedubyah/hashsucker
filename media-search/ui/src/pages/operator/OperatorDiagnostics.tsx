import type { OperatorDiagnostic, OperatorDiagnosticResult } from '@/types/api';
import { Badge } from '@/components/Badge';

interface Props {
  diagnostics: OperatorDiagnostic[] | null;
  result: OperatorDiagnosticResult | null;
  loading: boolean;
  onLoad: () => void;
  onRun: (id: string) => void;
}

export function OperatorDiagnostics({ diagnostics, result, loading, onLoad, onRun }: Props) {
  return (
    <div className="operator-diagnostics">
      <div className="operator-diagnostics-header">
        <h2>Diagnostics</h2>
        <button className="btn btn-secondary" onClick={onLoad}>Refresh List</button>
      </div>

      {loading && <div className="operator-loading">Running...</div>}

      {diagnostics && (
        <div className="diagnostic-grid">
          {diagnostics.map(d => (
            <div key={d.id} className="diagnostic-card">
              <div className="diagnostic-card-header">
                <h3>{d.name}</h3>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => onRun(d.id)}
                  disabled={loading}
                >
                  Run
                </button>
              </div>
              <p className="diagnostic-description">{d.description}</p>
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className={`diagnostic-result ${result.status}`}>
          <h3>
            Result: {result.name}{' '}
            <Badge variant={result.status === 'pass' ? 'success' : 'error'}>
              {result.status.toUpperCase()}
            </Badge>
          </h3>
          <div className="diagnostic-meta">
            <span>Duration: {result.duration.toFixed(1)}s</span>
            <span>Exit code: {result.exitCode}</span>
            <span>Ran at: {result.ranAt}</span>
          </div>

          {result.stdout && (
            <details className="diagnostic-output">
              <summary>Output</summary>
              <pre>{result.stdout}</pre>
            </details>
          )}

          {result.stderr && (
            <details className="diagnostic-output">
              <summary>Errors</summary>
              <pre className="error">{result.stderr}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
