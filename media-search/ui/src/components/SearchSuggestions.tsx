import type { TitleResult } from '@/types/api';

interface Props {
  suggestions: TitleResult[];
  loading: boolean;
  error: string | null;
  query: string;
  onSelect: (result: TitleResult) => void;
}

/**
 * Typeahead dropdown for predictive Cinemeta search results.
 * Shows poster thumbnails, title, year, and media type.
 */
export function SearchSuggestions({ suggestions, loading, error, query, onSelect }: Props) {
  if (error) {
    return (
      <div className="search-suggestions search-suggestions-error" role="alert">
        <span className="suggestion-error-text">Search unavailable: {error}</span>
      </div>
    );
  }

  if (loading && suggestions.length === 0) {
    return (
      <div className="search-suggestions search-suggestions-loading" role="status">
        <span className="suggestion-loading-text">Searching…</span>
      </div>
    );
  }

  if (query.trim().length >= 2 && suggestions.length === 0 && !loading) {
    return (
      <div className="search-suggestions search-suggestions-empty">
        <span className="suggestion-empty-text">No results found for "{query.trim()}"</span>
      </div>
    );
  }

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <ul className="search-suggestions" role="listbox" aria-label="Search suggestions">
      {suggestions.map((result) => (
        <li key={result.id} className="suggestion-item" role="option" aria-selected={false}>
          <button
            type="button"
            className="suggestion-button"
            onClick={() => onSelect(result)}
          >
            <div className="suggestion-poster">
              {result.posterUrl ? (
                <img
                  src={result.posterUrl}
                  alt={`${result.title} poster`}
                  className="suggestion-poster-img"
                  loading="lazy"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.style.display = 'none';
                    const parent = target.parentElement;
                    if (parent && !parent.querySelector('.suggestion-poster-placeholder')) {
                      const placeholder = document.createElement('div');
                      placeholder.className = 'suggestion-poster-placeholder';
                      placeholder.setAttribute('aria-hidden', 'true');
                      placeholder.textContent = result.title.slice(0, 1).toUpperCase();
                      parent.appendChild(placeholder);
                    }
                  }}
                />
              ) : (
                <div className="suggestion-poster-placeholder" aria-hidden="true">
                  {result.title.slice(0, 1).toUpperCase()}
                </div>
              )}
            </div>
            <div className="suggestion-info">
              <span className="suggestion-title">{result.title}</span>
              <span className="suggestion-meta">
                {result.type === 'movie' ? 'Movie' : 'Series'}
                {result.year && ` · ${result.year}`}
              </span>
              {result.overview && (
                <span className="suggestion-overview">{result.overview.slice(0, 100)}{result.overview.length > 100 ? '…' : ''}</span>
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
