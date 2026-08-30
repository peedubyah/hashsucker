import { useEffect } from 'react';
import { SearchPage } from '@/pages/SearchPage';
import { DebugConsole } from '@/pages/DebugConsole';
import { RequestConsole } from '@/pages/RequestConsole';
import { LibraryPage } from '@/pages/LibraryPage';
import { ProvidersPage } from '@/pages/ProvidersPage';
import { ResolverPage } from '@/pages/ResolverPage';
import { CorpusPage } from '@/pages/CorpusPage';
import { readQuery, useUrlState } from '@/lib/url-state';

type Tab =
  | 'search'
  | 'requests'
  | 'library'
  | 'providers'
  | 'resolver'
  | 'corpus'
  | 'debug';

const TABS: { id: Tab; label: string }[] = [
  { id: 'search', label: 'Search' },
  { id: 'requests', label: 'Requests' },
  { id: 'library', label: 'Library / VFS' },
  { id: 'providers', label: 'Providers' },
  { id: 'resolver', label: 'Resolver' },
  { id: 'corpus', label: 'Corpus / Discovery' },
  { id: 'debug', label: 'Diagnostics' },
];

const TAB_IDS: Tab[] = TABS.map((t) => t.id);

function normalizeTab(value: string | null): Tab {
  return TAB_IDS.includes(value as Tab) ? (value as Tab) : 'search';
}

export default function App() {
  const [params, setParams] = useUrlState();
  const tab = normalizeTab(params.get('tab'));

  // Pick up changes triggered outside React (popstate already handled by
  // useUrlState). Kept as a no-op listener to document the contract.
  useEffect(() => {
    const onPop = () => readQuery();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const setTab = (next: Tab) => {
    setParams({ tab: next === 'search' ? null : next, sub: null, id: null, filter: null }, { replace: true });
  };

  return (
    <div className="app">
      <header className="app-topbar">
        <div className="app-brand">
          <span className="app-brand-mark">HS</span>
          <span className="app-brand-text">Hashsucker Operator</span>
        </div>
        <nav className="app-nav" role="tablist" aria-label="Operator surfaces">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`nav-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="app-main">
        {tab === 'search' && (
          <SearchPage onNavigateRequests={() => setTab('requests')} />
        )}
        {tab === 'requests' && <RequestConsole />}
        {tab === 'library' && <LibraryPage />}
        {tab === 'providers' && <ProvidersPage />}
        {tab === 'resolver' && <ResolverPage />}
        {tab === 'corpus' && <CorpusPage />}
        {tab === 'debug' && <DebugConsole />}
      </main>
    </div>
  );
}
