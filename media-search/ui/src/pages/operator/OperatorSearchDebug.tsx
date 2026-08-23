import { useState } from 'react';
import type { OperatorSearchDebug as OperatorSearchDebugType } from '@/types/api';

interface Props {
  result: OperatorSearchDebugType | null;
  loading: boolean;
  onSearch: (query: string) => void;
}

export function OperatorSearchDebug({ result, loading, onSearch }: Props) {
  const [query, setQuery] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.length >= 2) {
      onSearch(query);
    }
  };

  return (
    <div className="operator-search-debug">
      <h2>Discovery Debug</h2>

      <form className="operator-search-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Enter search query..."
          className="operator-search-input"
        />
        <button type="submit" className="btn btn-primary" disabled={query.length < 2}>
          Search
        </button>
      </form>

      {loading && <div className="operator-loading">Searching...</div>}

      {result && (
        <div className="search-debug-results">
          <h3>
            Query: <code>{result.query}</code> ({result.total} total)
          </h3>

          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Title</th>
                <th>Score</th>
                <th>Relevance</th>
                <th>Quality</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((r, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{r.title}</td>
                  <td className="num">{r.score.toFixed(1)}</td>
                  <td className="num">{r.components?.relevance?.toFixed(1) || '-'}</td>
                  <td className="num">{r.components?.quality?.toFixed(1) || '-'}</td>
                  <td>{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.results.length === 0 && (
            <div className="operator-empty">No candidates found.</div>
          )}
        </div>
      )}
    </div>
  );
}
