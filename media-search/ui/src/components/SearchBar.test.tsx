import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SearchBar } from './SearchBar';
import type { TitleResult } from '@/types/api';

const mockResults: TitleResult[] = [
  {
    id: 'tt2085059',
    type: 'series',
    title: 'Black Mirror',
    year: 2011,
    posterUrl: 'https://example.com/poster.jpg',
    backdropUrl: null,
    overview: null,
  },
];

describe('SearchBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('renders a single primary search bar', () => {
    render(
      <SearchBar
        onSearch={() => {}}
        onSelect={() => {}}
        suggestions={[]}
        loading={false}
        error={null}
      />
    );
    expect(screen.getByPlaceholderText('Search by title, IMDb ID, or TVDb ID…')).toBeTruthy();
  });

  it('debounces search by ~250ms', async () => {
    const onSearch = vi.fn();
    render(
      <SearchBar
        onSearch={onSearch}
        onSelect={() => {}}
        suggestions={[]}
        loading={false}
        error={null}
      />
    );
    const input = screen.getByPlaceholderText('Search by title, IMDb ID, or TVDb ID…');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'black mirror' } });
    });
    // Not called immediately
    expect(onSearch).not.toHaveBeenCalled();
    // Advance past debounce
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(onSearch).toHaveBeenCalledWith('black mirror');
  });

  it('calls onSelect with the selected media identity', () => {
    const onSelect = vi.fn();
    render(
      <SearchBar
        onSearch={() => {}}
        onSelect={onSelect}
        suggestions={mockResults}
        loading={false}
        error={null}
      />
    );
    // Show suggestions by focusing with valid input
    const input = screen.getByPlaceholderText('Search by title, IMDb ID, or TVDb ID…');
    fireEvent.change(input, { target: { value: 'black' } });
    fireEvent.focus(input);
    fireEvent.click(screen.getByText('Black Mirror'));
    expect(onSelect).toHaveBeenCalledWith(mockResults[0]);
  });

  it('does not expose torrent candidates during title selection', () => {
    render(
      <SearchBar
        onSearch={() => {}}
        onSelect={() => {}}
        suggestions={mockResults}
        loading={false}
        error={null}
      />
    );
    const input = screen.getByPlaceholderText('Search by title, IMDb ID, or TVDb ID…');
    fireEvent.change(input, { target: { value: 'black' } });
    fireEvent.focus(input);
    // Verify no torrent-level data (infohash, release key) is rendered
    expect(screen.queryByText(/infohash/i)).toBeNull();
    expect(screen.queryByText(/release key/i)).toBeNull();
    expect(screen.queryByText(/score/i)).toBeNull();
  });
});
