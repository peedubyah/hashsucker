import { useCallback } from 'react';
import { HomePage } from '@/pages/HomePage';
import { RequestsPage } from '@/pages/RequestsPage';
import { LibraryPage } from '@/pages/LibraryPage';
import { DownloadsPage } from '@/pages/DownloadsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { useUrlState } from '@/lib/url-state';
import { usePoll } from '@/lib/use-poll';
import { fetchReady } from '@/api';

type Tab = 'home' | 'requests' | 'library' | 'downloads' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: 'Home / Search' },
  { id: 'requests', label: 'Requests' },
  { id: 'library', label: 'Library' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'settings', label: 'Settings' },
];

const TAB_IDS: Tab[] = TABS.map((t) => t.id);

function normalizeTab(value: string | null): Tab {
  return TAB_IDS.includes(value as Tab) ? (value as Tab) : 'home';
}

export default function App() {
  const [params, setParams] = useUrlState();
  const tab = normalizeTab(params.get('tab'));
  const [ready] = usePoll(useCallback(() => fetchReady().catch(() => ({ status: 'unreachable' })), []), 30_000);

  const setTab = (next: Tab) => {
    setParams({ tab: next === 'home' ? null : next }, { replace: true });
  };

  return (
    <div className="app">
      <header className="app-topbar">
        <div className="app-brand">
          <img className="app-brand-logo" src="/logo.png" alt="HashSucker" width={28} height={28} />
          <span className="app-brand-text">HashSucker</span>
        </div>
        <nav className="app-nav" role="tablist" aria-label="Appliance sections">
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
        <div className={`global-health global-health-${ready?.status === 'ready' ? 'ready' : 'attention'}`} title={ready?.status === 'ready' ? 'HashSucker is ready' : 'HashSucker needs attention'}>
          <span aria-hidden="true">●</span> {ready?.status === 'ready' ? 'Ready' : 'Needs attention'}
        </div>
      </header>

      <main className="app-main">
        {tab === 'home' && <HomePage />}
        {tab === 'requests' && <RequestsPage />}
        {tab === 'library' && <LibraryPage />}
        {tab === 'downloads' && <DownloadsPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
