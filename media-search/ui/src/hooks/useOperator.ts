import { useState, useCallback } from 'react';
import {
  listOperatorRequests,
  getOperatorRequest,
  retryOperatorRequest,
  resetOperatorRequest,
  deleteOperatorRequest,
  operatorSearchDebug,
  operatorLogs,
  listOperatorDiagnostics,
  runOperatorDiagnostic,
  operatorHealth,
} from '@api/client';
import type {
  OperatorRequestList,
  OperatorRequestDetail,
  OperatorSearchDebug,
  OperatorLogs,
  OperatorDiagnostic,
  OperatorDiagnosticResult,
  OperatorHealth,
} from '@/types/api';

export interface OperatorState {
  requests: OperatorRequestList | null;
  selectedRequest: OperatorRequestDetail | null;
  searchDebug: OperatorSearchDebug | null;
  logs: OperatorLogs | null;
  diagnostics: OperatorDiagnostic[] | null;
  diagnosticResult: OperatorDiagnosticResult | null;
  health: OperatorHealth | null;
  loading: boolean;
  error: string | null;
}

export function useOperator() {
  const [state, setState] = useState<OperatorState>({
    requests: null,
    selectedRequest: null,
    searchDebug: null,
    logs: null,
    diagnostics: null,
    diagnosticResult: null,
    health: null,
    loading: false,
    error: null,
  });

  const setLoading = (loading: boolean) => setState(s => ({ ...s, loading }));
  const setError = (error: string | null) => setState(s => ({ ...s, error }));

  const loadRequests = useCallback(async (filter = 'all') => {
    setLoading(true);
    setError(null);
    try {
      const result = await listOperatorRequests(filter);
      setState(s => ({ ...s, requests: result, loading: false }));
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  const loadRequestDetail = useCallback(async (requestId: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getOperatorRequest(requestId);
      setState(s => ({ ...s, selectedRequest: result, loading: false }));
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  const retryRequest = useCallback(async (requestId: string) => {
    setLoading(true);
    try {
      await retryOperatorRequest(requestId);
      await loadRequestDetail(requestId);
      await loadRequests();
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, [loadRequestDetail, loadRequests]);

  const resetRequest = useCallback(async (requestId: string) => {
    setLoading(true);
    try {
      await resetOperatorRequest(requestId);
      await loadRequestDetail(requestId);
      await loadRequests();
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, [loadRequestDetail, loadRequests]);

  const deleteRequest = useCallback(async (requestId: string) => {
    setLoading(true);
    try {
      await deleteOperatorRequest(requestId);
      setState(s => ({
        ...s,
        selectedRequest: null,
        loading: false,
      }));
      await loadRequests();
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, [loadRequests]);

  const runSearchDebug = useCallback(async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await operatorSearchDebug(query);
      setState(s => ({ ...s, searchDebug: result, loading: false }));
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  const loadLogs = useCallback(async (limit = 50) => {
    setLoading(true);
    try {
      const result = await operatorLogs(limit);
      setState(s => ({ ...s, logs: result, loading: false }));
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  const loadDiagnostics = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listOperatorDiagnostics();
      setState(s => ({ ...s, diagnostics: result.available, loading: false }));
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  const runDiagnostic = useCallback(async (diagId: string) => {
    setLoading(true);
    try {
      const result = await runOperatorDiagnostic(diagId);
      setState(s => ({ ...s, diagnosticResult: result, loading: false }));
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  const loadHealth = useCallback(async () => {
    setLoading(true);
    try {
      const result = await operatorHealth();
      setState(s => ({ ...s, health: result, loading: false }));
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  const clearSelection = useCallback(() => {
    setState(s => ({ ...s, selectedRequest: null }));
  }, []);

  return {
    ...state,
    loadRequests,
    loadRequestDetail,
    retryRequest,
    resetRequest,
    deleteRequest,
    runSearchDebug,
    loadLogs,
    loadDiagnostics,
    runDiagnostic,
    loadHealth,
    clearSelection,
  };
}
