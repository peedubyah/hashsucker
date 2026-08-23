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

export function SearchPage({ titles, loading, error, onSearch, onSelect }: Props) {
  return (
    <div className="page search-page">
      <SearchBar
        onSearch={onSearch}
        onSelect={onSelect}
        suggestions={titles ?? []}
        loading={loading}
        error={error}
      />
      {loading && !titles?.length && <LoadingState message="Searching..." />}
      {error && !titles?.length && <ErrorState message={error} onRetry={() => onSearch('')} />}
    </div>
  );
}
