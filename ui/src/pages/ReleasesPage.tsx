import { useState } from 'react';
import { submitRequest } from '@api/client';
import type { ReleaseSearchResult, MediaResult, ReleaseResult, RequestSubmissionResult } from '@/types/api';
import { FilterBar } from '@/components/FilterBar';
import { ReleaseRow } from '@/components/ReleaseRow';
import { ReleaseDetails } from '@/components/ReleaseDetails';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import { useReleaseFilters } from '@/hooks/useReleaseFilters';
import type { SortKey } from '@/hooks/useReleaseFilters';

interface Props {
  releases: ReleaseSearchResult | null;
  media: { media: MediaResult } | null;
  loading: boolean;
  error: string | null;
  onBack: () => void;
}

export function ReleasesPage({ releases, media, loading, error, onBack }: Props) {
  const [selectedRelease, setSelectedRelease] = useState<ReleaseResult | null>(null);
  const [requestResult, setRequestResult] = useState<RequestSubmissionResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  const {
    filters,
    setFilters,
    sorted,
    sort,
    toggleSort,
    totalCount,
    filteredCount,
  } = useReleaseFilters(releases?.results ?? []);

  const handleSelectRelease = (release: ReleaseResult) => {
    setSelectedRelease(release);
    setRequestResult(null);
    setRequestError(null);
  };

  const handleSubmitRequest = async () => {
    if (!selectedRelease || !releases) return;
    setRequesting(true);
    setRequestError(null);
    try {
      const result: RequestSubmissionResult = await submitRequest({
        type: releases.intent.streamType,
        mediaId: releases.intent.mediaId,
        release: selectedRelease,
      });
      setRequestResult(result);
    } catch (requestFailure) {
      setRequestError((requestFailure as Error).message);
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="page releases-page">
      <header className="releases-header">
        <button type="button" onClick={onBack} className="back-button">
          ← Back
        </button>
        {media && (
          <div className="media-title">
            <h1>{media.media.title}</h1>
            <span className="media-subtitle">
              {media.media.type} {media.media.year && `· ${media.media.year}`}
            </span>
          </div>
        )}
        {releases && (
          <div className="releases-stats">
            <span>{releases.total} results</span>
            <span>{releases.timings.totalMs}ms</span>
          </div>
        )}
      </header>

      {loading && <LoadingState message="Finding releases..." />}
      {error && <ErrorState message={error} onRetry={onBack} />}

      {releases && !loading && (
        <>
          <FilterBar
            filters={filters}
            onChange={setFilters}
            resultCount={filteredCount}
            totalCount={totalCount}
          />
          <div className="sort-controls">
            <span className="sort-label">Sort by:</span>
            {(['score', 'size', 'resolution', 'confidence', 'filename'] as SortKey[]).map(key => (
              <button
                key={key}
                type="button"
                className={`sort-button ${sort.key === key ? 'active' : ''}`}
                onClick={() => toggleSort(key)}
              >
                {key}
                {sort.key === key && (sort.direction === 'asc' ? ' ↑' : ' ↓')}
              </button>
            ))}
          </div>
          {sorted.length === 0 ? (
            <EmptyState message="No releases match the current filters." />
          ) : (
            <div className="release-list">
              {sorted.map((r, i) => (
                <ReleaseRow
                  key={r.releaseKey}
                  release={r}
                  rank={i + 1}
                  onSelect={handleSelectRelease}
                />
              ))}
            </div>
          )}
        </>
      )}

      {selectedRelease && (
        <ReleaseDetails
          release={selectedRelease}
          onClose={() => setSelectedRelease(null)}
          onSubmit={handleSubmitRequest}
          requesting={requesting}
          requestResult={requestResult}
          requestError={requestError}
        />
      )}
    </div>
  );
}
