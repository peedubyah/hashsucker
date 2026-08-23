import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReleaseFilters } from './useReleaseFilters';
import { mockReleases } from '../test/fixtures';

describe('useReleaseFilters', () => {
  it('returns all releases sorted by score desc by default', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    expect(result.current.sorted).toHaveLength(mockReleases.length);
    expect(result.current.sorted[0].score).toBe(0.85);
    expect(result.current.sorted[result.current.sorted.length - 1].score).toBe(0.3);
  });

  it('splits into recommended and others', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    expect(result.current.recommended.length).toBeLessThanOrEqual(result.current.sorted.length);
    expect(result.current.recommended.length + result.current.others.length).toBe(result.current.sorted.length);
  });

  it('filters by source', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.setFilters({
        ...result.current.filters,
        source: 'corpus',
      });
    });
    const corpusCount = mockReleases.filter(r => r._source === 'corpus').length;
    expect(result.current.sorted).toHaveLength(corpusCount);
    expect(result.current.sorted.every(r => r._source === 'corpus')).toBe(true);
  });

  it('filters by resolution', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.setFilters({
        ...result.current.filters,
        resolution: '1080p',
      });
    });
    const count1080p = mockReleases.filter(r => r.resolution === '1080p').length;
    expect(result.current.sorted).toHaveLength(count1080p);
    expect(result.current.sorted.every(r => r.resolution === '1080p')).toBe(true);
  });

  it('filters by quality', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.setFilters({
        ...result.current.filters,
        quality: 'WEB-DL',
      });
    });
    const webdlCount = mockReleases.filter(r => r.quality === 'WEB-DL').length;
    expect(result.current.sorted).toHaveLength(webdlCount);
    expect(result.current.sorted.every(r => r.quality === 'WEB-DL')).toBe(true);
  });

  it('filters by cached status', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.setFilters({
        ...result.current.filters,
        cached: 'cached',
      });
    });
    const cachedCount = mockReleases.filter(r =>
      r.providerObservations?.some(o => o.cached === true && o.state === 'cached')
    ).length;
    expect(result.current.sorted).toHaveLength(cachedCount);
  });

  it('filters by query matching filename', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.setFilters({
        ...result.current.filters,
        query: '720p',
      });
    });
    expect(result.current.sorted.every(r => r.filename.toLowerCase().includes('720p'))).toBe(true);
  });

  it('toggles sort direction', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    expect(result.current.sort.direction).toBe('desc');
    act(() => {
      result.current.toggleSort('score');
    });
    expect(result.current.sort.direction).toBe('asc');
    expect(result.current.sorted[0].score).toBe(0.3);
  });

  it('sorts by size descending by default', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.toggleSort('size');
    });
    expect(result.current.sorted[0].size).toBe(8589934592);
  });

  it('sorts by filename descending on first toggle', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.toggleSort('filename');
    });
    expect(result.current.sort.direction).toBe('desc');
  });

  it('sorts by filename ascending on second toggle', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.toggleSort('filename');
    });
    act(() => {
      result.current.toggleSort('filename');
    });
    expect(result.current.sort.direction).toBe('asc');
    expect(result.current.sorted[0].filename).toBe('Black.Mirror.S07E03.1080p.BluRay.mkv');
  });

  it('combines multiple filters', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.setFilters({
        ...result.current.filters,
        source: 'corpus',
        resolution: '2160p',
      });
    });
    expect(result.current.sorted).toHaveLength(1);
    expect(result.current.sorted[0].infoHash).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('returns empty when no matches', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.setFilters({
        ...result.current.filters,
        query: 'nonexistent',
      });
    });
    expect(result.current.sorted).toHaveLength(0);
  });
});
