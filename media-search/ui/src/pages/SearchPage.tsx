import { useState, useCallback, useRef, useEffect } from 'react';
import {
  searchTitles,
  searchReleases,
  submitRequest,
} from '@api/client';
import type {
  TitleSearchResult,
  TitleResult,
  ReleaseSearchResult,
  ReleaseResult,
} from '@/types/api';
import { readQuery, updateQuery, getStoredPreference, storePreference } from '@/lib/url-state';

type View = 'titles' | 'releases';

type Fulfillment = 'download' | 'stream';

const FULFILLMENT_OPTIONS: { value: Fulfillment; label: string; description: string }[] = [
  {
    value: 'stream',
    label: 'Virtual Library',
    description: 'Publishes the release through the VFS / STRM layer. No local acquisition.',
  },
  {
    value: 'download',
    label: 'Download & Import',
    description: 'Acquires the release locally and feeds the existing Sonarr/Radarr import path.',
  },
];

interface SearchPageProps {
  onNavigateRequests?: () => void;
}

/**
 * SearchPage — the user-facing search experience.
 *
 * Contract (verified against src/api/client.js + ui/src/types/api.ts):
 *   searchTitles(q)        → { results: TitleResult[], requestId, fromCache, errors?, timings }
 *   searchReleases(t, id)  → { intent, results: ReleaseResult[], total, timings, stats }
 *   submitRequest(req)     → { requestId, status: 'queued', release }
 *
 * No backend or ranking changes. This component only wires existing plumbing.
 */
export function SearchPage({ onNavigateRequests }: SearchPageProps) {
  // Search input
  const [query, setQuery] = useState(() => readQuery().get('q') ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  // Fulfillment policy for subsequent submissions.
  // Precedence: URL ?handlingMode → saved local preference → 'download'.
  const fulfillment: Fulfillment = (() => {
    const fromUrl = readQuery().get('handlingMode');
    if (fromUrl === 'download' || fromUrl === 'stream') return fromUrl;
    return getStoredPreference<Fulfillment>('hashsucker:fulfillment', 'download', ['download', 'stream']);
  })();
  const setFulfillment = (next: Fulfillment) => {
    storePreference('hashsucker:fulfillment', next);
    updateQuery({ handlingMode: next === 'download' ? null : next }, { replace: true });
  };

  // Title search state
  const [titleResult, setTitleResult] = useState<TitleSearchResult | null>(null);
  const [titleLoading, setTitleLoading] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  // Release drill-down state
  const [view, setView] = useState<View>('titles');
  const [selectedMedia, setSelectedMedia] = useState<TitleResult | null>(null);
  const [releaseResult, setReleaseResult] = useState<ReleaseSearchResult | null>(null);
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [expandedRelease, setExpandedRelease] = useState<string | null>(null);
  const [requestStatus, setRequestStatus] = useState<Record<string, 'idle' | 'submitting' | 'queued' | 'error'>>({});

  // Filter / sort state
  const [filterText, setFilterText] = useState('');
  const [filterSource, setFilterSource] = useState<'all' | 'corpus' | 'live'>('all');
  const [sortBy, setSortBy] = useState<'score' | 'size' | 'name'>('score');

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ── Title search ──────────────────────────────────────────────────────────
  const handleTitleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;

    // Keep ?q= in sync with the submitted query so refresh deep-links survive.
    updateQuery({ q }, { replace: true });

    setTitleLoading(true);
    setTitleError(null);
    setTitleResult(null);
    setView('titles');
    setSelectedMedia(null);
    setReleaseResult(null);
    setReleaseError(null);
    setFilterText('');
    setFilterSource('all');
    setSortBy('score');

    try {
      const result = await searchTitles(q);
      setTitleResult(result);
    } catch (err) {
      setTitleError((err as Error).message);
    } finally {
      setTitleLoading(false);
    }
  }, [query]);

  // ── Release drill-down ────────────────────────────────────────────────────
  const handleSelectMedia = useCallback(async (media: TitleResult) => {
    setSelectedMedia(media);
    setReleaseLoading(true);
    setReleaseError(null);
    setReleaseResult(null);
    setView('releases');
    setExpandedRelease(null);

    try {
      const result = await searchReleases(media.type, media.id);
      console.log('SEARCH_RESPONSE:', {
        apiResultsLength: result?.results?.length ?? 0,
        total: result?.total,
        firstResult: result?.results?.[0] || null,
      });
      setReleaseResult(result);
    } catch (err) {
      setReleaseError((err as Error).message);
    } finally {
      setReleaseLoading(false);
    }
  }, []);

  const handleBack = useCallback(() => {
    setView('titles');
    setSelectedMedia(null);
    setReleaseResult(null);
    setReleaseError(null);
    setExpandedRelease(null);
  }, []);

  // ── Request submission ────────────────────────────────────────────────────
  const handleRequest = useCallback(async (release: ReleaseResult) => {
    if (!selectedMedia) return;
    const key = release.releaseKey;
    setRequestStatus(prev => ({ ...prev, [key]: 'submitting' }));

    try {
      await submitRequest({
        type: selectedMedia.type,
        mediaId: selectedMedia.id,
        handlingMode: fulfillment,
        release: {
          infoHash: release.infoHash,
          fileIndex: release.fileIndex,
          releaseKey: release.releaseKey,
        },
      });
      setRequestStatus(prev => ({ ...prev, [key]: 'queued' }));
    } catch {
      setRequestStatus(prev => ({ ...prev, [key]: 'error' }));
    }
  }, [selectedMedia, fulfillment]);

  // ── Derived: filtered + sorted releases ───────────────────────────────────
  const filteredReleases = (releaseResult?.results ?? [])
    .filter(r => {
      if (filterSource === 'corpus' && r._source !== 'corpus') return false;
      if (filterSource === 'live' && r._source !== 'live') return false;
      if (filterText.trim()) {
        const needle = filterText.toLowerCase();
        const haystack = `${r.filename} ${r.title} ${r.resolution ?? ''} ${r.releaseGroup ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'size') return (b.size ?? 0) - (a.size ?? 0);
      if (sortBy === 'name') return a.filename.localeCompare(b.filename);
      return b.score - a.score;
    });

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="search-page">
      {/* Search Bar */}
      <form
        className="search-bar"
        onSubmit={e => {
          e.preventDefault();
          handleTitleSearch();
        }}
      >
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder="Search movies & series..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          disabled={titleLoading}
          aria-label="Search query"
        />
        <button
          className="search-button"
          type="submit"
          disabled={titleLoading || !query.trim()}
        >
          {titleLoading ? 'Searching…' : 'Search'}
        </button>
        {onNavigateRequests && (
          <button
            className="search-button"
            type="button"
            onClick={onNavigateRequests}
            style={{ background: 'var(--bg-surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
          >
            Requests
          </button>
        )}
      </form>

      {/* Error State */}
      {titleError && (
        <div className="error-state" role="alert">
          <span className="error-icon">✗</span>
          <span className="error-message">{titleError}</span>
          <button className="retry-button" onClick={handleTitleSearch}>Retry</button>
        </div>
      )}

      {/* Loading State */}
      {titleLoading && (
        <div className="loading-state" role="status">
          <div className="spinner" />
          <span>Searching…</span>
        </div>
      )}

      {/* Empty State */}
      {!titleLoading && !titleError && titleResult && titleResult.results.length === 0 && (
        <div className="empty-state">
          <span>No results for "{query}"</span>
        </div>
      )}

      {/* Title Results */}
      {!titleLoading && !titleError && titleResult && titleResult.results.length > 0 && view === 'titles' && (
        <div className="media-results">
          <h2>{titleResult.results.length} result{titleResult.results.length !== 1 ? 's' : ''}</h2>
          <ul className="media-list">
            {titleResult.results.map(media => (
              <li key={media.id} className="media-item">
                <button
                  className="media-select"
                  onClick={() => handleSelectMedia(media)}
                  aria-label={`View releases for ${media.title}`}
                >
                  {media.posterUrl && (
                    <img className="media-poster" src={media.posterUrl} alt="" loading="lazy" />
                  )}
                  {!media.posterUrl && (
                    <div className="media-poster" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem', color: 'var(--text-dim)' }}>
                      {media.type === 'series' ? 'TV' : '🎬'}
                    </div>
                  )}
                  <div className="media-info">
                    <span className="media-name">{media.title}</span>
                    <span className="media-meta">
                      {media.type === 'series' ? 'Series' : 'Movie'}
                      {media.year ? ` · ${media.year}` : ''}
                    </span>
                    {media.overview && <span className="media-desc">{media.overview}</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {titleResult.errors && titleResult.errors.length > 0 && (
            <div style={{ marginTop: '1rem', fontSize: '0.8rem', color: 'var(--warning)' }}>
              ⚠ {titleResult.errors.length} provider{titleResult.errors.length !== 1 ? 's' : ''} reported errors
            </div>
          )}
        </div>
      )}

      {/* Release Drill-Down */}
      {view === 'releases' && selectedMedia && (
        <div className="releases-view">
          <div className="releases-header">
            <button className="back-button" onClick={handleBack}>← Back</button>
            <div className="media-title">
              <h1>{selectedMedia.title}</h1>
              <span className="media-subtitle">
                {selectedMedia.type === 'series' ? 'Series' : 'Movie'}
                {selectedMedia.year ? ` · ${selectedMedia.year}` : ''}
              </span>
            </div>
            {releaseResult && (
              <div className="releases-stats">
                <span>{releaseResult.total} releases</span>
                <span>{releaseResult.timings.totalMs}ms</span>
              </div>
            )}
          </div>

          {/* Release Loading */}
          {releaseLoading && (
            <div className="loading-state" role="status">
              <div className="spinner" />
              <span>Finding releases…</span>
            </div>
          )}

          {/* Release Error */}
          {releaseError && (
            <div className="error-state" role="alert">
              <span className="error-icon">✗</span>
              <span className="error-message">{releaseError}</span>
              <button className="retry-button" onClick={() => handleSelectMedia(selectedMedia)}>Retry</button>
            </div>
          )}

          {/* Release Empty */}
          {!releaseLoading && !releaseError && releaseResult && releaseResult.results.length === 0 && (
            <div className="empty-state">
              <span>No releases found for this title</span>
            </div>
          )}

          {/* Debug: log state and render lengths */}
          {(() => {
            console.log('SEARCH_RENDER_DEBUG', {
              apiResultsLength: releaseResult?.results?.length ?? 0,
              stateResultsLength: filteredReleases.length,
              renderedResultsLength: filteredReleases.length,
              releaseLoading,
              releaseError,
              hasReleaseResult: !!releaseResult,
            });
            return null;
          })()}

          {/* Release Results */}
          {!releaseLoading && !releaseError && releaseResult && releaseResult.results.length > 0 && (
            <>
              {/* Fulfillment selector — URL → localStorage → 'download' default */}
              <FulfillmentPicker value={fulfillment} onChange={setFulfillment} />

              {/* Filter Bar */}
              <div className="filter-bar">
                <div className="filter-row">
                  <input
                    className="filter-input"
                    type="text"
                    placeholder="Filter releases..."
                    value={filterText}
                    onChange={e => setFilterText(e.target.value)}
                    aria-label="Filter releases"
                  />
                  <select
                    className="filter-select"
                    value={filterSource}
                    onChange={e => setFilterSource(e.target.value as 'all' | 'corpus' | 'live')}
                    aria-label="Filter by source"
                  >
                    <option value="all">All Sources</option>
                    <option value="corpus">Corpus</option>
                    <option value="live">Live</option>
                  </select>
                  <span className="filter-count">
                    {filteredReleases.length} of {releaseResult.results.length}
                  </span>
                </div>
              </div>

              {/* Sort Controls */}
              <div className="sort-controls">
                <span className="sort-label">Sort by</span>
                <button
                  className={`sort-button ${sortBy === 'score' ? 'active' : ''}`}
                  onClick={() => setSortBy('score')}
                >
                  Score
                </button>
                <button
                  className={`sort-button ${sortBy === 'size' ? 'active' : ''}`}
                  onClick={() => setSortBy('size')}
                >
                  Size
                </button>
                <button
                  className={`sort-button ${sortBy === 'name' ? 'active' : ''}`}
                  onClick={() => setSortBy('name')}
                >
                  Name
                </button>
              </div>

              {/* Release List */}
              <div className="release-list">
                {filteredReleases.map((release, idx) => (
                  <ReleaseRow
                    key={release.releaseKey}
                    release={release}
                    rank={idx + 1}
                    expanded={expandedRelease === release.releaseKey}
                    onToggle={() => setExpandedRelease(
                      expandedRelease === release.releaseKey ? null : release.releaseKey
                    )}
                    onRequest={() => handleRequest(release)}
                    requestStatus={requestStatus[release.releaseKey] ?? 'idle'}
                  />
                ))}
              </div>

              {filteredReleases.length === 0 && (
                <div className="empty-state">
                  <span>No releases match filters</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Release Row ─────────────────────────────────────────────────────────────

interface ReleaseRowProps {
  release: ReleaseResult;
  rank: number;
  expanded: boolean;
  onToggle: () => void;
  onRequest: () => void;
  requestStatus: 'idle' | 'submitting' | 'queued' | 'error';
}

function ReleaseRow({ release, rank, expanded, onToggle, onRequest, requestStatus }: ReleaseRowProps) {
  const sourceClass = release._source === 'corpus' ? 'source-corpus' : release._source === 'live' ? 'source-live' : '';

  return (
    <div className={`release-row ${sourceClass}`}>
      <div className="release-row-main" onClick={onToggle}>
        <span className="release-rank">#{rank}</span>
        <div className="release-info">
          <div className="release-filename" title={release.filename}>{release.filename}</div>
          <div className="release-tags">
            {release.resolution && <span className="badge badge-default">{release.resolution}</span>}
            {release.quality && <span className="badge badge-default">{release.quality}</span>}
            {release.codec && <span className="badge badge-default">{release.codec}</span>}
            {release.hdr && <span className="badge badge-info">{release.hdr}</span>}
            {release._source === 'corpus' && <span className="badge badge-corpus">Corpus</span>}
            {release._source === 'live' && <span className="badge badge-live">Live</span>}
          </div>
        </div>
        <div className="release-meta">
          <span className="release-score">{release.score.toFixed(1)}</span>
          <span className="release-size">{release.size ? formatSize(release.size) : '—'}</span>
        </div>
        <button className="expand-toggle" aria-label={expanded ? 'Collapse' : 'Expand'}>
          {expanded ? '−' : '+'}
        </button>
      </div>

      {expanded && (
        <div className="release-row-details">
          <div className="detail-grid">
            <div className="detail-item">
              <span className="detail-label">Info Hash</span>
              <span className="detail-value mono">{release.infoHash}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Release Key</span>
              <span className="detail-value mono">{release.releaseKey}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">File Index</span>
              <span className="detail-value">{release.fileIndex ?? 'torrent'}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Confidence</span>
              <span className="detail-value">{(release.confidence * 100).toFixed(0)}%</span>
            </div>
            {release.releaseGroup && (
              <div className="detail-item">
                <span className="detail-label">Group</span>
                <span className="detail-value">{release.releaseGroup}</span>
              </div>
            )}
            {release.year && (
              <div className="detail-item">
                <span className="detail-label">Year</span>
                <span className="detail-value">{release.year}</span>
              </div>
            )}
          </div>

          {/* Score Components */}
          {release.components && Object.keys(release.components).length > 0 && (
            <div className="ranking-details">
              <div className="ranking-components">
                {release.components.relevance !== undefined && (
                  <ScoreSeg label="REL" value={release.components.relevance} />
                )}
                {release.components.quality !== undefined && (
                  <ScoreSeg label="QLT" value={release.components.quality} />
                )}
                {release.components.releaseConfidence !== undefined && (
                  <ScoreSeg label="RC" value={release.components.releaseConfidence} />
                )}
                {release.components.identityConfidence !== undefined && (
                  <ScoreSeg label="IC" value={release.components.identityConfidence} />
                )}
                {release.components.providerAvailability !== undefined && (
                  <ScoreSeg label="PA" value={release.components.providerAvailability} />
                )}
              </div>
            </div>
          )}

          {/* Request Button */}
          <button
            className="request-button"
            onClick={onRequest}
            disabled={requestStatus === 'submitting' || requestStatus === 'queued'}
          >
            {requestStatus === 'submitting' && 'Submitting…'}
            {requestStatus === 'queued' && '✓ Queued'}
            {requestStatus === 'error' && 'Error — Retry'}
            {requestStatus === 'idle' && 'Request'}
          </button>
        </div>
      )}
    </div>
  );
}

function ScoreSeg({ label, value }: { label: string; value: number }) {
  return (
    <div className="score-seg">
      <span className="score-label">{label}</span>
      <div className="score-track">
        <div className="score-fill" style={{ width: `${Math.min(100, value * 100)}%` }} />
      </div>
    </div>
  );
}

function FulfillmentPicker({
  value,
  onChange,
}: {
  value: Fulfillment;
  onChange: (v: Fulfillment) => void;
}) {
  return (
    <div className="fulfillment-picker" role="radiogroup" aria-label="Fulfillment mode">
      {FULFILLMENT_OPTIONS.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`fulfillment-option ${value === option.value ? 'active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          <strong>{option.label}</strong>
          <span className="muted small">{option.description}</span>
        </button>
      ))}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}
