import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReleaseFilters } from './useReleaseFilters';
import { mockReleases } from '../test/fixtures';

describe('useReleaseFilters', () => {
  it('returns all releases sorted by score desc by default', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    expect(result.current.sorted).toHaveLength(3);
    expect(result.current.sorted[0].score).toBe(0.85);
    expect(result.current.sorted[2].score).toBe(0.45);
  });

  it('filters by source', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.setFilters({
        ...result.current.filters,
        source: 'corpus',
      });
    });
    expect(result.current.sorted).toHaveLength(2);
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
    expect(result.current.sorted).toHaveLength(1);
    expect(result.current.sorted[0].resolution).toBe('1080p');
  });

  it('filters by quality', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.setFilters({
        ...result.current.filters,
        quality: 'WEB-DL',
      });
    });
    expect(result.current.sorted).toHaveLength(2);
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
    expect(result.current.sorted).toHaveLength(1);
    expect(result.current.sorted[0].infoHash).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('filters by query matching filename', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.setFilters({
        ...result.current.filters,
        query: '720p',
      });
    });
    expect(result.current.sorted).toHaveLength(1);
    expect(result.current.sorted[0].resolution).toBe('720p');
  });

  it('toggles sort direction', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    expect(result.current.sort.direction).toBe('desc');
    act(() => {
      result.current.toggleSort('score');
    });
    expect(result.current.sort.direction).toBe('asc');
    expect(result.current.sorted[0].score).toBe(0.45);
  });

  it('sorts by size descending by default', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.toggleSort('size');
    });
    expect(result.current.sorted[0].size).toBe(8589934592);
    expect(result.current.sorted[2].size).toBe(1073741824);
  });

  it('sorts by filename descending on first toggle', () => {
    const { result } = renderHook(() => useReleaseFilters(mockReleases));
    act(() => {
      result.current.toggleSort('filename');
    });
    expect(result.current.sort.direction).toBe('desc');
    expect(result.current.sorted[0].filename).toBe('Black.Mirror.S07E03.720p.HDTV.mkv');
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
    expect(result.current.sorted[0].filename).toBe('Black.Mirror.S07E03.1080p.WEB-DL.mkv');
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
