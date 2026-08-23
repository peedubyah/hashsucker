import { useState } from 'react';
import { getControlPlaneItem, submitRequest } from '@api/client';
import type {
  ControlPlaneItemDetail, ReleaseSearchResult, MediaResult, ReleaseResult,
  RequestSubmissionResult, ControlPlaneItemList, ViewMode,
} from '@/types/api';
import { FilterBar } from '@/components/FilterBar';
import { ReleaseRow } from '@/components/ReleaseRow';
import { ReleaseDetails } from '@/components/ReleaseDetails';
import type { HandlingMode } from '@/components/ReleaseDetails';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';
import { LifecycleStatus } from '@/components/LifecycleStatus';
import { useReleaseFilters, RECOMMENDED_RELEASE_LIMIT } from '@/hooks/useReleaseFilters';
import type { SortKey } from '@/hooks/useReleaseFilters';

interface Props {
  releases: ReleaseSearchResult | null;
  media: { media: MediaResult } | null;
  controlPlaneItems?: ControlPlaneItemList | null;
  controlPlaneError?: string | null;
  loading: boolean;
  error: string | null;
  onBack: () => void;
}

export function ReleasesPage({
  releases, media, controlPlaneItems = null, controlPlaneError = null, loading, error, onBack,
}: Props) {
  const [selectedRelease, setSelectedRelease] = useState<ReleaseResult | null>(null);
  const [requestResult, setRequestResult] = useState<RequestSubmissionResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [controlPlaneDetail, setControlPlaneDetail] = useState<ControlPlaneItemDetail | null>(null);
  const [controlPlaneDetailError, setControlPlaneDetailError] = useState<string | null>(null);
  const [controlPlaneDetailLoading, setControlPlaneDetailLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('user');
  const [showOtherReleases, setShowOtherReleases] = useState(false);

  const {
    filters,
    setFilters,
    sorted,
    recommended,
    others,
    sort,
    toggleSort,
    totalCount,
    filteredCount,
  } = useReleaseFilters(releases?.results ?? []);

  const handleSelectRelease = (release: ReleaseResult) => {
    setSelectedRelease(release);
    setRequestResult(null);
    setRequestError(null);
    setControlPlaneDetail(null);
    setControlPlaneDetailError(null);
    const items = controlPlaneItems?.items ?? [];
    if (items.length === 1) {
      setControlPlaneDetailLoading(true);
      getControlPlaneItem(items[0].item.id, release)
        .then((detail: ControlPlaneItemDetail) => setControlPlaneDetail(detail))
        .catch((failure: Error) => setControlPlaneDetailError(failure.message))
        .finally(() => setControlPlaneDetailLoading(false));
    } else if (items.length > 1) {
      setControlPlaneDetailError('Multiple library items match this media; select an item before release-scoped reconciliation.');
    }
  };

  const handleSubmitRequest = async (handlingMode: HandlingMode) => {
    if (!selectedRelease || !releases) return;
    setRequesting(true);
    setRequestError(null);
    try {
      const result: RequestSubmissionResult = await submitRequest({
        type: releases.intent.streamType,
        mediaId: releases.intent.mediaId,
        release: selectedRelease,
        handlingMode,
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
            <span>{releases.total} releases</span>
          </div>
        )}
      </header>

      {loading && <LoadingState message="Finding releases..." />}
      {error && <ErrorState message={error} onRetry={onBack} />}

      {releases && !loading && (
        <>
          <LifecycleStatus items={controlPlaneItems?.items ?? []} error={controlPlaneError} />
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
            <button
              type="button"
              className="view-mode-toggle"
              onClick={() => setViewMode(m => m === 'user' ? 'debug' : 'user')}
              aria-pressed={viewMode === 'debug'}
            >
              {viewMode === 'user' ? 'Debug ▸' : '◂ Simple'}
            </button>
          </div>
          {sorted.length === 0 ? (
            <EmptyState message="No releases match your filters." hint="Try removing some filters or searching for a different title." />
          ) : (
            <>
              <div className="release-list-header">
                <h2 className="release-list-title">Recommended for you</h2>
                <span className="release-list-count">Top {Math.min(recommended.length, RECOMMENDED_RELEASE_LIMIT)} of {sorted.length}</span>
              </div>
              <div className="release-list">
                {recommended.map((r, i) => (
                  <ReleaseRow
                    key={r.releaseKey}
                    release={r}
                    rank={i + 1}
                    viewMode={viewMode}
                    onSelect={handleSelectRelease}
                  />
                ))}
              </div>
              {others.length > 0 && (
                <div className="other-releases-section">
                  <button
                    type="button"
                    className="other-releases-toggle"
                    onClick={() => setShowOtherReleases(s => !s)}
                    aria-expanded={showOtherReleases}
                    aria-controls="other-releases-list"
                  >
                    {showOtherReleases ? '▾' : '▸'} Other releases ({others.length})
                  </button>
                  {showOtherReleases && (
                    <div className="release-list" id="other-releases-list">
                      {others.map((r, i) => (
                        <ReleaseRow
                          key={r.releaseKey}
                          release={r}
                          rank={recommended.length + i + 1}
                          viewMode={viewMode}
                          onSelect={handleSelectRelease}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
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
          viewMode={viewMode}
          controlPlaneDetail={controlPlaneDetail}
          controlPlaneLoading={controlPlaneDetailLoading}
          controlPlaneError={controlPlaneDetailError}
        />
      )}
    </div>
  );
}
