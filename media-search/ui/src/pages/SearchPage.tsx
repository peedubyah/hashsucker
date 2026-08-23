import { SearchBar } from '@/components/SearchBar';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import type { TitleResult } from '@/types/api';

interface Props {
  titles: TitleResult[] | null;
  loading: boolean;
  error: string | null;
  onSearch: (query: string) => void;
  onSelect: (result: TitleResult) => void;
}

/**
 * Cinemeta-backed predictive media search page.
 * Shows torrent candidates ONLY after title selection (via ReleasesPage).
 */
export function SearchPage({ titles, loading, error, onSearch, onSelect }: Props) {
  return (
    <div className="page search-page">
      <div className="search-header">
        <h1 className="search-title">HashSucker</h1>
        <p className="search-subtitle">Search for movies and TV shows</p>
      </div>
      <SearchBar
        onSearch={onSearch}
        onSelect={onSelect}
        suggestions={titles ?? []}
        loading={loading}
        error={error}
      />
      {loading && !titles?.length && <LoadingState message="Searching..." />}
      {error && !titles?.length && <ErrorState message={error} onRetry={() => onSearch('')} />}
      <div className="search-help">
        <p>Search by title (e.g., "Batman Begins") or IMDb ID (e.g., "tt0372784")</p>
      </div>
    </div>
  );
}
