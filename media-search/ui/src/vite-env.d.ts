/// <reference types="vite/client" />

declare module '@api/client' {
  export function searchTitles(query: string): Promise<import('@/types/api').TitleSearchResult>;
  export function searchReleases(type: string, mediaId: string): Promise<import('@/types/api').ReleaseSearchResult>;
  export function getMedia(type: string, id: string): Promise<import('@/types/api').MediaLookupResult>;
  export function submitRequest(request: {
    type: import('@/types/api').SearchIntent['streamType'];
    mediaId: string;
    release: {
      infoHash: string;
      fileIndex: number | null;
      releaseKey: string;
    };
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
  export async function inspectAllRequests(opts?: { filter?: string }): Promise<{
    requests: Array<{
      requestId: string;
      status: string;
      createdAt: string | null;
      handlingMode: string | null;
      mediaTitle: string | null;
      mediaId: string | null;
      releaseTitle: string | null;
      provider: string | null;
      lastError: string | null;
    }>;
    total: number;
  }>;
  export async function inspectRequest(requestId: string): Promise<{
    requestId: string;
    status: string;
    request: Record<string, unknown>;
    trace: {
      current: { state: string; owner: string | null; nextAction: string };
      timeline: Array<{ timestamp: string | null; label: string; status: string }>;
    };
  }>;
  // ── 2026-08-30 additions ─────────────────────────────────────────────
  export async function getSearchStats(): Promise<import('@/types/api').SearchStats>;
  export async function listControlPlaneItems(options: { mediaId: string; limit?: number }): Promise<import('@/types/api').ControlPlaneItemList>;
  export async function getControlPlaneItemDetail(itemId: string, release?: { infoHash?: string; fileIndex?: number | null } | null): Promise<import('@/types/api').ControlPlaneItemDetail>;
  export async function getOperatorSearchDebug(query: string): Promise<import('@/types/api').OperatorSearchDebug>;
  export async function getResolverTelemetry(options?: { limit?: number }): Promise<import('@/types/api').ResolverTelemetry>;
  export async function getCacheIntelligence(): Promise<import('@/types/api').CacheIntelligence>;
  export async function getSearchCacheMetrics(): Promise<import('@/types/api').SearchCacheMetrics>;
  export async function getControlPlaneHealth(): Promise<import('@/types/api').ControlPlaneHealth>;
}
