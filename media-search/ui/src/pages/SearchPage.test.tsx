import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchPage } from './SearchPage';

// Mock the API client module
vi.mock('@api/client', () => ({
  searchTitles: vi.fn(),
  searchReleases: vi.fn(),
  submitRequest: vi.fn(),
}));

import { searchTitles, searchReleases, submitRequest } from '@api/client';

const mockSearchTitles = searchTitles as ReturnType<typeof vi.fn>;
const mockSearchReleases = searchReleases as ReturnType<typeof vi.fn>;
const mockSubmitRequest = submitRequest as ReturnType<typeof vi.fn>;

// ── Fixtures ────────────────────────────────────────────────────────────────

const mockTitleResult = {
  results: [
    {
      id: 'tt0944947',
      type: 'series' as const,
      title: 'Game of Thrones',
      year: 2011,
      posterUrl: 'https://example.com/got.jpg',
      backdropUrl: null,
      overview: 'Seven noble families fight for control of the mythical land of Westeros.',
    },
    {
      id: 'tt1234567',
      type: 'movie' as const,
      title: 'Dragon',
      year: 2024,
      posterUrl: null,
      backdropUrl: null,
      overview: null,
    },
  ],
  requestId: 'req-abc-123',
  fromCache: false,
  timings: { totalMs: 142 },
};

const mockReleaseResult = {
  intent: {
    streamType: 'series' as const,
    mediaType: 'tv' as const,
    scope: 'series' as const,
    mediaId: 'tt0944947',
    baseMediaId: 'tt0944947',
    season: null,
    episodes: [],
  },
  results: [
    {
      infoHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      fileIndex: 5,
      releaseKey: 'got-s01e1-1080p-bluray',
      title: 'Game of Thrones S01E1',
      filename: 'Game.of.Thrones.S01E1.Winter.Is.Coming.1080p.BluRay.x264-TEST',
      size: 2_500_000_000,
      resolution: '1080p',
      quality: 'BluRay',
      codec: 'x264',
      hdr: null,
      audio: 'AAC',
      releaseGroup: 'TEST',
      year: 2011,
      season: 1,
      episode: 1,
      confidence: 0.95,
      score: 8.7,
      components: { relevance: 0.9, quality: 0.85, releaseConfidence: 0.95 },
      providers: {},
      providerObservations: [],
      media: [],
      _source: 'corpus' as const,
    },
    {
      infoHash: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
      fileIndex: null,
      releaseKey: 'got-s01e1-720p-web',
      title: 'Game of Thrones S01E1',
      filename: 'Game.of.Thrones.S01E1.720p.WEB-DL',
      size: 1_200_000_000,
      resolution: '720p',
      quality: 'WEB-DL',
      codec: 'x264',
      hdr: null,
      audio: 'AAC',
      releaseGroup: 'SOMETHING',
      year: 2011,
      season: 1,
      episode: 1,
      confidence: 0.8,
      score: 6.2,
      components: {},
      providers: {},
      providerObservations: [],
      media: [],
      _source: 'live' as const,
    },
  ],
  total: 2,
  timings: { totalMs: 89 },
  stats: { indexed: 1500, total: 2 },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

async function typeAndSearch(user: ReturnType<typeof userEvent.setup>, query: string) {
  const input = screen.getByPlaceholderText('Search movies & series...');
  await user.clear(input);
  await user.type(input, query);
  await user.click(screen.getByRole('button', { name: /search/i }));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders search input and button on mount', () => {
    render(<SearchPage />);
    expect(screen.getByPlaceholderText('Search movies & series...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
  });

  it('search button is disabled when query is empty', () => {
    render(<SearchPage />);
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
  });

  it('search button enables when query has text', async () => {
    const user = userEvent.setup();
    render(<SearchPage />);
    const input = screen.getByPlaceholderText('Search movies & series...');
    await user.type(input, 'dragon');
    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
  });

  it('shows loading state while searching', async () => {
    const user = userEvent.setup();
    // Delay the response so we can observe loading state
    mockSearchTitles.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');
    // Loading state: the button shows "Searching…" and the loading div shows "Searching…"
    // Use the status role to disambiguate.
    expect(screen.getByRole('status')).toHaveTextContent('Searching…');
  });

  it('parses search response and maps results into UI items', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockResolvedValue(mockTitleResult);
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');

    await waitFor(() => {
      expect(screen.getByText('Game of Thrones')).toBeInTheDocument();
    });
    expect(screen.getByText('Dragon')).toBeInTheDocument();
    expect(screen.getByText('2 results')).toBeInTheDocument();
  });

  it('loading state clears after results arrive', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockResolvedValue(mockTitleResult);
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');

    await waitFor(() => {
      expect(screen.getByText('Game of Thrones')).toBeInTheDocument();
    });
    expect(screen.queryByText('Searching…')).not.toBeInTheDocument();
  });

  it('renders empty state when no results returned', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockResolvedValue({
      results: [],
      requestId: 'req-empty',
      fromCache: false,
      timings: { totalMs: 12 },
    });
    render(<SearchPage />);
    await typeAndSearch(user, 'zzzznonexistent');

    await waitFor(() => {
      expect(screen.getByText(/no results for/i)).toBeInTheDocument();
    });
  });

  it('renders error state on network failure', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockRejectedValue(new Error('Search failed: 502'));
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText('Search failed: 502')).toBeInTheDocument();
  });

  it('retry button re-runs the search', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockRejectedValueOnce(new Error('Network error'));
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });

    mockSearchTitles.mockResolvedValueOnce(mockTitleResult);
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByText('Game of Thrones')).toBeInTheDocument();
    });
  });

  it('drills into releases when a title is selected', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockResolvedValue(mockTitleResult);
    mockSearchReleases.mockResolvedValue(mockReleaseResult);
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');

    await waitFor(() => {
      expect(screen.getByText('Game of Thrones')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /view releases for game of thrones/i }));

    await waitFor(() => {
      expect(screen.getByText('Game.of.Thrones.S01E1.Winter.Is.Coming.1080p.BluRay.x264-TEST')).toBeInTheDocument();
    });
    expect(screen.getByText('Game.of.Thrones.S01E1.720p.WEB-DL')).toBeInTheDocument();
  });

  it('shows loading state during release drill-down', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockResolvedValue(mockTitleResult);
    mockSearchReleases.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');

    await waitFor(() => {
      expect(screen.getByText('Game of Thrones')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /view releases for game of thrones/i }));
    expect(screen.getByText('Finding releases…')).toBeInTheDocument();
  });

  it('shows error state when release search fails', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockResolvedValue(mockTitleResult);
    mockSearchReleases.mockRejectedValue(new Error('Release search failed: 500'));
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');

    await waitFor(() => {
      expect(screen.getByText('Game of Thrones')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /view releases for game of thrones/i }));

    await waitFor(() => {
      expect(screen.getByText('Release search failed: 500')).toBeInTheDocument();
    });
  });

  it('shows empty state when no releases found', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockResolvedValue(mockTitleResult);
    mockSearchReleases.mockResolvedValue({
      intent: mockReleaseResult.intent,
      results: [],
      total: 0,
      timings: { totalMs: 5 },
      stats: { indexed: 1500, total: 0 },
    });
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');

    await waitFor(() => {
      expect(screen.getByText('Game of Thrones')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /view releases for game of thrones/i }));

    await waitFor(() => {
      expect(screen.getByText('No releases found for this title')).toBeInTheDocument();
    });
  });

  it('back button returns to title results', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockResolvedValue(mockTitleResult);
    let resolveReleases: (val: typeof mockReleaseResult) => void;
    mockSearchReleases.mockReturnValue(new Promise(r => { resolveReleases = r; }));
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');

    await waitFor(() => {
      expect(screen.getByText('Game of Thrones')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /view releases for game of thrones/i }));

    // While the promise is pending, the loading state should be visible.
    expect(screen.getByText('Finding releases…')).toBeInTheDocument();

    // Now resolve the release search.
    resolveReleases!(mockReleaseResult);
    await waitFor(() => {
      expect(screen.getByText('Game.of.Thrones.S01E1.Winter.Is.Coming.1080p.BluRay.x264-TEST')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: '← Back' }));

    await waitFor(() => {
      expect(screen.getByText('2 results')).toBeInTheDocument();
    });
    expect(screen.queryByText('Finding releases…')).not.toBeInTheDocument();
  });

  it('filter bar narrows release results', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockResolvedValue(mockTitleResult);
    mockSearchReleases.mockResolvedValue(mockReleaseResult);
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');

    await waitFor(() => {
      expect(screen.getByText('Game of Thrones')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /view releases for game of thrones/i }));

    await waitFor(() => {
      expect(screen.getByText('Game.of.Thrones.S01E1.Winter.Is.Coming.1080p.BluRay.x264-TEST')).toBeInTheDocument();
    });

    // Type in filter
    const filterInput = screen.getByPlaceholderText('Filter releases...');
    await user.type(filterInput, '720p');

    expect(screen.getByText('Game.of.Thrones.S01E1.720p.WEB-DL')).toBeInTheDocument();
    expect(screen.queryByText('Game.of.Thrones.S01E1.Winter.Is.Coming.1080p.BluRay.x264-TEST')).not.toBeInTheDocument();
  });

  it('request button submits and shows queued status', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockResolvedValue(mockTitleResult);
    mockSearchReleases.mockResolvedValue(mockReleaseResult);
    mockSubmitRequest.mockResolvedValue({ requestId: 'req-new', status: 'queued', release: {} });
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');

    await waitFor(() => {
      expect(screen.getByText('Game of Thrones')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /view releases for game of thrones/i }));

    await waitFor(() => {
      expect(screen.getByText('Game.of.Thrones.S01E1.Winter.Is.Coming.1080p.BluRay.x264-TEST')).toBeInTheDocument();
    });

    // Expand the first release row
    const expandButtons = screen.getAllByRole('button', { name: 'Expand' });
    await user.click(expandButtons[0]);

    // Click the request button
    const requestButton = screen.getByRole('button', { name: 'Request' });
    await user.click(requestButton);

    await waitFor(() => {
      expect(screen.getByText('✓ Queued')).toBeInTheDocument();
    });

    expect(mockSubmitRequest).toHaveBeenCalledWith({
      type: 'series',
      mediaId: 'tt0944947',
      release: {
        infoHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        fileIndex: 5,
        releaseKey: 'got-s01e1-1080p-bluray',
      },
    });
  });

  it('displays provider error warning when present', async () => {
    const user = userEvent.setup();
    mockSearchTitles.mockResolvedValue({
      ...mockTitleResult,
      errors: [{ provider: 'cinemeta', error: 'timeout' }],
    });
    render(<SearchPage />);
    await typeAndSearch(user, 'dragon');

    await waitFor(() => {
      expect(screen.getByText(/1 provider.*reported errors/i)).toBeInTheDocument();
    });
  });
});
