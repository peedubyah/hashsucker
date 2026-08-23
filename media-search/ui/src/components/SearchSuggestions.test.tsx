import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchSuggestions } from './SearchSuggestions';
import type { TitleResult } from '@/types/api';

const mockResults: TitleResult[] = [
  {
    id: 'tt2085059',
    type: 'series',
    title: 'Black Mirror',
    year: 2011,
    posterUrl: 'https://example.com/poster.jpg',
    backdropUrl: null,
    overview: 'Stand-alone dramas exploring twisted high-tech futures.',
  },
  {
    id: 'tt0944947',
    type: 'series',
    title: 'Game of Thrones',
    year: 2011,
    posterUrl: null,
    backdropUrl: null,
    overview: null,
  },
  {
    id: 'tt0111161',
    type: 'movie',
    title: 'The Shawshank Redemption',
    year: 1994,
    posterUrl: 'https://example.com/shawshank.jpg',
    backdropUrl: null,
    overview: 'Two imprisoned men bond over a number of years.',
  },
];

describe('SearchSuggestions', () => {
  it('renders Cinemeta results returned with title, year, and type', () => {
    render(
      <SearchSuggestions
        suggestions={mockResults}
        loading={false}
        error={null}
        query="black"
        onSelect={() => {}}
      />
    );
    expect(screen.getByText('Black Mirror')).toBeTruthy();
    expect(screen.getByText('The Shawshank Redemption')).toBeTruthy();
    expect(screen.getByText('Movie · 1994')).toBeTruthy();
  });

  it('renders poster thumbnails when available', () => {
    const { container } = render(
      <SearchSuggestions
        suggestions={mockResults}
        loading={false}
        error={null}
        query="black"
        onSelect={() => {}}
      />
    );
    const posterImgs = container.querySelectorAll('img.suggestion-poster-img') as NodeListOf<HTMLImageElement>;
    expect(posterImgs).toHaveLength(2);
    expect(posterImgs[0].src).toContain('poster.jpg');
    expect(posterImgs[1].src).toContain('shawshank.jpg');
  });

  it('renders placeholder when poster unavailable', () => {
    render(
      <SearchSuggestions
        suggestions={[mockResults[1]]}
        loading={false}
        error={null}
        query="game"
        onSelect={() => {}}
      />
   );
    expect(screen.getByText('G')).toBeTruthy(); // First letter of title
  });

  it('shows loading state when searching', () => {
    render(
      <SearchSuggestions
        suggestions={[]}
        loading={true}
        error={null}
        query="bla"
        onSelect={() => {}}
      />
    );
    expect(screen.getByText('Searching…')).toBeTruthy();
  });

  it('shows empty state when no results found', () => {
    render(
      <SearchSuggestions
        suggestions={[]}
        loading={false}
        error={null}
        query="black"
        onSelect={() => {}}
      />
    );
    expect(screen.getByText('No results found')).toBeTruthy();
  });

  it('shows error state when metadata unavailable', () => {
    render(
      <SearchSuggestions
        suggestions={[]}
        loading={false}
        error="Service unavailable"
        query="black"
        onSelect={() => {}}
      />
    );
    expect(screen.getByText(/Search unavailable: Service unavailable/)).toBeTruthy();
  });

  it('calls onSelect with the full result when user selects a media identity', () => {
    let selected: TitleResult | undefined;
    render(
      <SearchSuggestions
        suggestions={mockResults}
        loading={false}
        error={null}
        query="black"
        onSelect={(r) => { selected = r; }}
      />
    );
    fireEvent.click(screen.getByText('Black Mirror'));
    expect(selected).toEqual(mockResults[0]);
    expect(selected?.id).toBe('tt2085059');
    expect(selected?.type).toBe('series');
  });

  it('renders as a listbox with options', () => {
    render(
      <SearchSuggestions
        suggestions={mockResults}
        loading={false}
        error={null}
        query="black"
        onSelect={() => {}}
      />
    );
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });
});
