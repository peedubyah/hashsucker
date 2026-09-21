import { OverviewPage } from '@/pages/OverviewPage';
import { ActivityPage } from '@/pages/ActivityPage';
import { LibraryPage } from '@/pages/LibraryPage';
import { DownloadsPage } from '@/pages/DownloadsPage';
import { ProvidersPage } from '@/pages/ProvidersPage';
import { DiagnosticsPage } from '@/pages/DiagnosticsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { useUrlState } from '@/lib/url-state';

type Tab =
  | 'overview'
  | 'activity'
  | 'library'
  | 'downloads'
  | 'providers'
  | 'diagnostics'
  | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'library', label: 'Library' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'providers', label: 'Providers' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'settings', label: 'Settings' },
];

const TAB_IDS: Tab[] = TABS.map((t) => t.id);

function normalizeTab(value: string | null): Tab {
  return TAB_IDS.includes(value as Tab) ? (value as Tab) : 'overview';
}

export default function App() {
  const [params, setParams] = useUrlState();
  const tab = normalizeTab(params.get('tab'));

  const setTab = (next: Tab) => {
    setParams({ tab: next === 'overview' ? null : next }, { replace: true });
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
      </header>

      <main className="app-main">
        {tab === 'overview' && <OverviewPage />}
        {tab === 'activity' && <ActivityPage />}
        {tab === 'library' && <LibraryPage />}
        {tab === 'downloads' && <DownloadsPage />}
        {tab === 'providers' && <ProvidersPage />}
        {tab === 'diagnostics' && <DiagnosticsPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
