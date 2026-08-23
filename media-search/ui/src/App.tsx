import { useState } from 'react';
import { useSearch } from '@/hooks/useSearch';
import { SearchPage } from '@/pages/SearchPage';
import { ReleasesPage } from '@/pages/ReleasesPage';
import { OperatorPage } from '@/pages/OperatorPage';

type AppView = 'search' | 'operator';

export default function App() {
  const [view, setView] = useState<AppView>('search');
  const {
    titles, releases, media, controlPlaneItems, controlPlaneError,
    loading, error, search, selectMedia, reset,
  } = useSearch();

  const hasReleases = releases && !loading;

  if (view === 'operator') {
    return <OperatorPage onExit={() => setView('search')} />;
  }

  return (
    <div className="app">
      <button
        className="operator-entry-btn"
        onClick={() => setView('operator')}
        title="Open operator dashboard"
      >
        ⚙ Operator
      </button>
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
