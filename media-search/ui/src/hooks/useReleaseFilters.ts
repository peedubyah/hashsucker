import { useState, useMemo } from 'react';
import type { ReleaseResult } from '@/types/api';
import type { FilterState } from '@/components/filter.types';
import { initialFilters } from '@/components/filter.types';
import { hasConfirmedCached, hasConfirmedUncached } from '@/utils/providerEvidence';

export type SortKey = 'score' | 'size' | 'resolution' | 'confidence' | 'filename';
export type SortDirection = 'asc' | 'desc';

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

const RESOLUTION_ORDER: Record<string, number> = {
  '2160p': 4,
  '1080p': 3,
  '720p': 2,
  '480p': 1,
};

export const RECOMMENDED_RELEASE_LIMIT = 5;

export function useReleaseFilters(releases: ReleaseResult[]) {
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [sort, setSort] = useState<SortState>({ key: 'score', direction: 'desc' });

  const filtered = useMemo(() => {
    let result = releases;

    if (filters.query) {
      const q = filters.query.toLowerCase();
      result = result.filter(r =>
        r.filename.toLowerCase().includes(q) ||
        (r.releaseGroup?.toLowerCase().includes(q)) ||
        (r.title?.toLowerCase().includes(q))
      );
    }

    if (filters.source !== 'all') {
      result = result.filter(r => r._source === filters.source);
    }

    if (filters.resolution) {
      result = result.filter(r => r.resolution === filters.resolution);
    }

    if (filters.quality) {
      result = result.filter(r => r.quality === filters.quality);
    }

    if (filters.cached !== 'all') {
      result = result.filter(r => filters.cached === 'cached'
        ? hasConfirmedCached(r)
        : hasConfirmedUncached(r));
    }

    return result;
  }, [releases, filters]);

  const sorted = useMemo(() => {
    const sorted = [...filtered];
    const { key, direction } = sort;
    const dir = direction === 'asc' ? 1 : -1;

    sorted.sort((a, b) => {
      let cmp = 0;
      switch (key) {
        case 'score':
          cmp = (a.score ?? 0) - (b.score ?? 0);
          break;
        case 'size':
          cmp = (a.size ?? 0) - (b.size ?? 0);
          break;
        case 'resolution':
          cmp = (RESOLUTION_ORDER[a.resolution ?? ''] ?? 0) - (RESOLUTION_ORDER[b.resolution ?? ''] ?? 0);
          break;
        case 'confidence':
          cmp = (a.confidence ?? 0) - (b.confidence ?? 0);
          break;
        case 'filename':
          cmp = a.filename.localeCompare(b.filename);
          break;
      }
      return cmp * dir;
    });

    return sorted;
  }, [filtered, sort]);

  const recommended = useMemo(() => sorted.slice(0, RECOMMENDED_RELEASE_LIMIT), [sorted]);
  const others = useMemo(() => sorted.slice(RECOMMENDED_RELEASE_LIMIT), [sorted]);

  const toggleSort = (key: SortKey) => {
    setSort(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc',
    }));
  };

  return {
    filters,
    setFilters,
    sorted,
    recommended,
    others,
    sort,
    toggleSort,
    totalCount: releases.length,
    filteredCount: filtered.length,
  };
}
