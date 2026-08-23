import { useSearch } from '@/hooks/useSearch';
import { SearchPage } from '@/pages/SearchPage';
import { ReleasesPage } from '@/pages/ReleasesPage';

export default function App() {
  const {
    titles, releases, media, controlPlaneItems, controlPlaneError,
    loading, error, search, selectMedia, reset,
  } = useSearch();

  const hasReleases = releases && !loading;

  return (
    <div className="app">
      {!hasReleases ? (
        <SearchPage
          titles={titles}
          loading={loading}
          error={error}
          onSearch={search}
          onSelect={selectMedia}
        />
      ) : (
        <ReleasesPage
          releases={releases}
          media={media}
          controlPlaneItems={controlPlaneItems}
          controlPlaneError={controlPlaneError}
          loading={loading}
          error={error}
          onBack={reset}
        />
      )}
    </div>
  );
}
