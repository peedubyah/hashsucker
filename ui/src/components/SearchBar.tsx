import { useState, type FormEvent } from 'react';

interface Props {
  onSearch: (query: string) => void;
  loading: boolean;
}

export function SearchBar({ onSearch, loading }: Props) {
  const [query, setQuery] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q.length >= 2) onSearch(q);
  };

  return (
    <form onSubmit={submit} className="search-bar">
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search for a movie or series..."
        className="search-input"
        autoFocus
      />
      <button type="submit" disabled={loading || query.trim().length < 2} className="search-button">
        {loading ? '...' : 'Search'}
      </button>
    </form>
  );
}
