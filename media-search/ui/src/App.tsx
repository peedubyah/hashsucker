import { useState } from 'react';
import { SearchPage } from '@/pages/SearchPage';
import { DebugConsole } from '@/pages/DebugConsole';
import { RequestConsole } from '@/pages/RequestConsole';

type Tab = 'search' | 'debug' | 'requests';

export default function App() {
  const [tab, setTab] = useState<Tab>('search');

  return (
    <div className="app">
      <nav className="app-nav" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
        <button
          className={`nav-tab ${tab === 'search' ? 'active' : ''}`}
          onClick={() => setTab('search')}
          style={navStyle(tab === 'search')}
        >
          Search
        </button>
        <button
          className={`nav-tab ${tab === 'requests' ? 'active' : ''}`}
          onClick={() => setTab('requests')}
          style={navStyle(tab === 'requests')}
        >
          Requests
        </button>
        <button
          className={`nav-tab ${tab === 'debug' ? 'active' : ''}`}
          onClick={() => setTab('debug')}
          style={navStyle(tab === 'debug')}
        >
          Debug
        </button>
      </nav>

      {tab === 'search' && (
        <SearchPage onNavigateRequests={() => setTab('requests')} />
      )}
      {tab === 'requests' && <RequestConsole />}
      {tab === 'debug' && <DebugConsole />}
    </div>
  );
}

function navStyle(active: boolean): React.CSSProperties {
  return {
    padding: '0.4rem 1rem',
    background: active ? 'var(--accent)' : 'var(--bg-surface)',
    color: active ? '#000' : 'var(--text)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: active ? 600 : 400,
  };
}
