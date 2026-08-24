/// <reference types="vite/client" />

declare module '@api/client' {
  export function searchTitles(query: string): Promise<import('@/types/api').TitleSearchResult>;
  export function searchReleases(type: string, mediaId: string): Promise<import('@/types/api').ReleaseSearchResult>;
  export function getMedia(type: string, id: string): Promise<import('@/types/api').MediaLookupResult>;
  export function submitRequest(request: {
    type: import('@/types/api').SearchIntent['streamType'];
    mediaId: string;
    release: import('@/types/api').ReleaseResult;
    handlingMode?: 'download' | 'stream';
  }): Promise<import('@/types/api').RequestSubmissionResult>;
  export function getRequestStatus(requestId: string): Promise<import('@/types/api').RequestStatusResult>;
  export async function livenessCheck(): Promise<{ status: string; uptime: number }>;
  export async function readinessCheck(): Promise<{ status: string; checks: Record<string, unknown> }>;
  export async function getRequestDebug(requestId: string): Promise<import('@/types/api').OperatorRequestDetail>;
  export async function searchDmmCorpus(query: string, limit?: number, offset?: number): Promise<import('@/types/api').ReleaseSearchResult>;
  export async function operatorLogs(limit?: number): Promise<import('@/types/api').OperatorLogs>;
  export async function listOperatorDiagnostics(): Promise<{ available: Array<{ id: string; name: string; description: string }> }>;
  export async function runOperatorDiagnostic(diagId: string): Promise<import('@/types/api').OperatorDiagnosticResult>;
  export async function retryFailedRequest(requestId: string): Promise<{ requestId: string; previousState: string; newState: string }>;
  export async function resetStuckRequest(requestId: string): Promise<{ requestId: string; previousState: string; newState: string }>;
  export async function deleteOrphanedRequest(requestId: string): Promise<{ requestId: string; previousState: string; newState: string }>;
  export async function getRequestHealth(): Promise<{
    orphaned: Array<{ requestId: string; state: string; reason: string; action: string }>;
    stuck: Array<{ requestId: string; state: string; reason: string; action: string }>;
    invalid: Array<{ requestId: string; state: string; reason: string; action: string }>;
    healthyCount: number;
  }>;
  export async function inspectAllRequests(): Promise<{
    requests: Array<{
      requestId: string;
      state: string;
      created_at: string;
      updated_at: string;
      last_event: string;
      queue_location: string;
      failure_reason: string | null;
      retry_count: number;
      timeline: Array<{ label: string; timestamp: string; status: string }>;
    }>;
    recommendations: Array<{
      type: string;
      severity: string;
      requestId?: string;
      reason: string;
      suggestion: string;
    }>;
    summary: {
      total: number;
      queued: number;
      processing: number;
      done: number;
      failed: number;
      recommendations: number;
    };
  }>;
  export async function inspectRequest(requestId: string): Promise<{ request: {
    requestId: string;
    state: string;
    created_at: string;
    updated_at: string;
    last_event: string;
    queue_location: string;
    failure_reason: string | null;
    retry_count: number;
    timeline: Array<{ label: string; timestamp: string; status: string }>;
  } }>;
}
