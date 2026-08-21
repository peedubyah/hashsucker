// TypeScript interfaces derived from media-search/src/api/types.js
// Source of truth: media-search/src/api/API_CONTRACT.md

export interface TitleSearchResult {
  results: TitleResult[];
  timings: Timings;
}

export interface TitleResult {
  id: string;
  type: 'movie' | 'series';
  name: string;
  poster: string | null;
  year: string | null;
  description: string | null;
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

export interface ReleaseResult {
  infoHash: string;
  fileIndex: number | null;
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
  media: MediaAssociation[];
  _source: 'corpus' | 'live';
}

export interface ScoreComponents {
  relevance: number;
  quality: number;
  releaseConfidence: number;
  identityConfidence: number;
  providerAvailability: number;
  episodeMatch: number;
}

export interface ProviderObservation {
  cached: boolean | null;
  evidence: string[] | null;
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

export interface MediaResult {
  id: string;
  type: 'movie' | 'series';
  name: string;
  poster: string | null;
  year: string | null;
  description: string | null;
  videos: VideoResult[];
}

export interface VideoResult {
  id: string;
  season: number;
  episode: number;
  title: string;
  released: string | null;
  thumbnail: string | null;
}
