/**
 * Appliance UI data client. Thin fetch wrappers over product endpoints —
 * no business logic, no state reconstruction. Shared shape lets a future
 * TUI consume the same operator API.
 */

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

export interface HealthReady {
  status: string;
  checks?: Record<string, { status?: string; detail?: string }>;
}

export interface Diagnostics {
  status: string;
  warnings?: string[];
  storage?: { discoveryDb?: { state?: string }; controlDb?: { state?: string } };
  dataPlane?: { state?: string; detail?: string } | string;
  providers?: {
    torbox?: { state?: string; detail?: string };
    realdebrid?: { state?: string; detail?: string };
  };
  consumers?: {
    plex?: { state?: string; detail?: string; endpoint?: string };
    jellyfin?: { state?: string; detail?: string; endpoint?: string };
  };
  publication?: {
    vfs?: { state?: string; detail?: string; movies?: number; episodes?: number };
    strm?: { state?: string };
  };
  corpus?: { state?: string; usable?: boolean; candidates?: number };
  arr?: {
    radarr?: { configured?: boolean; state?: string };
    sonarr?: { configured?: boolean; state?: string };
  };
}

export type RequestIntent = 'library' | 'watch' | 'immediate';

export interface MediaSearchResult {
  id: string;
  type: 'movie' | 'series';
  title: string;
  year?: number | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  overview?: string | null;
}

export interface RequestItem {
  id: string;
  mediaId?: string | null;
  mediaType?: string | null;
  season?: number | null;
  episode?: number | null;
  title?: string | null;
  year?: number | null;
  posterUrl?: string | null;
  stage: string;
  intentLabel: string;
  qualityProfile?: string | null;
  message: string;
  createdAt?: number | null;
}

export interface ActivityItem {
  kind: 'request' | 'download';
  id: string;
  mediaId?: string | null;
  mediaType?: string | null;
  season?: number | null;
  episode?: number | null;
  state?: string | null;
  headline?: string | null;
  qualityProfile?: string | null;
  at?: number | null;
}

export interface LibraryItem {
  mediaId: string;
  mediaType: string;
  season?: number | null;
  episode?: number | null;
  title?: string | null;
  year?: number | null;
  state?: string | null;
  publicationMode?: string | null;
  qualityProfile?: string | null;
  intent?: string | null;
  upgradePolicy?: string | null;
  canonicalPath?: string | null;
  torrentFileId?: string | null;
  size?: number | null;
  hasServingCoordinates?: boolean;
  hasActiveBinding?: boolean;
}

export interface QualityInfo {
  torrentFileId: string;
  found: boolean;
  resolution?: string | null;
  source?: string | null;
  tier?: number | null;
  label?: string | null;
  size?: number | null;
}

export interface DownloadItem {
  downloadRequestId: string;
  mediaId: string;
  mediaType: string;
  season?: number | null;
  episode?: number | null;
  title?: string | null;
  year?: number | null;
  state: string;
  qualityProfile?: string | null;
  expectedSize?: number | null;
  bytesComplete?: number | null;
  filePresent?: boolean | null;
  headline?: string | null;
  detail?: string | null;
  retryPending?: boolean;
  attempts?: number;
  nextDueAt?: number | null;
  handoffState?: string;
  handoffVersion?: number;
  cleanupDueAt?: number | null;
  cleanupDoneAt?: number | null;
}

export interface FailedEvent {
  requestId?: string;
  mediaId?: string | null;
  error?: string | null;
  at?: number | null;
}

export const fetchHealth = () => get<{ status: string }>('/health');
export const fetchReady = () => get<HealthReady>('/health/ready');
export const fetchTitleSearch = (query: string) =>
  get<{ results: MediaSearchResult[]; errors?: unknown[] }>(`/api/search?q=${encodeURIComponent(query)}`);
export const fetchRequests = (limit = 50) =>
  get<{ items: RequestItem[] }>(`/api/operator/media-requests?limit=${limit}`);
export const submitMediaRequest = (body: Record<string, unknown>) =>
  post<{ requestId?: number | string; intent?: RequestIntent; handoff?: unknown }>('/api/media-request', body);
export const submitDownloadRequest = (body: Record<string, unknown>) =>
  post<{ downloadRequestId?: string; state?: string }>('/api/download-request', { ...body, intent: 'download' });
export const fetchDiagnostics = () => get<Diagnostics>('/api/diagnostics');
export const fetchActivity = (limit = 30) =>
  get<{ items: ActivityItem[] }>(`/api/operator/activity?limit=${limit}`);
export const fetchLibrary = (limit = 100) =>
  get<{ items: LibraryItem[] }>(`/api/library?limit=${limit}`);
export const fetchQuality = (tfs: string[]) =>
  get<{ items: QualityInfo[] }>(`/api/operator/quality?tfs=${tfs.join(',')}`);
export const fetchDownloads = (limit = 50) =>
  get<{ items: DownloadItem[] }>(`/api/operator/downloads?limit=${limit}`);
export const fetchFailedEvents = (limit = 10) =>
  get<{ runs: FailedEvent[] }>(`/api/operator/events/failed?limit=${limit}`);
export const fetchWorkers = () => get<unknown>('/api/operator/workers');

export const retryDownload = (d: Pick<DownloadItem, 'mediaId' | 'mediaType' | 'season' | 'episode' | 'title' | 'year'>) =>
  post<{ downloadRequestId: string; state: string }>('/api/download-request', {
    mediaId: d.mediaId,
    mediaType: d.mediaType === 'episode' ? 'episode' : 'movie',
    ...(d.season != null ? { season: d.season } : {}),
    ...(d.episode != null ? { episode: d.episode } : {}),
    ...(d.title ? { title: d.title } : {}),
    ...(d.year ? { year: d.year } : {}),
  });

export const setLibraryProfile = (args: {
  mediaId: string;
  mediaType: string;
  season?: number | null;
  episode?: number | null;
  qualityProfile: string;
}) => post<{ qualityProfile: string; fannedOut?: number }>('/api/library/profile', args);

export const setLibraryIntent = (args: {
  mediaId: string;
  mediaType: string;
  season?: number | null;
  episode?: number | null;
  intent: 'library' | 'watch' | 'immediate';
}) => post<{ intent: string; unchanged?: boolean }>('/api/library/intent', args);

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)} KB`;
  return `${n} B`;
}

export function mediaLabel(i: {
  title?: string | null;
  mediaId?: string | null;
  mediaType?: string | null;
  season?: number | null;
  episode?: number | null;
  year?: number | null;
  episodeTitle?: string | null;
}): string {
  const base = i.title || i.mediaId || 'Unknown';
  const y = i.year ? ` (${i.year})` : '';
  if (i.mediaType === 'episode' && i.season != null && i.episode != null) {
    return `${base}${y} S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}${i.episodeTitle ? ` — ${i.episodeTitle}` : ''}`;
  }
  return `${base}${y}`;
}
