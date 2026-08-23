import { useState, useCallback, useRef, type FormEvent } from 'react';
import { debounce } from '@/utils/debounce';
import { SearchSuggestions } from './SearchSuggestions';
import type { TitleResult } from '@/types/api';

interface Props {
  onSearch: (query: string) => void;
  onSelect: (result: TitleResult) => void;
  suggestions: TitleResult[];
  loading: boolean;
  error: string | null;
}

export function SearchBar({ onSearch, onSelect, suggestions, loading, error }: Props) {
  const [query, setQuery] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const debouncedSearch = useCallback(
    debounce((q: string) => {
      if (q.trim().length >= 2) {
        onSearch(q.trim());
        setShowSuggestions(true);
      }
    }, 250),
    [onSearch],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    if (value.trim().length >= 2) {
      debouncedSearch(value);
    } else {
      setShowSuggestions(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q.length >= 2) {
      onSearch(q);
    }
  };

  const handleSelect = (result: TitleResult) => {
    setQuery(result.title);
    setShowSuggestions(false);
    onSelect(result);
    inputRef.current?.blur();
  };

  const handleFocus = () => {
    if (query.trim().length >= 2 && suggestions.length > 0) {
      setShowSuggestions(true);
    }
  };

  const handleBlur = () => {
    setTimeout(() => setShowSuggestions(false), 200);
  };

  return (
    <div className="search-bar-container">
      <form onSubmit={handleSubmit} className="search-bar">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder="Search by title, IMDb ID, or TVDb ID…"
          className="search-input"
          autoFocus
          aria-label="Search for media"
          aria-expanded={showSuggestions}
          aria-controls="search-suggestions-list"
          role="combobox"
          aria-autocomplete="list"
        />
        <button
          type="submit"
          disabled={loading || query.trim().length < 2}
          className="search-button"
        >
          {loading ? '…' : 'Search'}
        </button>
      </form>
      {showSuggestions && (
        <SearchSuggestions
          suggestions={suggestions}
          loading={loading}
          error={error}
          query={query}
          onSelect={handleSelect}
        />
      )}
    </div>
  );
}
