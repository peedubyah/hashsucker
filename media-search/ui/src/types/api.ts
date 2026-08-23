// TypeScript interfaces derived from media-search/src/api/types.js
// Source of truth: media-search/src/api/API_CONTRACT.md

export interface TitleSearchResult {
  results: TitleResult[];
  requestId: string;
  fromCache: boolean;
  errors?: Array<{ provider: string; error: string }>;
  timings: Timings;
}

export interface TitleResult {
  id: string;
  type: 'movie' | 'series';
  title: string;
  year: number | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  overview: string | null;
}

export interface ReleaseSearchResult {
  intent: SearchIntent;
  results: ReleaseResult[];
  total: number;
  timings: Timings;
  stats: SearchStats;
}

export interface SearchIntent {
  streamType: 'movie' | 'series';
  mediaType: 'movie' | 'tv';
  scope: 'movie' | 'series' | 'episode';
  mediaId: string;
  baseMediaId: string;
  season: number | null;
  episodes: number[];
}

export interface ReleaseIdentity {
  infoHash: string;
  fileIndex: number | null;
  releaseKey: string;
}

export interface ReleaseResult extends ReleaseIdentity {
  title: string;
  filename: string;
  size: number | null;
  resolution: string | null;
  quality: string | null;
  codec: string | null;
  hdr: string | null;
  audio: string | null;
  releaseGroup: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  confidence: number;
  score: number;
  components: ScoreComponents;
  providers: Record<string, ProviderObservation>;
  providerObservations: ProviderObservation[];
  media: MediaAssociation[];
  _source: 'corpus' | 'live' | 'merged' | 'unknown';
}

export type ViewMode = 'user' | 'debug';

export interface ScoreComponents {
  relevance?: number;
  quality?: number;
  releaseConfidence?: number;
  identityConfidence?: number;
  providerAvailability?: number;
  episodeMatch?: number;
}

export interface ProviderObservation {
  provider?: string;
  accountScope?: string;
  scope?: string;
  kind?: 'authoritative' | 'inferred' | 'predicted';
  state?: 'cached' | 'uncached' | 'unknown' | 'error';
  cached: boolean | null;
  observedAt?: number | null;
  expiresAt?: number | null;
  freshness?: 'fresh' | 'stale' | 'unbounded' | 'missing';
  fresh?: boolean | null;
  ageMs?: number | null;
  source?: string;
  evidence?: unknown;
  errorCategory?: string | null;
  retryable?: boolean | null;
  retryAfterMs?: number | null;
}

export type LifecycleMilestone =
  | 'requested' | 'checked' | 'placed' | 'provider-ready' | 'exposed'
  | 'exact-file-mapped' | 'bound' | 'cataloged' | 'playable';

export interface LifecycleStatus {
  status: 'pending' | 'satisfied' | 'degraded' | 'failed' | 'unknown';
  occurredAt: number;
  failureCategory: string | null;
  retryable: boolean | null;
  retryAfterMs: number | null;
  source: string;
  reason: string | null;
}

export interface ControlPlaneItemSummary {
  item: {
    id: string;
    mediaType: 'movie' | 'episode';
    mediaId: string;
    editionKey: string;
    title: string;
    year: number | null;
    season: number | null;
    episode: number | null;
    desiredState: 'present' | 'absent';
  };
  canonicalPath: { id: string; path: string; active: boolean } | null;
  activeBinding: ControlPlaneBinding | null;
  lifecycle: Record<LifecycleMilestone, LifecycleStatus | null>;
}

export interface ControlPlaneBinding {
  id: string;
  releaseKey: string;
  providerFileRef: string;
  version: number;
  status: 'active' | 'superseded' | 'degraded' | 'failed';
  reason: string;
  validFrom: number;
  supersededAt: number | null;
  reconciledAt: number;
  failureCategory: string | null;
}

export interface ControlPlaneItemList {
  generatedAt: number;
  items: ControlPlaneItemSummary[];
}

export interface ControlPlaneItemDetail extends ControlPlaneItemSummary {
  generatedAt: number;
  bindingHistory: ControlPlaneBinding[];
  release: ReleaseIdentity | null;
  providerObservations: ProviderObservation[];
  resources: {
    placements: Array<{ provider: string; accountScope: string; state: string; ownership: string; observedAt: number; expiresAt: number | null; failureCategory: string | null; retryable: boolean | null; dependentBindingCount: number }>;
    files: Array<{ providerFileRef: string; corpusFileIndex: number | null; size: number | null; selected: boolean | null; present: boolean; inventoryObservedAt: number; inventoryExpiresAt: number | null }>;
    mappings: Array<{ releaseKey: string; providerFileRef: string; state: string; method: string; authoritative: boolean; mappedAt: number; failureCategory: string | null }>;
    exposures: Array<{ providerFileRef: string; transport: string; state: string; readOnly: boolean; observedAt: number; expiresAt: number | null; failureCategory: string | null; retryable: boolean | null }>;
  } | null;
  shadowPlan: {
    mode: 'shadow';
    executed: false;
    actions: Array<{ action: string; reason: string; target: string | null; attempt: number | null; notBefore: number | null; retryable: boolean | null }>;
    failures: Array<{ category: string; retryable: boolean }>;
    destructiveActionCount: number;
  } | null;
}

export interface MediaAssociation {
  mediaId: string;
  source: string;
  confidence: number;
  evidence: string[];
  associatedAt: number;
}

export interface SearchStats {
  indexed: number;
  total: number;
}

export interface Timings {
  totalMs: number;
}

export interface MediaLookupResult {
  media: MediaResult;
  timings: Timings;
}

export interface MediaResult extends TitleResult {
  videos?: VideoResult[];
}

export interface RequestSubmissionResult {
  requestId: string;
  status: 'queued';
  release: ReleaseIdentity;
}

export interface RequestStatusResult {
  requestId: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  release: ReleaseIdentity;
}

export interface VideoResult {
  id: string;
  season: number;
  episode: number;
  title: string;
  released: string | null;
  thumbnail: string | null;
}

// Operator dashboard types
export interface OperatorRequestItem {
  requestId: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  createdAt: string | null;
  handlingMode: string | null;
  mediaTitle: string | null;
  mediaId: string | null;
  releaseTitle: string | null;
  provider: string | null;
  lastError: string | null;
}

export interface OperatorRequestList {
  requests: OperatorRequestItem[];
  total: number;
}

export interface OperatorTraceEvent {
  timestamp: string | null;
  label: string;
  status: 'complete' | 'error' | 'active' | 'pending';
}

export interface OperatorTrace {
  current: {
    state: string;
    owner: string | null;
    nextAction: string;
  };
  timeline: OperatorTraceEvent[];
}

export interface OperatorRequestDetail {
  requestId: string;
  status: string;
  request: Record<string, unknown>;
  trace: OperatorTrace;
}

export interface OperatorSearchDebugResult {
  title: string;
  score: number;
  components?: ScoreComponents;
  source: string;
}

export interface OperatorSearchDebug {
  query: string;
  total: number;
  results: OperatorSearchDebugResult[];
}

export interface OperatorLogEntry {
  requestId: string;
  status: string;
  lastError: string | null;
  updatedAt: string | null;
}

export interface OperatorLogs {
  logs: OperatorLogEntry[];
}

export interface OperatorDiagnostic {
  id: string;
  name: string;
  description: string;
}

export interface OperatorDiagnosticResult {
  id: string;
  name: string;
  status: 'pass' | 'fail';
  exitCode: number;
  duration: number;
  stdout: string;
  stderr: string;
  ranAt: string;
}

export interface OperatorHealth {
  ok: boolean;
  warning?: boolean;
  checks: {
    database: { name: string; status: string; detail: string; byState?: Record<string, number> };
    worker: { name: string; status: string; detail: string };
    storage: { name: string; status: string; detail: string };
  };
  generatedAt: string;
}
