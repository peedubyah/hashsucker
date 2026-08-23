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
}
