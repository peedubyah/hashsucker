import { useState, useCallback } from 'react';
import { searchTitles, searchReleases, getMedia, getControlPlaneItems } from '@api/client';
import type {
  TitleSearchResult,
  ReleaseSearchResult,
  MediaLookupResult,
  TitleResult,
  ControlPlaneItemList,
} from '@/types/api';

export interface SearchState {
  titles: TitleResult[] | null;
  releases: ReleaseSearchResult | null;
  media: MediaLookupResult | null;
  controlPlaneItems: ControlPlaneItemList | null;
  controlPlaneError: string | null;
  loading: boolean;
  error: string | null;
}

export function useSearch() {
  const [state, setState] = useState<SearchState>({
    titles: null,
    releases: null,
    media: null,
    controlPlaneItems: null,
    controlPlaneError: null,
    loading: false,
    error: null,
  });

  const search = useCallback(async (query: string) => {
    setState(s => ({
      ...s, loading: true, error: null, releases: null, media: null,
      controlPlaneItems: null, controlPlaneError: null,
    }));
    try {
      const result: TitleSearchResult = await searchTitles(query);
      setState(s => ({ ...s, titles: result.results, loading: false }));
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  const selectMedia = useCallback(async (result: TitleResult) => {
    const { id, type } = result;
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const [releases, media, controlPlaneResult] = await Promise.all([
        searchReleases(type, id),
        getMedia(type, id),
        getControlPlaneItems(id)
          .then((items: ControlPlaneItemList) => ({ items, error: null }))
          .catch((failure: Error) => ({ items: null, error: failure.message })),
      ]);
      setState(s => ({
        ...s,
        releases,
        media,
        controlPlaneItems: controlPlaneResult.items,
        controlPlaneError: controlPlaneResult.error,
        loading: false,
      }));
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  const reset = useCallback(() => {
    setState({
      titles: null, releases: null, media: null,
      controlPlaneItems: null, controlPlaneError: null,
      loading: false, error: null,
    });
  }, []);

  return { ...state, search, selectMedia, reset };
}
