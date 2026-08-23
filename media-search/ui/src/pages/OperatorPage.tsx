import { useState, useEffect, useCallback } from 'react';
import { useOperator } from '@/hooks/useOperator';
import { OperatorHealth } from './operator/OperatorHealth';
import { OperatorRequestList } from './operator/OperatorRequestList';
import { OperatorRequestDetail } from './operator/OperatorRequestDetail';
import { OperatorSearchDebug } from './operator/OperatorSearchDebug';
import { OperatorLogs } from './operator/OperatorLogs';
import { OperatorDiagnostics } from './operator/OperatorDiagnostics';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';

type Tab = 'health' | 'requests' | 'search' | 'logs' | 'diagnostics';

interface Props {
  onExit: () => void;
}

export function OperatorPage({ onExit }: Props) {
  const [tab, setTab] = useState<Tab>('health');
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [refreshInterval, setRefreshInterval] = useState<number>(0);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const op = useOperator();

  const refresh = useCallback(() => {
    switch (tab) {
      case 'health':
        op.loadHealth();
        break;
      case 'requests':
        op.loadRequests();
        break;
      case 'logs':
        op.loadLogs();
        break;
      case 'diagnostics':
        op.loadDiagnostics();
        break;
    }
    setLastRefresh(new Date());
  }, [tab, op]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (refreshInterval <= 0) return;
    const id = setInterval(refresh, refreshInterval * 1000);
    return () => clearInterval(id);
  }, [refreshInterval, refresh]);

  useEffect(() => {
    if (selectedRequestId) {
      op.loadRequestDetail(selectedRequestId);
    }
  }, [selectedRequestId, op]);

  const handleSelectRequest = (requestId: string) => {
    setSelectedRequestId(requestId);
    setTab('requests');
  };

  const handleBackFromDetail = () => {
    setSelectedRequestId(null);
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'health', label: 'Health' },
    { id: 'requests', label: 'Requests' },
    { id: 'search', label: 'Discovery' },
    { id: 'logs', label: 'Workers' },
    { id: 'diagnostics', label: 'Diagnostics' },
  ];

  return (
    <div className="page operator-page">
      <header className="operator-header">
        <div className="operator-header-left">
          <button className="operator-exit-btn" onClick={onExit}>← Search</button>
          <h1 className="operator-title">HashSucker Operator</h1>
        </div>
        <nav className="operator-tabs">
          {tabs.map(t => (
            <button
              key={t.id}
              className={`operator-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="operator-header-right">
          <select
            value={refreshInterval}
            onChange={e => setRefreshInterval(Number(e.target.value))}
            className="operator-refresh-select"
          >
            <option value={0}>Manual</option>
            <option value={5}>5s</option>
            <option value={10}>10s</option>
            <option value={30}>30s</option>
          </select>
          <button className="operator-refresh-btn" onClick={refresh}>Refresh</button>
        </div>
      </header>

      {op.loading && <LoadingState message="Loading..." />}
      {op.error && <ErrorState message={op.error} onRetry={refresh} />}

      <main className="operator-content">
        {tab === 'health' && op.health && (
          <OperatorHealth health={op.health} />
        )}

        {tab === 'requests' && !selectedRequestId && (
          <OperatorRequestList
            requests={op.requests}
            onSelect={handleSelectRequest}
            onFilter={op.loadRequests}
          />
        )}

        {tab === 'requests' && selectedRequestId && op.selectedRequest && (
          <OperatorRequestDetail
            detail={op.selectedRequest}
            onBack={handleBackFromDetail}
            onRetry={op.retryRequest}
            onReset={op.resetRequest}
            onDelete={op.deleteRequest}
          />
        )}

        {tab === 'search' && (
          <OperatorSearchDebug
            result={op.searchDebug}
            loading={op.loading}
            onSearch={op.runSearchDebug}
          />
        )}

        {tab === 'logs' && (
          <OperatorLogs
            logs={op.logs}
            loading={op.loading}
            onLoad={op.loadLogs}
          />
        )}

        {tab === 'diagnostics' && (
          <OperatorDiagnostics
            diagnostics={op.diagnostics}
            result={op.diagnosticResult}
            loading={op.loading}
            onLoad={op.loadDiagnostics}
            onRun={op.runDiagnostic}
          />
        )}
      </main>

      <footer className="operator-footer">
        <span>Last refresh: {lastRefresh.toLocaleTimeString()}</span>
        {op.health && (
          <span className={`operator-status ${op.health.ok ? 'ok' : 'error'}`}>
            {op.health.ok ? '✓ System healthy' : '✗ Issues detected'}
          </span>
        )}
      </footer>
    </div>
  );
}
