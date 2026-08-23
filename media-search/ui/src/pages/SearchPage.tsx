import { SearchBar } from '@/components/SearchBar';
import { MediaResults } from '@/components/MediaResults';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import type { TitleResult } from '@/types/api';

interface Props {
  titles: TitleResult[] | null;
  loading: boolean;
  error: string | null;
  onSearch: (query: string) => void;
  onSelect: (type: string, id: string) => void;
}

export function SearchPage({ titles, loading, error, onSearch, onSelect }: Props) {
  return (
    <div className="page search-page">
      <SearchBar onSearch={onSearch} loading={loading} />
      {loading && <LoadingState message="Searching..." />}
      {error && <ErrorState message={error} onRetry={() => onSearch('')} />}
      {titles && !loading && (
        titles.length === 0 ? (
          <EmptyState message="No titles found. Try a different query." />
        ) : (
          <MediaResults titles={titles} onSelect={onSelect} />
        )
      )}
    </div>
  );
}
