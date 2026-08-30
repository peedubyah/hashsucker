import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  searchTitles,
  searchReleases,
  submitRequest,
  getOperatorSearchDebug,
} from '@api/client';
import type {
  TitleSearchResult,
  TitleResult,
  ReleaseSearchResult,
  ReleaseResult,
  ReleaseIdentity,
  ScoreComponents,
} from '@/types/api';
import { readQuery, updateQuery, getStoredPreference, storePreference } from '@/lib/url-state';
import { PageHeader, Section, EmptyState, ErrorState, LoadingState, MetricGrid, MetricTile } from '@/components/common';
import { StatusBadge, formatNumber, formatRelative } from '@/lib/format';

type View = 'titles' | 'releases';
type Fulfillment = 'download' | 'stream';
type SourceFilter = 'all' | 'corpus' | 'live' | 'merged';
type SortKey = 'rank' | 'size' | 'name' | 'score';

const FULFILLMENT_OPTIONS: { value: Fulfillment; label: string; description: string }[] = [
  {
    value: 'stream',
    label: 'Virtual Library',
    description: 'Publishes the release through the VFS / STRM layer. No local acquisition.',
  },
  {
    value: 'download',
    label: 'Download & Import',
    description: 'Physical acquisition via torbox-importer. Default server behavior.',
  },
];

const FULFILLMENT_STORAGE_KEY = 'hs.fulfillment';
const SOURCE_FILTER_STORAGE_KEY = 'hs.sourceFilter';
const ELIGIBLE_ONLY_STORAGE_KEY = 'hs.eligibleOnly';

const SEARCH_INPUT_DEBOUNCE_MS = 250;

function readFulfillment(): Fulfillment {
  return getStoredPreference<Fulfillment>(FULFILLMENT_STORAGE_KEY, 'download', ['download', 'stream']);
}
function readSourceFilter(): SourceFilter {
  return getStoredPreference<SourceFilter>(SOURCE_FILTER_STORAGE_KEY, 'all', ['all', 'corpus', 'live', 'merged']);
}
function readEligibleOnly(): boolean {
  try {
    return window.localStorage.getItem(ELIGIBLE_ONLY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

interface CandidateFilters {
  eligibleOnly: boolean;
  resolution: string;
  providerState: 'all' | 'cached' | 'uncached' | 'unknown';
  sizeBucket: 'all' | 'lt1' | '1to4' | '4to15' | 'gt15';
  text: string;
}

const DEFAULT_FILTERS: CandidateFilters = {
  eligibleOnly: false,
  resolution: 'all',
  providerState: 'all',
  sizeBucket: 'all',
  text: '',
};

interface SearchPageProps {
  onNavigateRequests?: () => void;
}

export function SearchPage({ onNavigateRequests }: SearchPageProps) {
  // Persistent state
  const [query, setQuery] = useState(() => readQuery().get('q') ?? '');
  const [fulfillment, setFulfillment] = useState<Fulfillment>(() => readFulfillment());
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(() => readSourceFilter());
  const [eligibleOnly, setEligibleOnly] = useState<boolean>(() => readEligibleOnly());
  const [view, setView] = useState<View>((readQuery().get('view') as View) || 'titles');

  // Filters (in-memory)
  const [filters, setFilters] = useState<CandidateFilters>(() => ({ ...DEFAULT_FILTERS, eligibleOnly }));
  const [sortBy, setSortBy] = useState<SortKey>('rank');

  // Results / loading / errors
  const [titleResult, setTitleResult] = useState<TitleSearchResult | null>(null);
  const [releaseResult, setReleaseResult] = useState<ReleaseSearchResult | null>(null);
  const [titleLoading, setTitleLoading] = useState(false);
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [selectedMedia, setSelectedMedia] = useState<TitleResult | null>(null);
  const [expandedRelease, setExpandedRelease] = useState<string | null>(null);
  const [requestStatus, setRequestStatus] = useState<Record<string, 'idle' | 'submitting' | 'queued' | 'error'>>({});
  const [identityDebug, setIdentityDebug] = useState<{ query: string; loadedAt: number } | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { storePreference(FULFILLMENT_STORAGE_KEY, fulfillment); }, [fulfillment]);
  useEffect(() => { storePreference(SOURCE_FILTER_STORAGE_KEY, sourceFilter); }, [sourceFilter]);
  useEffect(() => { storePreference(ELIGIBLE_ONLY_STORAGE_KEY, eligibleOnly ? '1' : '0'); }, [eligibleOnly]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      updateQuery({ q: query.trim() || null, view: view === 'titles' ? null : view }, { replace: true });
    }, SEARCH_INPUT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, view]);

  const handleTitleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setTitleLoading(true);
    setTitleError(null);
    setReleaseError(null);
    setTitleResult(null);
    setReleaseResult(null);
    setSelectedMedia(null);
    setView('titles');
    try {
      const result = await searchTitles(query.trim());
      setTitleResult(result);
    } catch (err) {
      setTitleError((err as Error).message);
    } finally {
      setTitleLoading(false);
    }
  }, [query]);

  const handleSelectMedia = useCallback(async (media: TitleResult) => {
    setSelectedMedia(media);
    setReleaseLoading(true);
    setReleaseError(null);
    setReleaseResult(null);
    setView('releases');
    setExpandedRelease(null);

    try {
      const result = await searchReleases(media.type, media.id);
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

  const loadIdentityDebug = useCallback(async () => {
    if (!query.trim()) return;
    try {
      await getOperatorSearchDebug(query.trim());
      setIdentityDebug({ query: query.trim(), loadedAt: Date.now() });
    } catch (err) {
      setIdentityDebug({ query: `${(err as Error).message}`, loadedAt: Date.now() });
    }
  }, [query]);

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
        } satisfies ReleaseIdentity,
      });
      setRequestStatus(prev => ({ ...prev, [key]: 'queued' }));
    } catch {
      setRequestStatus(prev => ({ ...prev, [key]: 'error' }));
    }
  }, [selectedMedia, fulfillment]);

  const facets = useMemo(() => buildFacets(releaseResult?.results ?? []), [releaseResult]);

  const visibleReleases = useMemo(() => {
    const all = releaseResult?.results ?? [];
    return applyFilters(all, { ...filters, eligibleOnly }, sourceFilter)
      .sort((a, b) => sortReleases(a, b, sortBy));
  }, [releaseResult, filters, eligibleOnly, sourceFilter, sortBy]);

  const rankAnomaly = useMemo(() => detectRankAnomaly(releaseResult?.results ?? []), [releaseResult]);

  return (
    <div className="page page-search">
      <PageHeader
        title="Search & Candidate Picker"
        subtitle="Find a title, review the ranked candidate list, and submit a fulfillment request."
      />

      <Section dense>
        <form
          className="search-bar"
          onSubmit={e => { e.preventDefault(); handleTitleSearch(); }}
        >
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            placeholder="Search movies & series…"
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
              className="btn btn-secondary"
              type="button"
              onClick={onNavigateRequests}
            >
              Requests
            </button>
          )}
        </form>

        <div className="search-persistence-row">
          <FulfillmentPicker value={fulfillment} onChange={setFulfillment} />
        </div>
      </Section>

      {titleError && (
        <Section>
          <ErrorState message={titleError} onRetry={handleTitleSearch} />
        </Section>
      )}

      {titleLoading && (
        <Section>
          <LoadingState label="Searching titles…" />
        </Section>
      )}

      {!titleLoading && !titleError && titleResult && titleResult.results.length === 0 && (
        <Section>
          <EmptyState title="No titles" detail={`No titles for "${query}"`} />
        </Section>
      )}

      {!titleLoading && !titleError && titleResult && titleResult.results.length > 0 && view === 'titles' && (
        <Section
          title={`Titles (${titleResult.results.length})`}
          meta={titleResult.fromCache ? 'from cache' : 'live'}
          actions={<span className="muted small">{titleResult.timings.totalMs}ms</span>}
        >
          {titleResult.errors && titleResult.errors.length > 0 && (
            <div className="warning-banner" role="status">
              {titleResult.errors.length} provider{titleResult.errors.length !== 1 ? 's' : ''} reported errors
            </div>
          )}
          <ul className="media-list">
            {titleResult.results.map(media => (
              <li key={media.id} className="media-item">
                <button
                  className="media-select"
                  onClick={() => handleSelectMedia(media)}
                  aria-label={`View releases for ${media.title}`}
                >
                  {media.posterUrl ? (
                    <img className="media-poster" src={media.posterUrl} alt="" loading="lazy" />
                  ) : (
                    <div className="media-poster media-poster-fallback">
                      {media.type === 'series' ? 'TV' : 'Film'}
                    </div>
                  )}
                  <div className="media-info">
                    <div className="media-name">{media.title}</div>
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
        </Section>
      )}

      {view === 'releases' && selectedMedia && (
        <Section
          title={`${selectedMedia.title}${selectedMedia.year ? ` (${selectedMedia.year})` : ''}`}
          actions={
            <button type="button" className="btn btn-secondary" onClick={handleBack}>← Back</button>
          }
        >
          {releaseLoading && <LoadingState label="Finding releases…" />}

          {releaseError && <ErrorState message={releaseError} />}

          {!releaseLoading && !releaseError && releaseResult && releaseResult.results.length === 0 && (
            <EmptyState
              title="No releases"
              detail={`No releases found for ${selectedMedia.title}`}
              action={
                <button type="button" className="btn" onClick={loadIdentityDebug}>
                  Run identity debug
                </button>
              }
            />
          )}

          {!releaseLoading && !releaseError && releaseResult && releaseResult.results.length > 0 && (
            <>
              <MetricGrid>
                <MetricTile
                  label="Candidates"
                  value={formatNumber(releaseResult.total)}
                  hint={`${visibleReleases.length} shown after filters`}
                />
                <MetricTile
                  label="Corpus"
                  value={facets.corpus}
                  tone="info"
                  hint="Local DMM matches"
                />
                <MetricTile
                  label="Live"
                  value={facets.live}
                  tone="info"
                  hint="Provider-discovered"
                />
                <MetricTile
                  label="Provider cached"
                  value={facets.cached}
                  tone={facets.cached > 0 ? 'good' : 'warn'}
                  hint="TorBox observations"
                />
                <MetricTile
                  label="Timings"
                  value={`${releaseResult.timings.totalMs}ms`}
                  hint={`${releaseResult.stats?.indexed ?? '—'} indexed`}
                />
              </MetricGrid>

              {rankAnomaly && (
                <div className="defect-banner" role="status">
                  <strong>Backend identity defect</strong>
                  <p>
                    {rankAnomaly.count} of the top {Math.min(10, releaseResult?.results.length ?? 0)} candidate{rankAnomaly.count !== 1 ? 's' : ''} on this mediaId {rankAnomaly.description}.
                    Identity confidence averages {Math.round(rankAnomaly.avgIdentity * 100)}% — the backend is returning parser-level corpus matches instead of semantic matches and does not currently rerank unrelated releases against the selected mediaId.
                  </p>
                  <button type="button" className="btn btn-secondary" onClick={loadIdentityDebug}>
                    Inspect with /api/operator/search-debug
                  </button>
                </div>
              )}

              <div className="candidate-toolbar">
                <div className="candidate-filters">
                  <label className="filter-chip">
                    <input
                      type="checkbox"
                      checked={eligibleOnly}
                      onChange={e => setEligibleOnly(e.target.checked)}
                    />
                    <span>Eligible only</span>
                  </label>
                  <label className="filter-select">
                    <span>Resolution</span>
                    <select
                      value={filters.resolution}
                      onChange={e => setFilters(f => ({ ...f, resolution: e.target.value }))}
                    >
                      <option value="all">All</option>
                      {facets.resolutions.map(r => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </label>
                  <label className="filter-select">
                    <span>Source</span>
                    <select
                      value={sourceFilter}
                      onChange={e => setSourceFilter(e.target.value as SourceFilter)}
                    >
                      <option value="all">All</option>
                      <option value="corpus">Corpus</option>
                      <option value="live">Live</option>
                      <option value="merged">Merged</option>
                    </select>
                  </label>
                  <label className="filter-select">
                    <span>Provider</span>
                    <select
                      value={filters.providerState}
                      onChange={e => setFilters(f => ({ ...f, providerState: e.target.value as CandidateFilters['providerState'] }))}
                    >
                      <option value="all">All</option>
                      <option value="cached">Cached</option>
                      <option value="uncached">Uncached</option>
                      <option value="unknown">Unknown</option>
                    </select>
                  </label>
                  <label className="filter-select">
                    <span>Size</span>
                    <select
                      value={filters.sizeBucket}
                      onChange={e => setFilters(f => ({ ...f, sizeBucket: e.target.value as CandidateFilters['sizeBucket'] }))}
                    >
                      <option value="all">All</option>
                      <option value="lt1">{'< 1 GB'}</option>
                      <option value="1to4">1–4 GB</option>
                      <option value="4to15">4–15 GB</option>
                      <option value="gt15">{'> 15 GB'}</option>
                    </select>
                  </label>
                  <label className="filter-input">
                    <span>Filter</span>
                    <input
                      type="search"
                      placeholder="filename, group, codec…"
                      value={filters.text}
                      onChange={e => setFilters(f => ({ ...f, text: e.target.value }))}
                    />
                  </label>
                </div>
                <div className="candidate-sort">
                  <span className="muted small">Sort</span>
                  <select value={sortBy} onChange={e => setSortBy(e.target.value as SortKey)}>
                    <option value="rank">Backend rank</option>
                    <option value="score">Score</option>
                    <option value="size">Size</option>
                    <option value="name">Name</option>
                  </select>
                </div>
              </div>

              {visibleReleases.length === 0 ? (
                <EmptyState
                  title="No matches"
                  detail="No candidate survives the current filters."
                  action={
                    <button type="button" className="btn btn-secondary" onClick={() => { setFilters({ ...DEFAULT_FILTERS }); setSourceFilter('all'); setEligibleOnly(false); }}>
                      Reset filters
                    </button>
                  }
                />
              ) : (
                <ul className="candidate-list" role="list">
                  {visibleReleases.map((release, idx) => {
                    const backendRank = (releaseResult?.results ?? []).findIndex(r => r.releaseKey === release.releaseKey) + 1;
                    return (
                      <li key={release.releaseKey}>
                        <ReleaseRow
                          release={release}
                          rank={backendRank || idx + 1}
                          expanded={expandedRelease === release.releaseKey}
                          onToggle={() => setExpandedRelease(prev => prev === release.releaseKey ? null : release.releaseKey)}
                          onRequest={() => handleRequest(release)}
                          requestStatus={requestStatus[release.releaseKey] ?? 'idle'}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}

              {identityDebug && (
                <div className="inline-debug-note muted small">
                  Identity debug loaded for <code>{identityDebug.query}</code> at {formatRelative(identityDebug.loadedAt)}.
                  See Corpus / Discovery for the full ranked debug list.
                </div>
              )}
            </>
          )}
        </Section>
      )}
    </div>
  );
}

function FulfillmentPicker({ value, onChange }: { value: Fulfillment; onChange: (v: Fulfillment) => void }) {
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

interface ReleaseRowProps {
  release: ReleaseResult;
  rank: number;
  expanded: boolean;
  onToggle: () => void;
  onRequest: () => void;
  requestStatus: 'idle' | 'submitting' | 'queued' | 'error';
}

function ReleaseRow({ release, rank, expanded, onToggle, onRequest, requestStatus }: ReleaseRowProps) {
  const sourceClass = release._source === 'corpus' ? 'source-corpus' : release._source === 'live' ? 'source-live' : 'source-merged';
  const cachedObservation = pickCachedObservation(release);
  const identityDefect = isIdentityMismatch(release);

  return (
    <div className={`candidate-row ${sourceClass}${identityDefect ? ' candidate-row-defect' : ''}`}>
      <div className="candidate-row-main" onClick={onToggle}>
        <div className="candidate-rank">
          <span className="rank-number">#{rank}</span>
          <span className="rank-score">{release.score.toFixed(2)}</span>
        </div>

        <div className="candidate-summary">
          <div className="candidate-title">
            {release.title || release.filename}
          </div>
          <div className="candidate-filename" title={release.filename}>
            {release.filename}
          </div>
          <div className="candidate-tags">
            {release.resolution && <span className="badge badge-default">{release.resolution}</span>}
            {release.quality && <span className="badge badge-default">{release.quality}</span>}
            {release.codec && <span className="badge badge-default">{release.codec}</span>}
            {release.hdr && <span className="badge badge-info">{release.hdr}</span>}
            {release.audio && <span className="badge badge-default">{release.audio}</span>}
            {release.releaseGroup && <span className="badge badge-default">{release.releaseGroup}</span>}
            {release._source === 'corpus' && <span className="badge badge-corpus">Corpus</span>}
            {release._source === 'live' && <span className="badge badge-live">Live</span>}
            {release._source === 'merged' && <span className="badge badge-default">Merged</span>}
            {cachedObservation && <span className="badge badge-success">Cached</span>}
            {identityDefect && <span className="badge badge-warning">Identity suspect</span>}
          </div>
        </div>

        <div className="candidate-metrics">
          <div className="candidate-metric">
            <span className="metric-label">Identity</span>
            <span className="metric-value">{Math.round((release.components?.identityConfidence ?? release.confidence) * 100)}%</span>
          </div>
          <div className="candidate-metric">
            <span className="metric-label">Provider</span>
            <span className="metric-value">{cachedObservation ? 'cached' : release.providers && Object.keys(release.providers).length ? 'observed' : 'unknown'}</span>
          </div>
          <div className="candidate-metric">
            <span className="metric-label">Size</span>
            <span className="metric-value">{release.size ? formatSize(release.size) : '—'}</span>
          </div>
          <div className="candidate-metric">
            <span className="metric-label">Score</span>
            <span className="metric-value">{release.score.toFixed(2)}</span>
          </div>
        </div>

        <div className="candidate-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={e => { e.stopPropagation(); onRequest(); }}
            disabled={requestStatus === 'submitting' || requestStatus === 'queued'}
          >
            {requestStatus === 'submitting' && 'Submitting…'}
            {requestStatus === 'queued' && '✓ Queued'}
            {requestStatus === 'error' && 'Retry'}
            {requestStatus === 'idle' && 'Request'}
          </button>
          <button
            type="button"
            className="expand-toggle"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            onClick={e => { e.stopPropagation(); onToggle(); }}
          >
            {expanded ? '−' : '+'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="candidate-row-details">
          <RankingExplanation components={release.components} />

          <dl className="kv-grid">
            <div className="kv-row">
              <dt className="kv-key">Info hash</dt>
              <dd className="kv-val mono">{release.infoHash}</dd>
            </div>
            <div className="kv-row">
              <dt className="kv-key">Release key</dt>
              <dd className="kv-val mono">{release.releaseKey}</dd>
            </div>
            <div className="kv-row">
              <dt className="kv-key">File index</dt>
              <dd className="kv-val">{release.fileIndex ?? 'torrent'}</dd>
            </div>
            <div className="kv-row">
              <dt className="kv-key">Source</dt>
              <dd className="kv-val">{release._source}</dd>
            </div>
            <div className="kv-row">
              <dt className="kv-key">Confidence</dt>
              <dd className="kv-val">{(release.confidence * 100).toFixed(0)}%</dd>
            </div>
            {release.year && (
              <div className="kv-row">
                <dt className="kv-key">Year</dt>
                <dd className="kv-val">{release.year}</dd>
              </div>
            )}
            {release.season != null && (
              <div className="kv-row">
                <dt className="kv-key">Episode</dt>
                <dd className="kv-val">S{String(release.season).padStart(2, '0')}E{String(release.episode ?? 0).padStart(2, '0')}</dd>
              </div>
            )}
          </dl>

          {release.providers && Object.keys(release.providers).length > 0 && (
            <div className="candidate-providers">
              <h4>Provider observations</h4>
              <ul className="provider-list">
                {Object.entries(release.providers).map(([name, obs]) => (
                  <li key={name}>
                    <span className="provider-name">{name}</span>
                    <StatusBadge value={obs?.state ?? (obs?.cached ? 'cached' : 'unknown')} />
                    {obs?.observedAt != null && (
                      <span className="muted small">{formatRelative(obs.observedAt)}</span>
                    )}
                    {obs?.errorCategory && (
                      <span className="badge badge-warning">{obs.errorCategory}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RankingExplanation({ components }: { components: ScoreComponents | undefined }) {
  if (!components) return null;
  const items: Array<[string, number | undefined]> = [
    ['Relevance', components.relevance],
    ['Quality', components.quality],
    ['Release Conf.', components.releaseConfidence],
    ['Identity', components.identityConfidence],
    ['Provider Avail.', components.providerAvailability],
    ['Episode Match', components.episodeMatch],
  ];
  return (
    <div className="ranking-explanation">
      <h4>Ranking</h4>
      <div className="ranking-components">
        {items.map(([label, value]) => {
          if (value == null) return null;
          const pct = Math.max(0, Math.min(1, value)) * 100;
          return (
            <div key={label} className="score-seg">
              <span className="score-label">{label}</span>
              <div className="score-track">
                <div className="score-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="score-num">{pct.toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

function buildFacets(results: ReleaseResult[]) {
  const resolutions = new Set<string>();
  let corpus = 0, live = 0, cached = 0;
  for (const r of results) {
    if (r.resolution) resolutions.add(r.resolution);
    if (r._source === 'corpus') corpus++;
    if (r._source === 'live') live++;
    if (pickCachedObservation(r)) cached++;
  }
  return {
    corpus,
    live,
    cached,
    resolutions: Array.from(resolutions).sort(),
  };
}

function pickCachedObservation(release: ReleaseResult) {
  for (const obs of release.providerObservations ?? []) {
    if (obs?.state === 'cached' || obs?.cached === true) return obs;
  }
  for (const obs of Object.values(release.providers ?? {})) {
    if ((obs as { cached?: boolean | null; state?: string })?.cached === true) return obs;
  }
  return null;
}

function applyFilters(
  results: ReleaseResult[],
  filters: CandidateFilters,
  sourceFilter: SourceFilter,
): ReleaseResult[] {
  return results.filter((r) => {
    if (sourceFilter !== 'all' && r._source !== sourceFilter) return false;
    if (filters.resolution !== 'all' && r.resolution !== filters.resolution) return false;
    if (filters.eligibleOnly && (r.components?.identityConfidence ?? 0) < 0.5) return false;
    if (filters.providerState !== 'all') {
      const obs = pickCachedObservation(r);
      if (filters.providerState === 'cached' && !obs) return false;
      if (filters.providerState === 'uncached' && obs) return false;
      if (filters.providerState === 'unknown' && obs) return false;
    }
    if (filters.sizeBucket !== 'all' && r.size != null) {
      const gb = r.size / 1_000_000_000;
      if (filters.sizeBucket === 'lt1' && gb >= 1) return false;
      if (filters.sizeBucket === '1to4' && (gb < 1 || gb > 4)) return false;
      if (filters.sizeBucket === '4to15' && (gb < 4 || gb > 15)) return false;
      if (filters.sizeBucket === 'gt15' && gb <= 15) return false;
    }
    if (filters.text.trim()) {
      const needle = filters.text.toLowerCase();
      const haystack = `${r.filename} ${r.title} ${r.releaseGroup ?? ''} ${r.codec ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

function sortReleases(a: ReleaseResult, b: ReleaseResult, sortBy: SortKey): number {
  if (sortBy === 'size') return (b.size ?? 0) - (a.size ?? 0);
  if (sortBy === 'name') return a.filename.localeCompare(b.filename);
  if (sortBy === 'score') return b.score - a.score;
  return 0;
}

function isIdentityMismatch(release: ReleaseResult) {
  const ic = release.components?.identityConfidence;
  return ic != null && ic < 0.4 && release._source === 'corpus';
}

// Detects the unrelated-but-eligible backend defect where corpus matches at the
// top of the list have only parser-level identity confidence and clearly do not
// belong to the requested mediaId. The strict <0.4 cutoff misses results at the
// 0.5 floor, so we additionally flag any release whose identity confidence is
// at or below the corpus floor (0.5) — these are parser matches, not semantic
// matches, and surface the backend's lack of reranking.
function isLowConfidenceCorpus(release: ReleaseResult) {
  if (release._source !== 'corpus') return false;
  const ic = release.components?.identityConfidence;
  return ic != null && ic <= 0.5;
}

function detectRankAnomaly(results: ReleaseResult[]) {
  if (!results.length) return null;
  const topSlice = results.slice(0, Math.min(results.length, 10));
  const lowConf = topSlice.filter(isLowConfidenceCorpus);
  if (lowConf.length < 1) return null;
  const avgIdentity = topSlice.reduce((acc, r) => acc + (r.components?.identityConfidence ?? 0), 0) / topSlice.length;
  const description = lowConf.length === 1
    ? 'has parser-level identity confidence and is not semantically matched to this mediaId'
    : 'have parser-level identity confidence and are not semantically matched to this mediaId';
  return {
    count: lowConf.length,
    description,
    avgIdentity,
  };
}
