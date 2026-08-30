import { useState, useEffect, useRef } from 'react';
import {
  livenessCheck,
  readinessCheck,
  getRequestDebug,
  operatorLogs,
  runOperatorDiagnostic,
  listOperatorDiagnostics,
} from '@api/client';
import { RequestConsole } from './RequestConsole';

interface DiagnosticItem {
  id: string;
  name: string;
  description: string;
}

type OutputSource = 'health' | 'logs' | 'trace' | 'diagnostics' | 'requests';

interface OutputLine {
  text: string;
  timestamp: string;
}

const SOURCES: { id: OutputSource; label: string }[] = [
  { id: 'health', label: 'System Health' },
  { id: 'logs', label: 'Worker Logs' },
  { id: 'trace', label: 'Request Trace' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'requests', label: 'Request Console' },
];

export function DebugConsole() {
  const [source, setSource] = useState<OutputSource>('health');
  const [output, setOutput] = useState<OutputLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [traceId, setTraceId] = useState('');
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [selectedDiag, setSelectedDiag] = useState<string>('');
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  useEffect(() => {
    if (source === 'diagnostics') {
      loadDiagnostics();
    } else if (source === 'trace' || source === 'requests') {
      setOutput([]);
    } else {
      handleRefresh();
    }
  }, [source]);

  const loadDiagnostics = async () => {
    setLoading(true);
    setOutput([]);
    const ts = new Date().toISOString();
    try {
      const result = await listOperatorDiagnostics();
      setDiagnostics(result.available);
      if (result.available.length > 0) {
        setSelectedDiag(result.available[0].id);
      }
      setOutput([{
        text: `[${ts}] Loaded ${result.available.length} diagnostics`,
        timestamp: ts,
      }]);
    } catch (err) {
      setOutput([{ text: `Error: ${(err as Error).message}`, timestamp: ts }]);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setLoading(true);
    setOutput([]);
    const ts = new Date().toISOString();
    try {
      let result: unknown;

      switch (source) {
        case 'health': {
          const [live, ready] = await Promise.all([
            livenessCheck(),
            readinessCheck(),
          ]);
          result = {
            'GET /health': live,
            'GET /health/ready': ready,
          };
          break;
        }
        case 'logs': {
          result = await operatorLogs(50);
          break;
        }
        case 'trace': {
          if (!traceId.trim()) {
            setOutput([{ text: 'Error: enter a request ID to trace.', timestamp: ts }]);
            setLoading(false);
            return;
          }
          result = await getRequestDebug(traceId.trim());
          break;
        }
        default:
          return;
      }

      setOutput([{ text: JSON.stringify(result, null, 2), timestamp: ts }]);
    } catch (err) {
      setOutput([{ text: `Error: ${(err as Error).message}`, timestamp: ts }]);
    } finally {
      setLoading(false);
    }
  };

  const handleRun = async () => {
    if (source !== 'diagnostics' || !selectedDiag) return;

    setLoading(true);
    const ts = new Date().toISOString();
    try {
      const result = await runOperatorDiagnostic(selectedDiag);
      const text = [
        `--- Diagnostic: ${selectedDiag} ---`,
        `Status: ${result.status}`,
        `Duration: ${result.duration}ms`,
        ``,
        `stdout:`,
        result.stdout,
        `stderr:`,
        result.stderr,
        `--- End ---`,
      ].join('\n');
      setOutput(prev => [...prev, { text, timestamp: ts }]);
    } catch (err) {
      setOutput(prev => [...prev, { text: `Error: ${(err as Error).message}`, timestamp: ts }]);
    } finally {
      setLoading(false);
    }
  };

  const handleInspect = () => {
    if (source === 'trace' && traceId.trim()) {
      handleRefresh();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleInspect();
    }
  };

  const isDiagnostics = source === 'diagnostics';
  const isTrace = source === 'trace';
  const isRequests = source === 'requests';
  const canRun = !loading && (!isDiagnostics || (isDiagnostics && selectedDiag));
  const canInspect = isTrace && !!traceId.trim() && !loading;

  if (isRequests) {
    return <RequestConsole />;
  }

  return (
    <div className="console-shell">
      <div className="console-toolbar">
        <select
          className="console-select"
          value={source}
          onChange={e => setSource(e.target.value as OutputSource)}
        >
          {SOURCES.map(s => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>

        {isTrace && (
          <input
            className="console-input"
            type="text"
            placeholder="Request ID"
            value={traceId}
            onChange={e => setTraceId(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        )}

        {isDiagnostics && (
          <select
            className="console-select"
            value={selectedDiag}
            onChange={e => setSelectedDiag(e.target.value)}
          >
            {diagnostics.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        )}

        {isTrace && (
          <button
            className="console-btn console-btn-run"
            onClick={handleInspect}
            disabled={!canInspect}
          >
            Inspect
          </button>
        )}

        {!isTrace && (
          <button
            className="console-btn"
            onClick={isDiagnostics ? loadDiagnostics : handleRefresh}
            disabled={loading}
          >
            Refresh
          </button>
        )}

        {isDiagnostics && (
          <button
            className="console-btn console-btn-run"
            onClick={handleRun}
            disabled={!canRun}
          >
            Run
          </button>
        )}
      </div>

      <div className="console-output" ref={outputRef}>
        {output.length === 0 && !loading && (
          <div className="console-empty">No data</div>
        )}
        {output.map((line, i) => (
          <div key={i} className="console-line">
            <span className="console-ts">{new Date(line.timestamp).toLocaleTimeString()}</span>
            <pre className="console-text">{line.text}</pre>
          </div>
        ))}
        {loading && <div className="console-loading">Loading...</div>}
      </div>
    </div>
  );
}
